import type { HybridObject } from 'react-native-nitro-modules';

export type MutationOperation = 'CREATE' | 'UPDATE' | 'DELETE';
export type MutationStatus = 'PENDING' | 'SYNCING' | 'FAILED';

export interface NativeMutation {
  readonly id: string;
  readonly tableName: string;
  readonly operation: MutationOperation;
  readonly payload: string;
  readonly timestamp: number;
  readonly status: MutationStatus;
  readonly retryCount: number;
}

export interface NitroSync extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  initialize(databasePath: string): void;
  enqueueMutation(
    id: string,
    tableName: string,
    operation: MutationOperation,
    payload: string,
    timestamp: number,
  ): void;
  listPendingMutations(limit: number): string[];
  markMutationSyncing(id: string): void;
  markMutationFailed(id: string): void;
  markMutationPending(id: string): void;
  removeMutation(id: string): void;
  upsertRecord(tableName: string, recordId: string, payload: string, timestamp: number): void;
  readRecords(tableName: string): string[];
}
