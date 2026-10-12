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
import { getNitroSync, getNitroSyncCreationError } from './native';
import { buildSyncRequestPayload, normalizeSyncResponse } from './protocol';
import { runSyncTableWorkers } from './tableWorkers';
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
import type { RejectedSyncMutation } from './storage';

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
    readonly resetRequired?: boolean;
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
    if (nativeEngine === null && storage === null) {
      const nativeError = getNitroSyncCreationError();
      const reason = nativeError instanceof Error ? ` Native module error: ${nativeError.message}` : '';
      throw new Error(
        `NitroSync native storage is unavailable.${reason} Configure a persistent SyncStorage adapter before rendering NitroSyncProvider.`,
      );
    }
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

  const replaceStoredTable = useCallback((
    tableName: string,
    tableRecords: readonly SyncRecord[],
    tableTombstones: readonly { readonly id: string; readonly timestamp: number }[],
    timestamp: number,
  ): void => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    if (nativeEngine !== null && nativeEngine !== undefined) {
      nativeEngine.replaceTable(
        tableName,
        tableRecords.map((record) => JSON.stringify(record)),
        tableTombstones.map((tombstone) => JSON.stringify(tombstone)),
        timestamp,
      );
      return;
    }
    if (storage?.replaceTable === undefined) {
      throw new Error('SyncStorage must implement replaceTable for replacement sync');
    }
    storage.replaceTable(tableName, tableRecords, tableTombstones, timestamp);
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
      const markRejected = (mutationId: string, code: string, message: string): void => {
        if (usesNative) {
          nativeEngine.markMutationRejected(mutationId, code, message);
        } else {
          storage?.markMutationRejected(mutationId, code, message);
        }
      };
      try {
        if (usesNative) {
          claimed = requestedTableName === undefined
            ? nativeEngine.listPendingMutations(100).map(parseSerializedMutation)
            : nativeEngine.listPendingMutationsForTable(requestedTableName, 100).map(parseSerializedMutation);
        } else if (storage !== null) {
          claimed = [...storage.listPendingMutations(100, requestedTableName)];
        } else {
          throw new Error('No persistent NitroSync queue is available');
        }
        for (const mutation of claimed) {
          unackedIds.add(mutation.id);
        }

        const grouped = groupMutationsByTable(claimed);
        const tables = requestedTableName === undefined
          ? [...new Set([...Object.keys(recordsRef.current), ...grouped.keys()])]
          : [requestedTableName];

        const concurrency = config.maxConcurrentTables ?? 4;

        const processTable = async (tableName: string): Promise<Error | null> => {
          const tableMutations = grouped.get(tableName) ?? [];
          try {
            if (recordsRef.current[tableName] === undefined) {
              const storedRecords = loadStoredRecords(tableName);
              setRecords((current) => ({ ...current, [tableName]: storedRecords }));
              recordsRef.current = { ...recordsRef.current, [tableName]: storedRecords };
            }
            const serverCursor = serverCursorsRef.current.has(tableName)
              ? serverCursorsRef.current.get(tableName) ?? null
              : storage?.getServerCursor(tableName) ?? readSyncServerCursor(config.metadataStore, tableName);
            const serverVersion = serverVersionsRef.current.has(tableName)
              ? serverVersionsRef.current.get(tableName) ?? null
              : storage?.getServerVersion(tableName) ?? readSyncServerVersion(config.metadataStore, tableName);
            const response = normalizeSyncResponse(await transport.pushAndPull<SyncRecord>(
              tableName,
              tableMutations,
              lastSyncedAtRef.current,
              serverCursor,
              serverVersion,
              deviceIdRef.current,
            ));
            const settlement = partitionSyncMutations(
              tableMutations,
              response.acknowledgedMutationIds ?? [],
              response.rejectedMutations ?? [],
            );
            const acknowledged = new Set(settlement.acknowledged.map((mutation) => mutation.id));
            const unacked = tableMutations.filter((mutation) => !acknowledged.has(mutation.id));
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
            const resetTombstonesById = new Map<string, { id: string; timestamp: number }>();
            for (const tombstone of serverTombstones) {
              resetTombstonesById.set(tombstone.id, tombstone);
            }
            if (response.resetRequired === true) {
              for (const mutation of unacked) {
                if (mutation.operation !== 'DELETE' || typeof mutation.payload.id !== 'string') {
                  continue;
                }
                const tombstone = {
                  id: mutation.payload.id,
                  timestamp: mutation.timestamp,
                };
                const existing = resetTombstonesById.get(tombstone.id);
                if (existing === undefined || tombstone.timestamp > existing.timestamp) {
                  resetTombstonesById.set(tombstone.id, tombstone);
                }
              }
            }
            const resetTombstones = response.resetRequired === true
              ? [...resetTombstonesById.values()]
              : tombstones;
            if (serverRecords !== undefined || serverTombstones.length > 0) {
              const protectedIds = new Set(
                unacked
                  .map((mutation) => mutation.payload.id)
                  .filter((id): id is string => typeof id === 'string'),
              );
              const localRecords = response.resetRequired === true
                ? (recordsRef.current[tableName] ?? []).filter((record) => protectedIds.has(record.id))
                : recordsRef.current[tableName] ?? [];
              const merged = mergePulledRecords(
                localRecords,
                serverRecords ?? [],
                unacked,
                config.conflictStrategy ?? 'last-write-wins',
                resetTombstones,
              );
              const deletedIds = new Set(
                unacked
                  .filter((mutation) => mutation.operation === 'DELETE')
                  .map((mutation) => mutation.payload.id)
                  .filter((id): id is string => typeof id === 'string'),
              );
              const visibleMerged = merged.filter((record) => !deletedIds.has(record.id));
              if (response.resetRequired === true) {
                replaceStoredTable(tableName, visibleMerged, resetTombstones, serverTimestamp);
              }
              recordsRef.current = { ...recordsRef.current, [tableName]: visibleMerged };
              setRecords((current) => ({ ...current, [tableName]: visibleMerged }));
              const mergedById = new Map(visibleMerged.map((record) => [record.id, record]));
              const tombstoneTimestamps = new Map(tombstones.map(({ id, timestamp }) => [id, timestamp]));
              if (response.resetRequired !== true) {
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
              const rejection = response.rejectedMutations?.find(
                (item) => item.mutationId === mutation.id,
              );
              markRejected(mutation.id, rejection?.code ?? 'rejected', rejection?.message ?? '');
              unackedIds.delete(mutation.id);
            },
          });
          if (response.serverCursor !== undefined || response.resetRequired === true) {
            const nextCursor = response.serverCursor ?? null;
            if (storage !== null) {
              storage.setServerCursor(tableName, nextCursor);
            } else {
              writeSyncServerCursor(config.metadataStore, tableName, nextCursor);
            }
            serverCursorsRef.current.set(tableName, nextCursor);
          }
          if (response.serverVersion !== undefined || response.resetRequired === true) {
            const nextVersion = response.serverVersion ?? null;
            if (storage !== null) {
              storage.setServerVersion(tableName, nextVersion);
            } else {
              writeSyncServerVersion(config.metadataStore, tableName, nextVersion);
            }
            serverVersionsRef.current.set(tableName, nextVersion);
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
            return null;
          } catch (caughtError) {
            failSyncMutations(
              tableMutations.filter((mutation) => unackedIds.has(mutation.id)),
              (mutation) => markFailed(mutation.id),
            );
            return caughtError instanceof Error ? caughtError : new Error(
              `Synchronization failed for table "${tableName}"`,
            );
          }
        };

        const tableErrors = await runSyncTableWorkers(tables, concurrency, processTable);
        if (tableErrors.length > 0) {
          throw new Error(
            `One or more tables failed to synchronize: ${tableErrors.map((error) => error.message).join('; ')}`,
          );
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
  }, [config, loadStoredRecords, loadStoredTombstones, persistRecord, replaceStoredTable, storage, transport]);

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

  const listRejectedMutations = useCallback((tableName: string): readonly RejectedSyncMutation[] => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    if (nativeEngine !== null && nativeEngine !== undefined) {
      return nativeEngine.listRejectedMutations(tableName).map((serialized) => {
        const raw = JSON.parse(serialized) as {
          readonly code?: unknown;
          readonly message?: unknown;
        };
        return {
          mutation: parseSerializedMutation(serialized),
          code: typeof raw.code === 'string' ? raw.code : 'unknown',
          message: typeof raw.message === 'string' ? raw.message : '',
        };
      });
    }
    return storage?.listRejectedMutations(tableName) ?? [];
  }, [config.nativeEngine, storage]);

  const retryRejectedMutation = useCallback((id: string): void => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    if (nativeEngine !== null && nativeEngine !== undefined) {
      nativeEngine.retryRejectedMutation(id);
    } else if (storage !== null) {
      storage.retryRejectedMutation(id);
    } else {
      throw new Error('No persistent NitroSync queue is available');
    }
    setVersion((current) => current + 1);
  }, [config.nativeEngine, storage]);

  const discardRejectedMutation = useCallback((id: string): void => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    if (nativeEngine !== null && nativeEngine !== undefined) {
      nativeEngine.discardRejectedMutation(id);
    } else if (storage !== null) {
      storage.discardRejectedMutation(id);
    } else {
      throw new Error('No persistent NitroSync queue is available');
    }
    setVersion((current) => current + 1);
  }, [config.nativeEngine, storage]);

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
      nativeEngine.applyMutation(
        mutationId,
        mutation.tableName,
        mutation.operation,
        JSON.stringify(queuePayload),
        timestamp,
        schemaVersion,
        recordId,
        JSON.stringify(mutation.operation === 'DELETE' ? { id: recordId } : persistedRecord),
        mutation.operation === 'DELETE',
      );
    } else if (storage !== null) {
      storage.applyMutation(
        nextMutation,
        persistedRecord,
        mutation.operation === 'DELETE',
      );
    } else {
      throw new Error('No persistent NitroSync queue is available');
    }

    recordsRef.current = { ...recordsRef.current, [mutation.tableName]: nextTable };
    setRecords((current) => ({ ...current, [mutation.tableName]: nextTable }));
    setVersion((current) => current + 1);
    return recordId;
  }, [config.nativeEngine, config.schemaVersions, storage]);

  const value = useMemo<SyncContextValue>(() => ({
    config,
    status,
    error,
    lastSyncedAt,
    version,
    ensureTable,
    getRecords,
    listRejectedMutations,
    retryRejectedMutation,
    discardRejectedMutation,
    mutate,
    sync,
  }), [
    config,
    ensureTable,
    error,
    getRecords,
    lastSyncedAt,
    listRejectedMutations,
    mutate,
    retryRejectedMutation,
    discardRejectedMutation,
    status,
    sync,
    version,
  ]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
