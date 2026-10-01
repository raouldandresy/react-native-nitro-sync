import { createSyncId, parseSerializedRecord } from './merge';
import type { JsonObject, SyncMutation, SyncRecord, SyncTombstone } from './types';

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
  readonly loadTombstones: (tableName: string) => readonly SyncTombstone[];
  readonly clearTombstone: (tableName: string, recordId: string, throughTimestamp: number) => void;
  readonly applyMutation: (
    mutation: SyncMutation<SyncRecord>,
    record: SyncRecord,
    deleted: boolean,
  ) => void;
  readonly saveMutation: (mutation: SyncMutation<SyncRecord>) => void;
  readonly listPendingMutations: (limit: number, tableName?: string) => readonly SyncMutation<SyncRecord>[];
  readonly listRejectedMutations: (tableName: string) => readonly RejectedSyncMutation[];
  readonly markMutationFailed: (id: string) => void;
  readonly markMutationRejected: (id: string, code: string, message: string) => void;
  readonly retryRejectedMutation: (id: string) => void;
  readonly discardRejectedMutation: (id: string) => void;
  readonly markMutationPending: (id: string) => void;
  readonly recoverStuckMutations: () => void;
  readonly removeMutation: (id: string) => void;
  readonly saveRecord: (tableName: string, record: SyncRecord, timestamp: number) => void;
  readonly removeRecord: (tableName: string, recordId: string, timestamp: number) => void;
  readonly getLastSyncedAt: () => number | null;
  readonly setLastSyncedAt: (timestamp: number) => void;
  readonly getServerCursor: (tableName: string) => string | null;
  readonly setServerCursor: (tableName: string, cursor: string | null) => void;
  readonly getServerVersion: (tableName: string) => number | null;
  readonly setServerVersion: (tableName: string, version: number | null) => void;
  readonly getDeviceId: () => string | null;
  readonly setDeviceId: (deviceId: string) => void;
}

export interface RejectedSyncMutation {
  readonly mutation: SyncMutation<SyncRecord>;
  readonly code: string;
  readonly message: string;
}

const QUEUE_SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  `CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY NOT NULL,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    timestamp INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'FAILED', 'REJECTED')),
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
const SERVER_CURSOR_KEY = 'nitro_sync.server_cursor.';
const SERVER_VERSION_KEY = 'nitro_sync.server_version.';
const CURRENT_SCHEMA_VERSION = 5;
const RETRY_DELAY_SQL = `CASE retry_count
  WHEN 0 THEN 1000
  WHEN 1 THEN 2000
  WHEN 2 THEN 4000
  WHEN 3 THEN 8000
  WHEN 4 THEN 16000
  WHEN 5 THEN 32000
  WHEN 6 THEN 64000
  WHEN 7 THEN 128000
  WHEN 8 THEN 256000
  ELSE 300000
