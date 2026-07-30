// Server origin resolution across hosts (PORTING-PLAN.md Tier 1).
//
// On web / PWA / Electron the server serves the UI same-origin, so API and WS use
// relative / page-derived URLs (unchanged behaviour). The Tauri desktop shell
// serves the UI LOCALLY from tauri://localhost (the only origin Tauri injects its
// native IPC into — verified), so the data server is reached at an absolute
// origin. These helpers are the single place that knows the difference.

import { isTauri } from './index';
import { getPairingToken, withTokenHeader, withTokenQuery } from './pairing';

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

/** Test-only: dimentica che lo shim è stato installato, così un test può provare
 *  il gate con e senza token nello stesso processo. */
export function __resetNetShimForTests(): void {
  shimInstalled = false;
}

/**
 * Shim globale su `fetch` + `EventSource`. Fa DUE cose, per due ragioni diverse,
 * e si installa se serve almeno una delle due:
 *
 * 1. **Riscrittura URL (solo Tauri).** Sotto Tauri la UI è servita da
 *    `tauri://localhost`, quindi le decine di `fetch('/api/…')` relative
 *    risolverebbero contro l'origine locale e fallirebbero: il leading-'/' va
 *    riscritto verso l'origine del data server. Su web `serverHttpBase()` è `''`,
 *    quindi questa parte è già un no-op per costruzione.
 *
 * 2. **Token di pairing (chiunque ne abbia uno).** Un dispositivo remoto paiato
 *    deve presentare `x-topics-token` su OGNI chiamata mutante, e nel client ce
 *    ne sono 80 su `/api` — 46 mutanti — sparse in oltre 20 file: i sync del
 *    pane-store, i tombstone, il layout di progetto, le tab del browser del task
 *    usano `fetch` NUDO con header propri, perché devono aggiungere
 *    `X-Client-Id` e usare `keepalive`. Non passano da `api.ts::request`, quindi
 *    `withTokenHeader` là dentro non li copre.
 *
 * Il gate era `!isTauri → esci`, e questo lasciava la PWA in LAN — l'unico caso
 * per cui il token esiste — senza token su tutti quei percorsi: 401 sul sync
 * delle tab, cioè la rottura che LAN-PAIR-01 doveva chiudere. Ora si installa
 * anche fuori da Tauri quando un token è memorizzato. Su web SENZA token non si
 * installa affatto: il browser locale sull'origine del server resta identico a
 * prima, senza monkey-patch.
 *
 * Va chiamata una volta all'avvio, DOPO `capturePairingTokenFromUrl()` — il gate
 * legge il token, che quella funzione ha appena messo in storage.
 *
 * I callsite WebSocket usano `serverWsBase()` + `withTokenQuery` espliciti (un
 * WebSocket non è shimmabile con la stessa pulizia).
 */
export function installNetShim(): void {
  if (shimInstalled || typeof window === 'undefined') return;
  // Serve per la riscrittura (Tauri) o per il token (dispositivo paiato). Se
  // nessuna delle due, meglio nessun shim.
  if (!isTauri && getPairingToken() === null) return;
  shimInstalled = true;
  const base = serverHttpBase();
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    // LAN-PAIR-01: attach the pairing token as `x-topics-token` on rewritten
    // `/…` calls (inert on desktop/loopback where no token is stored — kept for
    // symmetry with the api.ts fetch path). Only the leading-'/' (server-bound)
    // calls get the header; foreign absolute URLs pass through untouched.
    if (typeof input === 'string' && input.startsWith('/')) {
      return orig(base + input, { ...init, headers: withTokenHeader(init?.headers) });
    }
    if (input instanceof Request && input.url.startsWith('/')) {
      const req = new Request(base + input.url, input);
      // Merge the token over the effective headers: init.headers wins over the
      // Request's own, matching the original `orig(req, init)` precedence.
      const headers = withTokenHeader(init?.headers ?? req.headers);
      return orig(req, { ...init, headers });
    }
    return orig(input, init);
  };

  // EventSource (SSE) ha lo stesso problema di URL relativo della fetch — sotto
  // Tauri un '/api/activity/stream' nudo risolverebbe contro tauri://localhost
  // (nessun server) e il feed sarebbe morto — e lo stesso problema di token della
  // fetch: un dispositivo paiato deve presentarlo, e SSE non porta header, quindi
  // va in query. EventSource è un costruttore, quindi si sottoclassa.
  const OrigES = window.EventSource;
  if (OrigES) {
    class ShimmedEventSource extends OrigES {
      constructor(url: string | URL, init?: EventSourceInit) {
        const rewritten = typeof url === 'string' && url.startsWith('/') ? base + url : url;
        super(typeof rewritten === 'string' ? withTokenQuery(rewritten) : rewritten, init);
      }
    }
    window.EventSource = ShimmedEventSource as typeof EventSource;
  }
}
