import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SyncContext, type SyncContextValue } from './context';
import {
  createSyncId,
  mergePulledRecords,
  parseSerializedMutation,
  parseSerializedRecord,
  parseSerializedTombstone,
  recordIdFromPayload,
  timestampOf,
} from './merge';
import { failSyncMutations, partitionSyncMutations, settleSyncMutations } from './mutationSettlement';
import { getNitroSync } from './native';
import { buildSyncRequestPayload, normalizeSyncResponse } from './protocol';
import {
  createDeviceId,
  createSyncStorage,
  readSyncDeviceId,
  readSyncLastSyncedAt,
  readSyncServerCursor,
  readSyncServerVersion,
  writeSyncDeviceId,
  writeSyncLastSyncedAt,
  writeSyncServerCursor,
  writeSyncServerVersion,
} from './storage';
import type { NitroSyncConfig, SyncMutation, SyncRecord, SyncStatus, SyncTransport } from './types';

export interface NitroSyncProviderProps {
  readonly config: NitroSyncConfig;
  readonly children: React.ReactNode;
}

function createConfiguredTransport(config: NitroSyncConfig): SyncTransport | undefined {
  if (config.transport !== undefined || config.endpoint === undefined) {
    return config.transport;
  }
  return {
    async pushAndPull<T extends SyncRecord>(
      tableName: string,
      mutations: readonly SyncMutation<T>[],
      lastSyncedAt: number | null,
      serverCursor?: string | null,
      serverVersion?: number | null,
      deviceId?: string,
    ) {
  const response = await fetch(config.endpoint as string, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.authToken === undefined ? {} : { Authorization: `Bearer ${config.authToken}` }),
    },
    body: JSON.stringify(buildSyncRequestPayload(
      tableName,
      mutations,
      lastSyncedAt,
      serverCursor,
      serverVersion,
      deviceId,
    )),
  });
  if (!response.ok) {
    throw new Error(`Synchronization request failed with HTTP ${response.status}`);
  }
  return await response.json() as {
    readonly protocolVersion?: number;
    readonly records?: readonly T[];
    readonly tombstones?: readonly { readonly id: string; readonly timestamp: number }[];
    readonly acknowledgedMutationIds?: readonly string[];
    readonly rejectedMutations?: readonly {
      readonly mutationId: string;
      readonly code: string;
      readonly message?: string;
      readonly retryable?: boolean;
    }[];
    readonly serverTimestamp?: number;
    readonly serverCursor?: string | null;
    readonly serverVersion?: number | null;
  };
    },
  };
}

function groupMutationsByTable(
  mutations: readonly SyncMutation<SyncRecord>[],
): Map<string, SyncMutation<SyncRecord>[]> {
  const grouped = new Map<string, SyncMutation<SyncRecord>[]>();
  for (const mutation of mutations) {
    const existing = grouped.get(mutation.tableName);
    if (existing === undefined) {
      grouped.set(mutation.tableName, [mutation]);
    } else {
      existing.push(mutation);
    }
  }
  return grouped;
}

