# Nitro Sync Example App

The Expo Router demo presents the library through four screens:

- **Notes** — create, edit, and delete local records.
- **Tasks** — exercise a second table and optimistic field updates.
- **Sync** — manually sync each table, inspect mock-server counters, and simulate a failed request followed by a retry.
- **Guide** — a short explanation of the client flow and what the mock does not provide.
- **Native queue benchmark** — synthetic batches against a dedicated SQLite database, with three runs per batch and median results.

## Run with the mock server

```sh
cd example
npm install
npx expo start
```

The example uses SQLite for local sync storage and MMKV for metadata. When no endpoint is configured, its transport is an in-memory server mock isolated by table. It demonstrates mutation-ID deduplication, cursors, tombstones, and a deliberately failed request. The mock server state is lost when the app process exits; it is for local evaluation only and does not provide authentication, durable server storage, or a production sync contract.

## Connect a local Node HTTP backend

Start the repository's local protocol fixture and reverse its port to the Android emulator:

```sh
# terminal 1, from repository root
npm run sync:test-server

# terminal 2, from repository root
adb reverse tcp:8787 tcp:8787
cd example
EXPO_PUBLIC_NITRO_SYNC_ENDPOINT=http://127.0.0.1:8787/sync npx expo start --dev-client
```

Open **Sync** and synchronize a locally created note or task. The example's API adapter sends real HTTP `POST /sync` requests. Its server-status card calls `GET /__test__/snapshot` and shows server-side request, mutation, deduplication, rejection, and record counts. Verify that those values change to confirm the complete app-to-HTTP-server path. `POST /__test__/reset` resets the in-memory fixture.

The fixture is intentionally bound to loopback and stores data only in memory. It is for local protocol validation, not a production backend; it does not provide authentication or durable server storage. For a separately hosted service, implement the protocol's cursor, idempotency, acknowledgement, rejection, and tombstone semantics; see [the main README](../README.md#transport-contract). Add the host application's authentication headers to `apiTransport.ts` before using an authenticated service. Do not use JSONPlaceholder: it does not implement this protocol.

## Development build: native modules

Use a development build to exercise Nitro and native SQLite; Expo Go does not load Nitro Modules:

```sh
npx expo prebuild
npx expo run:ios
# oppure
npx expo run:android
```

The Android development build compiles the Nitro C++ bridge through CMake/NDK. Background execution remains platform-scheduled and best-effort; this example does not register an authenticated production background delegate.

## Native queue benchmark

Open **Sync → Apri benchmark della queue** in a development build. The benchmark screen uses a separate `nitro-sync-benchmark.db`, so it does not claim the app's normal pending mutations. It measures batches of 10, 50, and 100 mutations, with 256-byte record bodies, and reports the median of three sequential runs. The app logs the result JSON with the `[NitroSyncBenchmark]` prefix.

The numbers describe the selected runtime only. Simulator results are useful for comparing code changes on the same simulator configuration, but are not physical-device performance claims. For production decisions, repeat in release builds on representative physical devices and workloads; the harness does not measure native heap usage or battery.
