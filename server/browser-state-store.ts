import type { BrowserContext } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync, rmdirSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Storage state shape derived directly from playwright-core's
 * BrowserContext.storageState() return type. We do NOT mirror the shape
 * manually because it tracks Playwright's evolution (sessionStorage, etc.)
 * and a manual mirror would force escape-hatch casts at every save/load
 * boundary.
 */
export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

// Phase 30.1 polish — honor DATA_DIR env var (set by E2E test server) so
// per-topic storage stays under the isolated test data dir instead of
// polluting the repo's `data/` folder. Falls back to `<cwd>/data/...` for
// production where DATA_DIR isn't set. Aligns with `topics.db` path.
const BASE_DIR = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "browser-state")
  : join(process.cwd(), "data", "browser-state");

function sanitize(topicId: string): string {
  // Same pattern as server/browser-service.ts:330. Prevents path traversal.
  return topicId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function topicDir(topicId: string): string {
  return join(BASE_DIR, sanitize(topicId));
}

function topicFile(topicId: string): string {
  return join(topicDir(topicId), "storage.json");
}

/**
 * Atomic write: tmp file + renameSync. Cleanup tmp on error.
 * Mirrors server/utils.ts:377 atomicWriteJSON pattern (which is
 * closure-bound and not exported as a free function).
 */
function atomicWriteJSON(filepath: string, data: object): void {
  const tempPath = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2));
    renameSync(tempPath, filepath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch {}
    throw err;
  }
}

export async function saveStorageState(
  topicId: string,
  state: BrowserStorageState,
): Promise<void> {
  const dir = topicDir(topicId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteJSON(topicFile(topicId), state);
}

export async function loadStorageState(
  topicId: string,
): Promise<BrowserStorageState | null> {
  const file = topicFile(topicId);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as BrowserStorageState;
  } catch (err) {
    console.warn(`[browser-state-store] Failed to load ${file}:`, err);
    return null;
  }
}

export async function deleteStorageState(topicId: string): Promise<void> {
  const file = topicFile(topicId);
  const dir = topicDir(topicId);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch {}
  }
  // Remove parent dir if empty (best effort).
  if (existsSync(dir)) {
    try {
      const entries = readdirSync(dir);
      if (entries.length === 0) rmdirSync(dir);
    } catch {}
  }
}

/**
 * Debounced saver: coalesces rapid trigger() calls into a single save
 * after delayMs of quiet. flush() saves immediately + clears pending
 * timer. cancel() clears timer without saving. Designed for use with
 * BrowserContext autosave on every navigation.
 *
 * IMPORTANT for callers using setInterval as the autosave heartbeat:
 * call `flush()` inside the setInterval callback, NOT `trigger()`.
 * Because `trigger()` re-arms the debounce timer on every call, a
 * setInterval that calls `trigger()` at the same period as the debounce
 * delay will keep pushing the deadline forward and never save anything.
 * `flush()` performs an immediate save (and clears any pending timer),
 * which is the desired heartbeat semantics.
 */
export function debouncedSaver(
  topicId: string,
  getState: () => Promise<BrowserStorageState>,
  delayMs: number,
): { trigger(): void; flush(): Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function doSave(): Promise<void> {
    timer = null;
    try {
      const state = await getState();
      await saveStorageState(topicId, state);
    } catch (err) {
      console.warn(`[browser-state-store] debouncedSaver(${topicId}) save failed:`, err);
    }
  }

  return {
    trigger(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void doSave(); }, delayMs);
    },
    async flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      await doSave();
    },
    cancel(): void {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
