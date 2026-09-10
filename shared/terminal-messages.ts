/**
 * The two words the terminal server and the terminal client have to spell the
 * same way, written once.
 *
 * Both exist because a status code alone was not enough to say what happened:
 *
 *   • 503 arrives with two different meanings on the same routes — this
 *     installation has no PTY bridge at all (standalone shell, sidecar, and
 *     every Windows build, where the bridge is a stub), or a live session
 *     refused to stop in time during a restart. The first is permanent and the
 *     client must say so; the second is worth retrying. `code` separates them.
 *
 *   • a dropped keystroke has no status code at all: it happens INSIDE an open
 *     WebSocket, where the server's only options were a `console.warn` nobody
 *     on the other side can read, or a frame. This is the frame.
 */

/** `code` on the 503 body of every terminal route when this build has no PTY bridge. */
export const STANDALONE_NO_PTY_CODE = "pty-bridge-unavailable";

/**
 * Control frame: the byte you typed did not reach the PTY, and it is not queued.
 *
 * Dropping it is deliberate (replaying input into a process that resumed in a
 * different state is worse than losing it), so this frame says the key is GONE,
 * not that it is coming later. The client shows a band until real output proves
 * the bridge answers again.
 */
export const TERMINAL_INPUT_DROPPED = "input-dropped";

/**
 * WebSocket close code for an attach to a session the server has PARKED: the
 * row is `status = 'dormant'`, the PTY is gone, and `POST /sessions/:id/revive`
 * is the way back. Application range (4000-4999), so no proxy rewrites it.
 *
 * It is a VERDICT, and that is why it is not 1008. The upgrade is accepted for
 * any id and the answer arrives only in `open`, so the client sees a
 * successful open first; 1008 ("session not found") is also what the server
 * says during the boot window, while the bridge has the PTY and the reconcile
 * has not reattached it yet, and for that case the client keeps a grace and
 * retries. A dormant row is never a race: only a park, an exit or a restart
 * writes it, and only a revive or a reload flips it back. So the pane stops
 * retrying at once and shows the expired overlay instead of a blank
 * rectangle - the loop measured on 2026-09-05 was one reconnect every 500 ms,
 * each one posting a resize the server answered 404, for as long as the tab
 * stayed open.
 */
export const TERMINAL_WS_CLOSE_DORMANT = 4001;

/**
 * Response header of `GET /api/terminal/sessions`: `"1"` when the roster has
 * been compared with the PTY bridge, so an EMPTY list means "no session" and
 * not "you asked before the reconcile finished".
 *
 * Why a header and not a field. The bit already travels in the
 * `terminal:sessions` broadcast, whose body is an object with room for it. The
 * REST body is a BARE ARRAY, read that way by MCP, by the phone client and by
 * the tests, so wrapping it to carry one boolean would break every reader for
 * the benefit of one. A header carries it without touching the body, and a
 * client that ignores it behaves exactly as before.
 */
export const ROSTER_RECONCILED_HEADER = "X-Roster-Reconciled";

/**
 * `code` on the 503 of the five terminal routes that decide existence on the
 * IN-MEMORY roster, while that roster is still being reconciled against the PTY
 * bridge.
 *
 * WHY IT IS NOT A 404. The HTTP layer starts answering before
 * `reconcileSessions` has finished (it is fire-and-forget), and until it does
 * the `sessions` map is the EMPTY one from boot. A `sessions.get(id)` there returns undefined for a
 * PTY that is alive in the bridge, so the route used to answer "Terminal
 * session not found" about a terminal the user is looking at. Measured on the
 * production error log on 2026-09-10: 33.246 of the last 60.000 lines (55%) are
 * that one warning, in bursts, and the reconcile window that produces them is
 * up to ~24s wide (a `list` that goes unanswered retries 8 times: 2s timeout +
 * 1s pause).
 *
 * The distinction is the whole point, so it has to survive the trip: 404 means
 * the session is gone and the client should prune the pane, 503+this code means
 * the server cannot tell YET and the client should ask again. A bare 503 could
 * not be told apart from the other two 503s these very routes already answer
 * (no bridge in this build — `STANDALONE_NO_PTY_CODE` — and a reload whose
 * session refused to stop in time), and only one of the three is worth retrying
 * on a short backoff.
 */
export const TERMINAL_ROSTER_WARMING_CODE = "terminal-roster-warming";

/**
 * `Retry-After` on that 503, in seconds.
 *
 * One second, not the window's width: the reconcile usually answers on its
 * first `list` (the 8-attempt ladder is the bridge-is-down path), so telling
 * every caller to wait 24s would make the common case slow to fix itself. The
 * client's own backoff is what covers the long tail.
 */
export const TERMINAL_ROSTER_WARMING_RETRY_AFTER_S = 1;
