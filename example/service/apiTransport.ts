// example/apiTransport.ts
import type { JsonObject, SyncMutation, SyncRecord, SyncTransport } from 'react-native-nitro-sync';

const API_BASE_URL = 'https://jsonplaceholder.typicode.com';

export const apiTransport: SyncTransport = {
  async pushAndPull<T extends SyncRecord>(
    tableName: string,
    mutations: readonly SyncMutation<T>[],
    lastSyncedAt: number | null
  ) {
    let acknowledgedMutationIds: string[] = [];

    // 1. Invio delle mutazioni pendenti al server (PUSH)
    if (mutations.length > 0) {
      try {
        const pushResponse = await fetch(`${API_BASE_URL}/${tableName}/sync-mutations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mutations, lastSyncedAt }),
        });

        if (pushResponse.ok) {
          const pushResult = (await pushResponse.json()) as { acknowledgedIds?: string[] };
          acknowledgedMutationIds = pushResult.acknowledgedIds ?? mutations.map((m) => m.id);
        }
      } catch (error) {
        console.warn('[Sync Transport] Fallimento invio mutazioni, retry al prossimo ciclo:', error);
      }
    }

    // 2. Recupero dei record aggiornati dal server (PULL)
    const pullResponse = await fetch(`${API_BASE_URL}/${tableName}?_limit=10`);
    if (!pullResponse.ok) {
      throw new Error(`Errore durante il recupero dei dati da ${tableName}: ${pullResponse.statusText}`);
    }

    const serverRecords = (await pullResponse.json()) as Array<Record<string, unknown>>;

    // Cast esplicito a T[] per rispettare il vincolo generico <T extends SyncRecord>
    const records: T[] = serverRecords.map((item) => ({
      id: String(item.id),
      text: String(item.title ?? item.text ?? ''),
    })) as unknown as T[];

    return {
      records,
      acknowledgedMutationIds,
    };
  },
};