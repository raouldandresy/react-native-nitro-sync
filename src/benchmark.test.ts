import { benchmarkNativeSyncQueue } from './benchmark';

describe('benchmarkNativeSyncQueue', () => {
  it('returns serialization, enqueue, claim, and JS blocking measurements and cleans up its batch', async () => {
    const queue = new Map<string, string>();
    const nativeEngine = {
      enqueueMutation: jest.fn((id, tableName, operation, payload, timestamp) => {
        queue.set(id, JSON.stringify({ id, tableName, operation, payload, timestamp }));
      }),
      listPendingMutations: jest.fn(() => [...queue.values()]),
      markMutationPending: jest.fn(),
      removeMutation: jest.fn((id: string) => {
        queue.delete(id);
      }),
    };

    const results = await benchmarkNativeSyncQueue(nativeEngine, [10, 100, 1_000, 10_000], 32);

    expect(results.map((result) => result.mutationCount)).toEqual([10, 100, 1_000, 10_000]);
    for (const result of results) {
      expect(result.mutationCount).toBeGreaterThan(0);
      expect(result.payloadBodyBytes).toBe(32);
      expect(result.serializedPayloadBytes).toBeGreaterThan(0);
      expect(result.claimResponseBytes).toBeGreaterThan(0);
      expect(result.serializationMs).toBeGreaterThanOrEqual(0);
      expect(result.deserializationMs).toBeGreaterThanOrEqual(0);
      expect(result.enqueueMs).toBeGreaterThanOrEqual(0);
      expect(result.enqueueMsPerMutation).toBeGreaterThanOrEqual(0);
      expect(result.claimMs).toBeGreaterThanOrEqual(0);
      expect(result.jsBlockingMs).toBeGreaterThanOrEqual(0);
    }
    expect(queue.size).toBe(0);
  });

  it('rejects invalid batch sizes and payload sizes', async () => {
    const nativeEngine = {
      enqueueMutation: jest.fn(),
      listPendingMutations: jest.fn(() => []),
      markMutationPending: jest.fn(),
      removeMutation: jest.fn(),
    };

    await expect(benchmarkNativeSyncQueue(nativeEngine, [])).rejects.toThrow('positive safe integers');
    await expect(benchmarkNativeSyncQueue(nativeEngine, [10], -1)).rejects.toThrow('non-negative safe integer');
  });
});
