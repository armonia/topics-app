import { watch, existsSync, readFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { OutboundMessage } from "../schemas/ws-outbound";

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
  broadcastToAll: (msg: OutboundMessage) => void;
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
 * references (`/assets/index-DWT3PvQi.css,/assets/index-Dra_ZXl3.js`).
 *
 * ONLY `index-*` on purpose: the entry hash transitively covers every chunk (a
 * chunk content change renames it, which changes its importer's bytes, up the
 * chain to the entry), so the entry names alone identify the build.
 *
 * The client no longer re-derives this from its live DOM — see
 * `stampBundleRev` below and `client/src/lib/devBundleReload.ts`.
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

/** The meta tag name carrying the rev of the bundle a window BOOTED with. */
export const BUNDLE_REV_META = "topics-bundle-rev";

/**
 * Stamp the served index.html with the rev it represents.
 *
 * WHY THIS EXISTS — the update-notice loop. The client used to re-derive its
 * own rev by scraping every `/assets/index-*` out of the LIVE DOM. But Vite's
 * preload helper appends `<link rel="modulepreload">` tags for LAZY chunks at
 * runtime, and several of those chunks are themselves named `index-*` (a lazy
 * module whose file is `index.js` — hast-util, micromark, CodeMirror…). The
 * moment the app rendered a markdown message or opened an editor, the DOM held
 * 5-6 `index-*` names while index.html referenced 2 — so the comparison could
 * NEVER match. Result: a permanent phantom "nuova versione disponibile" that
 * came back on every reconnect and every rebuild, and which no reload could
 * clear because nothing was actually stale.
 *
 * Stamping the value the server itself computed removes the derivation (and
 * therefore the whole class of drift): both sides now read ONE number. A window
 * with no stamp — the Tauri shell serving its embedded/disk bundle without
 * going through us — can't converge by reloading anyway, so the client treats a
 * missing meta as "this check does not apply here" instead of nagging forever.
 */
export function stampBundleRev(html: string, rev: string): string {
  if (!rev) return html;
  const tag = `<meta name="${BUNDLE_REV_META}" content="${rev}">`;
  return html.includes("<head>") ? html.replace("<head>", `<head>${tag}`) : `${tag}${html}`;
}
