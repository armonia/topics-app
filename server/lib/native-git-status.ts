import { getDatabase } from "../db";
import type { Database } from "bun:sqlite";
import { loadNativeModule, nativeModuleLoadError } from "./native-addon";
import type { NativeGitNumstat, NativeGitStatus, NativeModule } from "./native-addon";

export interface NativeGitStatusMetrics {
  loaded: boolean;
  enabled: boolean;
  calls: number;
  fallbacks: number;
  numstatCalls: number;
  numstatFallbacks: number;
  lastError: string | null;
}

const metrics = { calls: 0, fallbacks: 0, numstatCalls: 0, numstatFallbacks: 0, lastError: null as string | null };
let enabledOverride: boolean | undefined;
let moduleOverride: NativeModule | null | undefined;
let lastFallbackLogAt = 0;

/** The preference is part of the server-synced `settings` ui-state value. */
export function nativeGitStatusEnabled(db?: Database): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  try {
    const database = db ?? getDatabase();
    const row = database.query("SELECT value FROM ui_state WHERE key = ?").get("settings") as
      | { value?: string | null }
      | null;
    if (!row?.value) return true;
    const settings: unknown = JSON.parse(row.value);
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      const value = (settings as Record<string, unknown>).nativeGitStatusEnabled;
      if (typeof value === "boolean") return value;
    }
  } catch {
    // Tests and early boot can run before the UI-state database is available.
  }
  return true;
}

function getGitStatusModule(): NativeModule | null {
  return moduleOverride === undefined ? loadNativeModule() : moduleOverride;
}

export function nativeGitStatusSnapshot(): NativeGitStatusMetrics {
  const loaded = typeof getGitStatusModule()?.gitStatus === "function";
  return { loaded, enabled: nativeGitStatusEnabled(), ...metrics };
}

/** `null` is a genuine non-repository result; `undefined` requests Git fallback. */
export async function readNativeGitStatus(repoPath: string): Promise<NativeGitStatus | null | undefined> {
  if (!nativeGitStatusEnabled()) return undefined;
  const module = getGitStatusModule();
  if (!module?.gitStatus) {
    metrics.fallbacks++;
    metrics.lastError = module ? "native module does not export gitStatus" : nativeModuleLoadError();
    return undefined;
  }
  metrics.calls++;
  try {
    const result = await module.gitStatus(repoPath);
    metrics.lastError = null;
    return result;
  } catch (error) {
    metrics.fallbacks++;
    metrics.lastError = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (now - lastFallbackLogAt >= 60_000) {
      lastFallbackLogAt = now;
      console.warn(`[native-git-status] addon failed; using git: ${metrics.lastError}`);
    }
    return undefined;
  }
}

export async function readNativeGitNumstat(repoPath: string): Promise<NativeGitNumstat | undefined> {
  if (!nativeGitStatusEnabled()) return undefined;
  const module = getGitStatusModule();
  if (!module?.gitNumstat) {
    metrics.numstatFallbacks++;
    metrics.lastError = module ? "native module does not export gitNumstat" : nativeModuleLoadError();
    return undefined;
  }
  metrics.numstatCalls++;
  try {
    const result = await module.gitNumstat(repoPath);
    metrics.lastError = null;
    return result;
  } catch (error) {
    metrics.numstatFallbacks++;
    metrics.lastError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

export function recordNativeGitNumstatFallbacks(count: number): void {
  metrics.numstatFallbacks += count;
}

/** Test seam for exercising native, disabled, and rejection paths. */
export function setNativeGitStatusTestOverrides(overrides: {
  enabled?: boolean | undefined;
  module?: NativeModule | null | undefined;
} | null): void {
  enabledOverride = overrides?.enabled;
  moduleOverride = overrides?.module;
  metrics.calls = 0;
  metrics.fallbacks = 0;
  metrics.numstatCalls = 0;
  metrics.numstatFallbacks = 0;
  metrics.lastError = null;
}
