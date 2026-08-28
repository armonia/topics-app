/**
 * The verdict a silent stream gets: nothing, one-shot resync, extend, finalize.
 * A live child is never ended by a clock; a dead one is finalized on the first
 * stale tick.
 *
 * @covers CHAT-REL-03
 */
import { describe, expect, test } from "bun:test";
import { staleStreamVerdict } from "./stale-stream-verdict";

const TIMEOUT = 3 * 60_000;

describe("staleStreamVerdict", () => {
  test("inside the silence window nothing happens", () => {
    expect(staleStreamVerdict({ silentMs: 10_000, timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: false })).toBe("ok");
    expect(staleStreamVerdict({ silentMs: TIMEOUT, timeoutMs: TIMEOUT, childAlive: false, alreadyResynced: true })).toBe("ok");
  });

  test("first stale tick on a live child spends the one-shot resync", () => {
    expect(staleStreamVerdict({ silentMs: TIMEOUT + 1, timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: false })).toBe("rescue");
  });

  /**
   * The regression. The liveness probe used to sit INSIDE the rescue branch,
   * so the second stale tick finalized a turn whose child was still working:
   * a 12-min build or a CLI auto-compact lost its answer and, on a dispatched
   * task, burnt an attempt. A child that is WORKING is never killed by a clock —
   * same policy as handleGraceExpiry / handleHardTimeout.
   *
   * The word "working" is doing real work in that sentence, and it was added on
   * 2026-08-28: see the frozen case below. The protection this test pins is for
   * a turn that has something in flight, which is what the 12-min build is.
   */
  test("a working child is NEVER finalized, however long the silence", () => {
    const working = { timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: true, toolRunning: true };
    expect(staleStreamVerdict({ silentMs: 6 * 60_000, ...working })).toBe("extend");
    expect(staleStreamVerdict({ silentMs: 12 * 60_000, ...working })).toBe("extend");
    expect(staleStreamVerdict({ silentMs: 3 * 60 * 60_000, ...working })).toBe("extend");
  });

  test("the resync is one-shot: an extend never re-issues it", () => {
    const verdicts = [true, true, true].map((_, i) =>
      staleStreamVerdict({ silentMs: TIMEOUT * (i + 2), timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: i > 0, toolRunning: true }),
    );
    expect(verdicts).toEqual(["rescue", "extend", "extend"]);
  });

  /**
   * THE THIRD STATE, and the price that made this rule get written.
   *
   * On 2026-08-28 the probe was fixed so it tells the truth about who owns the
   * session, and the defect flipped: `topic:0299ac2d` stayed "streaming" for
   * FIFTEEN MINUTES with zero characters and zero tools, extended on every tick
   * by the "a live turn is never killed by a clock" branch. Neither clock has a
   * real ceiling: the 30-minute hard cap also extends on a live child.
   *
   * "The process is alive" does NOT mean "the turn is making progress": the
   * native provider holds its AbortController for the whole request, so the probe
   * answers `true` even when the call to the model has stalled.
   */
  test("alive, silent and with nothing in flight: past the cap it is STUCK, not extended", () => {
    const idle = { timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: true, toolRunning: false };
    // Under the cap it still waits: the cost of waiting is a few minutes.
    expect(staleStreamVerdict({ silentMs: 5 * 60_000, ...idle })).toBe("extend");
    // Past it, it is stuck and that must be said.
    expect(staleStreamVerdict({ silentMs: 10 * 60_000, ...idle })).toBe("frozen");
    expect(staleStreamVerdict({ silentMs: 15 * 60_000, ...idle })).toBe("frozen");
  });

  test("the frozen cap does NOT touch a turn that is working", () => {
    // The line that separates the cure from the relapse: same silence, same live
    // child, but with a tool in flight the verdict stays "extend".
    expect(staleStreamVerdict({
      silentMs: 60 * 60_000, timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: true, toolRunning: true,
    })).toBe("extend");
  });

  test("a dead child finalizes on the first stale tick, rescue spent or not", () => {
    expect(staleStreamVerdict({ silentMs: TIMEOUT + 1, timeoutMs: TIMEOUT, childAlive: false, alreadyResynced: false })).toBe("finalize");
    expect(staleStreamVerdict({ silentMs: TIMEOUT + 1, timeoutMs: TIMEOUT, childAlive: false, alreadyResynced: true })).toBe("finalize");
  });

  test("a provider that cannot answer finalizes: the sweeper must still be able to close a stream", () => {
    expect(staleStreamVerdict({ silentMs: TIMEOUT + 1, timeoutMs: TIMEOUT, childAlive: undefined, alreadyResynced: false })).toBe("finalize");
  });
});
