/**
 * @covers dispatch-memory-history
 */
import { describe, expect, test } from "bun:test";
import {
  createDispatchMemoryHistory,
  DISPATCH_MEMORY_HISTORY_CADENCE_MS,
  DISPATCH_MEMORY_HISTORY_WINDOW_MS,
} from "./dispatch-memory-history";

describe("createDispatchMemoryHistory", () => {
  test("records no more than one reading per minute", () => {
    const history = createDispatchMemoryHistory();

    expect(history.record(1_000, 4.7)).toBe(true);
    expect(history.record(1_000 + DISPATCH_MEMORY_HISTORY_CADENCE_MS - 1, 4.6)).toBe(false);
    expect(history.record(1_000 + DISPATCH_MEMORY_HISTORY_CADENCE_MS, 4.5)).toBe(true);
    expect(history.read(61_000)).toEqual([
      { at: 1_000, freeGB: 4.7 },
      { at: 61_000, freeGB: 4.5 },
    ]);
  });

  test("keeps the two-hour window and never grows past its cadence bound", () => {
    const history = createDispatchMemoryHistory();
    const end = DISPATCH_MEMORY_HISTORY_WINDOW_MS + DISPATCH_MEMORY_HISTORY_CADENCE_MS;

    for (let at = 0; at <= end; at += DISPATCH_MEMORY_HISTORY_CADENCE_MS) {
      expect(history.record(at, 4.7)).toBe(true);
    }

    const points = history.read(end);
    expect(points).toHaveLength(DISPATCH_MEMORY_HISTORY_WINDOW_MS / DISPATCH_MEMORY_HISTORY_CADENCE_MS + 1);
    expect(points[0]?.at).toBe(DISPATCH_MEMORY_HISTORY_CADENCE_MS);
    expect(points.at(-1)?.at).toBe(end);
  });

  test("returns copies and rejects invalid or backwards readings", () => {
    const history = createDispatchMemoryHistory();
    expect(history.record(10_000, 4.7)).toBe(true);
    expect(history.record(9_000, 4.6)).toBe(false);
    expect(history.record(70_000, Number.NaN)).toBe(false);
    expect(history.record(Number.POSITIVE_INFINITY, 4.6)).toBe(false);
    expect(history.record(70_000, -1)).toBe(false);

    const snapshot = history.read(10_000);
    snapshot[0]!.freeGB = 0;
    snapshot.push({ at: 70_000, freeGB: 0 });
    expect(history.read(10_000)).toEqual([{ at: 10_000, freeGB: 4.7 }]);
  });

  test("expires stale readings when queried after the sampler stops", () => {
    const history = createDispatchMemoryHistory();
    const recordedAt = 1_000;
    history.record(recordedAt, 4.7);

    expect(history.read(recordedAt + DISPATCH_MEMORY_HISTORY_WINDOW_MS + 1)).toEqual([]);
  });
});
