import type { NitroSync } from './specs/NitroSync.nitro';
import type { SyncMetadataStore, SyncSqliteDatabase, SyncStorage } from './storage';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SyncRecord extends JsonObject {
  readonly id: string;
}

export interface SyncTombstone {
  readonly id: string;
  readonly timestamp: number;
}

export interface SyncMutationRejection {
  readonly mutationId: string;
  readonly code: string;
  readonly message?: string;
  readonly retryable?: boolean;
}

export interface SyncMutation<T extends JsonObject = JsonObject> {
  readonly id: string;
  readonly tableName: string;
  readonly operation: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly payload: T;
  readonly timestamp: number;
  readonly schemaVersion?: number;
}

export interface SyncTransportResponse<T extends SyncRecord = SyncRecord> {
  readonly protocolVersion?: number;
  readonly records?: readonly T[];
  readonly tombstones?: readonly SyncTombstone[];
  readonly acknowledgedMutationIds?: readonly string[];
  readonly rejectedMutations?: readonly SyncMutationRejection[];
  readonly serverTimestamp?: number;
  readonly serverCursor?: string | null;
  readonly serverVersion?: number | null;
}

export interface SyncTransportRequest {
  readonly protocolVersion: number;
  readonly tableName: string;
  readonly mutations: readonly SyncMutation[];
  readonly deviceId?: string;
  readonly lastSyncedAt: number | null;
  readonly serverCursor?: string | null;
  readonly serverVersion?: number | null;
}

export interface SyncTransport {
  pushAndPull<T extends SyncRecord>(
    tableName: string,
    mutations: readonly SyncMutation<T>[],
    lastSyncedAt: number | null,
    serverCursor?: string | null,
    serverVersion?: number | null,
    deviceId?: string,
  ): Promise<SyncTransportResponse<T>>;
}

export type SyncConflictStrategy = 'lww' | 'last-write-wins' | 'server-wins' | 'client-wins' | 'merge-fields';
export type SyncConflictResolver<T extends SyncRecord = SyncRecord> = (
  local: T,
  remote: T,
  mutation?: SyncMutation<T>,
) => T;

export type SyncMutationStatus = 'PENDING' | 'SYNCING' | 'FAILED' | 'REJECTED' | 'ACKED';
export type SyncMutationEvent =
  | 'ENQUEUED'
  | 'CLAIMED'
  | 'ACKED'
  | 'REJECTED'
  | 'RETRY'
  | 'FAILED'
  | 'RECOVERED';

export interface NitroSyncConfig {
  readonly databaseName?: string;
  readonly endpoint?: string;
  readonly authToken?: string;
  readonly pollingIntervalMs?: number;
  readonly transport?: SyncTransport;
  readonly nativeEngine?: NitroSync;
  readonly storage?: SyncStorage;
  readonly sqliteDatabase?: SyncSqliteDatabase;
  readonly metadataStore?: SyncMetadataStore;
  readonly deviceId?: string;
  readonly conflictStrategy?: SyncConflictStrategy | SyncConflictResolver;
  readonly schemaVersions?: Readonly<Record<string, number>>;
}

export type SyncStatus = 'idle' | 'syncing' | 'error';
