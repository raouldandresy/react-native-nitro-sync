// example/app/_layout.tsx
import { open } from '@op-engineering/op-sqlite';
import { MMKV } from 'react-native-mmkv';
import { Stack } from 'expo-router';
import { createSyncStorage, type JsonObject, NitroSyncProvider } from 'react-native-nitro-sync';
import { apiTransport } from '../service/apiTransport';
import { transport } from '../testTransport';

const database = open({ name: 'nitro-sync-example.db' });
const metadata = new MMKV({ id: 'nitro-sync-example-metadata' });
const activeTransport = process.env.EXPO_PUBLIC_NITRO_SYNC_ENDPOINT ? apiTransport : transport;

const storage = createSyncStorage(
  {
    executeSync(sql, params) {
      const result = database.executeSync(sql, params === undefined ? undefined : [...params]);
      return { rows: result.rows as unknown as readonly JsonObject[] };
    },
  },
  metadata
);

export default function Layout(): React.JSX.Element {
  return (
    <NitroSyncProvider
      config={{
        storage,
        metadataStore: metadata,
        pollingIntervalMs: 0,
        transport: activeTransport,
        conflictStrategy: 'merge-fields',
        schemaVersions: { notes: 1, tasks: 1 },
      }}
    >
      <Stack screenOptions={{ headerTitle: 'Nitro Sync' }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="benchmark" options={{ title: 'Native queue benchmark' }} />
      </Stack>
    </NitroSyncProvider>
  );
}