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
