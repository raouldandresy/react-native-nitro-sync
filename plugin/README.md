# Expo Config Plugin

Add `react-native-nitro-sync` to the `plugins` array in `app.json` or `app.config.ts`.

The plugin declares the iOS `BGTaskScheduler` identifier and Android wake/boot permissions. The package includes `NitroSyncWorker` and `NitroSyncBackgroundTask`; the host app must provide their transport delegate and schedule them according to its authentication lifecycle.
