import { NitroModules } from 'react-native-nitro-modules';
import type { NitroSync } from './specs/NitroSync.nitro';

let engine: NitroSync | null = null;

export function getNitroSync(): NitroSync | null {
  if (engine !== null) {
    return engine;
  }

  try {
    engine = NitroModules.createHybridObject<NitroSync>('NitroSync');
  } catch {
    return null;
  }

  return engine;
}
