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
  const unsubscribe = subscribeFrames(
    (frame) => {
      const rev = (frame as { rev?: unknown }).rev;
      // Rev on both sides and they match → this window is already fresh.
      if (typeof rev === 'string' && rev !== '' && rev === ownBundleRev()) return;
      const early = Date.now() - loadedAt < RELOAD_QUIET_MS;
      if (!early) { window.location.reload(); return; }
      // Early mismatch: don't DROP it (a genuinely stale window that just
      // reconnected must still converge) — defer past the quiet window, which
      // still breaks any reload loop (each incarnation waits 10s and a fresh
      // load matches the rev anyway).
      if (pending) return;
      pending = setTimeout(() => window.location.reload(), RELOAD_QUIET_MS - (Date.now() - loadedAt));
    },
    { types: ['ui:bundle-updated', 'ui:bundle-rev'] },
  );
  return () => {
    if (pending) clearTimeout(pending);
    unsubscribe();
  };
}
