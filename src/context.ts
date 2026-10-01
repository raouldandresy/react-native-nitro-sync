import { createContext } from 'react';
import type { RejectedSyncMutation } from './storage';
import type { NitroSyncConfig, SyncMutation, SyncRecord, SyncStatus } from './types';

export interface SyncContextValue {
  readonly config: NitroSyncConfig;
  readonly status: SyncStatus;
  readonly error: Error | null;
  readonly lastSyncedAt: number | null;
  readonly version: number;
  readonly ensureTable: (tableName: string) => void;
  readonly getRecords: (tableName: string) => readonly SyncRecord[];
  readonly listRejectedMutations: (tableName: string) => readonly RejectedSyncMutation[];
  readonly retryRejectedMutation: (id: string) => void;
  readonly discardRejectedMutation: (id: string) => void;
  readonly mutate: <T extends SyncRecord>(
    mutation: Omit<SyncMutation<T>, 'id' | 'timestamp'> & { readonly id?: string },
  ) => string;
  readonly sync: (tableName?: string) => Promise<void>;
}

export const SyncContext = createContext<SyncContextValue | null>(null);
