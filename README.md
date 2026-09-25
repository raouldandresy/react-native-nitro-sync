# react-native-nitro-sync

[![npm version](https://img.shields.io/npm/v/react-native-nitro-sync)](https://www.npmjs.com/package/react-native-nitro-sync)
[![CI](https://github.com/your-org/react-native-nitro-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/react-native-nitro-sync/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Local-first and offline-first synchronization for React Native. The package keeps optimistic mutations in a SQLite queue, exposes synchronous Nitro Module primitives, and lets applications bring their own REST, GraphQL, or WebSocket transport.

## Status

Early development. The TypeScript API, C++ Nitro bridge, storage contract, and background entry points are provided as a starting point. Production apps must provide the backend transport delegate and schedule work with their own authentication lifecycle.

## Requirements

- React Native 0.73+ with the New Architecture enabled
- iOS 13.4+ or Android API 24+
- `react-native-nitro-modules` 0.25+
- A SQLite provider such as `@op-engineering/op-sqlite`
- `react-native-mmkv` for sync metadata such as `device_id` and `last_synced_at`

## Installation

```sh
npm install react-native-nitro-sync react-native-nitro-modules @op-engineering/op-sqlite react-native-mmkv
cd ios && pod install && cd ..
```

For Expo, use a development build rather than Expo Go because Nitro Modules and SQLite require native code:

```sh
npx expo install react-native-nitro-sync react-native-nitro-modules @op-engineering/op-sqlite react-native-mmkv
npx expo prebuild
npx expo run:ios
```

Add the config plugin to `app.json`:

```json
{
  "expo": {
    "plugins": [["react-native-nitro-sync", { "backgroundTaskIdentifier": "com.example.sync" }]
  }
}
```

## Quick start

```tsx
import { NitroSyncProvider, useSyncCollection } from "react-native-nitro-sync";

type Todo = { id: string; title: string; completed: boolean };

const transport = {
  async pushAndPull(tableName: string, mutations: readonly unknown[]) {
    const response = await fetch("https://api.example.com/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tableName, mutations }),
    });
    return (await response.json()) as {
      records: Todo[];
      acknowledgedMutationIds: string[];
    };
  },
};

export function App() {
  return (
    <NitroSyncProvider config={{ transport, pollingIntervalMs: 15_000 }}>
      <TodoList />
    </NitroSyncProvider>
  );
}

function TodoList() {
  const todos = useSyncCollection<Todo>("todos");
  const addTodo = () =>
    todos.insert({ title: "Read locally first", completed: false });

  return todos.data.map((todo) => (
    <Button
      key={todo.id}
      title={todo.title}
      onPress={() => todos.update(todo.id, { completed: true })}
    />
  ));
}
```

## SQLite and MMKV adapters

For structured local data, pass an OP-SQLite database handle through the typed `sqliteDatabase` adapter. Keep only sync metadata in MMKV:

```tsx
import { MMKV } from "react-native-mmkv";
import { open } from "@op-engineering/op-sqlite";
import { NitroSyncProvider, createSyncStorage } from "react-native-nitro-sync";

const metadata = new MMKV({ id: "nitro-sync-metadata" });
const database = open({ name: "nitro-sync.db" });

<NitroSyncProvider
  config={{
    sqliteDatabase: database,
    metadataStore: metadata,
    endpoint: "https://api.example.com/sync",
    authToken: token,
  }}
>
  {children}
</NitroSyncProvider>;
```

`createSyncStorage(database, metadata)` is also exported when an application wants to construct and test the storage layer directly. The adapter creates `sync_queue` and `sync_records`, claims mutations inside `BEGIN IMMEDIATE`, and stores `last_synced_at` and `device_id` in the metadata store.

`insert`, `update`, and `delete` update the local collection immediately and enqueue a durable mutation. The transport decides how mutations are pushed and how server records are pulled. Conflict resolution is designed around last-write-wins timestamps; applications should enforce the same rule on the server.

## Native storage

The queue schema is in [`schema.sql`](schema.sql). SQLite uses WAL mode and an atomic `BEGIN IMMEDIATE` claim transaction. Keep high-frequency sync metadata in MMKV; do not use it as the source of truth for structured records. The C++ queue implementation is in [`cpp/MutationQueue.cpp`](cpp/MutationQueue.cpp).

The Nitro spec is intentionally small and synchronous for enqueue/read/claim operations. `cpp/NitroSync.cpp` registers the `NitroSync` HybridObject and connects it to the queue. Pending batches cross the native boundary as serialized JSON strings, keeping the native ABI small while preserving typed decoding in TypeScript.

## Expo background work

The included plugin declares `BGTaskSchedulerPermittedIdentifiers` on iOS and wake/boot permissions on Android. `NitroSyncWorker` provides WorkManager retry semantics and `NitroSyncWorkScheduler.enqueue(context, databasePath)` schedules unique connected work. `NitroSyncBackgroundTask` registers and schedules `BGProcessingTask`. Android compiles the Nitro bridge through `android/CMakeLists.txt`. Set the Android `NitroSyncBackgroundDelegate.runner` or the iOS handler from the host app so background work can use the app's transport and credentials.

## Development

```sh
npm install
npm run typecheck
npm run build
```

See [`example/`](example/) for a minimal Expo Router app.

## Security

Please read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Enable GitHub Dependabot alerts and security updates in the repository settings; the committed [`dependabot.yml`](.github/dependabot.yml) configures dependency update pull requests.
