import { useContext, useMemo } from 'react';
import { SyncContext } from '../context';
import type { JsonObject, SyncRecord, SyncStatus } from '../types';

export interface SyncCollection<T extends SyncRecord> {
  readonly data: readonly T[];
  readonly status: SyncStatus;
  readonly error: Error | null;
  readonly lastSyncedAt: number | null;
  readonly insert: (record: Omit<T, 'id'> & { readonly id?: string }) => string;
  readonly update: (id: string, patch: Partial<Omit<T, 'id'>>) => string;
  readonly delete: (id: string) => string;
  readonly refresh: () => Promise<void>;
}

export function useSyncCollection<T extends SyncRecord>(tableName: string): SyncCollection<T> {
  const context = useContext(SyncContext);
  if (context === null) {
    throw new Error('useSyncCollection must be used inside NitroSyncProvider');
  }

  const data = context.getRecords(tableName) as readonly T[];
  return useMemo(() => ({
    data,
    status: context.status,
    error: context.error,
    lastSyncedAt: context.lastSyncedAt,
    insert: (record) => context.mutate({
      tableName,
      operation: 'CREATE',
      payload: record as T & JsonObject,
      id: record.id,
    }),
    update: (id, patch) => context.mutate({
      tableName,
      operation: 'UPDATE',
      payload: { ...patch, id } as T & JsonObject,
      id,
    }),
    delete: (id) => context.mutate({
      tableName,
      operation: 'DELETE',
      payload: { id } as T & JsonObject,
      id,
    }),
    refresh: () => context.sync(tableName),
  }), [context, data, tableName]);
}
