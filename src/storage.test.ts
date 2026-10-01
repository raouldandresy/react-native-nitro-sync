import { createSyncStorage } from './storage';
import type { SyncSqliteDatabase, SyncMetadataStore } from './storage';

function createMemoryMetadataStore(): SyncMetadataStore {
  const values = new Map<string, string>();
  return {
    getString: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

function createMemoryDatabase(initialUserVersion = 0): SyncSqliteDatabase & {
  readonly getUserVersion: () => number;
  readonly advanceTime: (milliseconds: number) => void;
} {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  let userVersion = initialUserVersion;
  let nowMs = 1_000_000;

  const ensureTable = (name: string) => {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
  };

  const updateQueueRow = (id: string, updater: (row: Record<string, unknown>) => Record<string, unknown>) => {
    const rows = tables.get('sync_queue');
    if (rows === undefined) {
      return;
    }
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) {
      rows[index] = updater(rows[index]);
    }
  };

  return {
    getUserVersion: () => userVersion,
    advanceTime: (milliseconds) => {
      nowMs += milliseconds;
    },
    executeSync: (sql: string, params: readonly (string | number | null)[] = []) => {
      const normalized = sql.trim();
      if (normalized === 'PRAGMA user_version') {
        return { rows: [{ user_version: userVersion }] };
      }
      if (normalized.startsWith('PRAGMA user_version = ')) {
        userVersion = Number(normalized.match(/=\s*(\d+)/)?.[1] ?? userVersion);
        return { rows: [] };
      }
      if (normalized.startsWith('PRAGMA') || normalized.startsWith('BEGIN') || normalized.startsWith('COMMIT') || normalized.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
        const tableName = normalized.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/)?.[1];
        if (tableName !== undefined) {
          ensureTable(tableName);
        }
        return { rows: [] };
      }
      if (normalized.startsWith('DROP INDEX IF EXISTS')) {
        return { rows: [] };
      }
      if (normalized.startsWith('DROP TABLE ')) {
        tables.delete(normalized.split(/\s+/)[2]);
        return { rows: [] };
      }
      if (normalized.startsWith('ALTER TABLE sync_queue_v3 RENAME TO sync_queue')) {
        tables.set('sync_queue', tables.get('sync_queue_v3') ?? []);
        tables.delete('sync_queue_v3');
        return { rows: [] };
      }
      if (normalized.startsWith('ALTER TABLE sync_queue ADD COLUMN schema_version')) {
        for (const row of tables.get('sync_queue') ?? []) {
          row.schema_version = 1;
        }
        return { rows: [] };
      }
      if (normalized.startsWith('ALTER TABLE sync_queue ADD COLUMN')) {
        const columnName = normalized.match(/ADD COLUMN (\w+)/)?.[1];
        if (columnName !== undefined) {
          for (const row of tables.get('sync_queue') ?? []) {
            row[columnName] = columnName === 'next_retry_at' ? 0 : null;
          }
        }
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO sync_queue_v3')) {
        ensureTable('sync_queue_v3');
        tables.set('sync_queue_v3', [...(tables.get('sync_queue') ?? [])]);
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO sync_queue')) {
        ensureTable('sync_queue');
        const [id, tableName, operation, payload, timestamp, schemaVersion] =
          params as [string, string, string, string, number, number];
        const rows = tables.get('sync_queue') as Record<string, unknown>[];
        const index = rows.findIndex((row) => row.id === id);
        if (index >= 0) {
          return { rows: [] };
        } else {
          rows.push({
            id,
            table_name: tableName,
            operation,
            payload,
            timestamp,
            status: 'PENDING',
            retry_count: 0,
            schema_version: schemaVersion,
            next_retry_at: 0,
            rejection_code: null,
            rejection_message: null,
          });
        }
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO sync_records')) {
        ensureTable('sync_records');
        const [tableName, recordId, payload, updatedAt, suppliedDeleted] = params as [string, string, string, number, number?];
        const rows = tables.get('sync_records') as Record<string, unknown>[];
        const index = rows.findIndex((row) => row.table_name === tableName && row.record_id === recordId);
        const nextRow = {
          table_name: tableName,
          record_id: recordId,
          payload,
          updated_at: updatedAt,
          deleted: suppliedDeleted ?? (normalized.includes('VALUES (?, ?, ?, ?, 1)') ? 1 : 0),
        };
        if (index >= 0) {
          if (updatedAt >= Number(rows[index].updated_at ?? 0)) {
            rows[index] = nextRow;
          }
        } else {
          rows.push(nextRow);
        }
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT')) {
        const rows = tables.get(normalized.includes('sync_records') ? 'sync_records' : 'sync_queue') ?? [];
        if (normalized.includes('FROM sync_queue')) {
          if (normalized.includes("status = 'REJECTED'")) {
            const tableName = String(params[0] ?? '');
            return { rows: rows
              .filter((row) => row.status === 'REJECTED' && row.table_name === tableName)
              .map((row) => ({
                id: row.id,
                table_name: row.table_name,
                operation: row.operation,
                payload: row.payload,
                timestamp: row.timestamp,
                schema_version: row.schema_version ?? 1,
                rejection_code: row.rejection_code,
                rejection_message: row.rejection_message,
              })) };
          }
          const scoped = normalized.includes('AND table_name = ?');
          const tableName = scoped ? String(params[0] ?? '') : undefined;
          const limit = Number(params[scoped ? 1 : 0] ?? 100);
          const selected = rows.filter((row) => {
            const status = String(row.status ?? '');
            return (status === 'PENDING' || status === 'FAILED') &&
              Number(row.next_retry_at ?? 0) <= nowMs &&
              (tableName === undefined || row.table_name === tableName);
          }).slice(0, limit);
          return { rows: selected.map((row) => ({
            id: row.id,
            table_name: row.table_name,
            operation: row.operation,
            payload: row.payload,
            timestamp: row.timestamp,
            schema_version: row.schema_version ?? 1,
          })) };
        }
        if (normalized.includes('FROM sync_records')) {
          const tableName = String(params[0] ?? '');
          if (normalized.includes('deleted = 1')) {
            return { rows: (rows as Record<string, unknown>[])
              .filter((row) => row.table_name === tableName && row.deleted === 1)
              .map((row) => ({
                record_id: row.record_id,
                updated_at: row.updated_at,
              })) };
          }
          return { rows: (rows as Record<string, unknown>[])
            .filter((row) => row.table_name === tableName && row.deleted === 0)
            .map((row) => ({ payload: row.payload })) };
        }
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE sync_queue SET status = \'SYNCING\' WHERE id = ?')) {
        updateQueueRow(String(params[0]), (row) => ({ ...row, status: 'SYNCING' }));
        return { rows: [] };
      }
      if (normalized.startsWith("UPDATE sync_queue SET status = 'PENDING' WHERE status = 'SYNCING'")) {
        const rows = tables.get('sync_queue') ?? [];
        for (const row of rows) {
          row.status = 'PENDING';
        }
        return { rows: [] };
      }
      if (normalized.includes("SET status = 'FAILED'")) {
        updateQueueRow(String(params[0]), (row) => ({
          ...row,
          status: 'FAILED',
          next_retry_at: nowMs + Math.min(1000 * (2 ** Number(row.retry_count ?? 0)), 300_000),
          retry_count: Number(row.retry_count ?? 0) + 1,
        }));
        return { rows: [] };
      }
      if (normalized.startsWith("UPDATE sync_queue SET status = 'REJECTED'")) {
        updateQueueRow(String(params[2]), (row) => ({
          ...row,
          status: 'REJECTED',
          rejection_code: params[0],
          rejection_message: params[1],
        }));
        return { rows: [] };
      }
      if (normalized.startsWith("UPDATE sync_queue SET status = 'PENDING', retry_count = 0")) {
        updateQueueRow(String(params[0]), (row) => ({
          ...row,
          status: 'PENDING',
          retry_count: 0,
          next_retry_at: 0,
          rejection_code: null,
          rejection_message: null,
        }));
        return { rows: [] };
      }
      if (normalized.startsWith("UPDATE sync_queue SET status = 'PENDING'")) {
        updateQueueRow(String(params[0]), (row) => ({ ...row, status: 'PENDING', next_retry_at: 0 }));
        return { rows: [] };
      }
      if (normalized.startsWith('DELETE FROM sync_queue WHERE id = ?')) {
        const rows = tables.get('sync_queue') ?? [];
        const filtered = rows.filter((row) => row.id !== params[0]);
        tables.set('sync_queue', filtered);
        return { rows: [] };
      }
      if (normalized.startsWith('DELETE FROM sync_records WHERE table_name = ?')) {
        const rows = tables.get('sync_records') ?? [];
        const [tableName, recordId, throughTimestamp] = params;
        tables.set('sync_records', rows.filter((row) => !(
          row.table_name === tableName &&
          row.record_id === recordId &&
          row.deleted === 1 &&
          Number(row.updated_at) <= Number(throughTimestamp)
        )));
        return { rows: [] };
      }
      throw new Error(`Unhandled SQL: ${normalized}`);
    },
  };
}

