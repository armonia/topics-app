import { subscribeFrames } from './wsFrameBus';

/**
 * Dev bundle hot-delivery, client half (server half:
 * server/lib/dev-bundle-reload.ts). When the server broadcasts
 * `ui:bundle-updated` (the built client in /public changed on disk), reload
 * the window so the user is ALWAYS looking at the latest bundle — no manual
 * ⌘R per iteration. The server only emits this when its dev flag file
 * exists, so standalone installs never receive it.
 */
const RELOAD_QUIET_MS = 10_000;

export function initDevBundleReload(): () => void {
  const loadedAt = Date.now();
  return subscribeFrames(
    () => {
      // A window that just loaded already holds the freshest bundle; ignoring
      // early events also breaks any possible reload loop (e.g. a second
      // build landing while the first reload is still booting).
      if (Date.now() - loadedAt < RELOAD_QUIET_MS) return;
      window.location.reload();
    },
    { types: ['ui:bundle-updated'] },
  );
}
