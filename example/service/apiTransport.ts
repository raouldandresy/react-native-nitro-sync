import {
  buildSyncRequestPayload,
  normalizeSyncResponse,
  type SyncMutation,
  type SyncRecord,
  type SyncTransport,
} from 'react-native-nitro-sync';

const endpoint = process.env.EXPO_PUBLIC_NITRO_SYNC_ENDPOINT;
const endpointHostname = endpoint === undefined ? null : new URL(endpoint).hostname;
export const isLocalTestBackend = (
  endpointHostname === 'localhost' ||
  endpointHostname === '127.0.0.1' ||
  endpointHostname === '10.0.2.2'
);

export interface TestServerSnapshot {
  readonly status: 'ok';
  readonly metrics: {
    readonly requests: number;
    readonly mutations: number;
    readonly duplicateMutations: number;
    readonly rejectedMutations: number;
  };
  readonly tables: Readonly<Record<string, {
    readonly version: number;
    readonly records: readonly SyncRecord[];
  }>>;
}

export async function fetchTestServerSnapshot(): Promise<TestServerSnapshot> {
  if (endpoint === undefined || endpoint.length === 0) {
    throw new Error('Set EXPO_PUBLIC_NITRO_SYNC_ENDPOINT to your sync protocol endpoint');
  }
  const snapshotEndpoint = new URL(endpoint);
  snapshotEndpoint.pathname = '/__test__/snapshot';
  snapshotEndpoint.search = '';
  const response = await fetch(snapshotEndpoint.toString());
  if (!response.ok) {
    throw new Error(`Test backend snapshot failed with HTTP ${response.status}`);
  }
  return await response.json() as TestServerSnapshot;
}

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
