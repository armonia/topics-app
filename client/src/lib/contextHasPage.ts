/**
 * "Is the server-side context already showing a page?"
 *
 * The seed must never reload a context somebody is already using, and THE
 * LOCAL URL CANNOT ANSWER THAT QUESTION. Once `onUrlChange` has persisted the
 * pane's url, the store holds exactly the url the seed is about to load, so
 * comparing the two strings reports "not loaded yet" for a context that has
 * been live for hours: reload the client, or open the same pane on a second
 * device, and `fetchInfo` refills that url within milliseconds, before the
 * seed timer fires. Navigating again is a real `page.goto`, so scroll, a
 * half-filled form and session state die, and in a shared session they die for
 * everyone watching.
 *
 * The server is the one that knows. `/api/browsers/:id` answers 404 until the
 * context exists at all - which is the case this pane's card was about, a
 * chat-opened pane whose url is known locally and has never been loaded - and
 * reports the real url once it does.
 *
 * IN DOUBT THE ANSWER IS `true`, leave it alone. The two errors are not equal:
 * a false "empty" reloads a page under somebody's hands, a false "occupied"
 * only skips the seed, and the url is still one click away in the address bar.
 */

/**
 * Past this, stop waiting and assume the context is busy.
 *
 * Same reasoning as the timeout in `loopbackAlive`, opposite default: there the
 * safe answer is "try to load", here it is "do not touch".
 */
const PROBE_TIMEOUT_MS = 1500;

export async function contextHasPage(
  contextId: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!contextId) return true;
  const ctrl = new AbortController();
  // A race, not just the abort signal: the ceiling has to hold even when fetch
  // does not honour the abort (a stub in the tests, a polyfill).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve(true); }, timeoutMs);
  });
  const ask = (async () => {
    try {
      const res = await fetch(`/api/browsers/${encodeURIComponent(contextId)}`, { signal: ctrl.signal });
      // No context yet: nothing to clobber, the seed is what creates it.
      if (res.status === 404) return false;
      if (!res.ok) return true;
      const body = (await res.json()) as { url?: string };
      const url = (body.url ?? '').trim();
      // A context parked on the empty page is not "in use" either.
      return url !== '' && url !== 'about:blank';
    } catch {
      return true;
    }
  })();
  try {
    return await Promise.race([ask, bail]);
  } finally {
    clearTimeout(timer);
  }
}
