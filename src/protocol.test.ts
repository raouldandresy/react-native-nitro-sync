import {
  assertCompatibleSchemaVersion,
  buildSyncRequestPayload,
  normalizeSyncResponse,
} from './protocol';

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

  it('serializes application schema and migration metadata', () => {
    expect(buildSyncRequestPayload(
      'todos',
      [],
      null,
      null,
      null,
      'device-7',
      4,
      {
        fromVersion: 3,
        tables: ['todos'],
        columns: { todos: ['archived'] },
      },
    )).toMatchObject({
      schemaVersion: 4,
      migration: {
        fromVersion: 3,
        tables: ['todos'],
        columns: { todos: ['archived'] },
      },
    });
    expect(() => buildSyncRequestPayload('todos', [], null, undefined, undefined, undefined, 0))
      .toThrow('schemaVersion');
    expect(() => buildSyncRequestPayload(
      'todos',
      [],
      null,
      undefined,
      undefined,
      undefined,
      4,
      { fromVersion: 3, tables: ['todos'], columns: { todos: [1] as never } },
    )).toThrow('schema migration');
    expect(() => buildSyncRequestPayload(
      'todos',
      [],
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      { fromVersion: 3, tables: ['todos'], columns: {} },
    )).toThrow('schemaVersion is required');
    expect(() => buildSyncRequestPayload(
      'todos',
      [],
      null,
      undefined,
      undefined,
      undefined,
      3,
      { fromVersion: 3, tables: ['todos'], columns: {} },
    )).toThrow('fromVersion must be older');
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

  it('requires a complete snapshot when the server requests replacement sync', () => {
    expect(normalizeSyncResponse({
      resetRequired: true,
      records: [{ id: 'todo-1', title: 'restored' }],
      tombstones: [{ id: 'todo-2', timestamp: 9 }],
      serverCursor: 'replacement-cursor',
    })).toMatchObject({
      resetRequired: true,
      records: [{ id: 'todo-1', title: 'restored' }],
      serverCursor: 'replacement-cursor',
    });

    expect(() => normalizeSyncResponse({ resetRequired: true }))
      .toThrow('resetRequired requires records');
    expect(() => normalizeSyncResponse({ resetRequired: 'yes' }))
      .toThrow('resetRequired must be a boolean');
  });

  it('validates a server minimum application schema version', () => {
    expect(normalizeSyncResponse({
      records: [],
      minimumSchemaVersion: 3,
    })).toMatchObject({ minimumSchemaVersion: 3 });
    expect(() => normalizeSyncResponse({ minimumSchemaVersion: 0 }))
      .toThrow('minimumSchemaVersion');
  });

  it('fails incompatible application schema versions before settlement', () => {
    expect(() => assertCompatibleSchemaVersion(2, 3))
      .toThrow('server requires 3');
    expect(() => assertCompatibleSchemaVersion(3, 3)).not.toThrow();
    expect(() => assertCompatibleSchemaVersion(0, undefined))
      .toThrow('positive safe integer');
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
