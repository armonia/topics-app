/**
 * "The server cannot tell yet" is not "it is gone", and the client has to act
 * on the difference.
 *
 * Five terminal routes answer existence off the server's in-memory roster, and
 * that roster is empty until `reconcileSessions` has finished asking the PTY
 * bridge which processes survived — up to ~24s after a server reload when the
 * bridge is slow to come up. The server used to spend a 404 on that window; it
 * now answers 503 with `code: TERMINAL_ROSTER_WARMING_CODE` and a `Retry-After`
 * (see `server/routes/terminal.ts`, and the constant's own note for the
 * measurement that motivated it).
 *
 * Both halves of the distinction have a cost if the client gets them wrong:
 *
 *   • treat the 503 as a hard failure and the gesture is simply LOST — the
 *     resize never lands (a full-screen TUI stays drawn at the previous
 *     geometry), the rename springs back, the restart says it failed. That is
 *     what a plain `.catch(() => {})` did with the old 404 too, which is why
 *     nobody noticed: the false 404 and the swallow hid each other.
 *
 *   • treat it as a generic error and SAY so, and the user gets a toast every
 *     time the server reloads. Noise, not loss — but the boot window is exactly
 *     when the app is busiest reconnecting, so it would be a lot of noise.
 *
 * Hence: retry silently while the answer is "not yet", surface everything else
 * unchanged. A 404 that arrives AFTER the window is a verdict and travels back
 * to the caller untouched, so the pane can prune itself as before.
 */
import { TERMINAL_ROSTER_WARMING_CODE } from '../../../shared/terminal-messages';

/**
 * The ladder, sized against the window it has to cover.
 *
 * The server's reconcile gives up after 8 unanswered `list` calls, each a 2s
 * timeout plus a 1s pause — about 24s worst case, after which it promotes the
 * roster from the DB and starts answering for real. So the retries have to add
 * up to at least that, or the client would give up while the server is still
 * about to become able to answer. 300ms doubling to a 4s ceiling over 8
 * attempts is ~23s of waiting spread across 9 requests: cheap enough to run per
 * resize, long enough that the worst measured window closes inside it.
 */
const FIRST_DELAY_MS = 300;
const MAX_DELAY_MS = 4000;
const MAX_RETRIES = 8;

/**
 * The short ladder, for a caller that is holding a UI overlay open while it
 * waits: 300+600+1200+2400 ≈ 4,5s across 5 requests.
 *
 * `restartTerminalSession` has a 15s timeout that takes its "Riavvio…" overlay
 * off the pane, and it means "no answer is coming". Handing that caller the
 * full 23s ladder would make its own net fire FIRST on every long window — the
 * overlay would come off while the retry was still in flight, and the restart
 * would then happen behind a screen that had already stopped saying so. Better
 * to cover the common window (the bridge answers on its first `list`) and let
 * the rare 24s one earn the honest "not ready, try again" toast.
 */
export const SHORT_ROSTER_RETRIES = 4;

/** Is this response the server saying "ask me again in a moment"? */
async function isRosterWarming(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  // The body is read from a CLONE: the caller still gets an unread stream, so a
  // 503 that turns out to be one of the other two (no PTY bridge in this build,
  // or a reload that would not stop in time) reaches them intact and readable.
  try {
    const said = await res.clone().json() as { code?: unknown };
    return said?.code === TERMINAL_ROSTER_WARMING_CODE;
  } catch {
    // No envelope, or an unreadable one: not our 503. Retrying a 503 we cannot
    // identify would turn the reload-timeout case into a hammer.
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `fetch`, with the roster-warming 503 absorbed.
 *
 * Returns the first response that is NOT a warming 503 — including the last
 * warming 503 itself, if the budget runs out, so the caller always gets a
 * Response and decides for itself. Network failures are not retried and reject
 * exactly as `fetch` does: they are a different problem with a different cure,
 * and swallowing them here would hide a server that is really gone.
 */
export async function fetchWhileRosterWarms(
  input: string,
  init?: RequestInit,
  maxRetries: number = MAX_RETRIES,
): Promise<Response> {
  let delay = FIRST_DELAY_MS;
  let res = await fetch(input, init);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (!(await isRosterWarming(res))) return res;
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
    res = await fetch(input, init);
  }
  return res;
}

/**
 * Tell the shared PTY how big this client's terminal is.
 *
 * Five call sites in `SingleTerminalPane` posted this by hand, each one
 * `.catch(() => {})`, each one a place where the boot window's answer was
 * dropped on the floor. They are the volume: a resize fires on attach, on
 * window focus, when the pane becomes the active tab, on a touch client
 * returning to the foreground, and on every xterm reflow — so on a reload with
 * several terminal panes open they all fire at once, straight into the window.
 *
 * Deliberately returns nothing. The callers are event handlers that have
 * nowhere to put a failure, and a resize that does not land is self-correcting:
 * the next focus, tab switch or reflow sends the current size again. What was
 * NOT self-correcting is the log line the old 404 wrote each time.
 */
export function postTerminalResize(sessionId: string, cols: number, rows: number): void {
  void fetchWhileRosterWarms(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  }).catch(() => { /* server unreachable: the next resize event says it again */ });
}

/**
 * Retire a terminal session server-side, waiting out the boot window.
 *
 * A DELETE that lands in the window used to be answered 404 and swallowed, and
 * the row stayed: the tab was gone from the screen but its PTY kept running,
 * and the next roster read brought the pane back. Retrying is the whole cure —
 * the caller has already removed the tab locally and has nothing to say about
 * a failure, which is why this returns nothing like the resize does.
 *
 * NOT used by the pane-unload path (`usePaneLifecycle`), which needs
 * `keepalive: true` because the document is going away: there is no later tick
 * to retry on there, so that one stays a single fire-and-forget DELETE.
 */
export function deleteTerminalSession(sessionId: string): void {
  void fetchWhileRosterWarms(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    .catch(() => { /* unreachable: the 1h dormant sweep is the backstop */ });
}