describe('createSyncStorage idempotent mutation recovery', () => {
  it('deduplicates repeated IDs without changing immutable mutation content, retries, then removes after acknowledgement', () => {
    const database = createMemoryDatabase();
    const metadataStore = createMemoryMetadataStore();
    const storage = createSyncStorage(database, metadataStore);
    const mutation = {
      id: 'mutation-1',
      tableName: 'todos',
      operation: 'UPDATE' as const,
      payload: { id: 'todo-1', title: 'first' },
      timestamp: 100,
    };

    storage.saveMutation(mutation);
    storage.saveMutation({ ...mutation, payload: { id: 'todo-1', title: 'second' } });

    const firstAttempt = storage.listPendingMutations(10);
    expect(firstAttempt).toHaveLength(1);
    expect(firstAttempt[0].payload.title).toBe('first');
    expect(firstAttempt[0].schemaVersion).toBe(1);

    storage.markMutationFailed('mutation-1');
    expect(storage.listPendingMutations(10)).toHaveLength(0);
    database.advanceTime(1_000);
    const retried = storage.listPendingMutations(10);
    expect(retried).toHaveLength(1);
    expect(retried[0].id).toBe(firstAttempt[0].id);
    expect(retried[0]).toEqual(firstAttempt[0]);

    storage.removeMutation('mutation-1');
    expect(storage.listPendingMutations(10)).toHaveLength(0);
  });

  it('recovers a claimed mutation on storage reinitialization after a simulated app restart', () => {
    const database = createMemoryDatabase();
    const firstStorage = createSyncStorage(database);
    firstStorage.initialize();
    firstStorage.saveMutation({
      id: 'mutation-after-crash',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-2', title: 'queued before crash' },
      timestamp: 200,
    });

    const inFlightBeforeCrash = firstStorage.listPendingMutations(10);
    expect(inFlightBeforeCrash).toHaveLength(1);
    expect(firstStorage.listPendingMutations(10)).toHaveLength(0);

    const restartedStorage = createSyncStorage(database);
    restartedStorage.initialize();
    const recovered = restartedStorage.listPendingMutations(10);

    expect(recovered).toEqual(inFlightBeforeCrash);
  });

  it('runs the pending schema migration from version 1 and rejects a future schema version', () => {
    const olderDatabase = createMemoryDatabase(1);
    createSyncStorage(olderDatabase).initialize();
    expect(olderDatabase.getUserVersion()).toBe(5);

    const newerDatabase = createMemoryDatabase(6);
    expect(() => createSyncStorage(newerDatabase).initialize())
      .toThrow('newer than supported version 5');
  });

  it('migrates an existing queue row without losing retry state or payload', () => {
    const database = createMemoryDatabase(2);
    database.executeSync(
      `CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY NOT NULL,
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        retry_count INTEGER NOT NULL DEFAULT 0
      )`,
    );
    database.executeSync(
      'INSERT INTO sync_queue (id, table_name, operation, payload, timestamp) VALUES (?, ?, ?, ?, ?)',
      ['pre-migration', 'todos', 'UPDATE', JSON.stringify({ id: 'todo-legacy', title: 'kept' }), 300],
    );
    const storage = createSyncStorage(database);
    storage.initialize();

    const restartedStorage = createSyncStorage(database);
    restartedStorage.initialize();
    expect(restartedStorage.listPendingMutations(10)).toEqual([{
      id: 'pre-migration',
      tableName: 'todos',
      operation: 'UPDATE',
      payload: { id: 'todo-legacy', title: 'kept' },
      timestamp: 300,
      schemaVersion: 1,
    }]);
  });

  it('keeps permanently rejected mutations out of automatic retries until manually requeued', () => {
    const database = createMemoryDatabase();
    const storage = createSyncStorage(database);
    storage.initialize();
    storage.saveMutation({
      id: 'rejected-1',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-3' },
      timestamp: 400,
    });
    storage.listPendingMutations(10);
    storage.markMutationRejected('rejected-1', 'invalid', 'not allowed');

    expect(storage.listPendingMutations(10)).toEqual([]);
    expect(storage.listRejectedMutations('todos')).toEqual([{
      mutation: {
        id: 'rejected-1',
        tableName: 'todos',
        operation: 'CREATE',
        payload: { id: 'todo-3' },
        timestamp: 400,
        schemaVersion: 1,
      },
      code: 'invalid',
      message: 'not allowed',
    }]);

    storage.retryRejectedMutation('rejected-1');
    storage.markMutationPending('rejected-1');
    expect(storage.listPendingMutations(10)).toHaveLength(1);
  });

  it('applies a local mutation and its materialized record in one SQLite transaction', () => {
    const database = createMemoryDatabase();
    const storage = createSyncStorage(database);
    storage.initialize();
    const mutation = {
      id: 'atomic-1',
      tableName: 'todos',
      operation: 'CREATE' as const,
      payload: { id: 'todo-atomic', title: 'atomic' },
      timestamp: 450,
    };

    storage.applyMutation(mutation, mutation.payload, false);

    expect(storage.listPendingMutations(10)).toEqual([{
      ...mutation,
      schemaVersion: 1,
    }]);
    expect(storage.loadRecords('todos')).toEqual([mutation.payload]);
  });

  it('claims a requested table directly without claiming older rows from other tables', () => {
    const storage = createSyncStorage(createMemoryDatabase());
    storage.initialize();
    storage.saveMutation({
      id: 'older-notes',
      tableName: 'notes',
      operation: 'CREATE',
      payload: { id: 'note-1' },
      timestamp: 1,
    });
    storage.saveMutation({
      id: 'target-todo',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-1' },
      timestamp: 2,
    });

    expect(storage.listPendingMutations(1, 'todos').map(({ id }) => id)).toEqual(['target-todo']);
    expect(storage.listPendingMutations(10, 'notes').map(({ id }) => id)).toEqual(['older-notes']);
  });

  it('caps repeated exponential retry delay at five minutes', () => {
    const database = createMemoryDatabase();
    const storage = createSyncStorage(database);
    storage.initialize();
    storage.saveMutation({
      id: 'backoff-cap',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-backoff' },
      timestamp: 3,
    });

    let delay = 1_000;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(storage.listPendingMutations(1)).toHaveLength(1);
      storage.markMutationFailed('backoff-cap');
      database.advanceTime(delay);
      delay = Math.min(delay * 2, 300_000);
    }

    expect(storage.listPendingMutations(1)).toHaveLength(1);
    storage.markMutationFailed('backoff-cap');
    database.advanceTime(299_999);
    expect(storage.listPendingMutations(1)).toHaveLength(0);
    database.advanceTime(1);
    expect(storage.listPendingMutations(1)).toHaveLength(1);
  });
});

