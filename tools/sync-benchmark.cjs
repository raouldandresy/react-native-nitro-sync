#!/usr/bin/env node

'use strict';

const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { createSyncTestServer, listen } = require('./sync-test-server.cjs');

function readPositiveIntegers(value, fallback, name) {
  const values = value === undefined
    ? fallback
    : value.split(',').map((entry) => Number(entry));
  if (values.length === 0 || values.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  }
  return values;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function sendBatch(endpoint, tableName, batchSize, payloadBytes, iteration) {
  const body = 'x'.repeat(payloadBytes);
  const mutations = Array.from({ length: batchSize }, (_, index) => {
    const id = `${iteration}-${index}`;
    return {
      id: `mutation-${id}`,
      tableName,
      operation: 'CREATE',
      payload: { id: `record-${id}`, body },
      timestamp: Date.now(),
      schemaVersion: 1,
    };
  });
  const requestBody = JSON.stringify({
    protocolVersion: 1,
    tableName,
    mutations,
    lastSyncedAt: null,
    deviceId: `benchmark-${iteration}`,
  });
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: requestBody,
  });
  const responseBody = await response.text();
  const durationMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`Benchmark request failed with HTTP ${response.status}: ${responseBody}`);
  }
  return {
    durationMs,
    requestBytes: Buffer.byteLength(requestBody),
    responseBytes: Buffer.byteLength(responseBody),
  };
}

async function run() {
  const batchSizes = readPositiveIntegers(process.env.SYNC_BENCH_BATCHES, [10, 100, 1_000], 'SYNC_BENCH_BATCHES');
  const payloadSizes = readPositiveIntegers(process.env.SYNC_BENCH_PAYLOADS, [256, 4_096], 'SYNC_BENCH_PAYLOADS');
  const concurrencyLevels = readPositiveIntegers(process.env.SYNC_BENCH_CONCURRENCY, [1, 4], 'SYNC_BENCH_CONCURRENCY');
  const iterations = Number(process.env.SYNC_BENCH_ITERATIONS ?? 5);
  if (!Number.isSafeInteger(iterations) || iterations < 2) {
    throw new Error('SYNC_BENCH_ITERATIONS must be an integer of at least 2');
  }

  const fixture = createSyncTestServer();
  const endpoint = await listen(fixture.server);
  const results = [];
  try {
    let runNumber = 0;
    for (const payloadBytes of payloadSizes) {
      for (const batchSize of batchSizes) {
        for (const concurrency of concurrencyLevels) {
          const tablePrefix = `bench-${payloadBytes}-${batchSize}-${concurrency}`;
          const startedAt = performance.now();
          const samples = await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
            const workerSamples = [];
            for (let iteration = 0; iteration < iterations; iteration += 1) {
              runNumber += 1;
              workerSamples.push(await sendBatch(
                endpoint,
                `${tablePrefix}-${worker}-${iteration}`,
                batchSize,
                payloadBytes,
                runNumber,
              ));
            }
            return workerSamples;
          }));
          const wallTimeMs = performance.now() - startedAt;
          const flatSamples = samples.flat();
          const totalMutations = batchSize * flatSamples.length;
          results.push({
            batchSize,
            payloadBytes,
            concurrency,
            iterations: flatSamples.length,
            requestLatencyP50Ms: percentile(flatSamples.map((sample) => sample.durationMs), 0.5),
            requestLatencyP95Ms: percentile(flatSamples.map((sample) => sample.durationMs), 0.95),
            mutationsPerSecond: totalMutations / (wallTimeMs / 1_000),
            averageRequestBytes: Math.round(flatSamples.reduce((sum, sample) => sum + sample.requestBytes, 0) / flatSamples.length),
            averageResponseBytes: Math.round(flatSamples.reduce((sum, sample) => sum + sample.responseBytes, 0) / flatSamples.length),
          });
        }
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      fixture.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  process.stdout.write(`${JSON.stringify({
    benchmark: 'nitro-sync-http-test-backend',
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      logicalCpus: os.cpus().length,
      iterationsPerWorker: iterations,
    },
    results,
  }, null, 2)}\n`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
