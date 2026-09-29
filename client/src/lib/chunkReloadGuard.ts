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
// "Unable to preload CSS" is Vite's own rejection for a stylesheet of the chunk
// that did not arrive: the same stale bundle, one file type over.
const CHUNK_ERROR_RX =
  /(Importing a module script failed|Unable to preload CSS|Failed to fetch dynamically imported module|error loading dynamically imported module|dynamically imported module|ChunkLoadError|Loading chunk [\d]+ failed)/i;

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

/** Why the reload prompt is up: a chunk of THIS window failed to load. */
export const CHUNK_FAILURE_REASON = 'chunk';

function signalChunkFailure(): void {
  window.dispatchEvent(new CustomEvent(BUNDLE_STALE_EVENT, { detail: { reason: CHUNK_FAILURE_REASON } }));
}

/**
 * The catch of every lazy load that is not awaited by a component: `warm`, the
 * hover prefetches, the idle warm-ups.
 *
 * Those catches used to be `() => {}`, and a chunk that 404s there is exactly
 * the window left behind by a rebuild: nothing on screen said so, the control
 * that needed the chunk simply did not open. A chunk-load failure now raises
 * the reload prompt; any other rejection (the chunk arrived and threw while
 * evaluating) is a real bug, not a stale bundle, so it is logged and no reload
 * is offered as a cure. Returns whether it was a chunk-load failure.
 */
export function reportLoadFailure(error: unknown): boolean {
  if (isChunkLoadError(error)) {
    signalChunkFailure();
    return true;
  }
  console.error('[lazy] a chunk loaded but failed to evaluate', error);
  return false;
}

/**
 * The URL of a lazy chunk, read from the `<link rel="modulepreload">` Vite's
 * preload helper puts in the document before it imports the chunk (the chunk is
 * in its own dependency list). `null` when there is none: the dev server, or a
 * chunk never asked for.
 */
export function findChunkHref(root: ParentNode, chunkName: string): string | null {
  for (const link of root.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')) {
    const file = new URL(link.href, 'http://x').pathname.split('/').pop() ?? '';
    if (file.startsWith(`${chunkName}-`) && file.endsWith('.js')) return link.href;
  }
  return null;
}

/**
 * Import a chunk again after `cause` made the first import fail.
 *
 * WHY A NEW URL: WebKit (so the Tauri window too) remembers a failed module for
 * the life of the document. Measured 2026-09-29 in Playwright WebKit: after one
 * 404, a second `import()` of the same URL rejected at once with no request on
 * the wire, even with the file back. A chunk that failed once, during a server
 * restart or a network blip, stayed dead until a reload. The query string makes
 * it a different module for the loader; its own imports keep their URLs, so the
 * shared chunks are not duplicated. A failure that is not a chunk-load failure,
 * or a chunk with no known URL, rethrows `cause` untouched.
 */
export async function reimportChunk<M>(chunkName: string, cause: unknown): Promise<M> {
  const href = isChunkLoadError(cause) ? findChunkHref(document, chunkName) : null;
  if (!href) throw cause;
  const url = new URL(href, window.location.href);
  url.searchParams.set('retry', String(Date.now()));
  return (await import(/* @vite-ignore */ url.href)) as M;
}

export function initChunkReloadGuard(): () => void {
  const signalStale = signalChunkFailure;

  // Vite's dedicated hook — fired on the window when a preloaded/dynamic chunk
  // fails. Not preventing default keeps the normal rejection flowing to any
  // ErrorBoundary too.
  //
  // FILTERED ON THE PAYLOAD: Vite's preload helper wraps the import itself,
  // `baseModule().catch(handlePreloadError)`, so the event also fires for a
  // chunk that ARRIVED and threw while evaluating. That is a bug in the chunk,
  // and a reload prompt announcing an old build would be a false diagnosis
  // (measured 2026-09-29 in Playwright WebKit: a 200 chunk whose body throws
  // raised "this window is on an old build", 4 runs out of 4).
  const onPreloadError = (event: Event) => {
    if (isChunkLoadError((event as Event & { payload?: unknown }).payload)) signalStale();
  };

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
