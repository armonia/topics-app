import { BUNDLE_STALE_EVENT } from './devBundleReload';

/**
 * Chunk-load error guard — the reactive safety net beside devBundleReload's
 * proactive rev check.
 *
 * When the built bundle is rebuilt under a live window (a concurrent session
 * editing the repo in dev, or a production deploy landing while the tab is
 * open), a lazy `import()` for a pane/panel resolves to a hashed chunk name
 * that no longer exists on the server. Vite surfaces this as a `vite:preloadError`
 * and the promise rejects with "Failed to fetch dynamically imported module" /
 * "Importing a module script failed" — which otherwise dies in the pane's
 * ErrorBoundary as a dead "Panel error".
 *
 * We intercept those signatures and fire `BUNDLE_STALE_EVENT` so the same
 * DevBundleToast "Ricarica" prompt appears — the tab never breaks silently.
 * We never auto-reload here either; the user (or the ErrorBoundary's reload
 * button) decides.
 */
const CHUNK_ERROR_RX =
  /(Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|dynamically imported module|ChunkLoadError|Loading chunk [\d]+ failed)/i;

/** True when an error/message looks like a stale-bundle dynamic-import failure. */
export function isChunkLoadError(input: unknown): boolean {
  const msg =
    typeof input === 'string'
      ? input
      : ((input as { message?: string; name?: string })?.message ?? '') +
        ' ' +
        ((input as { name?: string })?.name ?? '');
  return CHUNK_ERROR_RX.test(msg);
}

export function initChunkReloadGuard(): () => void {
  const signalStale = () => window.dispatchEvent(new CustomEvent(BUNDLE_STALE_EVENT));

  // Vite's dedicated hook — fired on the window when a preloaded/dynamic chunk
  // fails to load. Most reliable signal; not preventing default keeps the
  // normal rejection flowing to any ErrorBoundary too.
  const onPreloadError = () => signalStale();

  // Belt: uncaught errors and unhandled rejections whose message matches a
  // dynamic-import failure (covers browsers/paths that don't emit
  // vite:preloadError, e.g. a rejected import awaited outside React.lazy).
  const onError = (e: ErrorEvent) => {
    if (isChunkLoadError(e.error ?? e.message)) signalStale();
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (isChunkLoadError(e.reason)) signalStale();
  };

  window.addEventListener('vite:preloadError', onPreloadError);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
