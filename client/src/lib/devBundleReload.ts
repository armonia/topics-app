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
/** Must match server/lib/dev-bundle-reload.ts BUNDLE_REV_META. */
const BUNDLE_REV_META = 'topics-bundle-rev';
/** A window that boots and stays quiet this long is demonstrably on a good
 *  bundle — see the counter reset in initDevBundleReload. */
const SETTLE_MS = 10_000;

/**
 * WHAT MUST BE TORN DOWN BY HAND BEFORE THE PAGE GOES AWAY.
 *
 * A reload does NOT unmount the native child webviews: a browser pane's
 * WKWebView belongs to the WINDOW, not to the document, so `location.replace`
 * leaves it alive with no React owner and no later `browser_close` aimed at it.
 * Measured on 2026-07-29: the app at 14 GB, 65 WebContent processes of which 61
 * had spent zero CPU in twelve seconds — 11,7 GB nobody was looking at, and the
 * reload points were named as one of the two causes.
 *
 * The cure exists and is measured: `browser_close` reaches
 * `-[WKWebView _close]`, the WebContent process dies, and a closed pane gives
 * the memory back (113 MB → 0 MB over five panes, 13/08). It just never ran on
 * this path. Whoever owns a native view registers its teardown here, and this
 * is the last moment it can run.
 *
 * Registered, not imported: the knowledge of which views are alive lives in
 * `hooks/useTauriBrowser`, and this file must stay importable by anything.
 */
const beforeReload = new Set<() => void>();

/** Register a teardown to run right before a bundle reload navigates away. */
export function onBeforeBundleReload(fn: () => void): () => void {
  beforeReload.add(fn);
  return () => { beforeReload.delete(fn); };
}

function runBeforeReload(): void {
  for (const fn of beforeReload) {
    // Best effort, always: a teardown that throws must not be the reason the
    // window stays on a stale bundle forever.
    try { fn(); } catch { /* the reload wins */ }
  }
}

/**
 * Cache-busted reload to the latest bundle. Called by the DevBundleToast's
 * "Ricarica" button, by the chunk-error ErrorBoundary, and — when the window is
 * hidden — by the freshness check itself.
 * Exported so every "the bundle moved" surface converges on one implementation.
 */
export function reloadForNewBundle(): void {
  const n = Number(sessionStorage.getItem(ATTEMPTS_KEY) ?? '0') + 1;
  sessionStorage.setItem(ATTEMPTS_KEY, String(n));
  if (n > MAX_RELOAD_ATTEMPTS) {
    console.warn(`[bundle] rev ancora stantìa dopo ${n - 1} reload — mi fermo (cache WKWebView da svuotare: ~/Library/Caches/io.armonia.topics.tauri + riavvio app)`);
    return;
  }
  // AFTER the budget check, never before: a reload that is not going to happen
  // must not close the panes it was going to bring back.
  runBeforeReload();
  const url = new URL(window.location.href);
  url.searchParams.set(BUST_PARAM, String(Date.now()));
  window.location.replace(url.toString());
}

/**
 * The rev of the bundle THIS window booted with — read from the
 * `<meta name="topics-bundle-rev">` the server stamps into index.html
 * (server/lib/dev-bundle-reload.ts `stampBundleRev`).
 *
 * It used to be re-derived by scraping every `/assets/index-*` out of the live
 * DOM, and that is what produced the endless "nuova versione disponibile":
 * Vite's preload helper appends `<link rel="modulepreload">` tags for LAZY
 * chunks at runtime, and several of those chunks are themselves named `index-*`
 * (any lazy module whose file is `index.js` — hast-util, micromark, CodeMirror…).
 * As soon as the app rendered a markdown message or opened an editor the DOM
 * held 5-6 `index-*` names against index.html's 2, so the comparison could never
 * match, on any build, however fresh. Reading one stamped value deletes the
 * derivation and with it the whole drift class.
 *
 * `null` = no stamp, i.e. this document did NOT come from our server (the Tauri
 * shell serving its embedded or disk bundle). Such a window cannot converge by
 * reloading, so the caller disables the check rather than nagging forever.
 */
function ownBundleRev(): string | null {
  const meta = document.querySelector(`meta[name="${BUNDLE_REV_META}"]`);
  const content = meta?.getAttribute('content');
  return content ? content : null;
}

export function initDevBundleReload(): () => void {
  // Cosmetic: drop a leftover cache-buster from the visible URL after a
  // manual reload landed.
  if (new URL(window.location.href).searchParams.has(BUST_PARAM)) {
    const clean = new URL(window.location.href);
    clean.searchParams.delete(BUST_PARAM);
    history.replaceState(history.state, '', clean.toString());
  }
  const own = ownBundleRev();
  // Unstamped document → this window did not boot from our server (Tauri shell
  // serving its embedded/disk bundle). It can't converge by reloading, and in
  // that mode the shell's own watcher already applies new builds, so a prompt
  // would be pure noise. Opt out entirely instead of comparing garbage.
  if (own === null) return () => {};

  // Self-healing attempt counter. It used to be cleared ONLY on a rev match —
  // which, with the old DOM-derived rev, could never happen: after three
  // "Ricarica" clicks the button silently became a no-op while the toast kept
  // returning ("faccio ricarica e continua ad esserci"). A window that has
  // stayed quiet since boot is on a good bundle by definition, so let the
  // budget refill on its own. Cheap insurance even now that revs can match.
  const settleTimer = setTimeout(() => sessionStorage.removeItem(ATTEMPTS_KEY), SETTLE_MS);

  const unsubscribe = subscribeFrames(
    (frame) => {
      const rev = (frame as { rev?: unknown }).rev;
      // Rev on both sides and they match → this window is fresh: converged,
      // forget the attempt count. (No toast — nothing stale.)
      if (typeof rev === 'string' && rev !== '' && rev === own) {
        sessionStorage.removeItem(ATTEMPTS_KEY);
        return;
      }
      // A newer build exists. The settle timer is cancelled first: this window
      // is NOT quiet, so it must not refill its reload budget behind our back.
      clearTimeout(settleTimer);
      // NOBODY SHOULD HAVE TO PRESS A BUTTON TO BE UP TO DATE — but the window
      // must not be yanked out from under someone either.
      //
      // Until 2026-07-20 this reloaded the instant any concurrent session
      // rebuilt the bundle, and on an actively edited repo that tore live panes
      // and mid-interaction state away every few minutes; it was made a prompt.
      // The prompt is right for a window somebody is looking at. It is pure
      // friction for one that is hidden — and hidden is where most of these
      // land, because the rebuilds come from the board landing work while the
      // person is somewhere else. So: hidden reloads itself, visible asks.
      //
      // Nothing of a turn is lost either way: with the native runtime the turn
      // runs inside the SERVER, and a reattaching client picks it back up.
      // The attempt cap above guards this path too, which matters more here:
      // an automatic reload against an unshakeable cache is the one that could
      // spin unseen.
      if (document.hidden) { reloadForNewBundle(); return; }
      window.dispatchEvent(new CustomEvent(BUNDLE_STALE_EVENT));
    },
    { types: ['ui:bundle-updated', 'ui:bundle-rev'] },
  );
  return () => {
    clearTimeout(settleTimer);
    unsubscribe();
  };
}
