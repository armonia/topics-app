// Server origin resolution across hosts (PORTING-PLAN.md Tier 1).
//
// On web / PWA / Electron the server serves the UI same-origin, so API and WS use
// relative / page-derived URLs (unchanged behaviour). The Tauri desktop shell
// serves the UI LOCALLY from tauri://localhost (the only origin Tauri injects its
// native IPC into — verified), so the data server is reached at an absolute
// origin. These helpers are the single place that knows the difference.

import { isTauri } from './index';

// The data server (Bun) serves HTTPS/WSS with a local-CA ("Armonia Local CA")
// certificate. WKWebView (the Tauri shell's engine) refuses that cert, so the
// shell does NOT hit :3333 directly. Instead the Rust side runs a loopback
// TLS-origination proxy (src-tauri/src/lib.rs `run_tls_proxy`) on this port: the
// webview speaks plain HTTP/WS to it, and the proxy adds the TLS to reach :3333.
// Plain HTTP/WS to loopback is something WKWebView accepts, so this sidesteps the
// cert-trust problem without weakening system trust. Keep the port in sync with
// PROXY_PORT in lib.rs.
const DESKTOP_SERVER_HOST = '127.0.0.1:13333';
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

  // EventSource (SSE) has the same relative-URL problem as fetch — a bare
  // '/api/activity/stream' would resolve against tauri://localhost (no server)
  // and the activity feed would be dead. EventSource is a constructor, so we
  // subclass it to rewrite leading-'/' URLs to the data-server origin.
  const OrigES = window.EventSource;
  if (OrigES) {
    class DesktopEventSource extends OrigES {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(typeof url === 'string' && url.startsWith('/') ? base + url : url, init);
      }
    }
    window.EventSource = DesktopEventSource as typeof EventSource;
  }
}
