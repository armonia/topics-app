/** @covers USAGE-26 */
import { describe, expect, test } from "bun:test";
import { RATE_WINDOW_MS, createRateTracker, outputRate } from "./session-rate";

describe("outputRate", () => {
  test("growth over the window, divided by the time it took", () => {
    const s = [{ at: 0, out: 1000 }, { at: 15_000, out: 1600 }, { at: 30_000, out: 2200 }];
    expect(outputRate(s, 30_000)).toBe(40);
  });

  test("the baseline is the newest sample at or before the window start, so a long history is cut to the window", () => {
    const s = [{ at: 0, out: 0 }, { at: 40_000, out: 4000 }, { at: 70_000, out: 4600 }];
    // now 70 s: window starts at 40 s; the sample AT 40 s is the baseline.
    expect(outputRate(s, 70_000)).toBe(20);
  });

  test("no growth is a measured zero, not a missing value", () => {
    expect(outputRate([{ at: 0, out: 500 }, { at: 20_000, out: 500 }], 20_000)).toBe(0);
  });

  test("one sample, or two a heartbeat apart, state nothing", () => {
    expect(outputRate([{ at: 0, out: 5 }], 0)).toBeNull();
    expect(outputRate([{ at: 0, out: 5 }, { at: 1_000, out: 500 }], 1_000)).toBeNull();
  });

  test("two reads minutes apart are not «the last 30 s»: stale reads state nothing", () => {
    // observe(0), then observe(300 s) with nobody looking in between: 3000 tokens is a 5-minute average, not a 30 s speed.
    expect(outputRate([{ at: 0, out: 0 }, { at: 300_000, out: 3000 }], 300_000)).toBeNull();
    // once a second read lands inside the window the speed is the window's own
    expect(outputRate([{ at: 0, out: 0 }, { at: 300_000, out: 3000 }, { at: 310_000, out: 3200 }], 310_000)).toBe(20);
    // and a tracker nobody has read for longer than the window says nothing either
    expect(outputRate([{ at: 0, out: 0 }, { at: 10_000, out: 300 }], 100_000)).toBeNull();
  });

  test("a read a few seconds before the window start still serves as its baseline", () => {
    const s = [{ at: 66_000, out: 0 }, { at: 100_000, out: 3400 }];
    // now 100 s: window starts at 70 s; the read at 66 s is 4 s before it, inside the slack.
    expect(outputRate(s, 100_000)).toBe(100);
  });

  test("a counter that went backwards is not negative speed", () => {
    expect(outputRate([{ at: 0, out: 900 }, { at: 10_000, out: 10 }], 10_000)).toBeNull();
  });
});

describe("createRateTracker", () => {
  test("rate follows what was observed; a reset starts over", () => {
    const t = createRateTracker();
    t.observe("k", 0, 0);
    t.observe("k", 300, 10_000);
    expect(t.rate("k", 10_000)).toBe(30);
    t.observe("k", 50, 20_000); // counter reset
    expect(t.rate("k", 20_000)).toBeNull();
    t.observe("k", 350, 30_000);
    expect(t.rate("k", 30_000)).toBe(30);
  });

  test("grewWithin and firstSeen", () => {
    const t = createRateTracker();
    t.observe("k", 10, 1_000);
    t.observe("k", 10, 5_000);
    expect(t.grewWithin("k", 5_000, 60_000)).toBe(false);
    t.observe("k", 90, 9_000);
    expect(t.grewWithin("k", 9_000, 5_000)).toBe(true);
    expect(t.grewWithin("k", 60_000, 5_000)).toBe(false);
    expect(t.firstSeen("k")).toBe(1_000);
    expect(t.firstSeen("other")).toBeNull();
  });

  test("old samples are dropped but a baseline at the window edge is kept", () => {
    const t = createRateTracker();
    for (let i = 0; i <= 40; i++) t.observe("k", i * 100, i * 5_000);
    const now = 200_000;
    expect(t.rate("k", now)).toBe(20);
    expect(RATE_WINDOW_MS).toBe(30_000);
  });

  test("prune forgets sessions not seen since", () => {
    const t = createRateTracker();
    t.observe("old", 1, 1_000);
    t.observe("new", 1, 90_000);
    t.prune(50_000);
    expect(t.firstSeen("old")).toBeNull();
    expect(t.firstSeen("new")).toBe(90_000);
  });
});
