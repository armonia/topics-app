import { watch, existsSync, type FSWatcher } from "node:fs";
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
 */
export function startDevBundleReload(opts: {
  publicDir: string;
  stateDir: string;
  broadcastToAll: (msg: object) => void;
  /** Test hook — production default 1200ms. */
  debounceMs?: number;
}): () => void {
  const debounceMs = opts.debounceMs ?? 1200;
  if (!existsSync(join(opts.stateDir, "topics-dev.json"))) return () => {};
  if (!existsSync(opts.publicDir)) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher;
  try {
    watcher = watch(opts.publicDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        opts.broadcastToAll({ type: "ui:bundle-updated", at: Date.now() });
      }, debounceMs);
    });
  } catch {
    // A missing/unwatchable dir must never take the server down over a dev nicety.
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
