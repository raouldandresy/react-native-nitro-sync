import type { SyncMutation, SyncRecord, SyncTransport } from 'react-native-nitro-sync';

interface ServerChange {
  readonly version: number;
  readonly tableName: string;
  readonly record?: SyncRecord;
  readonly tombstone?: { readonly id: string; readonly timestamp: number };
}

const serverRecords = new Map<string, SyncRecord>();
const processedMutationIds = new Set<string>();
const changes: ServerChange[] = [];
let currentServerVersion = 0;
let failNextRequest = false;

export function failNextSync(): void {
  failNextRequest = true;
}

export function getMockServerSnapshot(): {
  readonly version: number;
  readonly recordCount: number;
  readonly processedMutationCount: number;
} {
  return {
    version: currentServerVersion,
    recordCount: serverRecords.size,
    processedMutationCount: processedMutationIds.size,
  };
}

export const transport: SyncTransport = {
  async pushAndPull<T extends SyncRecord>(
    tableName: string,
    mutations: readonly SyncMutation<T>[],
    _lastSyncedAt: number | null,
    serverCursor?: string | null,
    previousServerVersion?: number | null,
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (failNextRequest) {
      failNextRequest = false;
      throw new Error('Intentional transport failure from example');
    }
    for (const mutation of mutations) {
      if (processedMutationIds.has(mutation.id)) {
        continue;
      }
      processedMutationIds.add(mutation.id);
      currentServerVersion += 1;
      const key = `${mutation.tableName}:${mutation.payload.id}`;
      if (mutation.operation === 'DELETE') {
        serverRecords.delete(key);
        changes.push({
          version: currentServerVersion,
          tableName: mutation.tableName,
          tombstone: { id: mutation.payload.id, timestamp: currentServerVersion },
        });
      } else {
        const record = {
          ...serverRecords.get(key),
          ...mutation.payload,
          updatedAt: currentServerVersion,
        } as T;
        serverRecords.set(key, record);
        changes.push({ version: currentServerVersion, tableName: mutation.tableName, record });
      }
    }
    const afterVersion = serverCursor === undefined || serverCursor === null
      ? previousServerVersion ?? 0
      : Number(serverCursor);
    const pulled = changes.filter((change) => (
      change.version > afterVersion && change.tableName === tableName
    ));
    return {
      protocolVersion: 1,
      records: pulled
        .filter((change) => change.record !== undefined)
        .map((change) => change.record as T),
      tombstones: pulled
        .filter((change) => change.tombstone !== undefined)
        .map((change) => change.tombstone as { readonly id: string; readonly timestamp: number }),
      acknowledgedMutationIds: mutations.map((mutation) => mutation.id),
      serverTimestamp: Date.now(),
      serverCursor: String(currentServerVersion),
      serverVersion: currentServerVersion,
    };
  },
};
