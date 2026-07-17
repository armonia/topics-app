import { subscribeFrames } from './wsFrameBus';

/**
 * Dev bundle hot-delivery, client half (server half:
 * server/lib/dev-bundle-reload.ts). Two frames, one goal — the window is
 * ALWAYS looking at the latest built bundle, no manual ⌘R:
 *
 * - `ui:bundle-updated` (broadcast at deploy time): /public changed on disk.
 * - `ui:bundle-rev` (sent to each client on WS connect): freshness check for
 *   windows that MISSED the deploy broadcast — opened before the dev flag,
 *   disconnected during the rsync, or alive across a server restart.
 *
 * Both carry the server's bundle rev (sorted /assets/* names from its
 * index.html); we compare against OUR OWN rev read from the live
 * <script>/<link> tags. Same rev → no reload (an rsync that changed nothing,
 * or the connect-time check on a fresh window, costs zero repaints). Different
 * rev → reload. The server only emits these when its dev flag file exists, so
 * standalone installs never receive them.
 */
const RELOAD_QUIET_MS = 10_000;

/**
 * Reload-attempt counter (sessionStorage survives the reload). The old
 * assumption — "a fresh load matches the rev anyway" — is FALSE when
 * WKWebView serves its CACHED index.html: every incarnation reloads the same
 * stale bundle, sees the same mismatch on the next WS connect, and reloads
 * again → the "window refreshes by itself every ~10s" loop. Two defenses:
 * cache-busted navigation (the query param forces a fresh index fetch, past
 * both the HTTP cache and any SW cache), and a hard cap.
 */
const ATTEMPTS_KEY = 'topics:bundle-reload-attempts';
const MAX_RELOAD_ATTEMPTS = 3;
const BUST_PARAM = 'bundle-bust';

function forceFreshReload(): void {
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
 * server's index.html-derived rev and false-trigger reloads. The entry hash
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
  const loadedAt = Date.now();
  let pending: ReturnType<typeof setTimeout> | null = null;
  // Cosmetic: drop a leftover cache-buster from the visible URL.
  if (new URL(window.location.href).searchParams.has(BUST_PARAM)) {
    const clean = new URL(window.location.href);
    clean.searchParams.delete(BUST_PARAM);
    history.replaceState(history.state, '', clean.toString());
  }
  const unsubscribe = subscribeFrames(
    (frame) => {
      const rev = (frame as { rev?: unknown }).rev;
      // Rev on both sides and they match → this window is fresh: the cycle (if
      // any) has converged, forget the attempt count.
      if (typeof rev === 'string' && rev !== '' && rev === ownBundleRev()) {
        sessionStorage.removeItem(ATTEMPTS_KEY);
        return;
      }
      const early = Date.now() - loadedAt < RELOAD_QUIET_MS;
      if (!early) { forceFreshReload(); return; }
      // Early mismatch: don't DROP it (a genuinely stale window that just
      // reconnected must still converge) — defer past the quiet window; the
      // attempt cap in forceFreshReload breaks any residual loop.
      if (pending) return;
      pending = setTimeout(forceFreshReload, RELOAD_QUIET_MS - (Date.now() - loadedAt));
    },
    { types: ['ui:bundle-updated', 'ui:bundle-rev'] },
  );
  return () => {
    if (pending) clearTimeout(pending);
    unsubscribe();
  };
}
