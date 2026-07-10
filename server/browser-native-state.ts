/**
 * Tauri native-pane login-state ops (browser_save_state / browser_load_state /
 * browser_import_chrome).
 *
 * The WKWebView pane has no CDP endpoint and no disk access, so these ops split
 * across the delegation seam exactly like browser_upload and the vision ops:
 * everything that needs the SERVER stays here — handle persistence in the
 * Topics + external stores (browser-login-state.ts, the SAME Playwright
 * storageState JSON the CDP and external companion surfaces use, so a handle
 * saved on the native pane loads anywhere) and the Chrome-cookie Keychain decryption
 * (integrations/chrome-cookies.ts) — while only the pane-local legs (cookie
 * store read/write via the native `browser_pane_get_cookies` /
 * `browser_pane_set_cookies` commands, localStorage via eval) are delegated to
 * the client executor (client/src/lib/shell/tauriBrowserOps.ts) over
 * /ws/browser. Deps are injectable so the flows are unit-tested without a
 * Keychain or a live pane.
 */
import {
  nativeDelegateRegistry,
  type NativeDelegateRegistry,
} from "./browser-native-delegate";
import {
  safeHandle,
  saveStateToStores,
  loadStateFromStores,
  type StorageState,
} from "./browser-login-state";
import { decryptChromeCookies, listChromeCookieHosts } from "./integrations/chrome-cookies";

export interface NativeStateDeps {
  registry?: NativeDelegateRegistry;
  decryptChrome?: typeof decryptChromeCookies;
  listChromeHosts?: typeof listChromeCookieHosts;
}

/** The three ops nativeStateOp handles for a delegated (native Tauri) context. */
export function isNativeStateOp(toolName: string): boolean {
  return (
    toolName === "browser_save_state" ||
    toolName === "browser_load_state" ||
    toolName === "browser_import_chrome"
  );
}

/** Validate the client's exported state into a StorageState (or null). */
function coerceStorageState(raw: unknown): StorageState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(s.cookies)) return null;
  return {
    cookies: s.cookies as StorageState["cookies"],
    origins: Array.isArray(s.origins) ? (s.origins as StorageState["origins"]) : [],
  };
}

/**
 * Server-side half of the native login-state ops. Return shapes mirror the
 * CDP/Playwright handlers (browser-tools-handler.ts) 1:1, so the agent sees the
 * IDENTICAL result whether the pane is native or streaming. Throws ONLY for
 * input validation (dispatcher contract); runtime failures come back as
 * structured `{ error }`.
 */
export async function nativeStateOp(
  toolName: string,
  args: Record<string, unknown>,
  contextId: string,
  deps: NativeStateDeps = {},
): Promise<unknown> {
  const registry = deps.registry ?? nativeDelegateRegistry;

  if (toolName === "browser_save_state") {
    if (typeof args?.handle !== "string" || !args.handle.trim()) {
      throw new Error("browser_save_state: 'handle' (string) is required");
    }
    const handle = safeHandle(args.handle);
    console.log(`[BrowserTools] browser_save_state(${contextId}, ${handle}) [native]`);
    const res = await registry.delegateOp(contextId, "browser_save_state", {});
    if (res && typeof res === "object" && "error" in res) return res;
    const state = coerceStorageState(res);
    if (!state) return { error: "browser_save_state failed: native pane returned a malformed state" };
    const { localStorageCaptured } = saveStateToStores(handle, state);
    const out: { ok: true; handle: string; cookies: number; origins: number; localStorageCaptured: boolean; warning?: string } = {
      ok: true,
      handle,
      cookies: state.cookies.length,
      origins: state.origins.length,
      localStorageCaptured,
    };
    if (!localStorageCaptured) {
      out.warning =
        "No localStorage captured — for token-in-localStorage logins (Firebase/Supabase/Auth0), save while ON the site so its origin is captured.";
    }
    return out;
  }

  if (toolName === "browser_load_state") {
    if (typeof args?.handle !== "string" || !args.handle.trim()) {
      throw new Error("browser_load_state: 'handle' (string) is required");
    }
    const handle = safeHandle(args.handle);
    // `from_jarvis` accepted as a deprecated alias of `from_external`.
    const fromExternal = !!(args.from_external ?? args.from_jarvis);
    const loaded = loadStateFromStores(handle, { fromExternal });
    if (!loaded) {
      return {
        error: `browser_load_state: no saved state for handle "${handle}"${fromExternal ? " in the external store" : ""}.`,
      };
    }
    console.log(`[BrowserTools] browser_load_state(${contextId}, ${handle}, source=${loaded.source}) [native]`);
    const res = await registry.delegateOp(contextId, "browser_load_state", { state: loaded.state });
    if (res && typeof res === "object" && "error" in res) return res;
    const applied = res as { cookies?: unknown; origins?: unknown } | null;
    return {
      ok: true as const,
      handle,
      source: loaded.source,
      cookies: typeof applied?.cookies === "number" ? applied.cookies : 0,
      origins: typeof applied?.origins === "number" ? applied.origins : 0,
    };
  }

  // browser_import_chrome — same consent model as the Electron path: reads ONLY
  // the Chrome cookie store (never saved passwords); the Keychain prompt is the
  // gate. dry_run never touches the Keychain.
  const domains = Array.isArray(args?.domains) ? (args.domains as unknown[]).map(String) : [];
  const profile = typeof args?.profile === "string" && args.profile ? args.profile : "Default";
  if (args?.dry_run) {
    return (deps.listChromeHosts ?? listChromeCookieHosts)({ domains, profile });
  }
  if (!domains.length) {
    throw new Error(
      'browser_import_chrome: "domains" (non-empty array) is required, e.g. ["youtube.com"]. Use dry_run:true to list importable hosts first.'
    );
  }
  console.log(`[BrowserTools] browser_import_chrome(${contextId}, domains=${domains.join(",")}) [native]`);
  const { cookies, decrypted, decryptFailed, skippedEmpty, appBoundEncrypted, profile: p } =
    await (deps.decryptChrome ?? decryptChromeCookies)({ domains, profile });
  if (!cookies.length) {
    return { ok: true, imported: 0, note: "no matching cookies (none found, all expired, or App-Bound encrypted)", appBoundEncrypted };
  }
  const res = await registry.delegateOp(contextId, "browser_import_chrome", { cookies });
  if (res && typeof res === "object" && "error" in res) return res;
  // Prefer the pane's REAL landed count (its batch → per-cookie fallback may
  // legitimately drop rejects); fall back to the decrypted count.
  const injected = (res as { imported?: unknown } | null)?.imported;
  const out: Record<string, unknown> = {
    ok: true,
    profile: p,
    imported: typeof injected === "number" ? injected : decrypted,
    decryptFailed,
    skippedEmpty,
  };
  if (appBoundEncrypted) out.appBoundEncrypted = appBoundEncrypted;
  return out;
}
