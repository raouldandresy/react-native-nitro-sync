import type { JsonObject, SyncMutation, SyncRecord } from './types';

export type SqliteValue = string | number | null;

export interface SqliteResult {
  readonly rows?: readonly JsonObject[];
}

/** Structural subset shared by OP-SQLite database handles. */
export interface SyncSqliteDatabase {
  readonly executeSync: (sql: string, params?: readonly SqliteValue[]) => SqliteResult;
}

/** Structural subset shared by MMKV instances. */
export interface SyncMetadataStore {
  readonly getString: (key: string) => string | undefined;
  readonly set: (key: string, value: string) => void;
}

export interface SyncStorage {
  readonly initialize: () => void;
  readonly loadRecords: (tableName: string) => readonly SyncRecord[];
  readonly saveMutation: (mutation: SyncMutation<SyncRecord>) => void;
  readonly listPendingMutations: (limit: number) => readonly SyncMutation<SyncRecord>[];
  readonly removeMutation: (id: string) => void;
  readonly saveRecord: (tableName: string, record: SyncRecord, timestamp: number) => void;
  readonly removeRecord: (tableName: string, recordId: string, timestamp: number) => void;
  readonly getLastSyncedAt: () => number | null;
  readonly setLastSyncedAt: (timestamp: number) => void;
  readonly getDeviceId: () => string | null;
  readonly setDeviceId: (deviceId: string) => void;
}

const QUEUE_SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  `CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY NOT NULL,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    timestamp INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'FAILED')),
    retry_count INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS sync_queue_status_timestamp ON sync_queue(status, timestamp)',
  `CREATE TABLE IF NOT EXISTS sync_records (
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (table_name, record_id)
  )`,
];

const LAST_SYNCED_AT_KEY = 'nitro_sync.last_synced_at';
const DEVICE_ID_KEY = 'nitro_sync.device_id';

function rowsFrom(result: SqliteResult): readonly JsonObject[] {
  return result.rows ?? [];
}

function toRecord(row: JsonObject): SyncRecord | null {
  const payload = row.payload;
  if (typeof payload !== 'string') return null;
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return typeof record.id === 'string' ? record as SyncRecord : null;
}

export function createSyncStorage(
  database: SyncSqliteDatabase,
  metadataStore?: SyncMetadataStore,
): SyncStorage {
  return {
    initialize: () => {
      for (const statement of QUEUE_SCHEMA) database.executeSync(statement);
    },
    loadRecords: (tableName) => rowsFrom(database.executeSync(
      'SELECT payload FROM sync_records WHERE table_name = ? AND deleted = 0 ORDER BY updated_at ASC',
      [tableName],
    )).map(toRecord).filter((record): record is SyncRecord => record !== null),
    saveMutation: (mutation) => {
      database.executeSync(
        `INSERT OR REPLACE INTO sync_queue
          (id, table_name, operation, payload, timestamp, status, retry_count)
          VALUES (?, ?, ?, ?, ?, 'PENDING', 0)`,
        [mutation.id, mutation.tableName, mutation.operation, JSON.stringify(mutation.payload), mutation.timestamp],
      );
    },
    listPendingMutations: (limit) => {
      database.executeSync('BEGIN IMMEDIATE TRANSACTION');
      try {
        const rows = rowsFrom(database.executeSync(
          `SELECT id, table_name, operation, payload, timestamp
           FROM sync_queue WHERE status IN ('PENDING', 'FAILED')
           ORDER BY timestamp ASC LIMIT ?`,
          [limit],
        ));
        const mutations = rows.map((row): SyncMutation<SyncRecord> | null => {
          if (typeof row.id !== 'string' || typeof row.table_name !== 'string' || typeof row.operation !== 'string') return null;
          if (row.operation !== 'CREATE' && row.operation !== 'UPDATE' && row.operation !== 'DELETE') return null;
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) as SyncRecord : null;
          return payload === null || typeof row.timestamp !== 'number' ? null : {
            id: row.id,
            tableName: row.table_name,
            operation: row.operation,
            payload,
            timestamp: row.timestamp,
          };
        }).filter((mutation): mutation is SyncMutation<SyncRecord> => mutation !== null);
        for (const mutation of mutations) {
          database.executeSync("UPDATE sync_queue SET status = 'SYNCING' WHERE id = ?", [mutation.id]);
        }
        database.executeSync('COMMIT');
        return mutations;
      } catch (error) {
        database.executeSync('ROLLBACK');
        throw error;
      }
    },
    removeMutation: (id) => {
      database.executeSync('DELETE FROM sync_queue WHERE id = ?', [id]);
    },
    saveRecord: (tableName, record, timestamp) => {
      database.executeSync(
        `INSERT INTO sync_records(table_name, record_id, payload, updated_at, deleted)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(table_name, record_id) DO UPDATE SET
           payload = excluded.payload, updated_at = excluded.updated_at, deleted = 0
         WHERE excluded.updated_at >= sync_records.updated_at`,
        [tableName, record.id, JSON.stringify(record), timestamp],
      );
    },
    removeRecord: (tableName, recordId, timestamp) => {
      database.executeSync(
        `INSERT INTO sync_records(table_name, record_id, payload, updated_at, deleted)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(table_name, record_id) DO UPDATE SET
           updated_at = excluded.updated_at, deleted = 1
         WHERE excluded.updated_at >= sync_records.updated_at`,
        [tableName, recordId, JSON.stringify({ id: recordId }), timestamp],
      );
    },
    getLastSyncedAt: () => {
      const value = metadataStore?.getString(LAST_SYNCED_AT_KEY);
      return value === undefined ? null : Number(value);
    },
    setLastSyncedAt: (timestamp) => metadataStore?.set(LAST_SYNCED_AT_KEY, String(timestamp)),
    getDeviceId: () => metadataStore?.getString(DEVICE_ID_KEY) ?? null,
    setDeviceId: (deviceId) => metadataStore?.set(DEVICE_ID_KEY, deviceId),
  };
}

export function createDeviceId(): string {
  return `nitro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
