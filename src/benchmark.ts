import type { NitroSync } from './specs/NitroSync.nitro';

export interface SyncQueueBenchmarkResult {
  readonly mutationCount: number;
  readonly payloadBodyBytes: number;
  readonly serializedPayloadBytes: number;
  readonly claimResponseBytes: number;
  readonly serializationMs: number;
  readonly deserializationMs: number;
  readonly enqueueMs: number;
  readonly enqueueMsPerMutation: number;
  readonly claimMs: number;
  readonly jsBlockingMs: number;
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function assertBatchSizes(batchSizes: readonly number[]): void {
  if (batchSizes.length === 0 || batchSizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) {
    throw new Error('Benchmark batch sizes must be positive safe integers');
  }
}

export async function benchmarkNativeSyncQueue(
  nativeEngine: Pick<
    NitroSync,
    'enqueueMutation' | 'listPendingMutations' | 'markMutationPending' | 'removeMutation'
  >,
  batchSizes: readonly number[] = [10, 100, 1_000, 10_000],
  payloadBytes = 256,
): Promise<readonly SyncQueueBenchmarkResult[]> {
  assertBatchSizes(batchSizes);
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error('Benchmark payload size must be a non-negative safe integer');
  }

  const results: SyncQueueBenchmarkResult[] = [];
  for (const mutationCount of batchSizes) {
    const tableName = `__nitro_sync_benchmark_${Date.now()}_${mutationCount}`;
    const body = 'x'.repeat(payloadBytes);
    let serializationMs = 0;
    let serializedPayloadBytes = 0;
    let enqueueMs = 0;
    const ids = Array.from({ length: mutationCount }, (_, index) => `${tableName}_${index}`);

    let jsBlockingMs = 0;
    const timerStartedAt = now();
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        jsBlockingMs = now() - timerStartedAt;
        resolve();
      }, 0);
    });

    for (let index = 0; index < mutationCount; index += 1) {
      const serializationStartedAt = now();
      const payload = JSON.stringify({
        id: ids[index],
        title: `benchmark-${index}`,
        body,
      });
      serializationMs += now() - serializationStartedAt;
      serializedPayloadBytes += payload.length;

      const enqueueStartedAt = now();
      nativeEngine.enqueueMutation(
        ids[index],
        tableName,
        'CREATE',
        payload,
        Date.now(),
        1,
      );
      enqueueMs += now() - enqueueStartedAt;
    }

    const claimStartedAt = now();
    const claimed = nativeEngine.listPendingMutations(mutationCount);
    const claimMs = now() - claimStartedAt;
    let deserializationMs = 0;
    let claimResponseBytes = 0;
    for (const serialized of claimed) {
      claimResponseBytes += serialized.length;
      const decodeStartedAt = now();
      const mutation = JSON.parse(serialized) as {
        readonly id?: unknown;
        readonly tableName?: unknown;
      };
      deserializationMs += now() - decodeStartedAt;
      if (typeof mutation.id === 'string') {
        if (mutation.tableName === tableName) {
          nativeEngine.removeMutation(mutation.id);
        } else {
          nativeEngine.markMutationPending(mutation.id);
        }
      }
    }
    await timer;

    results.push({
      mutationCount,
      payloadBodyBytes: payloadBytes,
      serializedPayloadBytes,
      claimResponseBytes,
      serializationMs,
      deserializationMs,
      enqueueMs,
      enqueueMsPerMutation: enqueueMs / mutationCount,
      claimMs,
      jsBlockingMs,
    });
  }

  return results;
}