END`;

export function readSyncLastSyncedAt(metadataStore?: SyncMetadataStore): number | null {
  const value = metadataStore?.getString(LAST_SYNCED_AT_KEY);
  if (value === undefined || value.length === 0) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function writeSyncLastSyncedAt(metadataStore: SyncMetadataStore | undefined, timestamp: number): void {
  metadataStore?.set(LAST_SYNCED_AT_KEY, String(timestamp));
}

export function readSyncDeviceId(metadataStore?: SyncMetadataStore): string | null {
  return metadataStore?.getString(DEVICE_ID_KEY) ?? null;
}

export function writeSyncDeviceId(metadataStore: SyncMetadataStore | undefined, deviceId: string): void {
  metadataStore?.set(DEVICE_ID_KEY, deviceId);
}

export function readSyncServerCursor(metadataStore: SyncMetadataStore | undefined, tableName: string): string | null {
  const value = metadataStore?.getString(`${SERVER_CURSOR_KEY}${encodeURIComponent(tableName)}`);
  return value === undefined || value.length === 0 ? null : value;
}

export function writeSyncServerCursor(
  metadataStore: SyncMetadataStore | undefined,
  tableName: string,
  cursor: string | null,
): void {
  metadataStore?.set(`${SERVER_CURSOR_KEY}${encodeURIComponent(tableName)}`, cursor ?? '');
}

export function readSyncServerVersion(metadataStore: SyncMetadataStore | undefined, tableName: string): number | null {
  const value = metadataStore?.getString(`${SERVER_VERSION_KEY}${encodeURIComponent(tableName)}`);
  if (value === undefined || value.length === 0) return null;
  const version = Number(value);
  return Number.isFinite(version) ? version : null;
}

export function writeSyncServerVersion(
  metadataStore: SyncMetadataStore | undefined,
  tableName: string,
  version: number | null,
): void {
  metadataStore?.set(`${SERVER_VERSION_KEY}${encodeURIComponent(tableName)}`, version === null ? '' : String(version));
}

function rowsFrom(result: SqliteResult): readonly JsonObject[] {
  return result.rows ?? [];
}

function toRecord(row: JsonObject): SyncRecord | null {
  const payload = row.payload;
  if (typeof payload !== 'string') return null;
  return parseSerializedRecord(payload);
}

export function createSyncStorage(
  database: SyncSqliteDatabase,
  metadataStore?: SyncMetadataStore,
): SyncStorage {
  return {
    initialize: () => {
      for (const statement of QUEUE_SCHEMA) database.executeSync(statement);
      const versionRow = rowsFrom(database.executeSync('PRAGMA user_version'))[0];
      const storedVersion = typeof versionRow?.user_version === 'number'
        ? versionRow.user_version
        : 0;
      if (storedVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `Database schema version ${storedVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
        );
      }
      if (storedVersion < 1) {
        database.executeSync('PRAGMA user_version = 1');
      }
      if (storedVersion < 2) {
        database.executeSync(
          'CREATE INDEX IF NOT EXISTS sync_records_deleted_updated_at ON sync_records(table_name, deleted, updated_at)',
        );
        database.executeSync('PRAGMA user_version = 2');
      }
      if (storedVersion < 3) {
        database.executeSync('BEGIN IMMEDIATE TRANSACTION');
        try {
          database.executeSync('DROP INDEX IF EXISTS sync_queue_status_timestamp');
          database.executeSync(`CREATE TABLE sync_queue_v3 (
            id TEXT PRIMARY KEY NOT NULL,
            table_name TEXT NOT NULL,
            operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
            payload TEXT NOT NULL CHECK (json_valid(payload)),
            timestamp INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'FAILED', 'REJECTED')),
            retry_count INTEGER NOT NULL DEFAULT 0
          )`);
          database.executeSync(`INSERT INTO sync_queue_v3
            (id, table_name, operation, payload, timestamp, status, retry_count)
            SELECT id, table_name, operation, payload, timestamp, status, retry_count FROM sync_queue`);
          database.executeSync('DROP TABLE sync_queue');
          database.executeSync('ALTER TABLE sync_queue_v3 RENAME TO sync_queue');
          database.executeSync('CREATE INDEX sync_queue_status_timestamp ON sync_queue(status, timestamp)');
          database.executeSync('PRAGMA user_version = 3');
          database.executeSync('COMMIT');
        } catch (error) {
          database.executeSync('ROLLBACK');
          throw error;
        }
      }
      if (storedVersion < 4) {
        database.executeSync('BEGIN IMMEDIATE TRANSACTION');
        try {
          database.executeSync(
            'ALTER TABLE sync_queue ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1',
          );
          database.executeSync('PRAGMA user_version = 4');
          database.executeSync('COMMIT');
        } catch (error) {
          database.executeSync('ROLLBACK');
          throw error;
        }
      }
      if (storedVersion < 5) {
        database.executeSync('BEGIN IMMEDIATE TRANSACTION');
        try {
          database.executeSync('ALTER TABLE sync_queue ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0');
          database.executeSync('ALTER TABLE sync_queue ADD COLUMN rejection_code TEXT');
          database.executeSync('ALTER TABLE sync_queue ADD COLUMN rejection_message TEXT');
          database.executeSync('PRAGMA user_version = 5');
          database.executeSync('COMMIT');
        } catch (error) {
          database.executeSync('ROLLBACK');
          throw error;
        }
      }
      database.executeSync("UPDATE sync_queue SET status = 'PENDING' WHERE status = 'SYNCING'");
    },
    loadRecords: (tableName) => rowsFrom(database.executeSync(
      'SELECT payload FROM sync_records WHERE table_name = ? AND deleted = 0 ORDER BY updated_at ASC',
      [tableName],
    )).map(toRecord).filter((record): record is SyncRecord => record !== null),
    loadTombstones: (tableName) => rowsFrom(database.executeSync(
      'SELECT record_id, updated_at FROM sync_records WHERE table_name = ? AND deleted = 1 ORDER BY updated_at ASC',
      [tableName],
    )).filter((row): row is JsonObject & { record_id: string; updated_at: number } => (
      typeof row.record_id === 'string' && typeof row.updated_at === 'number'
    )).map((row) => ({ id: row.record_id, timestamp: row.updated_at })),
    clearTombstone: (tableName, recordId, throughTimestamp) => {
      database.executeSync(
        'DELETE FROM sync_records WHERE table_name = ? AND record_id = ? AND deleted = 1 AND updated_at <= ?',
        [tableName, recordId, throughTimestamp],
      );
    },
    saveMutation: (mutation) => {
      database.executeSync(
        `INSERT INTO sync_queue
          (id, table_name, operation, payload, timestamp, status, retry_count, schema_version)
          VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)
          ON CONFLICT(id) DO NOTHING`,
        [
          mutation.id,
          mutation.tableName,
          mutation.operation,
          JSON.stringify(mutation.payload),
          mutation.timestamp,
          mutation.schemaVersion ?? 1,
        ],
      );
    },
    applyMutation: (mutation, record, deleted) => {
      database.executeSync('BEGIN IMMEDIATE TRANSACTION');
      try {
        database.executeSync(
          `INSERT INTO sync_queue
            (id, table_name, operation, payload, timestamp, status, retry_count, schema_version)
            VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)
            ON CONFLICT(id) DO NOTHING`,
          [
            mutation.id,
            mutation.tableName,
            mutation.operation,
            JSON.stringify(mutation.payload),
            mutation.timestamp,
            mutation.schemaVersion ?? 1,
          ],
        );
        if (deleted) {
          database.executeSync(
            `INSERT INTO sync_records(table_name, record_id, payload, updated_at, deleted)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(table_name, record_id) DO UPDATE SET
               updated_at = excluded.updated_at, deleted = 1
             WHERE excluded.updated_at >= sync_records.updated_at`,
            [mutation.tableName, record.id, JSON.stringify({ id: record.id }), mutation.timestamp],
          );
        } else {
          database.executeSync(
            `INSERT INTO sync_records(table_name, record_id, payload, updated_at, deleted)
             VALUES (?, ?, ?, ?, 0)
             ON CONFLICT(table_name, record_id) DO UPDATE SET
               payload = excluded.payload, updated_at = excluded.updated_at, deleted = 0
             WHERE excluded.updated_at >= sync_records.updated_at`,
            [mutation.tableName, record.id, JSON.stringify(record), mutation.timestamp],
          );
        }
        database.executeSync('COMMIT');
      } catch (error) {
        database.executeSync('ROLLBACK');
        throw error;
      }
    },
    listPendingMutations: (limit, tableName) => {
      database.executeSync('BEGIN IMMEDIATE TRANSACTION');
      try {
        const rows = rowsFrom(database.executeSync(
          `SELECT id, table_name, operation, payload, timestamp, schema_version
           FROM sync_queue
           WHERE status IN ('PENDING', 'FAILED')
             AND next_retry_at <= (strftime('%s', 'now') * 1000)
             ${tableName === undefined ? '' : 'AND table_name = ?'}
           ORDER BY timestamp ASC LIMIT ?`,
          tableName === undefined ? [limit] : [tableName, limit],
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
            schemaVersion: typeof row.schema_version === 'number' ? row.schema_version : 1,
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
    listRejectedMutations: (tableName) => rowsFrom(database.executeSync(
      `SELECT id, table_name, operation, payload, timestamp, schema_version,
              rejection_code, rejection_message
       FROM sync_queue WHERE status = 'REJECTED' AND table_name = ?
       ORDER BY timestamp ASC`,
      [tableName],
    )).flatMap((row): RejectedSyncMutation[] => {
      if (
        typeof row.id !== 'string' || typeof row.table_name !== 'string' ||
        typeof row.operation !== 'string' ||
        (row.operation !== 'CREATE' && row.operation !== 'UPDATE' && row.operation !== 'DELETE') ||
        typeof row.payload !== 'string' || typeof row.timestamp !== 'number'
      ) {
        return [];
      }
      const payload = parseSerializedRecord(row.payload);
      if (payload === null) return [];
      return [{
        mutation: {
          id: row.id,
          tableName: row.table_name,
          operation: row.operation,
          payload,
          timestamp: row.timestamp,
          schemaVersion: typeof row.schema_version === 'number' ? row.schema_version : 1,
        },
        code: typeof row.rejection_code === 'string' ? row.rejection_code : 'unknown',
        message: typeof row.rejection_message === 'string' ? row.rejection_message : '',
      }];
    }),
    markMutationFailed: (id) => {
      database.executeSync(
        `UPDATE sync_queue
         SET status = 'FAILED',
             next_retry_at = (strftime('%s', 'now') * 1000) + (${RETRY_DELAY_SQL}),
             retry_count = retry_count + 1
         WHERE id = ?`,
        [id],
      );
    },
    markMutationRejected: (id, code, message) => {
      database.executeSync(
        "UPDATE sync_queue SET status = 'REJECTED', rejection_code = ?, rejection_message = ? WHERE id = ?",
        [code, message, id],
      );
    },
    retryRejectedMutation: (id) => {
      database.executeSync(
        "UPDATE sync_queue SET status = 'PENDING', retry_count = 0, next_retry_at = 0, rejection_code = NULL, rejection_message = NULL WHERE id = ? AND status = 'REJECTED'",
        [id],
      );
    },
    discardRejectedMutation: (id) => {
      database.executeSync(
        "DELETE FROM sync_queue WHERE id = ? AND status = 'REJECTED'",
        [id],
      );
    },
    markMutationPending: (id) => {
      database.executeSync(
        "UPDATE sync_queue SET status = 'PENDING', next_retry_at = 0 WHERE id = ?",
        [id],
      );
    },
    recoverStuckMutations: () => {
      database.executeSync("UPDATE sync_queue SET status = 'PENDING' WHERE status = 'SYNCING'");
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
      return readSyncLastSyncedAt(metadataStore);
    },
    setLastSyncedAt: (timestamp) => writeSyncLastSyncedAt(metadataStore, timestamp),
    getServerCursor: (tableName) => readSyncServerCursor(metadataStore, tableName),
    setServerCursor: (tableName, cursor) => writeSyncServerCursor(metadataStore, tableName, cursor),
    getServerVersion: (tableName) => readSyncServerVersion(metadataStore, tableName),
    setServerVersion: (tableName, version) => writeSyncServerVersion(metadataStore, tableName, version),
    getDeviceId: () => readSyncDeviceId(metadataStore),
    setDeviceId: (deviceId) => writeSyncDeviceId(metadataStore, deviceId),
  };
}

export function createDeviceId(): string {
  return createSyncId();
}
