// Server origin resolution across hosts (PORTING-PLAN.md Tier 1).
//
// On web / PWA / Electron the server serves the UI same-origin, so API and WS use
// relative / page-derived URLs (unchanged behaviour). The Tauri desktop shell
// serves the UI LOCALLY from tauri://localhost (the only origin Tauri injects its
// native IPC into — verified), so the data server is reached at an absolute
// origin. These helpers are the single place that knows the difference.

import { isTauri } from './index';

// The data server (Bun) the desktop shell connects to. Single constant so the
// host/port/scheme is trivial to change (e.g. when TLS is enabled on :3333).
const DESKTOP_SERVER_HOST = '127.0.0.1:3333';
const DESKTOP_SERVER_HTTP = `http://${DESKTOP_SERVER_HOST}`;
const DESKTOP_SERVER_WS = `ws://${DESKTOP_SERVER_HOST}`;

/** HTTP base for the data server: '' (same-origin) off-desktop, absolute on Tauri. */
export function serverHttpBase(): string {
  return isTauri ? DESKTOP_SERVER_HTTP : '';
}

/** WebSocket base, e.g. 'ws://127.0.0.1:3333' (Tauri) or '<proto>//<host>' (web). */
export function serverWsBase(): string {
  if (isTauri) return DESKTOP_SERVER_WS;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

let shimInstalled = false;
/** Under Tauri the UI is served from tauri://localhost, so the many relative
 *  `fetch('/api/…')` callsites would resolve against the local origin and fail.
 *  This installs a one-time global fetch shim that rewrites leading-'/' request
 *  URLs to the data server origin. No-op off-desktop, so web/Electron are
 *  untouched. WebSocket callsites use serverWsBase() explicitly (not shimmable
 *  as cleanly). Call once at app startup. */
export function installDesktopFetchShim(): void {
  if (shimInstalled || !isTauri || typeof window === 'undefined') return;
  shimInstalled = true;
  const base = serverHttpBase();
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return orig(base + input, init);
    }
    if (input instanceof Request && input.url.startsWith('/')) {
      return orig(new Request(base + input.url, input), init);
    }
    return orig(input, init);
  };
}
