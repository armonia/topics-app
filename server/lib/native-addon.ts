import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export interface NativeModule {
  nativeVersion(): string;
  gitHeadCommitId(repoPath: string): string | null;
}

interface NativeExports {
  nativeVersion?: () => string;
  gitHeadCommitId?: (repoPath: string) => string | null;
}

let loaded = false;
let nativeModule: NativeModule | null = null;
let loadError = "native module is unavailable";
const requireFromHere = createRequire(import.meta.url);

export function loadNativeModule(): NativeModule | null {
  if (loaded) return nativeModule;
  loaded = true;

  // `isStandaloneExecutable` exists at runtime but not in the Bun types here.
  // Compiled, the addon is an embedded asset next to the entry (`/$bunfs/root`);
  // from the checkout it is the build output of scripts/build-native-addon.sh.
  const isStandalone = (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true;
  const candidates = isStandalone
    ? [resolve(import.meta.dir, "topics_native.node")]
    : [resolve(import.meta.dir, "../../native/topics_native.node")];

  for (const candidate of candidates) {
    nativeModule = loadNativeModuleAt(candidate);
    if (nativeModule) return nativeModule;
  }

  return null;
}

export function loadNativeModuleAt(candidate: string): NativeModule | null {
  if (!existsSync(candidate)) {
    loadError = `native module not found at ${candidate}`;
    console.warn(`[native-module] ${loadError}`);
    return null;
  }

  try {
    const exports = requireFromHere(candidate) as NativeExports;
    const { nativeVersion, gitHeadCommitId } = exports;
    if (typeof nativeVersion !== "function" || typeof gitHeadCommitId !== "function") {
      nativeModule = null;
      loadError = "native module exports are incomplete";
      console.warn(`[native-module] ${loadError}`);
    } else {
      nativeModule = {
        nativeVersion: nativeVersion.bind(exports),
        gitHeadCommitId: gitHeadCommitId.bind(exports),
      };
    }
  } catch (error) {
    nativeModule = null;
    loadError = error instanceof Error ? error.message : String(error);
    console.warn(`[native-module] ${loadError}`);
  }

  return nativeModule;
}

export function nativeModuleLoadError(): string {
  return loadError;
}
