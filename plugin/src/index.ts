import { ConfigPlugin, withAndroidManifest, withInfoPlist, withProjectBuildGradle } from '@expo/config-plugins';

export interface NitroSyncPluginProps {
  readonly backgroundTaskIdentifier?: string;
}

const DEFAULT_TASK_IDENTIFIER = 'com.nitrosync.sync';

const withNitroSync: ConfigPlugin<NitroSyncPluginProps | undefined> = (config, props = {}) => {
  const taskIdentifier = props.backgroundTaskIdentifier ?? DEFAULT_TASK_IDENTIFIER;

  config = withInfoPlist(config, (mod) => {
    const configuredIdentifiers = mod.modResults.BGTaskSchedulerPermittedIdentifiers;
    const identifiers: string[] = Array.isArray(configuredIdentifiers)
      ? configuredIdentifiers.filter((value): value is string => typeof value === 'string')
      : [];
    if (!identifiers.includes(taskIdentifier)) {
      identifiers.push(taskIdentifier);
    }
    mod.modResults.BGTaskSchedulerPermittedIdentifiers = identifiers;
    return mod;
  });

  config = withProjectBuildGradle(config, (mod) => {
    mod.modResults.contents = mod.modResults.contents.replace(
      /classpath\((['"])org\.jetbrains\.kotlin:kotlin-gradle-plugin\1\)/,
      "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25')",
    );
    return mod;
  });

  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const permissions = manifest['uses-permission'] ?? [];
    for (const permission of ['android.permission.WAKE_LOCK', 'android.permission.RECEIVE_BOOT_COMPLETED']) {
      if (!permissions.some((entry) => entry.$?.['android:name'] === permission)) {
        permissions.push({ $: { 'android:name': permission } });
      }
    }
    manifest['uses-permission'] = permissions;
    return mod;
  });
};

export default withNitroSync;