describe('createSyncStorage tombstones', () => {
  it('retains offline deletes across initialization and clears them only when a record is restored', () => {
    const database = createMemoryDatabase();
    const storage = createSyncStorage(database);
    storage.initialize();
    storage.removeRecord('todos', 'todo-deleted', 100);

    const restartedStorage = createSyncStorage(database);
    restartedStorage.initialize();
    expect(restartedStorage.loadRecords('todos')).toEqual([]);
    expect(restartedStorage.loadTombstones('todos')).toEqual([
      { id: 'todo-deleted', timestamp: 100 },
    ]);

    restartedStorage.saveRecord(
      'todos',
      { id: 'todo-deleted', title: 'stale server revision' },
      99,
    );
    expect(restartedStorage.loadRecords('todos')).toEqual([]);
    expect(restartedStorage.loadTombstones('todos')).toEqual([
      { id: 'todo-deleted', timestamp: 100 },
    ]);

    restartedStorage.saveRecord(
      'todos',
      { id: 'todo-deleted', title: 'restored by newer server revision' },
      101,
    );
    expect(restartedStorage.loadRecords('todos')).toEqual([
      { id: 'todo-deleted', title: 'restored by newer server revision' },
    ]);
    expect(restartedStorage.loadTombstones('todos')).toEqual([]);
  });

  it('clears only tombstones covered by the acknowledged delete timestamp', () => {
    const database = createMemoryDatabase();
    const storage = createSyncStorage(database);
    storage.initialize();
    storage.removeRecord('todos', 'todo-1', 100);
    storage.removeRecord('todos', 'todo-1', 200);

    storage.clearTombstone('todos', 'todo-1', 150);
    expect(storage.loadTombstones('todos')).toEqual([
      { id: 'todo-1', timestamp: 200 },
    ]);

    storage.clearTombstone('todos', 'todo-1', 200);
    expect(storage.loadTombstones('todos')).toEqual([]);
  });

  it('persists cursor and version independently per table across storage instances', () => {
    const database = createMemoryDatabase();
    const metadata = createMemoryMetadataStore();
    const storage = createSyncStorage(database, metadata);
    storage.setServerCursor('todos/work', 'cursor-10');
    storage.setServerVersion('todos/work', 10);
    storage.setServerCursor('notes', 'cursor-3');
    storage.setServerVersion('notes', 3);

    const restartedStorage = createSyncStorage(database, metadata);
    expect(restartedStorage.getServerCursor('todos/work')).toBe('cursor-10');
    expect(restartedStorage.getServerVersion('todos/work')).toBe(10);
    expect(restartedStorage.getServerCursor('notes')).toBe('cursor-3');
    expect(restartedStorage.getServerVersion('notes')).toBe(3);
  });

  it('persists configured mutation schema versions through queue claims and retries', () => {
    const storage = createSyncStorage(createMemoryDatabase());
    storage.initialize();
    storage.saveMutation({
      id: 'schema-v8',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-v8' },
      timestamp: 500,
      schemaVersion: 8,
    });

    expect(storage.listPendingMutations(10)).toEqual([{
      id: 'schema-v8',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-v8' },
      timestamp: 500,
      schemaVersion: 8,
    }]);
  });

  it('clears a confirmed delete tombstone without deleting a newer restored record', () => {
    const database = createMemoryDatabase();
    const storage = createSyncStorage(database);
    storage.initialize();
    storage.removeRecord('todos', 'todo-confirmed', 100);
    storage.clearTombstone('todos', 'todo-confirmed', 100);
    expect(storage.loadTombstones('todos')).toEqual([]);

    storage.saveRecord('todos', { id: 'todo-confirmed', title: 'restored' }, 101);
    storage.removeRecord('todos', 'todo-confirmed', 102);
    storage.clearTombstone('todos', 'todo-confirmed', 101);
    expect(storage.loadTombstones('todos')).toEqual([
      { id: 'todo-confirmed', timestamp: 102 },
    ]);
  });
});
