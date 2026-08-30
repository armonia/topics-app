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

// The two loopback ports this app answers on: the shell's TLS proxy (PROXY_PORT
// in src-tauri/src/lib.rs) and the data server behind it (DEFAULT_UPSTREAM_PORT).
// A permalink copied anywhere in the app is born on one of the two — the shell
// can only offer 13333 (its webview knows no other door), the web client and the
// agent tool descriptions say 3333.
const APP_LOOPBACK_PORTS = new Set(['13333', '3333']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * True when `origin` is THIS app reached over loopback, on either of its ports.
 *
 * It does not claim the origin is reachable from here — it claims the link
 * SPEAKS OF this server, so the path can be resolved against the current origin
 * instead of being handed to the system browser. Which is what the boot path
 * already does: `consumeTabLinkFromUrl` reads `location.pathname` and never
 * looks at the origin at all. Only the CLICK path disagreed, and the price was
 * a permalink copied in the desktop shell opening a SECOND FULL COPY of Topics
 * in a browser tab — same WebSocket, same pane-store — instead of switching tab.
 *
 * Deliberately narrow: loopback hosts only, and only our own two ports.
 * A wider rule (any loopback port) would swallow a link pointing at some other
 * local dev server that happens to use our path grammar.
 */
export function isAppLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(u.hostname) && APP_LOOPBACK_PORTS.has(u.port);
  } catch {
    return false;
  }
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
 * Shim globale su `fetch` + `EventSource`: riscrive gli URL relativi verso
 * l'origine del data server.
 *
 * Serve SOLO sotto Tauri, dove la UI è servita da `tauri://localhost`: le decine
 * di `fetch('/api/…')` relative risolverebbero contro l'origine locale — che non
 * ha un server — e fallirebbero. Su web `serverHttpBase()` è `''`, quindi la
 * riscrittura sarebbe un no-op per costruzione e lo shim non si installa affatto:
 * il browser sull'origine del server resta senza monkey-patch.
 *
 * Ha portato per un periodo anche il token di pairing, che è stata la ragione per
 * cui si installava pure fuori da Tauri: nel client ci sono ~80 chiamate `/api`,
 * 46 mutanti, sparse in oltre 20 file, e le più calde — sync del pane-store,
 * tombstone, layout di progetto, tab del browser del task — usano `fetch` NUDO
 * con header propri (`X-Client-Id`, `keepalive`) e non passano da
 * `api.ts::request`. Il token non esiste più (change `lan-open-same-origin`), ma
 * quel fatto resta vero: **questo è l'unico choke point** che le vede tutte. Se
 * l'autenticazione centralizzata dovrà attaccare un header di sessione, si
 * attacca qui — non nei 46 callsite.
 *
 * Va chiamata una volta all'avvio. I callsite WebSocket usano `serverWsBase()`
 * esplicito: un WebSocket non è shimmabile con la stessa pulizia.
 */
export function installNetShim(): void {
  if (shimInstalled || typeof window === 'undefined') return;
  // Fuori da Tauri la riscrittura è un no-op: nessuno shim.
  if (!isTauri) return;
  shimInstalled = true;
  const base = serverHttpBase();
  const orig = window.fetch.bind(window);
  const rewriting = (input: RequestInfo | URL, init?: RequestInit) => {
    // Solo le chiamate col leading-'/' (dirette al server) vengono riscritte; un
    // URL assoluto verso un'altra origine passa intatto.
    if (typeof input === 'string' && input.startsWith('/')) {
      return orig(base + input, init);
    }
    if (input instanceof Request && input.url.startsWith('/')) {
      return orig(new Request(base + input.url, input), init);
    }
    return orig(input, init);
  };
  // `Object.assign` e non un'assegnazione nuda: questo shim è un INVOLUCRO
  // attorno a `fetch`, non un rimpiazzo. `fetch` può portarsi dietro proprietà
  // statiche (in Bun c'è `fetch.preconnect`, e nulla vieta a una piattaforma di
  // aggiungerne), e sostituirlo con una funzione nuda le cancellerebbe per tutta
  // l'app — silenziosamente, perché nessuno le legge da qui. Copiarle è anche
  // ciò che rende l'assegnazione vera per il tipo: senza, `window.fetch` (che
  // dichiara quelle statiche) non accetta la funzione sola. Nel browser oggi
  // `fetch` non ha proprietà proprie enumerabili, quindi a runtime è un no-op.
  window.fetch = Object.assign(rewriting, window.fetch);

  // EventSource (SSE) ha lo stesso problema di URL relativo della fetch: sotto
  // Tauri un '/api/activity/stream' nudo risolverebbe contro tauri://localhost,
  // dove non c'è nessun server, e il feed sarebbe morto. EventSource è un
  // costruttore, quindi si sottoclassa.
  const OrigES = window.EventSource;
  if (OrigES) {
    class ShimmedEventSource extends OrigES {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(typeof url === 'string' && url.startsWith('/') ? base + url : url, init);
      }
    }
    window.EventSource = ShimmedEventSource as typeof EventSource;
  }
}
