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
import { resolveStateDir } from "./lib/data-dir";

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

/**
 * Sanitize a handle EXACTLY the way the Jarvis daemon does
 * (`jarvis-browser/daemon.mjs`: `String(s||"default").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,64)`),
 * so a handle written to the SHARED Jarvis store lands under the same filename
 * `jbrowser load-state <handle>` will look for. Topics' own `safeHandle` keeps
 * dots (so "github.com" → "github.com.json" locally), but Jarvis strips them
 * ("github.com" → "github_com.json"). Using safeHandle for the Jarvis copy
 * silently broke cross-tool reuse for site-named handles; this keeps the two
 * sides byte-identical on the interop path. Mirror daemon.mjs verbatim.
 */
export function jarvisSanitizeHandle(handle: string): string {
  return (
    String(handle || "default")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64) || "default"
  );
}

/** True only for http/https origins — the schemes that carry web localStorage
 *  and the only ones we'll auto-navigate to when applying a saved state. */
function isHttpOrigin(url: string): boolean {
  try {
    const p = new URL(url).protocol.toLowerCase();
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

function topicsStatesDir(): string {
  const base = process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "browser-state")
    : join(resolveStateDir(process.cwd()), "data", "browser-state");
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
  // Validate for traversal via safeHandle, then map to the JARVIS filename so
  // the shared store stays interoperable with `jbrowser load-state`.
  safeHandle(handle);
  return join(jarvisStatesDir(), `${jarvisSanitizeHandle(handle)}.json`);
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
    // A storageState file is agent/peer-supplied data: never navigate to a
    // non-web origin (e.g. a planted `file:///etc/passwd`) just to seed its
    // localStorage. Only http(s) origins carry web localStorage anyway.
    if (!isHttpOrigin(o.origin)) continue;
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
    if (origUrl && isHttpOrigin(origUrl)) {
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
