'use strict';

const { createSyncTestServer, listen } = require('./sync-test-server.cjs');
const { buildSyncRequestPayload, normalizeSyncResponse } = require('../src/protocol.ts');

describe('local sync protocol backend', () => {
  let fixture;
  let endpoint;

  beforeEach(async () => {
    fixture = createSyncTestServer();
    endpoint = await listen(fixture.server);
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => {
      fixture.server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function sync(tableName, mutations = [], options = {}) {
    const request = buildSyncRequestPayload(
      tableName,
      mutations,
      options.lastSyncedAt ?? null,
      options.serverCursor,
      options.serverVersion,
      options.deviceId ?? 'test-device',
    );
    const response = await fetch(`${endpoint}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(request),
    });
    const body = await response.json();
    return { response, body };
  }

  it('exposes health, server data, and a reset API for the example app', async () => {
    await sync('notes', [mutation('snapshot-note', 'notes')]);
    const health = await fetch(`${endpoint}/__test__/health`).then((response) => response.json());
    const snapshot = await fetch(`${endpoint}/__test__/snapshot`).then((response) => response.json());
    const resetResponse = await fetch(`${endpoint}/__test__/reset`, { method: 'POST' });
    const reset = await resetResponse.json();

    expect(health).toEqual({ status: 'ok', protocolVersion: 1 });
    expect(snapshot.metrics.mutations).toBe(1);
    expect(snapshot.tables.notes.records).toEqual([
      expect.objectContaining({ id: 'snapshot-note-record', value: 'snapshot-note' }),
    ]);
    expect(reset.status).toBe('ok');
    expect(reset.tables).toEqual({});
    expect(reset.metrics.mutations).toBe(0);
  });

  function mutation(id, tableName, operation = 'CREATE', payload = { id: `${id}-record`, value: id }) {
    return { id, tableName, operation, payload, timestamp: 1, schemaVersion: 1 };
  }

  it('deduplicates mutation IDs atomically and returns the same acknowledgement on retry', async () => {
    const submitted = mutation('once', 'notes');
    const first = await sync('notes', [submitted]);
    const retry = await sync('notes', [submitted], { serverCursor: first.body.serverCursor });

    expect(first.response.status).toBe(200);
    expect(normalizeSyncResponse(first.body).acknowledgedMutationIds).toEqual(['once']);
    expect(normalizeSyncResponse(retry.body).acknowledgedMutationIds).toEqual(['once']);
    expect(fixture.snapshot().metrics).toMatchObject({
      mutations: 2,
      duplicateMutations: 1,
    });
    expect(fixture.snapshot().tables.notes.records).toHaveLength(1);
  });

  it('rejects reuse of a mutation ID with a changed payload', async () => {
    await sync('notes', [mutation('same-id', 'notes')]);
    const result = await sync('notes', [mutation('same-id', 'notes', 'UPDATE', {
      id: 'same-id-record',
      value: 'different',
    })]);

    expect(result.response.status).toBe(409);
    expect(result.body.error).toMatch(/different payload/);
    expect(fixture.snapshot().tables.notes.records[0].value).toBe('same-id');
  });

  it('recovers a committed mutation when the first acknowledgement is lost', async () => {
    const submitted = mutation('lost-ack', 'notes');
    const first = await sync('notes', [submitted], {
      headers: { 'x-sync-test-drop-ack-id': submitted.id },
    });
    const retry = await sync('notes', [submitted]);

    expect(first.body.acknowledgedMutationIds).toEqual([]);
    expect(retry.body.acknowledgedMutationIds).toEqual(['lost-ack']);
    expect(fixture.snapshot().tables.notes.records).toHaveLength(1);
    expect(fixture.snapshot().metrics.duplicateMutations).toBe(1);
  });

  it('keeps cursors table-scoped and returns only changes after each cursor', async () => {
    const initial = await sync('notes', [mutation('note-1', 'notes')]);
    await sync('tasks', [mutation('task-1', 'tasks')]);
    await sync('notes', [mutation('note-2', 'notes')], {
      serverCursor: initial.body.serverCursor,
    });

    const notes = await sync('notes', [], { serverCursor: '1' });
    const tasks = await sync('tasks', [], { serverCursor: '0' });
    expect(notes.body.records.map((record) => record.id)).toEqual(['note-2-record']);
    expect(notes.body.serverCursor).toBe('2');
    expect(tasks.body.records.map((record) => record.id)).toEqual(['task-1-record']);
    expect(tasks.body.serverCursor).toBe('1');
  });

  it('returns versioned tombstones for deletes', async () => {
    const submitted = mutation('delete-note', 'notes', 'DELETE', { id: 'note-1' });
    const { response, body } = await sync('notes', [submitted]);

    expect(response.status).toBe(200);
    expect(normalizeSyncResponse(body).tombstones).toEqual([
      { id: 'note-1', timestamp: 1 },
    ]);
    expect(fixture.snapshot().tables.notes.records).toEqual([]);
  });

  it('returns the latest conflicting record with a monotonically increasing server revision', async () => {
    await sync('notes', [mutation('create', 'notes', 'CREATE', {
      id: 'note-1',
      value: 'initial',
    })]);
    const firstUpdate = await sync('notes', [mutation('update-a', 'notes', 'UPDATE', {
      id: 'note-1',
      value: 'first edit',
    })], { serverCursor: '1' });
    const secondUpdate = await sync('notes', [mutation('update-b', 'notes', 'UPDATE', {
      id: 'note-1',
      value: 'second edit',
    })], { serverCursor: firstUpdate.body.serverCursor });

    expect(firstUpdate.body.records).toEqual([
      expect.objectContaining({ id: 'note-1', value: 'first edit', updatedAt: 2 }),
    ]);
    expect(secondUpdate.body.records).toEqual([
      expect.objectContaining({ id: 'note-1', value: 'second edit', updatedAt: 3 }),
    ]);
    expect(secondUpdate.body.serverVersion).toBe(3);
  });

  it('returns retryable and permanent rejections without acknowledging them', async () => {
    const retryable = mutation('retryable', 'notes');
    const first = await sync('notes', [retryable], {
      headers: {
        'x-sync-test-reject-id': retryable.id,
        'x-sync-test-retryable': 'true',
      },
    });
    const retried = await sync('notes', [retryable]);
    const permanent = mutation('permanent', 'notes');
    const rejected = await sync('notes', [permanent], {
      headers: {
        'x-sync-test-reject-id': permanent.id,
        'x-sync-test-retryable': 'false',
      },
    });
    const permanentRetry = await sync('notes', [permanent]);

    expect(first.body.rejectedMutations[0]).toMatchObject({
      mutationId: 'retryable',
      code: 'test_rejection',
      retryable: true,
    });
    expect(retried.body.acknowledgedMutationIds).toEqual(['retryable']);
    expect(rejected.body.rejectedMutations[0]).toMatchObject({
      mutationId: 'permanent',
      retryable: false,
    });
    expect(permanentRetry.body.rejectedMutations).toEqual(rejected.body.rejectedMutations);
    expect(permanentRetry.body.acknowledgedMutationIds).toEqual([]);
  });

  it('rejects unsupported protocol versions and mismatched mutation tables', async () => {
    const request = buildSyncRequestPayload(
      'notes',
      [mutation('wrong-table', 'tasks')],
      null,
    );
    const tableMismatch = await fetch(`${endpoint}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const unsupportedVersion = await fetch(`${endpoint}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, mutations: [], protocolVersion: 2 }),
    });

    expect(tableMismatch.status).toBe(400);
    expect(unsupportedVersion.status).toBe(400);
  });
});
