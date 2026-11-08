/**
 * Login-state sharing between the Topics native pane and an optional external
 * companion browser tool. Both speak Playwright `storageState` JSON (cookies +
 * per-origin localStorage), so a handle saved by one side loads on the other —
 * WITHOUT routing the pane through the companion's daemon (file-format interop).
 *
 *   - Topics handles:    <DATA_DIR|data>/browser-state/_handles/<handle>.json
 *   - External handles:  <TOPICS_EXTERNAL_STATES_DIR>/<handle>.json  (opt-in)
 *
 * The external store is OPT-IN: it's used only when `TOPICS_EXTERNAL_STATES_DIR`
 * is set (or the legacy companion store already exists on this machine — see
 * `externalStatesDir`). When active, a handle is written to BOTH locations on
 * save, so an external tool can reuse a Topics login and vice versa. A fresh
 * install writes to the Topics store only — no external paths are created.
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
import { resolveDataDir, resolveStateDir } from "./lib/data-dir";

// Il formato sta in `shared/browser-login-state.ts`: lo leggono anche il client
// e (per struct gemella) il pane nativo in Rust.
// Si ri-esporta solo `StorageState`, l'unico che qualcuno importa da qui: le due
// forme interne (`StorageCookie`, `StorageOrigin`) si prendono da `shared/`, che
// è dove sono dichiarate e da dove già le importa il client.
export type { StorageState } from "../shared/browser-login-state";
import type { StorageState } from "../shared/browser-login-state";

/** Sanitize a handle to a safe single path segment (no traversal). */
export function safeHandle(handle: string): string {
  const h = String(handle).trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!h || h === "." || h === "..") throw new Error("invalid state handle");
  return h.slice(0, 128);
}

/**
 * Sanitize a handle the way common companion browser daemons do
 * (`String(s||"default").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,64)`), so a
 * handle written to the SHARED external store lands under the same filename the
 * companion tool will look for. Topics' own `safeHandle` keeps dots (so
 * "github.com" → "github.com.json" locally), but the companion convention
 * strips them ("github.com" → "github_com.json"). Using safeHandle for the
 * external copy would silently break cross-tool reuse for site-named handles;
 * this keeps the two sides byte-identical on the interop path.
 */
export function externalSanitizeHandle(handle: string): string {
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
  const base = join(resolveDataDir(resolveStateDir(process.cwd())), "browser-state");
  return join(base, "_handles");
}

/**
 * Resolve the OPT-IN external companion store, or null when there isn't one.
 *   1. `TOPICS_EXTERNAL_STATES_DIR` — explicit opt-in (also the test override).
 *   2. `JARVIS_STATES_DIR` — backward-compat alias for the original integration.
 *   3. A legacy companion store that already exists on this machine — so an
 *      existing zero-config setup keeps interoperating, while a fresh install
 *      (where the dir is absent) gets the Topics store only.
 * Returning null means "Topics store only" — nothing external is written/read.
 */
function externalStatesDir(): string | null {
  const configured =
    process.env.TOPICS_EXTERNAL_STATES_DIR || process.env.JARVIS_STATES_DIR;
  if (configured) return configured;
  const legacy = join(homedir(), ".claude", "jarvis", "state", "browser-states");
  return existsSync(legacy) ? legacy : null;
}

export function topicsStatePath(handle: string): string {
  return join(topicsStatesDir(), `${safeHandle(handle)}.json`);
}

/** Path in the external store, or null when no external store is active. */
export function externalStatePath(handle: string): string | null {
  // Validate for traversal via safeHandle, then map to the companion filename
  // so the shared store stays interoperable with the external tool.
  safeHandle(handle);
  const dir = externalStatesDir();
  if (!dir) return null;
  return join(dir, `${externalSanitizeHandle(handle)}.json`);
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
 * (now authenticated). Mirrors the companion daemon's loadState semantics.
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

/**
 * Persist a state under a handle to the Topics store, and — when an external
 * companion store is active — to that store too. `externalPath` is null on a
 * fresh install with no external store configured.
 */
export function saveStateToStores(handle: string, state: StorageState): {
  topicsPath: string;
  externalPath: string | null;
  localStorageCaptured: boolean;
} {
  const topicsPath = topicsStatePath(handle);
  const externalPath = externalStatePath(handle);
  writeStateFile(topicsPath, state);
  if (externalPath) {
    try {
      writeStateFile(externalPath, state);
    } catch {
      /* external dir may not be writable — Topics copy still saved */
    }
  }
  const localStorageCaptured = (state.origins ?? []).some(
    (o) => Array.isArray(o.localStorage) && o.localStorage.length > 0,
  );
  return { topicsPath, externalPath, localStorageCaptured };
}

/** Resolve a handle to a saved state — Topics store, or the external store. */
export function loadStateFromStores(
  handle: string,
  opts: { fromExternal?: boolean } = {},
): { state: StorageState; source: "topics" | "external" } | null {
  const externalPath = externalStatePath(handle);
  if (opts.fromExternal) {
    const s = externalPath ? readStateFile(externalPath) : null;
    return s ? { state: s, source: "external" } : null;
  }
  const t = readStateFile(topicsStatePath(handle));
  if (t) return { state: t, source: "topics" };
  const e = externalPath ? readStateFile(externalPath) : null;
  return e ? { state: e, source: "external" } : null;
}
