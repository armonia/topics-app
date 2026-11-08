import { getDatabase } from "../db";
import type { Database } from "bun:sqlite";
import type { FileNode } from "../../shared/file-tree";
import { loadNativeModule, nativeModuleLoadError } from "./native-addon";
import type { NativeModule } from "./native-addon";

export interface NativeFileTreeMetrics {
  loaded: boolean;
  enabled: boolean;
  calls: number;
  fallbacks: number;
  lastError: string | null;
}

const metrics = { calls: 0, fallbacks: 0, lastError: null as string | null };
let enabledOverride: boolean | undefined;
let moduleOverride: NativeModule | null | undefined;
let lastFallbackLogAt = 0;

/** The preference lives in the `settings` ui_state row, synchronized across clients. */
export function nativeFileTreeEnabled(db?: Database): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  try {
    const database = db ?? getDatabase();
    const row = database.query("SELECT value FROM ui_state WHERE key = ?").get("settings") as
      | { value?: string | null }
      | null;
    if (!row?.value) return true;
    const settings: unknown = JSON.parse(row.value);
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      const value = (settings as Record<string, unknown>).nativeFileTreeEnabled;
      if (typeof value === "boolean") return value;
    }
  } catch {
    // Startup and tests can run before the database is available.
  }
  return true;
}

function getNativeModule(): NativeModule | null {
  return moduleOverride === undefined ? loadNativeModule() : moduleOverride;
}

export function nativeFileTreeSnapshot(): NativeFileTreeMetrics {
  const loaded = typeof getNativeModule()?.walkFileTree === "function";
  return { loaded, enabled: nativeFileTreeEnabled(), ...metrics };
}

/** Return undefined when the JavaScript walker should run. */
export async function readNativeFileTree(root: string, depth: number, home?: string): Promise<FileNode[] | undefined> {
  if (!nativeFileTreeEnabled()) return undefined;
  const native = getNativeModule();
  if (!native?.walkFileTree) {
    metrics.fallbacks++;
    metrics.lastError = native ? "native module does not export walkFileTree" : nativeModuleLoadError();
    return undefined;
  }
  metrics.calls++;
  try {
    const result = await native.walkFileTree(root, depth, home);
    metrics.lastError = null;
    return result;
  } catch (error) {
    metrics.fallbacks++;
    metrics.lastError = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (now - lastFallbackLogAt >= 60_000) {
      lastFallbackLogAt = now;
      console.warn(`[native-file-tree] addon failed; using JavaScript: ${metrics.lastError}`);
    }
    return undefined;
  }
}

/** Override the module and state in tests only. */
export function setNativeFileTreeTestOverrides(overrides: {
  enabled?: boolean | undefined;
  module?: NativeModule | null | undefined;
} | null): void {
  enabledOverride = overrides?.enabled;
  moduleOverride = overrides?.module;
  metrics.calls = 0;
  metrics.fallbacks = 0;
  metrics.lastError = null;
}
