import type {
  JsonObject,
  JsonValue,
  SyncConflictResolver,
  SyncConflictStrategy,
  SyncMutation,
  SyncRecord,
  SyncTombstone,
} from './types';

export function createSyncId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `nitro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function recordIdFromPayload(payload: SyncRecord, fallbackId?: string): string {
  if (typeof payload.id === 'string' && payload.id.length > 0) {
    return payload.id;
  }
  if (typeof fallbackId === 'string' && fallbackId.length > 0) {
    return fallbackId;
  }
  return createSyncId();
}

export function timestampOf(record: SyncRecord): number {
  const updatedAt = record.updatedAt;
  if (typeof updatedAt === 'number') {
    return updatedAt;
  }
  const snake = record.updated_at;
  if (typeof snake === 'number') {
    return snake;
  }
  return 0;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeJsonValue(local: JsonValue, remote: JsonValue): JsonValue {
  if (!isJsonObject(local) || !isJsonObject(remote)) {
    return remote;
  }
  const merged: Record<string, JsonValue> = { ...local };
  for (const [key, remoteValue] of Object.entries(remote)) {
    const localValue = local[key];
    merged[key] = localValue === undefined
      ? remoteValue
      : mergeJsonValue(localValue, remoteValue);
  }
  return merged;
}

export function resolveConflict<T extends SyncRecord>(
  local: T,
  remote: T,
  strategy: SyncConflictStrategy | SyncConflictResolver<T> = 'last-write-wins',
  mutation?: SyncMutation<T>,
): T {
  if (typeof strategy === 'function') {
    return strategy(local, remote, mutation);
  }

  switch (strategy) {
    case 'server-wins':
      return remote;
    case 'client-wins':
      return local;
    case 'merge-fields': {
      return mergeJsonValue(local, remote) as T;
    }
    case 'lww':
    case 'last-write-wins':
    default: {
      const remoteTimestamp = timestampOf(remote);
      const localTimestamp = timestampOf(local);
      if (remoteTimestamp === 0 && localTimestamp === 0) {
        return remote;
      }
      return remoteTimestamp >= localTimestamp ? remote : local;
    }
  }
}

export function mergePulledRecords<T extends SyncRecord>(
  local: readonly T[],
  remote: readonly T[],
  unacked: readonly SyncMutation<T>[],
  strategy: SyncConflictStrategy | SyncConflictResolver<T> = 'last-write-wins',
  tombstones: readonly SyncTombstone[] = [],
): T[] {
  const protectedIds = new Set<string>();
  for (const mutation of unacked) {
    const id = mutation.payload.id;
    if (typeof id === 'string') {
      protectedIds.add(id);
    }
  }

  const tombstoneTimestamps = new Map(tombstones.map(({ id, timestamp }) => [id, timestamp]));
  const merged = new Map<string, T>();
  for (const record of local) {
    const tombstoneTimestamp = tombstoneTimestamps.get(record.id);
    if (
      !protectedIds.has(record.id) &&
      tombstoneTimestamp !== undefined &&
      timestampOf(record) <= tombstoneTimestamp
    ) {
      continue;
    }
    merged.set(record.id, record);
  }

  for (const record of remote) {
    if (protectedIds.has(record.id)) {
      continue;
    }
    const tombstoneTimestamp = tombstoneTimestamps.get(record.id);
    if (tombstoneTimestamp !== undefined && timestampOf(record) <= tombstoneTimestamp) {
      continue;
    }
    const current = merged.get(record.id);
    if (current === undefined) {
      merged.set(record.id, record);
      continue;
    }
    const resolved = resolveConflict(current, record, strategy);
    if (resolved.id !== record.id) {
      throw new Error(`Conflict resolver changed immutable record ID "${record.id}"`);
    }
    merged.set(record.id, resolved);
  }

  return [...merged.values()] as T[];
}

export function parseSerializedMutation(serialized: string): SyncMutation<SyncRecord> {
  const raw = JSON.parse(serialized) as {
    readonly id: string;
    readonly tableName: string;
    readonly operation: 'CREATE' | 'UPDATE' | 'DELETE';
    readonly payload: string | SyncRecord;
    readonly timestamp: number;
    readonly schemaVersion?: number;
  };
  const payload = typeof raw.payload === 'string'
    ? JSON.parse(raw.payload) as SyncRecord
    : raw.payload;
  return {
    id: raw.id,
    tableName: raw.tableName,
    operation: raw.operation,
    payload,
    timestamp: raw.timestamp,
    schemaVersion: raw.schemaVersion !== undefined &&
      Number.isSafeInteger(raw.schemaVersion) &&
      raw.schemaVersion > 0
      ? raw.schemaVersion
      : 1,
  };
}

export function parseSerializedRecord(serialized: string): SyncRecord | null {
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return typeof record.id === 'string' ? record as SyncRecord : null;
}

export function parseSerializedTombstone(serialized: string): SyncTombstone | null {
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const tombstone = parsed as Record<string, unknown>;
  return typeof tombstone.id === 'string' && typeof tombstone.timestamp === 'number'
    ? { id: tombstone.id, timestamp: tombstone.timestamp }
    : null;
}
