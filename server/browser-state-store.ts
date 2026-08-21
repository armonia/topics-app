import type { BrowserContext } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync, rmdirSync, readdirSync, chmodSync } from "fs";
import { join } from "path";
import { resolveStateDir } from "./lib/data-dir";

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
/* READ PER CALL, NOT FROZEN AT IMPORT.
 *
 * This was a module-level `const`, and a `const` here means the directory is
 * decided by whatever `DATA_DIR` happened to be set when the FIRST importer
 * loaded this module. Under `bun test` that is the first test file in the run
 * that pulls it in, alphabetically, which is a different file depending on
 * which tests you run: the module froze one path while a test that sets its own
 * `DATA_DIR` in `beforeEach` computed another, and the two stopped agreeing.
 *
 * The symptom is the nastiest shape there is: `browser-state-store.test.ts`
 * green on its own, red in the full suite, and red only in CI, because there
 * the run includes the file that imports this one first. Measured 2026-08-21:
 * adding `browser-last-url-expiry.test.ts` (which sorts BEFORE the store's own
 * test) turned 6 of its cases red without touching a line of what they test.
 *
 * A function costs a `join` per call and cannot drift. See
 * `tests/setup/bun-test-preload.ts` for the other half of this class of bug. */
export function browserStateBaseDir(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "browser-state")
    : join(resolveStateDir(process.cwd()), "data", "browser-state");
}

function sanitize(topicId: string): string {
  // Same pattern as server/browser-service.ts:330. Prevents path traversal.
  return topicId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function topicDir(topicId: string): string {
  return join(browserStateBaseDir(), sanitize(topicId));
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
    // 0600 come il file dei login sotto `_handles` (browser-login-state.ts:117):
    // `storage.json` contiene cookie di sessione IN CHIARO, e da quando il
    // passaggio nativa→condivisa esiste ci finiscono anche quelli della
    // WKWebView del Mac. Il default di umask lo lasciava leggibile a chiunque
    // abbia un account su questa macchina — due file con lo stesso contenuto e
    // due permessi diversi non era una decisione, era una svista.
    writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tempPath, filepath);
    try { chmodSync(filepath, 0o600); } catch { /* best effort */ }
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

// ── Last-URL persistence ─────────────────────────────────────────────────────
// A context recreated under the same id (server restart, inactivity reap)
// comes up about:blank even though the PANE remembers its url — the page has
// to come back by itself for browser tabs to match chat tabs ("riavvia l'app
// e continua"). Stored next to storage.json so it shares the context's
// storage lifecycle (survives destroyContext, removed with deleteStorageState).

function lastUrlFile(topicId: string): string {
  return join(topicDir(topicId), "last-url.json");
}

/** Only http(s) pages are worth restoring — about:blank / chrome-error /
 *  devtools schemes would clobber the good url or fail to load. */
function isRestorableUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

/** Persist the context's last real page URL (best-effort, atomic). */
export function saveLastUrl(topicId: string, url: string): void {
  if (!isRestorableUrl(url)) return;
  try {
    const dir = topicDir(topicId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteJSON(lastUrlFile(topicId), { url, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn(`[browser-state-store] saveLastUrl(${topicId}) failed:`, err);
  }
}

/** Read the persisted last URL for a context id (null when none/invalid). */
export function loadLastUrl(topicId: string): string | null {
  const file = lastUrlFile(topicId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { url?: unknown };
    return isRestorableUrl(parsed.url) ? parsed.url : null;
  } catch {
    return null;
  }
}

/**
 * Read the last-url entry (url + updatedAt) for a context id. Unlike
 * `loadLastUrl`, it also surfaces the recency stamp so callers can bound a
 * bulk restore (e.g. restoreAllContexts) to the most-recently-active contexts
 * instead of eagerly re-launching every context that ever had a page — a boot
 * storm over hundreds of stale contexts. `updatedAt` is epoch ms (0 if the file
 * predates the stamp). Returns null when there's nothing restorable on disk.
 */
export function readLastUrlEntry(topicId: string): { url: string; updatedAt: number } | null {
  const file = lastUrlFile(topicId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { url?: unknown; updatedAt?: unknown };
    if (!isRestorableUrl(parsed.url)) return null;
    const ts = typeof parsed.updatedAt === "string" ? Date.parse(parsed.updatedAt) : NaN;
    return { url: parsed.url, updatedAt: Number.isFinite(ts) ? ts : 0 };
  } catch {
    return null;
  }
}

/**
 * Is this last-url worth keeping after a failed restore?
 *
 * A restore that fails is not by itself proof the url is dead: the machine can
 * be offline, DNS can be down, a site can be having a bad minute. Forgetting on
 * the first failure would throw away a good page for a transient reason.
 *
 * One case IS permanent, and it is the one that fills the log. A url on
 * loopback or a private LAN address is a dev server or a task preview: when the
 * process that served it ends, that port does not come back, and nothing else
 * on the machine will ever answer for it. Measured on 2026-08-21 in
 * `topics-server.log`: 5,665 `last-url restore failed`, 5,305 of them
 * ERR_CONNECTION_REFUSED, with 1,380 attempts on a single dead preview port.
 * Every context creation paid an 8s timeout for a page that was never coming
 * back, and `entry.url` kept claiming the pane was on it.
 *
 * So the rule is narrow on purpose, and it needs BOTH halves: a private host
 * AND an error that says nothing is listening. A public site that refuses a
 * connection is still remembered.
 */
export function shouldForgetLastUrl(url: string, errorMessage: string): boolean {
  if (!isPrivateHostUrl(url)) return false;
  return /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_ADDRESS_UNREACHABLE|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(
    errorMessage,
  );
}

/**
 * A host only this machine (or this LAN) can answer for. Deliberately the same
 * list the client already refuses to seed (`isSeedableUrl` in
 * `RemoteBrowserPanel.tsx`): the two ends have to agree on what "not publicly
 * reachable" means, or the server forgets a url the client puts straight back.
 */
function isPrivateHostUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "0.0.0.0" || lower === "::1") return true;
  if (lower.endsWith(".local") || lower.endsWith(".localhost")) return true;
  if (!host.includes(":") && !host.includes(".")) return true; // bare hostname
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/** Forget the persisted last URL for a context (no-op when there is none). */
export function clearLastUrl(topicId: string): void {
  try { unlinkSync(lastUrlFile(topicId)); } catch {}
}

export async function deleteStorageState(topicId: string): Promise<void> {
  // The last-url rides the same lifecycle as storage.json: an explicitly
  // deleted state must not resurrect the old page on a future same-id context.
  try { unlinkSync(lastUrlFile(topicId)); } catch {}
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
