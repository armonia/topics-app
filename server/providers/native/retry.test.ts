/**
 * The retry DECISION, exercised without a network.
 *
 * Every branch here maps to a failure the native runtime has actually shown
 * in the chat (see the header of `retry.ts`): the two measured on 2026-09-03
 * (an in-stream `overloaded_error`, a 401 on a rotated token) plus the shapes
 * the official SDK retries. What must NOT be retried is asserted too: a 400 is
 * the request's fault, and a stream that already delivered text cannot be
 * replayed without showing that text twice.
 * @covers CHAT-REL-06
 */
import { describe, expect, test } from "bun:test";
import {
  ApiHttpError,
  ApiStreamError,
  ApiTransportError,
  backoffMs,
  classifyFailure,
  exhaustedMessage,
  isTransientStatus,
  parseRetryAfter,
  retryRound,
  sleepUnlessAborted,
  type RetryPolicy,
} from "./retry";

const flat: RetryPolicy = { maxAttempts: 10, baseMs: 100, capMs: 1000, jitter: () => 1 };

describe("which failures get another attempt", () => {
  test("529 overloaded and the other transient statuses: retry", () => {
    for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) {
      expect(isTransientStatus(s)).toBe(true);
      expect(classifyFailure(new ApiHttpError(`API ${s}`, s)).kind).toBe("retry");
    }
  });

  test("400, 403, 404, 413, 422: the request is wrong, give up", () => {
    for (const s of [400, 403, 404, 413, 422]) {
      expect(isTransientStatus(s)).toBe(false);
      expect(classifyFailure(new ApiHttpError(`API ${s}`, s)).kind).toBe("give-up");
    }
  });

  test("401: not a retry, a re-authentication", () => {
    expect(classifyFailure(new ApiHttpError("API 401", 401))).toEqual({ kind: "reauth", reason: "API 401" });
  });

  test("retry-after travels with the verdict", () => {
    const v = classifyFailure(new ApiHttpError("API 429", 429, 2500));
    expect(v).toEqual({ kind: "retry", reason: "API 429", retryAfterMs: 2500 });
  });

  test("in-stream overloaded_error before any content: retry (the case measured on 2026-09-03)", () => {
    const v = classifyFailure(new ApiStreamError("stream error: overloaded", "overloaded_error", false));
    expect(v.kind).toBe("retry");
  });

  test("the same stream error AFTER content was emitted: give up, a replay would duplicate it", () => {
    const v = classifyFailure(new ApiStreamError("stream error: overloaded", "overloaded_error", true));
    expect(v.kind).toBe("give-up");
  });

  test("in-stream invalid_request_error: not transient", () => {
    expect(classifyFailure(new ApiStreamError("bad", "invalid_request_error", false)).kind).toBe("give-up");
  });

  test("in-stream authentication_error: re-authenticate", () => {
    expect(classifyFailure(new ApiStreamError("auth", "authentication_error", false)).kind).toBe("reauth");
  });

  test("a dropped connection before any byte: retry; after content: give up", () => {
    expect(classifyFailure(new ApiTransportError("fetch failed", false)).kind).toBe("retry");
    expect(classifyFailure(new ApiTransportError("socket hang up", true)).kind).toBe("give-up");
  });

  test("anything else (a bug of ours, a tool exception) is never retried", () => {
    expect(classifyFailure(new Error("TypeError: x is not a function")).kind).toBe("give-up");
    expect(classifyFailure("string").kind).toBe("give-up");
  });
});

describe("the default window", () => {
  test("outlives a ten-minute incident, and is over well within fifteen", () => {
    const { DEFAULT_RETRY_POLICY } = require("./retry") as typeof import("./retry");
    const worst = { ...DEFAULT_RETRY_POLICY, jitter: () => 1 };
    let total = 0;
    for (let a = 1; a < worst.maxAttempts; a++) total += backoffMs(a, worst);
    expect(total).toBeGreaterThan(9 * 60_000);
    expect(total).toBeLessThan(15 * 60_000);
  });
});

