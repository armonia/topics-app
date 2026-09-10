/**
 * WHEN `loadTopics` TRIES AGAIN, AND HOW LONG IT WAITS.
 *
 * It lives in a module of its own, with not one import, because this is the
 * rule that decides whether the sidebar's amber notice will ever go out: inside
 * `useTopics` it was three lines at the bottom of a twenty-line `catch`, and
 * nobody could run it.
 *
 * THE BRANCH THAT WAS MISSING. The condition was "a timeout or a network
 * error", and the two were recognised by `name` ('AbortError') and by the
 * message ("Failed to fetch" / "NetworkError" / "Load failed", one per engine).
 * An HTTP refusal has neither - `ApiError` is called 'ApiError' and its message
 * is whatever the server wrote - so it fell outside both: a 500, or a 400, left
 * "Using cached data, server unreachable" lit for the rest of the session, with
 * the local copy on screen and nothing ever replacing it. The case is real and
 * not rare: the server's project allowlist has a five-second cache, and right
 * after a restart `GET /api/topics` answers 400 for that window - which is
 * exactly when clients are reloading.
 *
 * WHAT STAYS OUT is the refusal by IDENTITY (401/403). Not because it matters
 * less, but because it already has an owner: `lib/api.ts` calls `markUnpaired`
 * on a 401, `lib/auth/session.ts` decides which of the three screens to show,
 * and the way out of there is to pair the device again. Knocking on that door
 * every three seconds does not change the answer.
 */

/** The little of an error that is needed to decide. Primitives and not the
 *  object itself: that way this module imports nothing, and neither does its
 *  test. */
export interface TopicsLoadFailure {
  /** `err.name` - 'AbortError' when the 6 s timeout fired. */
  name?: unknown;
  /** `err.message` - the engine's text for a transport failure. */
  message?: unknown;
  /** The status of an `ApiError`, or null when the failure is not a response. */
  status?: number | null;
}

/** The first wait, and the longest one that will ever be waited. */
export const TOPICS_RETRY_BASE_MS = 3000;
export const TOPICS_RETRY_CEILING_MS = 60_000;

/** The 401/403 of identity: see the header. */
function isIdentityRefusal(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

export function shouldRetryTopicsLoad(failure: TopicsLoadFailure): boolean {
  const status = typeof failure.status === 'number' ? failure.status : null;
  if (isIdentityRefusal(status)) return false;
  if (failure.name === 'AbortError') return true;
  if (status !== null) return true;
  const message = typeof failure.message === 'string' ? failure.message : '';
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('Load failed')
  );
}

/**
 * The wait before attempt number `attempt` (0 = the first one after a failure):
 * 3 s, 6 s, 12 s, 24 s, 48 s, then 60 s for ever.
 *
 * THE CEILING SLOWS DOWN, IT DOES NOT SWITCH OFF. Giving up after N attempts
 * looks like the prudent choice and is not: against a server that comes back
 * after ten minutes, a client that has given up sits on the amber notice until
 * somebody reloads the page by hand. Slowing down costs one request a minute
 * and repairs itself - and there is already something that starts the count
 * over, because on the socket's return `useReconnectCatchUp` calls `loadTopics`
 * again.
 *
 * The ceiling serves the opposite direction: the call was RECURSIVE under a
 * comment that said "auto-retry once", so against a dead server it was three
 * seconds for ever - twenty requests a minute per open window, all night.
 */
export function topicsRetryDelayMs(attempt: number): number {
  const steps = Math.max(0, Math.min(attempt, 30));
  return Math.min(TOPICS_RETRY_BASE_MS * 2 ** steps, TOPICS_RETRY_CEILING_MS);
}
