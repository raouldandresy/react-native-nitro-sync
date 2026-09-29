import {
  buildSyncRequestPayload,
  normalizeSyncResponse,
  type SyncMutation,
  type SyncRecord,
  type SyncTransport,
} from 'react-native-nitro-sync';

const endpoint = process.env.EXPO_PUBLIC_NITRO_SYNC_ENDPOINT;

export const apiTransport: SyncTransport = {
  async pushAndPull<T extends SyncRecord>(
    tableName: string,
    mutations: readonly SyncMutation<T>[],
    lastSyncedAt: number | null,
    serverCursor?: string | null,
    serverVersion?: number | null,
    deviceId?: string,
  ) {
    if (endpoint === undefined || endpoint.length === 0) {
      throw new Error('Set EXPO_PUBLIC_NITRO_SYNC_ENDPOINT to your sync protocol endpoint');
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      throw new Error(`Sync endpoint failed with HTTP ${response.status}`);
    }
    return normalizeSyncResponse<T>(await response.json());
  },
};
