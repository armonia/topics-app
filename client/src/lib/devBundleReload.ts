import { subscribeFrames } from './wsFrameBus';

/**
 * Dev bundle freshness, client half (server half:
 * server/lib/dev-bundle-reload.ts). Two frames tell a window that the built
 * bundle on disk has moved past what it's running:
 *
 * - `ui:bundle-updated` (broadcast at deploy time): /public changed on disk.
 * - `ui:bundle-rev` (sent to each client on WS connect): freshness check for
 *   windows that MISSED the deploy broadcast — opened before the dev flag,
 *   disconnected during the rsync, or alive across a server restart.
 *
 * Both carry the server's bundle rev (sorted /assets/index-* names from its
 * index.html); we compare against OUR OWN rev read from the live
 * <script>/<link> tags. Same rev → nothing to do. Different rev → a newer
 * build exists.
 *
 * NO AUTO-RELOAD (revised 2026-07-20 — "gestiamo meglio l'hot-reload"). This
 * used to `window.location.replace()` the window out from under whatever the
 * user was doing the instant a concurrent session rebuilt the bundle — which,
 * with an actively-edited repo, yanked live panes and mid-interaction state
 * every few minutes. Now a mismatch only DISPATCHES `topics:bundle-stale`; the
 * DevBundleToast surfaces a "Ricarica" prompt and the user reloads when ready
 * via `reloadForNewBundle()`. The server only emits these frames when its dev
 * flag file exists, so standalone installs never receive them.
 */
/**
 * Fired (on `window`) whenever a newer built bundle is detected — either by the
 * dev rev-mismatch check below, or by the chunk-error guard when a lazy import
 * 404s against a rebuilt bundle. The DevBundleToast listens for it and shows
 * the "Ricarica" prompt. One event, every "the bundle moved" source.
 */
export const BUNDLE_STALE_EVENT = 'topics:bundle-stale';

/**
 * Reload-attempt counter (sessionStorage survives the reload). WKWebView can
 * serve a CACHED index.html: every incarnation reloads the same stale bundle,
 * sees the same mismatch, and would reload again → a loop. Two defenses on the
 * MANUAL reload path: a cache-busted navigation (the query param forces a fresh
 * index fetch, past both the HTTP cache and any SW cache), and a hard cap so a
 * genuinely unshakeable cache can't spin forever.
 */
const ATTEMPTS_KEY = 'topics:bundle-reload-attempts';
const MAX_RELOAD_ATTEMPTS = 3;
const BUST_PARAM = 'bundle-bust';

/**
 * Cache-busted reload to the latest bundle. Called by the DevBundleToast's
 * "Ricarica" button (and the chunk-error ErrorBoundary) — never automatically.
 * Exported so every "the bundle moved" surface converges on one implementation.
 */
export function reloadForNewBundle(): void {
  const n = Number(sessionStorage.getItem(ATTEMPTS_KEY) ?? '0') + 1;
  sessionStorage.setItem(ATTEMPTS_KEY, String(n));
  if (n > MAX_RELOAD_ATTEMPTS) {
    console.warn(`[bundle] rev ancora stantìa dopo ${n - 1} reload — mi fermo (cache WKWebView da svuotare: ~/Library/Caches/io.armonia.topics.tauri + riavvio app)`);
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set(BUST_PARAM, String(Date.now()));
  window.location.replace(url.toString());
}

/**
 * Our bundle rev: mirror of server readBundleRev(), derived from the DOM.
 * ONLY `index-*` entry assets — Vite injects <link>/<script> tags for LAZY
 * chunks at runtime, so matching every /assets/ name would drift from the
 * server's index.html-derived rev and false-trigger. The entry hash
 * transitively covers all chunks (content-hash chain).
 */
function ownBundleRev(): string {
  const names = new Set<string>();
  document.querySelectorAll('script[src], link[href]').forEach((el) => {
    const u = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
    const m = u.match(/\/assets\/index-[A-Za-z0-9._-]+/);
    if (m) names.add(m[0]);
  });
  return [...names].sort().join(',');
}

export function initDevBundleReload(): () => void {
  // Cosmetic: drop a leftover cache-buster from the visible URL after a
  // manual reload landed.
  if (new URL(window.location.href).searchParams.has(BUST_PARAM)) {
    const clean = new URL(window.location.href);
    clean.searchParams.delete(BUST_PARAM);
    history.replaceState(history.state, '', clean.toString());
  }
  const unsubscribe = subscribeFrames(
    (frame) => {
      const rev = (frame as { rev?: unknown }).rev;
      // Rev on both sides and they match → this window is fresh: converged,
      // forget the attempt count. (No toast — nothing stale.)
      if (typeof rev === 'string' && rev !== '' && rev === ownBundleRev()) {
        sessionStorage.removeItem(ATTEMPTS_KEY);
        return;
      }
      // Mismatch (or a frame with no rev, i.e. a plain deploy broadcast): a
      // newer build exists. Prompt, never auto-reload — the toast owns the
      // decision. Same event the chunk-error guard fires, so both paths land
      // on one UI surface.
      window.dispatchEvent(new CustomEvent(BUNDLE_STALE_EVENT));
    },
    { types: ['ui:bundle-updated', 'ui:bundle-rev'] },
  );
  return unsubscribe;
}
