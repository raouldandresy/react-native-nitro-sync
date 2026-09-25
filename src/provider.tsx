import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SyncContext, type SyncContextValue } from './context';
import { getNitroSync } from './native';
import { createDeviceId, createSyncStorage } from './storage';
import type { NitroSyncConfig, SyncMutation, SyncRecord, SyncStatus, SyncTransport } from './types';

export interface NitroSyncProviderProps {
  readonly config: NitroSyncConfig;
  readonly children: React.ReactNode;
}

function createId(): string {
  const randomPart = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${randomPart}`;
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
    ) {
      const response = await fetch(config.endpoint as string, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.authToken === undefined ? {} : { authorization: `Bearer ${config.authToken}` }),
        },
        body: JSON.stringify({ tableName, mutations, lastSyncedAt }),
      });
      if (!response.ok) {
        throw new Error(`Synchronization request failed with HTTP ${response.status}`);
      }
      return await response.json() as {
        readonly records?: readonly T[];
        readonly acknowledgedMutationIds?: readonly string[];
        readonly serverTimestamp?: number;
      };
    },
  };
}

export function NitroSyncProvider({ config, children }: NitroSyncProviderProps): React.JSX.Element {
  const [records, setRecords] = useState<Record<string, SyncRecord[]>>({});
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const recordsRef = useRef(records);
  const fallbackMutationsRef = useRef<SyncMutation<SyncRecord>[]>([]);
  recordsRef.current = records;
  const transport = useMemo(() => createConfiguredTransport(config), [config]);
  const storage = useMemo(() => {
    if (config.storage !== undefined) return config.storage;
    if (config.sqliteDatabase === undefined) return null;
    return createSyncStorage(config.sqliteDatabase, config.metadataStore);
  }, [config.metadataStore, config.sqliteDatabase, config.storage]);

  useEffect(() => {
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    nativeEngine?.initialize(config.databaseName ?? 'nitro-sync.db');
    storage?.initialize();
    const storedLastSyncedAt = storage?.getLastSyncedAt() ?? null;
    setLastSyncedAt(storedLastSyncedAt);
    if (storage !== null && storage.getDeviceId() === null) {
      storage.setDeviceId(config.deviceId ?? createDeviceId());
    }
  }, [config.databaseName, config.deviceId, config.nativeEngine, storage]);

  const sync = useCallback(async (requestedTableName?: string): Promise<void> => {
    if (transport === undefined) {
      return;
    }

    setStatus('syncing');
    setError(null);
    try {
      const nativeEngine = config.nativeEngine ?? getNitroSync();
      const tables = requestedTableName === undefined
        ? Object.keys(recordsRef.current)
        : [requestedTableName];
      for (const tableName of tables) {
        if (storage !== null && recordsRef.current[tableName] === undefined) {
          const storedRecords = storage.loadRecords(tableName);
          setRecords((current) => ({ ...current, [tableName]: [...storedRecords] }));
        }
        const nativePending = (nativeEngine?.listPendingMutations(100) ?? [])
          .map((serializedMutation) => JSON.parse(serializedMutation) as {
            readonly id: string;
            readonly tableName: string;
            readonly operation: 'CREATE' | 'UPDATE' | 'DELETE';
            readonly payload: string;
            readonly timestamp: number;
          });
        const storedPending = storage?.listPendingMutations(100) ?? [];
        const pending = nativePending.length > 0
          ? nativePending
          : storedPending.length > 0
            ? storedPending
            : fallbackMutationsRef.current;
        const mutations: SyncMutation<SyncRecord>[] = pending
          .filter((mutation) => mutation.tableName === tableName)
          .map((mutation) => ({
            id: mutation.id,
            tableName: mutation.tableName,
            operation: mutation.operation,
            payload: typeof mutation.payload === 'string'
              ? JSON.parse(mutation.payload) as SyncRecord
              : mutation.payload,
            timestamp: mutation.timestamp,
          }));
        const response = await transport.pushAndPull<SyncRecord>(tableName, mutations, lastSyncedAt);
        const serverRecords = response.records;
        const serverTimestamp = response.serverTimestamp ?? Date.now();
        if (serverRecords !== undefined) {
          setRecords((current) => ({ ...current, [tableName]: [...serverRecords] }));
          if (storage !== null) {
            for (const record of serverRecords) storage.saveRecord(tableName, record, serverTimestamp);
          }
        }
        for (const mutationId of response.acknowledgedMutationIds ?? []) {
          nativeEngine?.removeMutation(mutationId);
          storage?.removeMutation(mutationId);
        }
        if (nativeEngine === null || nativeEngine === undefined) {
          const acknowledged = new Set(response.acknowledgedMutationIds ?? []);
          fallbackMutationsRef.current = fallbackMutationsRef.current.filter(
            (mutation) => !acknowledged.has(mutation.id),
          );
        }
      }
      setStatus('idle');
      const syncedAt = Date.now();
      setLastSyncedAt(syncedAt);
      storage?.setLastSyncedAt(syncedAt);
      setVersion((current) => current + 1);
    } catch (caughtError) {
      const nextError = caughtError instanceof Error ? caughtError : new Error('Synchronization failed');
      setError(nextError);
      setStatus('error');
    }
  }, [config, lastSyncedAt, storage, transport]);

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
    const id = mutation.id ?? createId();
    const timestamp = Date.now();
    const nativeEngine = config.nativeEngine ?? getNitroSync();
    const payload = { ...mutation.payload, id };
    const nextMutation: SyncMutation<SyncRecord> = {
      id,
      tableName: mutation.tableName,
      operation: mutation.operation,
      payload,
      timestamp,
    };

    setRecords((current) => {
      const existing = current[mutation.tableName] ?? [];
      const withoutRecord = existing.filter((record) => record.id !== id);
      if (mutation.operation === 'DELETE') {
        return { ...current, [mutation.tableName]: withoutRecord };
      }
      const previousRecord = existing.find((record) => record.id === id);
      const nextRecord = mutation.operation === 'UPDATE'
        ? { ...previousRecord, ...payload, id }
        : payload;
      return { ...current, [mutation.tableName]: [...withoutRecord, nextRecord] };
    });
    if (nativeEngine === null || nativeEngine === undefined) {
      fallbackMutationsRef.current = [...fallbackMutationsRef.current, nextMutation];
    } else {
      nativeEngine.enqueueMutation(id, mutation.tableName, mutation.operation, JSON.stringify(payload), timestamp);
    }
    storage?.saveMutation(nextMutation);
    if (mutation.operation === 'DELETE') {
      storage?.removeRecord(mutation.tableName, id, timestamp);
    } else {
      storage?.saveRecord(mutation.tableName, payload, timestamp);
    }
    setVersion((current) => current + 1);
    return id;
  }, [config.nativeEngine, storage]);

  const value = useMemo<SyncContextValue>(() => ({
    config,
    status,
    error,
    lastSyncedAt,
    version,
    getRecords,
    mutate,
    sync,
  }), [config, error, getRecords, lastSyncedAt, mutate, status, sync, version]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