describe("how long to wait", () => {
  test("doubles from the base and stops at the cap", () => {
    expect(backoffMs(1, flat)).toBe(100);
    expect(backoffMs(2, flat)).toBe(200);
    expect(backoffMs(3, flat)).toBe(400);
    expect(backoffMs(4, flat)).toBe(800);
    expect(backoffMs(5, flat)).toBe(1000);
    expect(backoffMs(9, flat)).toBe(1000);
  });

  test("jitter only ever shortens, never lengthens", () => {
    const low: RetryPolicy = { ...flat, jitter: () => 0.75 };
    expect(backoffMs(3, low)).toBe(300);
  });

  test("retry-after is a floor, not a replacement", () => {
    expect(backoffMs(1, flat, 5000)).toBe(5000);
    expect(backoffMs(5, flat, 50)).toBe(1000);
  });

  test("retry-after in seconds, as a date, capped, or unreadable", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0.5")).toBe(500);
    const now = Date.parse("2026-09-03T12:00:00Z");
    expect(parseRetryAfter("Thu, 03 Sep 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("3600")).toBe(60_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
  });
});

describe("the wait between attempts", () => {
  test("resolves after the delay", async () => {
    const t0 = Date.now();
    await sleepUnlessAborted(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  test("a Stop during the wait rejects at once with the signal's reason", async () => {
    const ac = new AbortController();
    const p = sleepUnlessAborted(10_000, ac.signal);
    setTimeout(() => ac.abort("user"), 5);
    const t0 = Date.now();
    await expect(p).rejects.toThrow("user");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("an already-aborted signal does not even start the timer", async () => {
    const ac = new AbortController();
    ac.abort("server-shutdown");
    await expect(sleepUnlessAborted(10_000, ac.signal)).rejects.toThrow("server-shutdown");
  });
});

describe("the sentence when attempts run out", () => {
  test("says how many times and for how long", () => {
    expect(exhaustedMessage("API 529: overloaded", 10, 121_400)).toBe(
      "API 529: overloaded (retried 9 times over 121s without success)",
    );
    expect(exhaustedMessage("x", 2, 500)).toContain("retried 1 time over");
  });
});

/**
 * A 429 with a spent usage window has an END, not a backoff: the loop asks
 * once and gives up with the hour in the message.
 *
 * @covers RESUME-04
 */
describe("a 429 with a spent usage window", () => {
  const policy: RetryPolicy = { maxAttempts: 5, baseMs: 1, capMs: 5, jitter: () => 1 };
  const ctxBase = { auth: { token: "t" }, policy, renewToken: async () => null };

  test("gives up at once with the reset in the message, instead of spending the attempts", async () => {
    let calls = 0;
    const untilMs = Date.now() + 3 * 60 * 60_000;
    const asked: (number | null)[] = [];
    const run = async () => { calls++; throw new ApiHttpError("API 429: rate limit", 429, 7_000); };
    await expect(retryRound(run, { ...ctxBase, onSaturated: async (ra) => { asked.push(ra); return untilMs; } }))
      .rejects.toThrow(/API 429: usage window exhausted, resets at \d{4}-/);
    expect(calls).toBe(1);
    expect(asked).toEqual([7_000]);
  });

  test("no spent window: the ordinary backoff, as before", async () => {
    let calls = 0;
    const run = async () => { calls++; if (calls < 3) throw new ApiHttpError("API 429: rate limit", 429, null); return "ok"; };
    expect(await retryRound(run, { ...ctxBase, onSaturated: async () => null })).toBe("ok");
    expect(calls).toBe(3);
  });

  test("a reset closer than the backoff cap is left to the backoff", async () => {
    let calls = 0;
    const run = async () => { calls++; if (calls < 2) throw new ApiHttpError("API 429: rate limit", 429, null); return "ok"; };
    expect(await retryRound(run, { ...ctxBase, onSaturated: async () => Date.now() + 2 })).toBe("ok");
    expect(calls).toBe(2);
  });
});
