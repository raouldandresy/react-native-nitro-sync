import { NitroModules } from 'react-native-nitro-modules';
import type { NitroSync } from './specs/NitroSync.nitro';

let engine: NitroSync | null = null;
let creationError: unknown;

export function getNitroSync(): NitroSync | null {
  if (engine !== null) {
    return engine;
  }

  try {
    engine = NitroModules.createHybridObject<NitroSync>('NitroSync');
  } catch (caughtError) {
    creationError = caughtError;
    return null;
  }

  creationError = null;
  return engine;
}

export function getNitroSyncCreationError(): unknown {
  return creationError;
}
