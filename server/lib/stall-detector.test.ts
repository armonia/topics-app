import { describe, expect, test } from "bun:test";
import { armStallDetector } from "./stall-detector";

/**
 * @covers CHAT-REL-03 — the "stream inactivity" watchdog. Same requirement as
 * `turn-deadline.test.ts`, opposite half: that one covers the deadline, this
 * one covers arming and disarming the idle detector that replaced the
 * wall-clock turn kill.
 *
 * Same fake-timer bench as `turn-deadline.test.ts`: timers and the clock are
 * both moved by hand, because the detector's whole point is what happens at
 * expiry, not real wall-clock waiting.
 */
function fakeTimers() {
  let seq = 0;
  let ora = 1_000_000;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimer: (h: unknown) => { pending.delete(h as number); },
    fire() {
      const last = [...pending.keys()].pop();
      if (last === undefined) throw new Error("no timer armed");
      const t = pending.get(last)!;
      pending.delete(last);
      t.fn();
      return t.ms;
    },
    armedCount: () => pending.size,
    now: () => ora,
    silence(ms: number) { ora += ms; },
  };
}

describe("armStallDetector — silence asks the judge before ever cutting", () => {
  test("a clean 'alive' verdict rearms the SAME watch, never calls onStuck", async () => {
    const t = fakeTimers();
    let stuck = 0;
    let rearms: Array<"human" | "checks" | "alive"> = [];
    armStallDetector({
      idleMs: 5_000,
      isWaitingForHuman: () => false,
      getTail: () => "assistant: still thinking",
      judge: async () => "alive",
      onStuck: () => { stuck++; },
      onRearm: (r) => rearms.push(r),
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silence(5_000);
    t.fire();
    // The judge call is async — flush microtasks.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(stuck).toBe(0);
    expect(rearms).toEqual(["alive"]);
    // A fresh watch is armed after the "alive" verdict.
    expect(t.armedCount()).toBe(1);
  });

  test("a confirmed 'stuck' verdict calls onStuck exactly once and stops watching", async () => {
    const t = fakeTimers();
    let stuck = 0;
    armStallDetector({
      idleMs: 5_000,
      isWaitingForHuman: () => false,
      getTail: () => "assistant: same error, again, again",
      judge: async () => "stuck",
      onStuck: () => { stuck++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silence(5_000);
    t.fire();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(stuck).toBe(1);
    // Nothing left armed: the caller is expected to abort + resume from here.
    expect(t.armedCount()).toBe(0);
  });

  test("no transcript to read (null tail) never calls the judge and never recycles", async () => {
    const t = fakeTimers();
    let stuck = 0;
    let judged = 0;
    armStallDetector({
      idleMs: 5_000,
      isWaitingForHuman: () => false,
      getTail: () => null,
      judge: async () => { judged++; return "stuck"; },
      onStuck: () => { stuck++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silence(5_000);
    t.fire();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(judged).toBe(0);
    expect(stuck).toBe(0);
  });

  test("a human on screen rearms without ever asking the judge", async () => {
    const t = fakeTimers();
    let judged = 0;
    let rearms: Array<"human" | "checks" | "alive"> = [];
    armStallDetector({
      idleMs: 5_000,
      isWaitingForHuman: () => true,
      getTail: () => "assistant: waiting on you",
      judge: async () => { judged++; return "stuck"; },
      onStuck: () => {},
      onRearm: (r) => rearms.push(r),
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silence(5_000);
    t.fire();
    expect(judged).toBe(0);
    expect(rearms).toEqual(["human"]);
  });

  test("our own pre-review checks hold the watch: no judge, rearm says 'checks'", async () => {
    // 2026-09-04: a delivering agent waits on the checks gate for minutes, its
    // transcript is quiet, and the judge read that silence as "stuck".
    const t = fakeTimers();
    let judged = 0;
    let stuck = 0;
    let rearms: Array<"human" | "checks" | "alive"> = [];
    let checksRunning = true;
    armStallDetector({
      idleMs: 5_000,
      isWaitingForHuman: () => false,
      isWaitingForChecks: () => checksRunning,
      getTail: () => "assistant: PATCH status=review → 202 review_checks_running",
      judge: async () => { judged++; return "stuck"; },
      onStuck: () => { stuck++; },
      onRearm: (r) => rearms.push(r),
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silence(5_000);
    t.fire();
    expect(judged).toBe(0);
    expect(stuck).toBe(0);
    expect(rearms).toEqual(["checks"]);
    // Checks done, still quiet: now the judge is asked and may recycle.
    checksRunning = false;
    t.silence(5_000);
    t.fire();
    await Promise.resolve(); await Promise.resolve();
    expect(judged).toBe(1);
    expect(stuck).toBe(1);
  });

  test("noteActivity forwards to the live inner watch (resets silence)", () => {
    const t = fakeTimers();
    let stuck = 0;
    const detector = armStallDetector({
      idleMs: 5_000,
      isWaitingForHuman: () => false,
      getTail: () => "tail",
      judge: async () => "stuck",
      onStuck: () => { stuck++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silence(4_000);
    detector.noteActivity();
    t.silence(4_000); // 4s since the activity, still under the 5s threshold
    expect(t.armedCount()).toBe(1); // still watching, no expiry fired yet
    expect(stuck).toBe(0);
  });

  test("clear() stops the watch — a later expiry never calls onStuck", async () => {
    const t = fakeTimers();
    let stuck = 0;
    const detector = armStallDetector({
      idleMs: 5_000,
      isWaitingForHuman: () => false,
      getTail: () => "tail",
      judge: async () => "stuck",
      onStuck: () => { stuck++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    detector.clear();
    expect(t.armedCount()).toBe(0);
    expect(stuck).toBe(0);
  });
});