export function NitroSyncProvider({ config, children }: NitroSyncProviderProps): React.JSX.Element {
  const [records, setRecords] = useState<Record<string, SyncRecord[]>>({});
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const recordsRef = useRef(records);
  const lastSyncedAtRef = useRef(lastSyncedAt);
  const serverCursorsRef = useRef(new Map<string, string | null>());
  const serverVersionsRef = useRef(new Map<string, number | null>());
  const deviceIdRef = useRef(config.deviceId ?? createDeviceId());
  const fallbackMutationsRef = useRef<SyncMutation<SyncRecord>[]>([]);
  const syncChainRef = useRef(Promise.resolve());
  recordsRef.current = records;
  lastSyncedAtRef.current = lastSyncedAt;
  const transport = useMemo(() => createConfiguredTransport(config), [config]);
  const storage = useMemo(() => {
    if (config.storage !== undefined) return config.storage;
    if (config.sqliteDatabase === undefined) return null;
    return createSyncStorage(config.sqliteDatabase, config.metadataStore);
  }, [config.metadataStore, config.sqliteDatabase, config.storage]);

  // Schema/engine initialization must complete before any child renders, because
  // React fires child `useEffect`s (e.g. `useSyncCollection`'s `ensureTable`) before
  // this provider's own effects on mount. Running it inside `useMemo` guarantees it
  // executes synchronously during render, ahead of any child querying the database.
  // Both calls are idempotent (`CREATE TABLE IF NOT EXISTS`, re-opening the same
  // native connection), so re-running them if dependencies change is safe.
  useMemo(() => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    nativeEngine?.initialize(config.databaseName ?? 'nitro-sync.db');
    storage?.initialize();
  }, [config.databaseName, config.nativeEngine, storage]);

  useEffect(() => {
    const storedLastSyncedAt = storage?.getLastSyncedAt() ?? readSyncLastSyncedAt(config.metadataStore);
    setLastSyncedAt(storedLastSyncedAt);
    const storedDeviceId = storage?.getDeviceId() ?? readSyncDeviceId(config.metadataStore);
    if (storedDeviceId === null) {
      if (storage !== null) {
        storage.setDeviceId(deviceIdRef.current);
      } else {
        writeSyncDeviceId(config.metadataStore, deviceIdRef.current);
      }
    } else {
      deviceIdRef.current = storedDeviceId;
    }
  }, [config.databaseName, config.deviceId, config.metadataStore, config.nativeEngine, storage]);

  const loadStoredRecords = useCallback((tableName: string): SyncRecord[] => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    if (nativeEngine !== null && nativeEngine !== undefined) {
      return nativeEngine.readRecords(tableName)
        .map(parseSerializedRecord)
        .filter((record): record is SyncRecord => record !== null);
    }
    return [...(storage?.loadRecords(tableName) ?? [])];
  }, [config.nativeEngine, storage]);

  const loadStoredTombstones = useCallback((tableName: string) => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    if (nativeEngine !== null && nativeEngine !== undefined) {
      return nativeEngine.readTombstones(tableName)
        .map(parseSerializedTombstone)
        .filter((tombstone): tombstone is NonNullable<typeof tombstone> => tombstone !== null);
    }
    return [...(storage?.loadTombstones(tableName) ?? [])];
  }, [config.nativeEngine, storage]);

  const persistRecord = useCallback((tableName: string, record: SyncRecord, timestamp: number, isDelete: boolean) => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    if (nativeEngine !== null && nativeEngine !== undefined) {
      if (isDelete) {
        nativeEngine.deleteRecord(tableName, record.id, timestamp);
      } else {
        nativeEngine.upsertRecord(tableName, record.id, JSON.stringify(record), timestamp);
      }
      return;
    }
    if (isDelete) {
      storage?.removeRecord(tableName, record.id, timestamp);
    } else {
      storage?.saveRecord(tableName, record, timestamp);
    }
  }, [config.nativeEngine, storage]);

  const ensureTable = useCallback((tableName: string) => {
    if (recordsRef.current[tableName] !== undefined) {
      return;
    }
    const loaded = loadStoredRecords(tableName);
    setRecords((current) => (
      current[tableName] !== undefined ? current : { ...current, [tableName]: loaded }
    ));
    setVersion((current) => current + 1);
  }, [loadStoredRecords]);

  const sync = useCallback(async (requestedTableName?: string): Promise<void> => {
    if (transport === undefined) {
      return;
    }

    const run = async (): Promise<void> => {
      setStatus('syncing');
      setError(null);
      const nativeEngine = config.nativeEngine ?? getNitroSync();
      const usesNative = nativeEngine !== null && nativeEngine !== undefined;
      let claimed: SyncMutation<SyncRecord>[] = [];
      const rejectionMessages: string[] = [];
      const unackedIds = new Set<string>();
      const markFailed = (mutationId: string): void => {
        if (usesNative) {
          nativeEngine.markMutationFailed(mutationId);
        } else {
          storage?.markMutationFailed(mutationId);
        }
      };
      const markRejected = (mutationId: string): void => {
        if (usesNative) {
          nativeEngine.markMutationRejected(mutationId);
        } else {
          storage?.markMutationRejected(mutationId);
        }
      };
      const markPending = (mutationId: string): void => {
        if (usesNative) {
          nativeEngine.markMutationPending(mutationId);
        } else {
          storage?.markMutationPending(mutationId);
        }
      };
      try {
        if (usesNative) {
          claimed = nativeEngine.listPendingMutations(100).map(parseSerializedMutation);
        } else if (storage !== null) {
          claimed = [...storage.listPendingMutations(100)];
        } else {
          claimed = [...fallbackMutationsRef.current];
        }
        for (const mutation of claimed) {
          unackedIds.add(mutation.id);
        }

        if (requestedTableName !== undefined && (usesNative || storage !== null)) {
          for (const mutation of claimed) {
            if (mutation.tableName !== requestedTableName) {
              markPending(mutation.id);
              unackedIds.delete(mutation.id);
            }
          }
          claimed = claimed.filter((mutation) => mutation.tableName === requestedTableName);
        }

        const grouped = groupMutationsByTable(claimed);
        const tables = requestedTableName === undefined
          ? [...new Set([...Object.keys(recordsRef.current), ...grouped.keys()])]
          : [requestedTableName];

        for (const tableName of tables) {
          if (recordsRef.current[tableName] === undefined) {
            const storedRecords = loadStoredRecords(tableName);
            setRecords((current) => ({ ...current, [tableName]: storedRecords }));
            recordsRef.current = { ...recordsRef.current, [tableName]: storedRecords };
          }
          const mutations = grouped.get(tableName) ?? [];
          const serverCursor = serverCursorsRef.current.has(tableName)
            ? serverCursorsRef.current.get(tableName) ?? null
            : storage?.getServerCursor(tableName) ?? readSyncServerCursor(config.metadataStore, tableName);
          const serverVersion = serverVersionsRef.current.has(tableName)
            ? serverVersionsRef.current.get(tableName) ?? null
            : storage?.getServerVersion(tableName) ?? readSyncServerVersion(config.metadataStore, tableName);
          const response = normalizeSyncResponse(await transport.pushAndPull<SyncRecord>(
            tableName,
            mutations,
            lastSyncedAtRef.current,
            serverCursor,
            serverVersion,
            deviceIdRef.current,
          ));
          const settlement = partitionSyncMutations(
            mutations,
            response.acknowledgedMutationIds ?? [],
            response.rejectedMutations ?? [],
          );
          const acknowledged = new Set(settlement.acknowledged.map((mutation) => mutation.id));
          const unacked = mutations.filter((mutation) => !acknowledged.has(mutation.id));
          const serverRecords = response.records;
          const serverTimestamp = response.serverTimestamp ?? Date.now();
          const localTombstones = loadStoredTombstones(tableName);
          const serverTombstones = response.tombstones ?? [];
          const tombstonesById = new Map<string, { id: string; timestamp: number }>();
          for (const tombstone of [...localTombstones, ...serverTombstones]) {
            const existing = tombstonesById.get(tombstone.id);
            if (existing === undefined || tombstone.timestamp > existing.timestamp) {
              tombstonesById.set(tombstone.id, tombstone);
            }
          }
          const tombstones = [...tombstonesById.values()];
          if (serverRecords !== undefined || serverTombstones.length > 0) {
            const merged = mergePulledRecords(
              recordsRef.current[tableName] ?? [],
              serverRecords ?? [],
              unacked,
              config.conflictStrategy ?? 'last-write-wins',
              tombstones,
            );
            recordsRef.current = { ...recordsRef.current, [tableName]: merged };
            setRecords((current) => ({ ...current, [tableName]: merged }));
            const protectedIds = new Set(
              unacked
                .map((mutation) => mutation.payload.id)
                .filter((id): id is string => typeof id === 'string'),
            );
            const mergedById = new Map(merged.map((record) => [record.id, record]));
            const tombstoneTimestamps = new Map(tombstones.map(({ id, timestamp }) => [id, timestamp]));
            for (const record of serverRecords ?? []) {
              const resolved = mergedById.get(record.id);
              if (!protectedIds.has(record.id) && resolved !== undefined) {
                const tombstoneTimestamp = tombstoneTimestamps.get(record.id);
                const timestamp = tombstoneTimestamp === undefined
                  ? serverTimestamp
                  : Math.max(serverTimestamp, timestampOf(record), tombstoneTimestamp + 1);
                persistRecord(tableName, resolved, timestamp, false);
              }
            }
            for (const tombstone of serverTombstones) {
              if (!protectedIds.has(tombstone.id)) {
                persistRecord(tableName, { id: tombstone.id }, tombstone.timestamp, true);
              }
            }
          }
          settleSyncMutations(settlement, {
            acknowledge: (mutation) => {
              if (usesNative) {
                nativeEngine.removeMutation(mutation.id);
                if (mutation.operation === 'DELETE' && typeof mutation.payload.id === 'string') {
                  nativeEngine.clearTombstone(
                    tableName,
                    mutation.payload.id,
                    mutation.timestamp,
                  );
                }
              } else {
                storage?.removeMutation(mutation.id);
                if (mutation.operation === 'DELETE' && typeof mutation.payload.id === 'string') {
                  storage?.clearTombstone(tableName, mutation.payload.id, mutation.timestamp);
                }
              }
              unackedIds.delete(mutation.id);
            },
            retry: (mutation) => {
              if (usesNative || storage !== null) {
                markFailed(mutation.id);
              }
              unackedIds.delete(mutation.id);
            },
            reject: (mutation) => {
              markRejected(mutation.id);
              unackedIds.delete(mutation.id);
            },
          });
          if (!usesNative && storage === null) {
            const settledIds = new Set([
              ...acknowledged,
              ...settlement.rejected.map((mutation) => mutation.id),
            ]);
            fallbackMutationsRef.current = fallbackMutationsRef.current.filter(
              (mutation) => !settledIds.has(mutation.id),
            );
          }
          if (response.serverCursor !== undefined) {
            if (storage !== null) {
              storage.setServerCursor(tableName, response.serverCursor);
            } else {
              writeSyncServerCursor(config.metadataStore, tableName, response.serverCursor);
            }
            serverCursorsRef.current.set(tableName, response.serverCursor);
          }
          if (response.serverVersion !== undefined) {
            if (storage !== null) {
              storage.setServerVersion(tableName, response.serverVersion);
            } else {
              writeSyncServerVersion(config.metadataStore, tableName, response.serverVersion);
            }
            serverVersionsRef.current.set(tableName, response.serverVersion);
          }
          const rejectionErrors = (response.rejectedMutations ?? [])
            .filter((rejection) => (
              settlement.rejected.some((mutation) => mutation.id === rejection.mutationId) ||
              settlement.unacknowledged.some((mutation) => mutation.id === rejection.mutationId)
            ))
            .map((rejection) => (
              `${rejection.mutationId}: ${rejection.code}${rejection.message === undefined ? '' : ` (${rejection.message})`}`
            ));
          if (rejectionErrors.length > 0) {
            rejectionMessages.push(...rejectionErrors);
          }
        }
        if (rejectionMessages.length > 0) {
          setError(new Error(`Server rejected mutations: ${rejectionMessages.join('; ')}`));
          setStatus('error');
        } else {
          setStatus('idle');
        }
        const syncedAt = Date.now();
        lastSyncedAtRef.current = syncedAt;
        setLastSyncedAt(syncedAt);
        if (storage !== null) {
          storage.setLastSyncedAt(syncedAt);
        } else {
          writeSyncLastSyncedAt(config.metadataStore, syncedAt);
        }
        setVersion((current) => current + 1);
      } catch (caughtError) {
        if (usesNative || storage !== null) {
          failSyncMutations(
            claimed.filter((mutation) => unackedIds.has(mutation.id)),
            (mutation) => markFailed(mutation.id),
          );
        }
        const nextError = caughtError instanceof Error ? caughtError : new Error('Synchronization failed');
        setError(nextError);
        setStatus('error');
      }
    };

    const next = syncChainRef.current.then(run, run);
    syncChainRef.current = next.then(() => undefined, () => undefined);
    await next;
  }, [config, loadStoredRecords, loadStoredTombstones, persistRecord, storage, transport]);

  useEffect(() => {
    const interval = config.pollingIntervalMs ?? 0;
    if (interval <= 0 || transport === undefined) {
      return undefined;
    }
    const timer = setInterval(() => {
      void sync();
    }, interval);
    return () => clearInterval(timer);
  }, [config.pollingIntervalMs, sync, transport]);

  const getRecords = useCallback((tableName: string): readonly SyncRecord[] => {
    return recordsRef.current[tableName] ?? [];
  }, []);

  const mutate = useCallback<SyncContextValue['mutate']>((mutation) => {
    const schemaVersion = config.schemaVersions?.[mutation.tableName] ?? 1;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
      throw new Error(`Schema version for "${mutation.tableName}" must be a positive safe integer`);
    }
    const mutationId = createSyncId();
    const recordId = recordIdFromPayload(mutation.payload, mutation.id);
    const timestamp = Date.now();
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    const usesNative = nativeEngine !== null && nativeEngine !== undefined;
    const payload = { ...mutation.payload, id: recordId };
    const existing = recordsRef.current[mutation.tableName] ?? [];
    const previousRecord = existing.find((record) => record.id === recordId);
    const withoutRecord = existing.filter((record) => record.id !== recordId);
    const nextTable = mutation.operation === 'DELETE'
      ? withoutRecord
      : [
        ...withoutRecord,
        mutation.operation === 'UPDATE'
          ? { ...previousRecord, ...payload, id: recordId }
          : payload,
      ];
    recordsRef.current = { ...recordsRef.current, [mutation.tableName]: nextTable };
    setRecords((current) => ({ ...current, [mutation.tableName]: nextTable }));

    const persistedRecord = mutation.operation === 'UPDATE'
      ? { ...previousRecord, ...payload, id: recordId }
      : payload;
    const queuePayload = mutation.operation === 'DELETE' ? payload : persistedRecord;
    const nextMutation: SyncMutation<SyncRecord> = {
      id: mutationId,
      tableName: mutation.tableName,
      operation: mutation.operation,
      payload: queuePayload,
      timestamp,
      schemaVersion,
    };

    if (usesNative) {
      nativeEngine.enqueueMutation(
        mutationId,
        mutation.tableName,
        mutation.operation,
        JSON.stringify(queuePayload),
        timestamp,
        schemaVersion,
      );
    } else if (storage !== null) {
      storage.saveMutation(nextMutation);
    } else {
      fallbackMutationsRef.current = [
        ...fallbackMutationsRef.current.filter((mutation) => mutation.id !== nextMutation.id),
        nextMutation,
      ];
    }

    persistRecord(
      mutation.tableName,
      persistedRecord,
      timestamp,
      mutation.operation === 'DELETE',
    );
    setVersion((current) => current + 1);
    return recordId;
  }, [config.nativeEngine, config.schemaVersions, persistRecord, storage]);

  const value = useMemo<SyncContextValue>(() => ({
    config,
    status,
    error,
    lastSyncedAt,
    version,
    ensureTable,
    getRecords,
    mutate,
    sync,
  }), [config, ensureTable, error, getRecords, lastSyncedAt, mutate, status, sync, version]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
