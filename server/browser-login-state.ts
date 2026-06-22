/**
 * Login-state sharing between the Topics native pane and Jarvis browser
 * sessions. Both speak Playwright `storageState` JSON (cookies + per-origin
 * localStorage), so a handle saved by one side loads on the other — WITHOUT
 * routing the pane through the Jarvis daemon (Approach A: file-format interop).
 *
 *   - Topics handles:  <DATA_DIR|data>/browser-state/_handles/<handle>.json
 *   - Jarvis handles:  ~/.claude/jarvis/state/browser-states/<handle>.json
 *
 * A handle is written to BOTH locations on save, so `jbrowser load-state <h>`
 * (and the daemon's loadState RPC) can reuse a Topics login and vice versa.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  chmodSync,
} from "node:fs";
import type { Page, BrowserContext } from "playwright-core";

export interface StorageCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}
export interface StorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}
export interface StorageState {
  cookies: StorageCookie[];
  origins: StorageOrigin[];
}

/** Sanitize a handle to a safe single path segment (no traversal). */
export function safeHandle(handle: string): string {
  const h = String(handle).trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!h || h === "." || h === "..") throw new Error("invalid state handle");
  return h.slice(0, 128);
}

function topicsStatesDir(): string {
  const base = process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "browser-state")
    : join(process.cwd(), "data", "browser-state");
  return join(base, "_handles");
}

function jarvisStatesDir(): string {
  // Overridable for tests so they never touch the real Jarvis store.
  if (process.env.JARVIS_STATES_DIR) return process.env.JARVIS_STATES_DIR;
  return join(homedir(), ".claude", "jarvis", "state", "browser-states");
}

export function topicsStatePath(handle: string): string {
  return join(topicsStatesDir(), `${safeHandle(handle)}.json`);
}
export function jarvisStatePath(handle: string): string {
  return join(jarvisStatesDir(), `${safeHandle(handle)}.json`);
}

/** Atomic, 0600 write of a storageState JSON (it holds decrypted cookies). */
function writeStateFile(path: string, state: StorageState): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function readStateFile(path: string): StorageState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StorageState;
    if (!parsed || !Array.isArray(parsed.cookies)) return null;
    if (!Array.isArray(parsed.origins)) parsed.origins = [];
    return parsed;
  } catch {
    return null;
  }
}

/** Export the live context's storageState (cookies + visited-origin localStorage). */
export async function exportStateFromContext(
  context: BrowserContext,
): Promise<StorageState> {
  return (await context.storageState()) as StorageState;
}

/**
 * Inject a saved storageState into the live pane: cookies first (batch, then
 * per-cookie fallback for any the browser rejects), then per-origin
 * localStorage (requires visiting the origin), then return to the original page
 * (now authenticated). Mirrors the Jarvis daemon's loadState semantics.
 */
export async function applyStateToPage(
  page: Page,
  state: StorageState,
): Promise<{ cookies: number; origins: number }> {
  const context = page.context();
  const origUrl = page.url();

  let cookieCount = 0;
  if (Array.isArray(state.cookies) && state.cookies.length) {
    try {
      await context.addCookies(state.cookies as never);
      cookieCount = state.cookies.length;
    } catch {
      // Batch rejected (one bad cookie fails all) — add individually.
      for (const c of state.cookies) {
        try {
          await context.addCookies([c] as never);
          cookieCount++;
        } catch {
          /* skip the offending cookie */
        }
      }
    }
  }

  let originCount = 0;
  for (const o of state.origins ?? []) {
    if (!o.origin || !Array.isArray(o.localStorage) || !o.localStorage.length) continue;
    try {
      await page.goto(o.origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.evaluate((items: Array<{ name: string; value: string }>) => {
        for (const it of items) {
          try { localStorage.setItem(it.name, it.value); } catch { /* quota/security */ }
        }
      }, o.localStorage);
      originCount++;
    } catch {
      /* origin unreachable — cookies still applied */
    }
  }

  // Return to where the pane was (now logged in), or reload if it was blank.
  try {
    if (origUrl && !origUrl.startsWith("about:") && !origUrl.startsWith("data:")) {
      await page.goto(origUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } else {
      await page.reload().catch(() => {});
    }
    // Ensure the page is fully settled before we return, so the agent's next
    // read (observe/eval/get_text) can't land mid-navigation ("Execution
    // context was destroyed") — real login pages often redirect after the
    // cookie/localStorage land.
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
  } catch {
    /* navigation best-effort */
  }
  return { cookies: cookieCount, origins: originCount };
}

/** Persist a state under a handle to BOTH the Topics and Jarvis stores. */
export function saveStateToStores(handle: string, state: StorageState): {
  topicsPath: string;
  jarvisPath: string;
  localStorageCaptured: boolean;
} {
  const topicsPath = topicsStatePath(handle);
  const jarvisPath = jarvisStatePath(handle);
  writeStateFile(topicsPath, state);
  try {
    writeStateFile(jarvisPath, state);
  } catch {
    /* Jarvis dir may not exist / be writable — Topics copy still saved */
  }
  const localStorageCaptured = (state.origins ?? []).some(
    (o) => Array.isArray(o.localStorage) && o.localStorage.length > 0,
  );
  return { topicsPath, jarvisPath, localStorageCaptured };
}

/** Resolve a handle to a saved state — Topics store, or Jarvis store. */
export function loadStateFromStores(
  handle: string,
  opts: { fromJarvis?: boolean } = {},
): { state: StorageState; source: "topics" | "jarvis" } | null {
  if (opts.fromJarvis) {
    const s = readStateFile(jarvisStatePath(handle));
    return s ? { state: s, source: "jarvis" } : null;
  }
  const t = readStateFile(topicsStatePath(handle));
  if (t) return { state: t, source: "topics" };
  const j = readStateFile(jarvisStatePath(handle));
  return j ? { state: j, source: "jarvis" } : null;
}
