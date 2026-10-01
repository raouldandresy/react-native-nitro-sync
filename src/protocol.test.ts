import { buildSyncRequestPayload, normalizeSyncResponse } from './protocol';

describe('sync protocol helpers', () => {
  it('serializes the server cursor and version into the payload', () => {
    const payload = buildSyncRequestPayload('todos', [{
      id: 'mutation-1',
      tableName: 'todos',
      operation: 'UPDATE',
      payload: { id: 'todo-1', title: 'next' },
      timestamp: 10,
      schemaVersion: 4,
    }], 5, 'cursor-42', 99, 'device-7');

    expect(payload).toEqual({
      protocolVersion: 1,
      tableName: 'todos',
      mutations: [{
        id: 'mutation-1',
        tableName: 'todos',
        operation: 'UPDATE',
        payload: { id: 'todo-1', title: 'next' },
        timestamp: 10,
        schemaVersion: 4,
      }],
      lastSyncedAt: 5,
      serverCursor: 'cursor-42',
      serverVersion: 99,
      deviceId: 'device-7',
    });
  });

  it('normalizes the response contract with explicit cursor and version metadata', () => {
    const normalized = normalizeSyncResponse({
      records: [{ id: 'todo-1', title: 'done' }],
      acknowledgedMutationIds: ['mutation-1'],
      tombstones: [{ id: 'todo-2', timestamp: 8 }],
      rejectedMutations: [{
        mutationId: 'mutation-2',
        code: 'validation',
        message: 'invalid',
        retryable: false,
      }],
      serverCursor: 'cursor-9',
      serverVersion: 7,
    });

    expect(normalized).toEqual({
      protocolVersion: 1,
      records: [{ id: 'todo-1', title: 'done' }],
      acknowledgedMutationIds: ['mutation-1'],
      tombstones: [{ id: 'todo-2', timestamp: 8 }],
      rejectedMutations: [{
        mutationId: 'mutation-2',
        code: 'validation',
        message: 'invalid',
        retryable: false,
      }],
      serverTimestamp: expect.any(Number),
      serverCursor: 'cursor-9',
      serverVersion: 7,
    });
  });

  it('rejects malformed response acknowledgements and tombstones explicitly', () => {
    expect(() => normalizeSyncResponse({ acknowledgedMutationIds: ['ok', 12] }))
      .toThrow('acknowledgedMutationIds must be an array of strings');
    expect(() => normalizeSyncResponse({
      tombstones: [{ id: 'record-1', timestamp: Number.NaN }],
    })).toThrow('tombstones must contain string IDs and finite timestamps');
    expect(() => normalizeSyncResponse({ rejectedMutations: [null] }))
      .toThrow('rejectedMutations has an invalid entry');
    expect(() => normalizeSyncResponse({ protocolVersion: 2 }))
      .toThrow('Unsupported sync protocol version 2');
  });

  it('normalizes a valid empty server response to an empty acknowledgement batch', () => {
    expect(normalizeSyncResponse({})).toEqual({
      protocolVersion: 1,
      records: undefined,
      tombstones: [],
      acknowledgedMutationIds: [],
      rejectedMutations: [],
      serverTimestamp: expect.any(Number),
    });
  });

  it('preserves absent cursor and version separately from explicit null values', () => {
    expect(normalizeSyncResponse({})).not.toHaveProperty('serverCursor');
    expect(normalizeSyncResponse({})).not.toHaveProperty('serverVersion');
    expect(normalizeSyncResponse({ serverCursor: null, serverVersion: null })).toMatchObject({
      serverCursor: null,
      serverVersion: null,
    });
  });
});
