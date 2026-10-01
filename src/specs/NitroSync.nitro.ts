import type { HybridObject } from 'react-native-nitro-modules';

export type MutationOperation = 'CREATE' | 'UPDATE' | 'DELETE';
export type MutationStatus = 'PENDING' | 'SYNCING' | 'FAILED' | 'REJECTED';

export interface NativeMutation {
  readonly id: string;
  readonly tableName: string;
  readonly operation: MutationOperation;
  readonly payload: string;
  readonly timestamp: number;
  readonly schemaVersion: number;
  readonly status: MutationStatus;
  readonly retryCount: number;
}

export interface NitroSync extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  initialize(databasePath: string): void;
  applyMutation(
    id: string,
    tableName: string,
    operation: MutationOperation,
    payload: string,
    timestamp: number,
    schemaVersion: number,
    recordId: string,
    recordPayload: string,
    deleted: boolean,
  ): void;
  enqueueMutation(
    id: string,
    tableName: string,
    operation: MutationOperation,
    payload: string,
    timestamp: number,
    schemaVersion: number,
  ): void;
  listPendingMutations(limit: number): string[];
  listPendingMutationsForTable(tableName: string, limit: number): string[];
  listRejectedMutations(tableName: string): string[];
  markMutationSyncing(id: string): void;
  markMutationFailed(id: string): void;
  markMutationRejected(id: string, code: string, message: string): void;
  markMutationPending(id: string): void;
  retryRejectedMutation(id: string): void;
  discardRejectedMutation(id: string): void;
  removeMutation(id: string): void;
  upsertRecord(tableName: string, recordId: string, payload: string, timestamp: number): void;
  deleteRecord(tableName: string, recordId: string, timestamp: number): void;
  readRecords(tableName: string): string[];
  readTombstones(tableName: string): string[];
  clearTombstone(tableName: string, recordId: string, throughTimestamp: number): void;
}
