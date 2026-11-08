/**
 * The one line an API request leaves in the server log, and when it leaves it.
 *
 * WHAT THERE WAS. A start line per `/api/*` request (`[HTTP] -> GET /x`) with
 * no time, no status and no duration, and a completion line for 404s only.
 * Under a loadavg of 33 that log could not answer the three questions a log is
 * for: when did the burst happen, which route was slow, did the request ever
 * finish. And it was mostly one route: `GET /api/browsers/:id/viewers`, polled
 * every 2s by every browser pane, was 44% of the API lines (7,662 of 17,335 on
 * a 20,000-line tail) and buried the `[worktree-residue]` / `[landing-audit]`
 * lines that matter.
 *
 * WHAT THERE IS. One line on COMPLETION, with an ISO timestamp, the status and
 * the duration. The routes that fire on a clock rather than on a user (the
 * viewer count, presence, the Claude hooks) print only when something is wrong:
 * a status of 400 or more, or a duration over `SLOW_MS`. Not sampled: a 2xx
 * that was logged one time in ten would look like a request that happened one
 * time in ten.
 *
 * Pure: the timestamp is a parameter, so the format can be pinned in a test.
 */

/** A request slower than this is printed even on a quiet route. */
export const SLOW_MS = 200;

/**
 * Routes a client hits on a timer. Healthy and fast, they say nothing new
 * from one line to the next; they still print when they fail or drag.
 */
const QUIET_ROUTES: readonly RegExp[] = [
  /^\/api\/browsers\/[^/]+\/viewers$/,
  /^\/api\/system\/presence$/,
  /^\/api\/claude-hooks(?:\/|$)/,
];

export function isQuietRoute(pathname: string): boolean {
  return QUIET_ROUTES.some((re) => re.test(pathname));
}

/** Does this completed request earn a line? */
export function shouldLogHttp(pathname: string, status: number, durationMs: number): boolean {
  if (!isQuietRoute(pathname)) return true;
  return status >= 400 || durationMs > SLOW_MS;
}

/** The line itself. Same marks as before (`x`, `!`, `ok`) so an eye used to the old log still reads it. */
export function formatHttpLine(now: Date, method: string, pathname: string, status: number, durationMs: number): string {
  const mark = status >= 500 ? "❌" : status >= 400 ? "⚠️" : "✓";
  return `${now.toISOString()} [HTTP] ${mark} ${method} ${pathname} ${status} ${durationMs}ms`;
}

/** The line to print for a completed request, or `null` when it stays quiet. */
export function httpLogLine(now: Date, method: string, pathname: string, status: number, durationMs: number): string | null {
  if (!shouldLogHttp(pathname, status, durationMs)) return null;
  return formatHttpLine(now, method, pathname, status, durationMs);
}
