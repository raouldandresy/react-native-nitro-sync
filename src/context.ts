import { createContext } from 'react';
import type { NitroSyncConfig, SyncMutation, SyncRecord, SyncStatus } from './types';

export interface SyncContextValue {
  readonly config: NitroSyncConfig;
  readonly status: SyncStatus;
  readonly error: Error | null;
  readonly lastSyncedAt: number | null;
  readonly version: number;
  readonly getRecords: (tableName: string) => readonly SyncRecord[];
  readonly mutate: <T extends SyncRecord>(
    mutation: Omit<SyncMutation<T>, 'id' | 'timestamp'> & { readonly id?: string },
  ) => string;
  readonly sync: (tableName?: string) => Promise<void>;
}

export const SyncContext = createContext<SyncContextValue | null>(null);
