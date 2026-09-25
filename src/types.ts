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

export interface SyncMutation<T extends JsonObject = JsonObject> {
  readonly id: string;
  readonly tableName: string;
  readonly operation: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly payload: T;
  readonly timestamp: number;
}

export interface SyncTransportResponse<T extends SyncRecord = SyncRecord> {
  readonly records?: readonly T[];
  readonly acknowledgedMutationIds?: readonly string[];
  readonly serverTimestamp?: number;
}

export interface SyncTransport {
  pushAndPull<T extends SyncRecord>(
    tableName: string,
    mutations: readonly SyncMutation<T>[],
    lastSyncedAt: number | null,
  ): Promise<SyncTransportResponse<T>>;
}

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
  readonly conflictStrategy?: 'lww';
}

export type SyncStatus = 'idle' | 'syncing' | 'error';
