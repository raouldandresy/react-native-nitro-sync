import type { SyncMutation, SyncRecord, SyncTransport } from 'react-native-nitro-sync';

const serverRecords = new Map<string, SyncRecord>();
let failNextRequest = false;

export function failNextSync(): void {
  failNextRequest = true;
}

export const transport: SyncTransport = {
  async pushAndPull<T extends SyncRecord>(_tableName: string, mutations: readonly SyncMutation<T>[]) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (failNextRequest) {
      failNextRequest = false;
      throw new Error('Intentional transport failure from example');
    }
    for (const mutation of mutations) {
      if (mutation.operation === 'DELETE') {
        serverRecords.delete(mutation.id);
      } else {
        serverRecords.set(mutation.id, mutation.payload);
      }
    }
    return {
      records: [...serverRecords.values()] as T[],
      acknowledgedMutationIds: mutations.map((mutation) => mutation.id),
      serverTimestamp: Date.now(),
    };
  },
};
