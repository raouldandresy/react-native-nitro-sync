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

## Connect a backend

Set the endpoint before starting Expo to use `service/apiTransport.ts` instead of the mock:

```sh
EXPO_PUBLIC_NITRO_SYNC_ENDPOINT=https://api.example.com/sync npx expo start
```

The endpoint must implement the versioned protocol and its cursor, idempotency, acknowledgement, rejection, and tombstone semantics; see [the main README](../README.md#transport-contract). `apiTransport.ts` is a small HTTP adapter, not a backend implementation. Add the host application's authentication headers in this adapter before using it with an authenticated service. Do not use JSONPlaceholder: it does not implement this protocol.

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

Open **Sync → Apri benchmark della queue** in a development build. The benchmark screen uses a separate `nitro-sync-benchmark.db`, so it does not claim the app's normal pending mutations. It measures batch sizes 10, 100, 1,000, and 10,000, with 256-byte record bodies, and reports the median of three sequential runs. The app logs the result JSON with the `[NitroSyncBenchmark]` prefix.

The numbers describe the selected runtime only. Simulator results are useful for comparing code changes on the same simulator configuration, but are not physical-device performance claims. For production decisions, repeat in release builds on representative physical devices and workloads; the harness does not measure native heap usage or battery.
