# react-native-nitro-sync

[![npm version](https://img.shields.io/npm/v/react-native-nitro-sync)](https://www.npmjs.com/package/react-native-nitro-sync)
[![CI](https://github.com/raouldandresy/react-native-nitro-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/raouldandresy/react-native-nitro-sync/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Local-first and offline-first synchronization primitives for React Native. The client persists records and queued mutations locally, exposes synchronous Nitro Module queue operations, and lets the host application provide its own REST, GraphQL, or WebSocket transport.

> **Maturity: early development — not yet production-ready as a general-purpose sync solution.** The client implementation and example are useful for evaluation and integration work, but the package does not ship a backend, guarantee distributed consistency, or provide a validated production background-sync service. See [Production readiness](#production-readiness).

## Features in this version

- Optimistic collection operations via `useSyncCollection`: insert, update, delete, and manual refresh.
- Durable local mutation queue with deduplication, retry/recovery, and per-mutation schema version.
- Nitro C++ queue plus a TypeScript/OP-SQLite storage adapter and MMKV-compatible metadata storage.
- Versioned client/server request and response contract (`protocolVersion: 1`), per-table cursors, acknowledgements, and permanent/retryable rejections.
- Configurable record merge strategies and persisted delete tombstones.
- Expo config plugin and native background entry points; execution is subject to operating-system scheduling and host-app integration.
- An Expo Router example with Notes, Tasks, Sync, and Guide screens using an in-memory mock transport.

## Requirements

- React Native 0.73+ with the New Architecture enabled.
- iOS 13.4+ or Android API 24+.
- `react-native-nitro-modules` 0.36.5+.
- `@op-engineering/op-sqlite` 10+ is required to build the Android Nitro C++ queue, which compiles the SQLite amalgamation shipped by this package; it is also the default provider for the TypeScript storage adapter, though another provider can be used there.
- `react-native-mmkv` for persistent sync metadata in the standard setup.

## Installation

```sh
npm install react-native-nitro-sync react-native-nitro-modules @op-engineering/op-sqlite react-native-mmkv
cd ios && pod install && cd ..
```

Expo applications need a development build because Nitro Modules and SQLite require native code; Expo Go is not supported:

```sh
npx expo install react-native-nitro-sync react-native-nitro-modules @op-engineering/op-sqlite react-native-mmkv
npx expo prebuild
npx expo run:ios
# or: npx expo run:android
```

The package's `prepare` script runs Nitrogen to generate the C++ spec and platform autolinking files before building the package. Generated files are checked in for native builds; when changing the Nitro spec or `nitro.json` in a source checkout, run `npm run generate` and commit the updated `nitrogen/generated` output.

Add the config plugin to `app.json` if background-task configuration is required:

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-nitro-sync",
        { "backgroundTaskIdentifier": "com.example.sync" }
      ]
    ]
  }
}
```

## Quick start

Configure one provider near the application root. The provider uses the native engine when available; an explicit SQLite adapter can be used as a fallback or directly by applications that construct their own storage.

```tsx
import { open } from "@op-engineering/op-sqlite";
import { MMKV } from "react-native-mmkv";
import type { PropsWithChildren } from "react";
import {
  NitroSyncProvider,
  normalizeSyncResponse,
  type SyncTransport,
  type SyncRecord,
} from "react-native-nitro-sync";

const database = open({ name: "nitro-sync.db" });
const metadataStore = new MMKV({ id: "nitro-sync-metadata" });

const transport: SyncTransport = {
  async pushAndPull<T extends SyncRecord>(
    tableName,
    mutations,
    lastSyncedAt,
    serverCursor,
    serverVersion,
    deviceId,
  ) {
    const response = await fetch("https://api.example.com/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Add credentials from your host app's auth/session provider here.
      },
      body: JSON.stringify({
        protocolVersion: 1,
        tableName,
        mutations,
        lastSyncedAt,
        serverCursor,
        serverVersion,
        deviceId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Sync failed with HTTP ${response.status}`);
    }
    return normalizeSyncResponse<T>(await response.json());
  },
};

export function AppRoot({ children }: PropsWithChildren) {
  return (
    <NitroSyncProvider
      config={{
        sqliteDatabase: database,
        metadataStore,
        transport,
        pollingIntervalMs: 15_000,
        conflictStrategy: "last-write-wins",
        schemaVersions: { todos: 1 },
      }}
    >
      {children}
    </NitroSyncProvider>
  );
}
```

Use the collection hook from a descendant of the provider:

```tsx
import { Button } from "react-native";
import { useSyncCollection, type SyncRecord } from "react-native-nitro-sync";

interface Todo extends SyncRecord {
  title: string;
  completed: boolean;
}

export function TodoList() {
  const todos = useSyncCollection<Todo>("todos");

  return (
    <>
      <Button
        title="Add todo"
        onPress={() => todos.insert({ title: "Read locally first", completed: false })}
      />
      {todos.data.map((todo) => (
        <Button
          key={todo.id}
          title={`${todo.completed ? "✓" : "○"} ${todo.title}`}
          onPress={() => todos.update(todo.id, { completed: !todo.completed })}
        />
      ))}
      <Button title="Sync now" onPress={() => void todos.refresh()} />
    </>
  );
}
```

`insert`, `update`, and `delete` return the record ID and update local state immediately. `refresh()` resolves after the sync attempt; inspect `status` and `error` to show failures to the user. `status` is shared at provider level (`idle`, `syncing`, or `error`), as is `lastSyncedAt`. A collection hook must be rendered below `NitroSyncProvider`.

## Transport contract

The `SyncTransport` receives a batch for one table at a time. The request includes `protocolVersion: 1`, `tableName`, `deviceId`, `mutations`, `lastSyncedAt`, and optional per-table `serverCursor` and `serverVersion`. Each mutation has an immutable ID, operation, payload, timestamp, and `schemaVersion` (default `1`, configurable using `config.schemaVersions`).

An example successful response:

```json
{
  "protocolVersion": 1,
  "records": [{ "id": "todo-123", "title": "Synced", "completed": false, "updatedAt": 42 }],
  "tombstones": [],
  "acknowledgedMutationIds": ["mutation-abc"],
  "rejectedMutations": [],
  "serverTimestamp": 1730000000000,
  "serverCursor": "opaque-table-cursor",
  "serverVersion": 42
}
```

`records`, `tombstones`, acknowledgements, and rejections are optional. A tombstone contains an `id` and finite numeric `timestamp`. A rejection contains `mutationId` and `code`, and may include `message` and `retryable`; explicitly permanent rejections are retained in `REJECTED` and are not retried automatically. Unacknowledged mutations remain retryable. The response parser rejects malformed structures and unsupported protocol versions. Only acknowledgement/rejection IDs from the submitted batch are settled.

The backend must make mutation processing idempotent by mutation ID, ideally in the same transaction as its data changes. Cursor values must be stable per table and advance only past changes included in that response. The client stores a returned cursor after processing the table response; it cannot detect a server that silently skips changes. Protect the endpoint with the host application's authentication and authorization. The example `apiTransport` sends the protocol shape but does not implement a server.

## How synchronization works

### Local write and successful sync

```mermaid
sequenceDiagram
  actor UI as React UI
  participant Hook as useSyncCollection
  participant Provider as NitroSyncProvider
  participant Queue as SQLite / Nitro queue
  participant Transport as Host transport
  participant Server as Application backend

  UI->>Hook: insert / update / delete
  Hook->>Provider: mutation
  Provider->>Provider: update in-memory collection optimistically
  Provider->>Queue: persist record, mutation and delete tombstone
  Provider-->>UI: updated collection immediately
  UI->>Hook: refresh()
  Hook->>Provider: sync(table)
  Provider->>Queue: claim pending mutations
  Provider->>Transport: push batch + cursor + device metadata
  Transport->>Server: authenticated protocol request
  Server->>Server: deduplicate IDs, apply mutations, read changes
  Server-->>Transport: ACKs + records/tombstones + next cursor
  Transport-->>Provider: validated protocol response
  Provider->>Provider: merge pulled data and settle ACKs/rejections
  Provider->>Queue: persist merged data, remove ACKs, save cursor
  Provider-->>Hook: status and lastSyncedAt
```

### Failure, retry, and restart recovery

```mermaid
sequenceDiagram
  participant Provider as NitroSyncProvider
  participant Queue as SQLite / Nitro queue
  participant Transport as Host transport
  participant Server as Application backend

  Provider->>Queue: claim mutation (PENDING → SYNCING)
  Provider->>Transport: send mutation with stable mutation ID
  alt network failure or missing ACK
    Transport--xProvider: error / no acknowledgement
    Provider->>Queue: retain mutation for retry (FAILED/PENDING)
    Note over Provider,Queue: Local optimistic record remains available
    Provider->>Transport: retry the same mutation ID
    Transport->>Server: resend batch
    Server->>Server: deduplicate previously applied ID
    Server-->>Provider: acknowledgement
    Provider->>Queue: remove acknowledged mutation
  else permanent rejection
    Server-->>Provider: rejectedMutations with retryable=false
    Provider->>Queue: retain mutation as REJECTED
  end
  Note over Queue: A mutation left SYNCING is recovered on queue initialization
```

These diagrams show the intended client flow, not a guarantee of exactly-once network delivery. Delivery is retryable and at-least-once; server-side idempotency is required.

## Storage, conflicts, and deletes

The native SQLite queue schema is in [`schema.sql`](schema.sql); the C++ implementation is in [`cpp/MutationQueue.cpp`](cpp/MutationQueue.cpp). The exported `createSyncStorage(database, metadata)` creates the OP-SQLite adapter. Both queue implementations deduplicate by mutation ID without replacing the original mutation payload. Queue migrations use `user_version` through version 4 and preserve existing queued work. A mutation left `SYNCING` is recovered at initialization.

Structured records, queue state, and tombstones belong in durable SQLite storage. The metadata store (for example MMKV) holds device ID, `lastSyncedAt`, and per-table cursors/versions. Avoid using metadata storage as the source of truth for records.

Choose `config.conflictStrategy` from:

- `last-write-wins` / `lww`: choose the record with the later comparable update timestamp.
- `server-wins`: choose the pulled server record on conflict.
- `client-wins`: preserve the local record on conflict.
- `merge-fields`: recursively merge JSON objects; remote values replace scalar and array conflicts. This is not a causal or CRDT merge.
- A custom resolver `(local, remote, mutation?) => record`; it must preserve the record ID.

The client-side strategy does not automatically configure server behavior. The backend must use compatible rules if replicas are to converge. Use server-controlled, comparable revisions for multi-device conflict resolution; device wall clocks alone are not a reliable global ordering.

Offline deletes are persisted as local tombstones. They hide matching records and suppress pulled rows unless a pulled row has a strictly newer numeric `updatedAt` or `updated_at` revision. The server may return authoritative tombstones. A matching acknowledged delete clears only the local tombstone it covers; newer deletes remain. Unversioned remote records cannot override a tombstone.

## Background work and benchmarking

The Expo plugin and native entry points configure/schedule platform background work, but they do not run the application's authenticated transport automatically. The host must wire a background delegate/handler and credentials. iOS and Android may defer or skip work; background execution is best-effort. Resume and drain the durable queue when the app starts or returns to the foreground.

`benchmarkNativeSyncQueue` measures serialization, queue enqueue/claim, payload sizes, and event-loop delay for synthetic batches against the Nitro queue. The helper is available, but the measurements must be run by the integrating app on its target hardware: this repository's unit tests use a fake queue and are not device performance results. For useful production data, run release builds on representative physical iOS and Android devices, record OS/device/build details, repeat runs, and include the application's actual payload sizes and queue workloads. Simulator timings are useful for functional checks only, not representative device-performance claims. The benchmark does not measure native heap usage or battery consumption and has no device-independent performance thresholds.

## Example app

The Expo Router demo lives in [`example/`](example/). It includes:

- **Notes:** local create, edit, delete, and collection status.
- **Tasks:** a second independently synchronized table and optimistic updates.
- **Sync:** manual per-table sync, mock server counters, and an intentional transport-failure/retry exercise.
- **Guide:** client sync lifecycle and explicit boundaries of the mock.

The demo transport is in-memory and resets when the process exits. It is for learning and local testing only; it is not a production backend. Follow [`example/README.md`](example/README.md) to run the app and configure a real endpoint.

## Production readiness

**Is this library production-ready today? It should be treated as early-stage and not yet production-validated.** It provides client-side sync building blocks rather than an end-to-end service. Whether it is production-suitable depends on the host app's integration, release validation, and backend contract.

The backend is deliberately not bundled: applications choose and operate their own backend and transport. Its absence from this repository is an architectural boundary, not by itself a production-readiness defect. The repository has unit coverage for protocol validation, storage, merge policies, lifecycle settlement, and the benchmark helper. The library build, type checks, lint, Jest suite, and Android example build have been exercised locally; these checks do **not** amount to production certification. No representative physical-device benchmark results or iOS release-device validation are available from this environment. Background delivery is not guaranteed.

Before relying on it in a production application, validate the complete app/backend integration. In particular:

1. Contract-test the chosen backend's atomic mutation-ID deduplication, per-table cursor consistency, rejection semantics, schema evolution, authentication, and delete/conflict behavior.
2. Run end-to-end tests covering concurrent edits/deletes, duplicate delivery, lost ACKs, partial responses, pagination/cursor gaps, upgrades, and restart recovery across multiple devices.
3. Build and exercise release configurations on supported iOS and Android versions, including the host app's background delegates and database lifecycle.
4. Measure queue size, latency, memory, and battery impact on representative devices and workloads; define operational limits and observability.
5. Review error recovery, permanent rejection UX, backup/restore behavior, privacy/security requirements, and the package's compatibility/support policy.

Treat the API and protocol as subject to change until those validations and a stable release policy are in place. Do not rely on the sample in-memory server or operating-system background scheduling for data durability or delivery guarantees.

## Development

```sh
npm install
npm run lint
npm test -- --runInBand --watch=false
npm run typecheck
npm run build
```

For the Expo demo:

```sh
cd example
npm install
npx expo start
```

Use a development build (`npx expo run:ios` or `npx expo run:android`) to exercise native modules; Expo Go cannot load Nitro Modules.

## Security

Please read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Enable GitHub Dependabot alerts and security updates in the repository settings; the committed [`dependabot.yml`](.github/dependabot.yml) configures dependency update pull requests.
