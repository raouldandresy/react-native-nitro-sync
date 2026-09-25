// example/app/_layout.tsx
import { open } from '@op-engineering/op-sqlite';
import { MMKV } from 'react-native-mmkv';
import { Stack } from 'expo-router';
import { createSyncStorage, type JsonObject, NitroSyncProvider } from 'react-native-nitro-sync';
import { apiTransport } from '../service/apiTransport';

const database = open({ name: 'nitro-sync-example.db' });
const metadata = new MMKV({ id: 'nitro-sync-example-metadata' });

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
    <NitroSyncProvider config={{ storage, pollingIntervalMs: 15_000, transport: apiTransport }}>
      <Stack screenOptions={{ headerTitle: 'NitroSync Live API' }} />
    </NitroSyncProvider>
  );
}