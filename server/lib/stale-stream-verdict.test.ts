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
   * task, burnt an attempt. A live child is never killed by a clock — same
   * policy as handleGraceExpiry / handleHardTimeout.
   */
  test("a live child is NEVER finalized, however long the silence", () => {
    expect(staleStreamVerdict({ silentMs: 6 * 60_000, timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: true })).toBe("extend");
    expect(staleStreamVerdict({ silentMs: 12 * 60_000, timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: true })).toBe("extend");
    expect(staleStreamVerdict({ silentMs: 3 * 60 * 60_000, timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: true })).toBe("extend");
  });

  test("the resync is one-shot: an extend never re-issues it", () => {
    const verdicts = [true, true, true].map((_, i) =>
      staleStreamVerdict({ silentMs: TIMEOUT * (i + 2), timeoutMs: TIMEOUT, childAlive: true, alreadyResynced: i > 0 }),
    );
    expect(verdicts).toEqual(["rescue", "extend", "extend"]);
  });

  test("a dead child finalizes on the first stale tick, rescue spent or not", () => {
    expect(staleStreamVerdict({ silentMs: TIMEOUT + 1, timeoutMs: TIMEOUT, childAlive: false, alreadyResynced: false })).toBe("finalize");
    expect(staleStreamVerdict({ silentMs: TIMEOUT + 1, timeoutMs: TIMEOUT, childAlive: false, alreadyResynced: true })).toBe("finalize");
  });

  test("a provider that cannot answer finalizes: the sweeper must still be able to close a stream", () => {
    expect(staleStreamVerdict({ silentMs: TIMEOUT + 1, timeoutMs: TIMEOUT, childAlive: undefined, alreadyResynced: false })).toBe("finalize");
  });
});
