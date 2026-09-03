/**
 * RETRY POLICY FOR THE NATIVE RUNTIME, with no network in it.
 *
 * ── The defect (2026-09-03, topic:9cb7c969) ─────────────────────────────────
 * Two turns died within a second of the user pressing Enter:
 *   · `stream error: {"type":"overloaded_error"}`: the API answered 200 and put
 *     the overload inside the SSE body, as the very first event.
 *   · `API 401: OAuth access token has been revoked`: the user's own CLI had
 *     rotated the refresh token; the server still held the previous access
 *     token, "fresh" by its expiry and dead upstream.
 * Neither was tried again. `streamOnce` threw, `runAgentTurn` let it through,
 * the provider wrote a ⚠️ message and the turn was over: an unanswered message
 * in the chat and a goal nobody was working on any more. Claude Code retries
 * both: exponential backoff on transient statuses, and on 401 a token refresh
 * followed by one more attempt.
 *
 * This module is the DECISION: which failure deserves another attempt, and how
 * long to wait before it. It knows nothing about fetch or SSE, so every branch
 * is testable with a constructed error. The loop that acts on the verdict
 * lives in `agent-loop.ts`.
 */

export interface RetryPolicy {
  /** Attempts in total, the first one included. Ten is what the CLI does. */
  maxAttempts: number;
  /** Wait after the first failure; doubles on each following one. */
  baseMs: number;
  /** The doubling stops here. */
  capMs: number;
  /**
   * Multiplier in [0.75, 1]. Ten sessions that failed on the same overload
   * would otherwise come back in the same millisecond and fail together again.
   */
  jitter: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  baseMs: 500,
  capMs: 30_000,
  jitter: () => 0.75 + Math.random() * 0.25,
};

/** A `retry-after` asking for more than this is asking us to give up instead. */
const RETRY_AFTER_CAP_MS = 60_000;

/** The API answered with a status that is not 2xx. */
export class ApiHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "ApiHttpError";
  }
}

/**
 * The API answered 200 and then sent an `error` event in the stream.
 * `emitted` says whether anything had already reached the handler: a retry
 * after that would replay text the user has already seen.
 */
export class ApiStreamError extends Error {
  constructor(message: string, readonly errorType: string, readonly emitted: boolean) {
    super(message);
    this.name = "ApiStreamError";
  }
}

/** The connection failed or dropped: no status, no event, just a broken pipe. */
export class ApiTransportError extends Error {
  constructor(message: string, readonly emitted: boolean, readonly cause?: unknown) {
    super(message);
    this.name = "ApiTransportError";
  }
}

export type RetryVerdict =
  | { kind: "retry"; reason: string; retryAfterMs: number | null }
  | { kind: "reauth"; reason: string }
  | { kind: "give-up" };

/**
 * 408/409/429 and every 5xx (529 is the overload), the same set the official
 * SDK retries. 400, 403, 404, 413, 422 mean the request itself is wrong, and
 * sending it again would only cost the same error twice.
 */
const TRANSIENT_STATUSES = new Set([408, 409, 429]);

/** In-stream error types the API documents as "try again". */
const TRANSIENT_STREAM_ERRORS = new Set(["overloaded_error", "api_error", "rate_limit_error", "timeout_error"]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status) || status >= 500;
}

export function classifyFailure(err: unknown): RetryVerdict {
  if (err instanceof ApiHttpError) {
    if (err.status === 401) return { kind: "reauth", reason: "API 401" };
    if (isTransientStatus(err.status)) {
      return { kind: "retry", reason: `API ${err.status}`, retryAfterMs: err.retryAfterMs };
    }
    return { kind: "give-up" };
  }
  if (err instanceof ApiStreamError) {
    // Whatever the type, once content reached the handler a second round would
    // append a second copy of it: the honest thing is to stop and say so.
    if (err.emitted) return { kind: "give-up" };
    if (err.errorType === "authentication_error") return { kind: "reauth", reason: "stream authentication_error" };
    if (TRANSIENT_STREAM_ERRORS.has(err.errorType)) {
      return { kind: "retry", reason: `stream ${err.errorType}`, retryAfterMs: null };
    }
    return { kind: "give-up" };
  }
  if (err instanceof ApiTransportError) {
    return err.emitted ? { kind: "give-up" } : { kind: "retry", reason: "network", retryAfterMs: null };
  }
  return { kind: "give-up" };
}

/**
 * `retry-after` comes as seconds or as an HTTP date. Both are honoured, both
 * are capped: the header is a hint about the server's load, not a contract
 * that lets it park a turn for an hour.
 */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(RETRY_AFTER_CAP_MS, Math.round(Number(s) * 1000));
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - now));
}

/**
 * How long to wait after `attempt` (1-based, the one that just failed).
 * `retry-after`, when the server sent one, is a floor: we never come back
 * sooner than asked, and never later than our own curve would have us.
 */
export function backoffMs(attempt: number, policy: RetryPolicy, retryAfterMs: number | null = null): number {
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exp * policy.jitter());
  return retryAfterMs != null ? Math.max(jittered, retryAfterMs) : jittered;
}

/**
 * A wait that a Stop can interrupt. Without this the turn would sit in a 30s
 * backoff after the user pressed Stop, and the abort would look ignored.
 * Rejects with the signal's own reason so the caller reads the cause, not a
 * generic message.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const onAbort = () => { clearTimeout(t); reject(abortError(signal!)); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const e = new Error(typeof signal.reason === "string" ? signal.reason : "aborted while waiting to retry");
  e.name = "AbortError";
  return e;
}

/**
 * The message that reaches the chat when the attempts run out. Saying how
 * many is what tells the reader this was not a single unlucky request but a
 * provider that stayed down: the difference between "press Retry" and
 * "come back later".
 */
export function exhaustedMessage(original: string, attempts: number, elapsedMs: number): string {
  const retries = Math.max(0, attempts - 1);
  return `${original} (retried ${retries} ${retries === 1 ? "time" : "times"} over ${Math.round(elapsedMs / 1000)}s without success)`;
}
