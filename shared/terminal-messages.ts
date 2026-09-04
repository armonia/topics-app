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
