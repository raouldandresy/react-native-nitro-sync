#!/usr/bin/env node

'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');

const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body exceeds 5 MiB'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRequest(body) {
  if (
    !isObject(body) ||
    body.protocolVersion !== PROTOCOL_VERSION ||
    typeof body.tableName !== 'string' ||
    body.tableName.length === 0 ||
    !Array.isArray(body.mutations) ||
    !(body.lastSyncedAt === null || Number.isFinite(body.lastSyncedAt))
  ) {
    return 'Expected protocolVersion 1, tableName, mutations, and lastSyncedAt';
  }
  if (
    (body.serverCursor !== undefined && body.serverCursor !== null && typeof body.serverCursor !== 'string') ||
    (body.serverVersion !== undefined && body.serverVersion !== null && !Number.isFinite(body.serverVersion))
  ) {
    return 'serverCursor and serverVersion must be strings, numbers, or null';
  }
  for (const mutation of body.mutations) {
    if (
      !isObject(mutation) ||
      typeof mutation.id !== 'string' ||
      mutation.id.length === 0 ||
      mutation.tableName !== body.tableName ||
      !['CREATE', 'UPDATE', 'DELETE'].includes(mutation.operation) ||
      !isObject(mutation.payload) ||
      typeof mutation.payload.id !== 'string' ||
      !Number.isFinite(mutation.timestamp)
    ) {
      return 'Each mutation must have an ID, matching table, supported operation, record payload, and finite timestamp';
    }
  }
  return null;
}

function createSyncTestServer() {
  const tables = new Map();
  const processedMutations = new Map();
  const rejectionRules = new Map();
  const droppedAcknowledgements = new Set();
  const metrics = { requests: 0, mutations: 0, duplicateMutations: 0, rejectedMutations: 0 };

  function getTable(name) {
    let table = tables.get(name);
    if (table === undefined) {
      table = { version: 0, records: new Map(), changes: [] };
      tables.set(name, table);
    }
    return table;
  }

  function handleSync(request, body) {
    const invalid = validateRequest(body);
    if (invalid !== null) {
      return { statusCode: 400, body: { error: invalid } };
    }

    const table = getTable(body.tableName);
    const cursorValue = body.serverCursor !== undefined && body.serverCursor !== null
      ? Number(body.serverCursor)
      : body.serverVersion ?? 0;
    if (!Number.isSafeInteger(cursorValue) || cursorValue < 0) {
      return { statusCode: 400, body: { error: 'Cursor must be a non-negative safe integer' } };
    }

    metrics.requests += 1;
    const acknowledgedMutationIds = [];
    const rejectedMutations = [];

    for (const mutation of body.mutations) {
      metrics.mutations += 1;
      const fingerprint = createHash('sha256').update(stableStringify(mutation)).digest('hex');
      const previous = processedMutations.get(mutation.id);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          return {
            statusCode: 409,
            body: { error: `Mutation ID ${mutation.id} was already used with a different payload` },
          };
        }
        metrics.duplicateMutations += 1;
        if (previous.rejection !== undefined) {
          rejectedMutations.push(previous.rejection);
        } else {
          droppedAcknowledgements.delete(mutation.id);
          acknowledgedMutationIds.push(mutation.id);
        }
        continue;
      }

      const configuredRule = rejectionRules.get(mutation.id);
      const headerRule = request.headers['x-sync-test-reject-id'] === mutation.id
        ? {
          code: request.headers['x-sync-test-reject-code'] || 'test_rejection',
          message: request.headers['x-sync-test-reject-message'] || 'Rejected by test fixture',
          retryable: request.headers['x-sync-test-retryable'] !== 'false',
        }
        : undefined;
      const rule = configuredRule ?? headerRule;
      if (rule !== undefined) {
        const rejection = { mutationId: mutation.id, ...rule };
        rejectedMutations.push(rejection);
        metrics.rejectedMutations += 1;
        if (!rule.retryable) {
          processedMutations.set(mutation.id, { fingerprint, rejection });
        }
        continue;
      }

      table.version += 1;
      if (mutation.operation === 'DELETE') {
        table.records.delete(mutation.payload.id);
        table.changes.push({
          version: table.version,
          tombstone: { id: mutation.payload.id, timestamp: table.version },
        });
      } else {
        const record = {
          ...table.records.get(mutation.payload.id),
          ...mutation.payload,
          updatedAt: table.version,
        };
        table.records.set(record.id, record);
        table.changes.push({ version: table.version, record });
      }
      processedMutations.set(mutation.id, { fingerprint });
      if (request.headers['x-sync-test-drop-ack-id'] !== mutation.id) {
        acknowledgedMutationIds.push(mutation.id);
      } else {
        droppedAcknowledgements.add(mutation.id);
      }
    }

    const pulled = table.changes.filter((change) => change.version > cursorValue);
    const nextCursor = pulled.length === 0 ? cursorValue : pulled[pulled.length - 1].version;
    return {
      statusCode: 200,
      body: {
        protocolVersion: PROTOCOL_VERSION,
        records: pulled.flatMap((change) => change.record === undefined ? [] : [change.record]),
        tombstones: pulled.flatMap((change) => change.tombstone === undefined ? [] : [change.tombstone]),
        acknowledgedMutationIds,
        rejectedMutations,
        serverTimestamp: Date.now(),
        serverCursor: String(nextCursor),
        serverVersion: nextCursor,
      },
    };
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      if (request.method === 'GET' && request.url === '/__test__/health') {
        response.writeHead(200).end(JSON.stringify({ status: 'ok', protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      if (request.method === 'GET' && request.url === '/__test__/snapshot') {
        response.writeHead(200).end(JSON.stringify({
          status: 'ok',
          ...fixture.snapshot(),
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/__test__/reset') {
        fixture.reset();
        response.writeHead(200).end(JSON.stringify({
          status: 'ok',
          ...fixture.snapshot(),
        }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/sync') {
        response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const result = handleSync(request, await readJson(request));
      response.writeHead(result.statusCode).end(JSON.stringify(result.body));
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      response.writeHead(statusCode).end(JSON.stringify({
        error: statusCode === 500 ? 'Internal test server error' : error.message,
      }));
    }
  });

  const fixture = {
    server,
    metrics,
    rejectionRules,
    reset() {
      tables.clear();
      processedMutations.clear();
      rejectionRules.clear();
      droppedAcknowledgements.clear();
      metrics.requests = 0;
      metrics.mutations = 0;
      metrics.duplicateMutations = 0;
      metrics.rejectedMutations = 0;
    },
    snapshot() {
      return {
        metrics: { ...metrics },
        tables: Object.fromEntries([...tables].map(([name, table]) => [name, {
          version: table.version,
          records: [...table.records.values()],
        }])),
      };
    },
  };
  return fixture;
}

async function listen(server, port = 0, host = '127.0.0.1') {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('The sync test server only listens on loopback interfaces');
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine test server address');
  }
  return `http://${host}:${address.port}`;
}

module.exports = { createSyncTestServer, listen };

if (require.main === module) {
  const { server } = createSyncTestServer();
  const host = process.env.SYNC_TEST_HOST || '127.0.0.1';
  const port = Number(process.env.SYNC_TEST_PORT || 8787);
  listen(server, port, host).then((endpoint) => {
    console.info(`Local NitroSync protocol test backend listening at ${endpoint}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
