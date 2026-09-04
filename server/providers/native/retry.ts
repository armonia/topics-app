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
  /**
   * Attempts in total, the first one included.
   *
   * Ten is what the CLI does, and ten was not enough: on 2026-09-03 at 16:30
   * Anthropic had an open incident ("Elevated errors", Opus 5 and Fable 5.1)
   * and two resumed turns spent 10 attempts over 122s and 128s, every one of
   * them `overloaded_error`, then died the way they had died before the retry
   * existed. A wait costs nothing (no tokens, one idle socket), the person can
   * press Stop at any moment, and the indicator counts the attempts out loud.
   * So the window is ~10 minutes: long enough to outlive the short incidents,
   * short enough that a real outage is still reported within the turn.
   */
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
  // 0.5+1+2+4+8+16 s, then 30 s × 22 ≈ 11.5 min at most; ~10 min with jitter.
  maxAttempts: 28,
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
  const exponential = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential * policy.jitter());
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

export interface RetryRoundContext {
  /** Mutable on purpose: a renewed token must be used by every later attempt. */
  auth: { token: string };
  policy: RetryPolicy;
  signal?: AbortSignal;
  /** Called once on a 401: returns a fresh token, or null when only /login helps. */
  renewToken: (staleToken: string) => Promise<string | null>;
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; reason: string }) => void;
  /**
   * Asked on a 429: "is there a published end to this?" Answers with the
   * reset time (ms epoch) when the plan's usage window is spent, null when the
   * 429 is the per-minute kind that the backoff below absorbs. See
   * `usage-window.ts`: this is what turns 27 minutes of blind retries into one
   * notice with the hour on it.
   */
  onSaturated?: (retryAfterMs: number | null) => Promise<number | null>;
}

/**
 * One round, tried again when the failure is the API's and not ours.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Until 2026-09-03 a round was ONE request: any failure ended the turn with a
 * ⚠️ in the chat. The two measured that day (an in-stream overload, a 401 on
 * a token the CLI had just rotated) were both recoverable in under a second,
 * and Claude Code recovers from both. A companion that dies where the CLI
 * shrugs is not a companion.
 *
 * ── The rules, in order ─────────────────────────────────────────────────────
 *   · An abort (Stop, shutdown) is never retried: the cause is in the signal
 *     and the caller reads it there.
 *   · 401 → renew the token ONCE and try again. A second 401 is a real one.
 *   · Transient statuses / in-stream transient errors / a dropped connection
 *     BEFORE any content → wait with exponential backoff and try again, up to
 *     `maxAttempts`. `retry-after` is honoured as a floor.
 *   · Anything else, or anything after content was emitted → give up, and if
 *     attempts were spent say how many, so the reader knows the provider
 *     stayed down rather than blinked.
 *
 * The wait is announced through `onRetry` so the chat can show WHY nothing
 * moves, and so the route's silence watchdog counts it as life. `run` receives
 * the token to use: the only thing that changes between attempts.
 */
export async function retryRound<T>(run: (token: string) => Promise<T>, ctx: RetryRoundContext): Promise<T> {
  const { auth, policy, signal } = ctx;
  const startedAt = Date.now();
  let renewedOnce = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(auth.token);
    } catch (err) {
      if (signal?.aborted) throw err;
      const verdict = classifyFailure(err);
      const message = err instanceof Error ? err.message : String(err);

      if (verdict.kind === "reauth") {
        if (renewedOnce) throw err;
        renewedOnce = true;
        const fresh = await ctx.renewToken(auth.token);
        if (!fresh) {
          throw new Error(`${message}. The token could not be renewed either: run \`claude\` → /login once, then retry.`);
        }
        auth.token = fresh;
        console.warn(`[native] ${verdict.reason}: token renewed, retrying at once (attempt ${attempt + 1}/${policy.maxAttempts})`);
        ctx.onRetry?.({ attempt, maxAttempts: policy.maxAttempts, delayMs: 0, reason: verdict.reason });
        continue;
      }

      if (verdict.kind !== "retry" || attempt >= policy.maxAttempts) {
        throw attempt > 1 ? new Error(exhaustedMessage(message, attempt, Date.now() - startedAt)) : err;
      }

      // A 429 with a spent usage window is not transient: its end is a clock,
      // not a backoff. Give up NOW with the hour in the message, so the turn
      // ends as `rate-limit` (see stop-reason.ts) and whoever resumes it
      // (`provider-hold.ts` readers) waits for that hour instead of retrying.
      if (verdict.reason === "API 429" && ctx.onSaturated) {
        const untilMs = await ctx.onSaturated(verdict.retryAfterMs);
        if (untilMs != null && untilMs - Date.now() > policy.capMs) {
          throw new ApiHttpError(`API 429: usage window exhausted, resets at ${new Date(untilMs).toISOString()}`, 429, untilMs - Date.now());
        }
      }

      const delayMs = backoffMs(attempt, policy, verdict.retryAfterMs);
      console.warn(`[native] ${verdict.reason}: retrying in ${delayMs}ms (attempt ${attempt + 1}/${policy.maxAttempts})`);
      ctx.onRetry?.({ attempt, maxAttempts: policy.maxAttempts, delayMs, reason: verdict.reason });
      await sleepUnlessAborted(delayMs, signal);
    }
  }
}
