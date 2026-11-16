/**
 * @covers SUBAGENT-29
 */
import { describe, expect, it } from "bun:test";
import { decodeLogSince, encodeLogOffset, randomLogEpoch } from "./subagent-remote-log-epoch";

describe("subagent-remote-log-epoch", () => {
  it("round-trips within the same epoch", () => {
    const epoch = 42;
    const offset = encodeLogOffset(epoch, 7);
    expect(decodeLogSince(epoch, offset)).toBe(7);
  });

  it("a since from a different epoch replays from 0, instead of skipping the log's first entries", () => {
    const oldOffset = encodeLogOffset(1, 5);
    expect(decodeLogSince(2, oldOffset)).toBe(0);
  });

  it("since=0 (never read before) always resolves to 0", () => {
    expect(decodeLogSince(99, 0)).toBe(0);
  });

  it("a negative or junk since never goes negative", () => {
    expect(decodeLogSince(5, -3)).toBe(0);
    expect(decodeLogSince(5, NaN)).toBe(0);
  });

  it("randomLogEpoch stays inside the safe range for encodeLogOffset", () => {
    const epoch = randomLogEpoch();
    expect(epoch).toBeGreaterThanOrEqual(0);
    expect(epoch).toBeLessThan(1_000_000);
    expect(Number.isSafeInteger(encodeLogOffset(epoch, 123))).toBeTrue();
  });
});
