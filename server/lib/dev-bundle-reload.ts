import { watch, existsSync, readFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

/**
 * Dev bundle hot-delivery: when the BUILT client in PUBLIC_DIR changes (a
 * `bun run build` just finished), broadcast `ui:bundle-updated` so every open
 * window reloads itself and shows the new bundle immediately — no manual ⌘R
 * per iteration.
 *
 * OPT-IN via flag file `topics-dev.json` in STATE_DIR (existence = on): a
 * downloaded/standalone install must never force-reload its users. The flag
 * is read once at boot — toggling requires a server restart, which keeps the
 * hot path zero-cost when off.
 *
 * Debounced: Vite writes dozens of asset files per build; we broadcast once,
 * after writes settle. Client-side, devBundleReload.ts guards against reload
 * loops (a freshly-loaded window ignores events for its first seconds).
 *
 * REV, not just "something changed": the broadcast carries a bundle revision
 * (the content-hashed /assets/* names referenced by index.html). Two reasons:
 * - a deploy that rewrites identical files (rsync touch, re-run of the same
 *   build) must NOT blank every open window — we only broadcast when the rev
 *   actually changed;
 * - a window that was NOT connected when the deploy landed (server booted
 *   without the flag, WS down, window opened during an outage) would stay on
 *   the stale bundle forever. getRev() lets the WS open handler send the
 *   current rev to every (re)connecting client, which self-reloads on
 *   mismatch — freshness is checked at connect time, not only pushed at
 *   deploy time.
 */
export function startDevBundleReload(opts: {
  publicDir: string;
  stateDir: string;
  broadcastToAll: (msg: object) => void;
  /** Test hook — production default 1200ms. */
  debounceMs?: number;
}): { stop: () => void; getRev: () => string | null } {
  const debounceMs = opts.debounceMs ?? 1200;
  const off = { stop: () => {}, getRev: () => null };
  if (!existsSync(join(opts.stateDir, "topics-dev.json"))) return off;
  if (!existsSync(opts.publicDir)) return off;

  let rev = readBundleRev(opts.publicDir);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher;
  try {
    watcher = watch(opts.publicDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = readBundleRev(opts.publicDir);
        // Unreadable index.html mid-rsync (next === '') or a byte-identical
        // redeploy must not reload anyone.
        if (!next || next === rev) return;
        rev = next;
        opts.broadcastToAll({ type: "ui:bundle-updated", at: Date.now(), rev });
      }, debounceMs);
    });
  } catch {
    // A missing/unwatchable dir must never take the server down over a dev nicety.
    return off;
  }
  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
    getRev: () => rev || null,
  };
}

/**
 * The bundle revision = the sorted content-hashed ENTRY asset names index.html
 * references (`/assets/index-DWT3PvQi.css,/assets/index-Dra_ZXl3.js`). The
 * client derives ITS OWN rev from its live <script>/<link> tags, so the two
 * sides compare the same thing without any extra manifest file.
 *
 * ONLY `index-*` on purpose: Vite's preload helper injects <link> tags for
 * lazy chunks at runtime, so the client DOM accumulates /assets/ names that
 * index.html doesn't have — comparing the full set would drift into false
 * mismatches. The entry hash already transitively covers every chunk (a chunk
 * content change renames it, which changes its importer's bytes, up the chain
 * to the entry).
 */
export function readBundleRev(publicDir: string): string {
  try {
    const html = readFileSync(join(publicDir, "index.html"), "utf8");
    const names = html.match(/\/assets\/index-[A-Za-z0-9._-]+/g);
    return names ? [...new Set(names)].sort().join(",") : "";
  } catch {
    return "";
  }
}
