/**
 * Unit coverage for the marker-strip primitives used by the WS-based chat
 * handler in server/routes/topics.ts.
 *
 * Three regression scenarios this locks in:
 *   1. Closed marker stripped from the cumulative broadcast.
 *   2. Marker spanning two chunks (open in chunk N, close in chunk N+1):
 *      both halves stay invisible to the client.
 *   3. Same-chunk close + post-marker tail: the tail reaches the client
 *      while the marker is stripped.
 *
 * These three cases describe exactly the bug we fixed: a literal
 * `{{BROWSER:https://mcp.cloudflare.com/authorize?...}}` was reaching the
 * UI because the per-delta `newText.replace(markerRegex, '')` strip only
 * matched fully-closed markers within a single delta. The cumulative-delta
 * approach in computeCleanBroadcastDelta() defends every split.
 */
import { describe, test, expect } from "bun:test";
import {
  CLOSED_MARKER_REGEX,
  OPEN_MARKER_TAIL_REGEX,
  computeCleanBroadcastDelta,
} from "./topics";

describe("CLOSED_MARKER_REGEX", () => {
  test("matches every supported marker family in a single pass", () => {
    const input =
      "alpha {{BROWSER:https://example.com}} beta " +
      "{{TOPIC_SWITCH:abc-123}} gamma " +
      "{{TOPIC_NEW:Some topic}} delta " +
      "{{PROJECT_CREATE:/tmp/foo}} epsilon " +
      "{{PROJECT_OPEN:/tmp/bar}} omega";
    const stripped = input.replace(CLOSED_MARKER_REGEX, "");
    expect(stripped).toBe("alpha  beta  gamma  delta  epsilon  omega");
  });

  test("does NOT match an unclosed marker", () => {
    const input = "before {{BROWSER:https://example.com/foo";
    expect(input.replace(CLOSED_MARKER_REGEX, "")).toBe(input);
  });

  test("matches the inner-most close (non-greedy `[^}]*`)", () => {
    // `[^}]*` excludes `}`, so a stray `}` inside the body cannot accidentally
    // extend the match across the legitimate `}}` close.
    const input = "x {{BROWSER:foo}}}}";
    const stripped = input.replace(CLOSED_MARKER_REGEX, "");
    expect(stripped).toBe("x }}");
  });
});

describe("OPEN_MARKER_TAIL_REGEX", () => {
  test("matches an unclosed marker at end-of-string", () => {
    const input = "prefix {{BROWSER:https://example.com/foo";
    expect(input.replace(OPEN_MARKER_TAIL_REGEX, "")).toBe("prefix ");
  });

  test("does NOT match a closed marker followed by text", () => {
    const input = "prefix {{BROWSER:https://example.com}} suffix";
    // Already-closed marker; the open-tail anchor `$` means no match because
    // the string doesn't end with an unclosed `{{NAME:...`.
    expect(input.replace(OPEN_MARKER_TAIL_REGEX, "")).toBe(input);
  });

  test("works with all marker family names", () => {
    for (const name of ["BROWSER", "TOPIC_SWITCH", "TOPIC_NEW", "PROJECT_CREATE", "PROJECT_OPEN"]) {
      const input = `tail open {{${name}:partial`;
      expect(input.replace(OPEN_MARKER_TAIL_REGEX, "")).toBe("tail open ");
    }
  });
});

describe("computeCleanBroadcastDelta", () => {
  test("scenario 1: closed marker in single chunk → tail-only delta", () => {
    // First broadcast: fullContent ends with the close.
    const r = computeCleanBroadcastDelta(
      "Opening browser… {{BROWSER:https://example.com}} done.",
      "Opening browser… ",
    );
    expect(r.cumulativeClean).toBe("Opening browser…  done.");
    expect(r.delta).toBe(" done.");
  });

  test("scenario 2: marker spans two chunks — open chunk emits prefix only", () => {
    // Chunk N: open arrives, close hasn't. We expect the prefix-before-open
    // to land on the client, nothing else.
    const r = computeCleanBroadcastDelta(
      "Opening at {{BROWSER:https://mcp.cloudflare.com/authorize?response_type=",
      "",
    );
    expect(r.cumulativeClean).toBe("Opening at ");
    expect(r.delta).toBe("Opening at ");
  });

  test("scenario 2 continued: close-arriving chunk emits nothing new", () => {
    // Chunk N+1: the open + close are now both in fullContent. The
    // cumulative clean is `Opening at ` (the marker is fully stripped). The
    // previous broadcast already sent `Opening at `, so the new delta is
    // empty — the client never sees the URL fragment.
    const r = computeCleanBroadcastDelta(
      "Opening at {{BROWSER:https://mcp.cloudflare.com/authorize?response_type=code}}",
      "Opening at ",
    );
    expect(r.cumulativeClean).toBe("Opening at ");
    expect(r.delta).toBe("");
  });

  test("scenario 3: same-chunk close + post-marker tail → only tail delta'd", () => {
    // Server has already broadcast everything up to "Opening at ". This
    // chunk completes the marker AND adds " now check it out". The delta
    // should be " now check it out" — the marker stays invisible, the tail
    // arrives.
    const r = computeCleanBroadcastDelta(
      "Opening at {{BROWSER:https://example.com}} now check it out",
      "Opening at ",
    );
    expect(r.cumulativeClean).toBe("Opening at  now check it out");
    expect(r.delta).toBe(" now check it out");
  });

  test("scenario 4: multiple markers in one chunk", () => {
    const r = computeCleanBroadcastDelta(
      "Switched. {{TOPIC_SWITCH:abc}} Opening {{BROWSER:https://x.com}} now.",
      "",
    );
    expect(r.cumulativeClean).toBe("Switched.  Opening  now.");
    expect(r.delta).toBe("Switched.  Opening  now.");
  });

  test("scenario 5: non-monotonic clean (defensive) — re-baselines without delta", () => {
    // Pathological: prior broadcast claimed more than the new cumulative
    // clean has. Should NOT push a "negative" delta to the client; should
    // re-baseline silently. stream:end will reconcile.
    const r = computeCleanBroadcastDelta(
      "short",
      "much longer baseline that exceeds current clean",
    );
    expect(r.cumulativeClean).toBe("short");
    expect(r.delta).toBe("");
  });

  test("scenario 6: unclosed marker preserves clean prefix only", () => {
    const r = computeCleanBroadcastDelta(
      "Hi user {{PROJECT_OPEN:/path/to/project",
      "",
    );
    expect(r.cumulativeClean).toBe("Hi user ");
    expect(r.delta).toBe("Hi user ");
  });

  test("scenario 7: pure text (no marker) is delta'd verbatim", () => {
    const r = computeCleanBroadcastDelta("Hello world", "Hello ");
    expect(r.cumulativeClean).toBe("Hello world");
    expect(r.delta).toBe("world");
  });
});
