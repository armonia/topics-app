/**
 * In-process rendez-vous for the `mcp__topics__ask_user_question` bridge tool.
 *
 * WHY this exists: the Claude Code CLI only registers its built-in
 * `AskUserQuestion` tool in INTERACTIVE mode. Topics spawns the CLI headless
 * (`--print` stream-json), where that tool is absent — so a native chat could
 * never render the clickable question panel the CLI users get. Topics re-exposes
 * the same contract as an MCP bridge tool. But an MCP tool call is executed by
 * the CLI against the bridge subprocess and the CLI blocks on the bridge's
 * JSON-RPC RESPONSE (not on stdin, unlike the built-in). So the bridge handler
 * must itself block until the human answers, then return the answer as its tool
 * result. This module is the hand-off point between:
 *
 *   - the bridge handler (blocks in `POST /api/mcp/ask-user`, calling `waitForAnswer`)
 *   - the chat UI answer (`POST /api/chat/tool-response`, calling `deliverAnswer`)
 *
 * Both are keyed by `sessionKey`: the CLI blocks the turn on a single
 * `ask_user_question` call, so there is at most one outstanding ask per session.
 *
 * The two sides can arrive in either order (the bridge POST fires the instant
 * the model calls the tool; the human answers seconds later — but a reload or a
 * fast test can invert that), so a short-lived answer BUFFER makes the rendez-
 * vous race-free in both directions.
 */

export interface AskUserBridgeOptions {
  /** How long the bridge handler waits before giving up (ms). */
  timeoutMs?: number;
  /** How long a delivered-but-unclaimed answer stays buffered (ms). */
  bufferTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — matches a patient human
const DEFAULT_BUFFER_TTL_MS = 30 * 1000; // answer that beat the waiter

interface Waiter {
  resolve: (answers: Record<string, string>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BufferedAnswer {
  answers: Record<string, string>;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, Waiter>();
const buffered = new Map<string, BufferedAnswer>();

/**
 * Called by the bridge tool handler. Resolves with the human's answers when
 * they arrive, or rejects on timeout. If the answer already landed (buffered),
 * resolves immediately. A second ask for the same session supersedes the first
 * (its waiter is rejected) — the CLI only blocks on one at a time, so a lingering
 * waiter is stale.
 */
export function waitForAnswer(
  sessionKey: string,
  opts: AskUserBridgeOptions = {},
): Promise<Record<string, string>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Answer already delivered before the waiter registered.
  const buf = buffered.get(sessionKey);
  if (buf) {
    clearTimeout(buf.timer);
    buffered.delete(sessionKey);
    return Promise.resolve(buf.answers);
  }

  // Supersede any stale waiter for this session.
  const existing = waiters.get(sessionKey);
  if (existing) {
    clearTimeout(existing.timer);
    waiters.delete(sessionKey);
    existing.reject(new Error("ask_user_question: superseded by a newer question"));
  }

  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(sessionKey);
      reject(new Error("ask_user_question: timed out waiting for the human answer"));
    }, timeoutMs);
    waiters.set(sessionKey, { resolve, reject, timer });
  });
}

/**
 * Called by the tool-response route when the human submits. Returns true if a
 * blocked bridge handler (or a soon-to-register one, via the buffer) will pick
 * the answer up — i.e. this session's pending tool is the bridge ask, not the
 * built-in stdin path. Returns false when there is nothing to deliver to (the
 * caller then falls back to the provider stdin path).
 */
export function deliverAnswer(
  sessionKey: string,
  answers: Record<string, string>,
  opts: AskUserBridgeOptions = {},
): boolean {
  const w = waiters.get(sessionKey);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(sessionKey);
    w.resolve(answers);
    return true;
  }
  // No waiter yet: buffer briefly so a bridge handler that registers a beat
  // later still gets it. We only buffer when a bridge ask is plausibly in
  // flight — the caller decides whether to invoke this at all.
  const ttl = opts.bufferTtlMs ?? DEFAULT_BUFFER_TTL_MS;
  const prev = buffered.get(sessionKey);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => buffered.delete(sessionKey), ttl);
  buffered.set(sessionKey, { answers, timer });
  return true;
}

/** True when a bridge handler is currently blocked waiting for this session. */
export function hasPendingAsk(sessionKey: string): boolean {
  return waiters.has(sessionKey);
}

/**
 * Drop any waiter/buffer for a session (turn aborted / session torn down) so a
 * blocked handler unblocks with an error instead of hanging to timeout.
 */
export function cancelAsk(sessionKey: string, reason = "cancelled"): void {
  const w = waiters.get(sessionKey);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(sessionKey);
    w.reject(new Error(`ask_user_question: ${reason}`));
  }
  const buf = buffered.get(sessionKey);
  if (buf) {
    clearTimeout(buf.timer);
    buffered.delete(sessionKey);
  }
}
