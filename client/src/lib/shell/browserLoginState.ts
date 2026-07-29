/**
 * Native-pane login-state shapes + helpers (Tauri).
 *
 * The server persists login state as Playwright `storageState` JSON
 * (server/browser-login-state.ts) — the SAME format the CDP path and an
 * optional external companion browser tool read/write, so a handle saved on any
 * surface loads on any other. The native pane's Rust cookie commands speak that SAME storageState
 * cookie shape (`browser_pane_get_cookies` returns a JSON string of them;
 * `browser_pane_set_cookies` takes them directly — see the `CookieJson` struct
 * in desktop-tauri/src-tauri/src/lib.rs, which mirrors `StorageCookie`). So no
 * cookie-format conversion is needed for save_state / load_state; the only
 * adaptation left is import_chrome, whose server-decrypted cookies arrive in the
 * CDP `Network.setCookies` shape (host-only cookies carry `url` instead of
 * `domain`) and must be normalized to a `domain` the Rust jar can address.
 * This module is the pure, unit-testable home for those shapes and helpers.
 */

// Il formato sta in `shared/browser-login-state.ts` — non è più uno specchio
// del server: è la stessa dichiarazione.
export type { StorageCookie, StorageOrigin, StorageState } from '../../../../shared/browser-login-state';
import type { StorageCookie } from '../../../../shared/browser-login-state';

/** Superset input `toCookieJson` accepts: a Playwright storage cookie (from a
 *  saved state) OR a CDP `Network.setCookies` param (from the server's Chrome
 *  decryption), which may carry `url` instead of `domain`. */
export interface PortableCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  url?: string;
  /** Epoch seconds (-1/absent = session). */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Portable cookie → storageState `CookieJson` (the shape the Rust
 * `browser_pane_set_cookies` command takes). Cookies from a saved state already
 * carry `domain` and pass straight through; CDP host-only cookies carry only a
 * `url`, so we derive the host from it (leading dot stripped — a host-only
 * cookie, which is exactly what a bare url without a dotted domain means). The
 * Rust side rejects a cookie with no domain, so an un-addressable cookie is
 * dropped here (returns null) rather than silently skipped downstream.
 */
export function toCookieJson(c: unknown): StorageCookie | null {
  const p = c as PortableCookie | null;
  if (!p || typeof p.name !== 'string' || typeof p.value !== 'string') return null;
  const path = typeof p.path === 'string' && p.path ? p.path : '/';
  let domain = typeof p.domain === 'string' && p.domain ? p.domain : '';
  if (!domain && typeof p.url === 'string' && p.url) {
    try {
      // Host-only cookie: the host addresses it, no leading dot (a dot would
      // make it a domain cookie, which the CDP `url` form is NOT).
      domain = new URL(p.url).hostname;
    } catch {
      /* unparseable url → no domain → dropped below */
    }
  }
  if (!domain) return null;
  const out: StorageCookie = {
    name: p.name,
    value: p.value,
    domain,
    path,
    httpOnly: !!p.httpOnly,
    secure: !!p.secure,
  };
  // -1/absent = session cookie; the Rust side omits Expires for expires <= 0.
  out.expires = typeof p.expires === 'number' && p.expires > 0 ? p.expires : -1;
  if (p.sameSite === 'Strict' || p.sameSite === 'Lax' || p.sameSite === 'None') {
    out.sameSite = p.sameSite;
  }
  return out;
}

/** True only for http/https URLs — mirror of server/browser-login-state.ts:
 *  never auto-navigate to a non-web origin from a (peer-supplied) state file. */
export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol.toLowerCase();
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** In-page JS capturing the CURRENT origin's localStorage as a StorageOrigin
 *  JSON string ('null' off-http or on error). */
export const CAPTURE_LOCAL_STORAGE_JS =
  `JSON.stringify((function(){try{` +
  `if(!/^https?:$/.test(location.protocol))return null;` +
  `var items=[];for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);` +
  `if(k!=null)items.push({name:k,value:localStorage.getItem(k)||''})}` +
  `return{origin:location.origin,localStorage:items}}catch(e){return null}})())`;

/** In-page JS seeding the given localStorage items (quota/security failures are
 *  skipped per item, like the server's applyStateToPage evaluate). */
export function setLocalStorageJs(items: Array<{ name: string; value: string }>): string {
  return (
    `(function(items){var n=0;for(var i=0;i<items.length;i++){` +
    `try{localStorage.setItem(items[i].name,items[i].value);n++}catch(e){}}` +
    `return String(n)})(${JSON.stringify(items)})`
  );
}
