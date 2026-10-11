/**
 * Putting async hooks back in the order they fired.
 *
 * @covers CCS-03
 */
import { describe, expect, test } from "bun:test";
import { createHookOrder, hookEventTime } from "./hook-order";

const T = 1_791_144_000_000;

describe("hookEventTime", () => {
  test("the script's stamp, header text or number, is the event time", () => {
    expect(hookEventTime(String(T - 3_000), T)).toBe(T - 3_000);
    expect(hookEventTime(T - 3_000, T)).toBe(T - 3_000);
  });

  test("no stamp, an empty one or a non-number is the arrival time", () => {
    for (const raw of [null, undefined, "", "1791144236N", "abc", "-5", "12.5"]) expect(hookEventTime(raw, T)).toBe(T);
  });

  test("a stamp from the future is not believed; a few ms ahead is the arrival", () => {
    expect(hookEventTime(String(T + 60_000), T)).toBe(T);
    expect(hookEventTime(String(T + 500), T)).toBe(T);
  });
});

describe("createHookOrder", () => {
  test("newer events are in order; one that fired before the newest applied is stale", () => {
    const order = createHookOrder();
    expect(order.admit("s", "UserPromptSubmit", undefined, T)).toBe("in-order");
    expect(order.admit("s", "Stop", undefined, T + 2_000)).toBe("in-order");
    expect(order.admit("s", "PreToolUse", "toolu_a", T + 1_000)).toBe("stale");
    // The stale one did not move the clock back: the next newer one is in order.
    expect(order.admit("s", "UserPromptSubmit", undefined, T + 1_500)).toBe("stale");
    expect(order.admit("s", "UserPromptSubmit", undefined, T + 3_000)).toBe("in-order");
  });

  test("equal times keep the arrival order", () => {
    const order = createHookOrder();
    expect(order.admit("s", "PreToolUse", "toolu_a", T)).toBe("in-order");
    expect(order.admit("s", "PreToolUse", "toolu_b", T)).toBe("in-order");
  });

  test("a PreToolUse whose PostToolUse already arrived is a finished call, whatever the clock", () => {
    const order = createHookOrder();
    expect(order.admit("s", "PostToolUse", "toolu_a", T + 10)).toBe("in-order");
    // Stamped LATER than its Post (jitter of two shells starting): the id still says it is over.
    expect(order.admit("s", "PreToolUse", "toolu_a", T + 20)).toBe("finished-call");
    expect(order.admit("s", "PreToolUse", "toolu_b", T + 30)).toBe("in-order");
  });

  test("a PostToolUse stamped before its own PreToolUse, arriving after it, closes the call", () => {
    const order = createHookOrder();
    expect(order.admit("s", "UserPromptSubmit", undefined, T)).toBe("in-order");
    // Jitter of two shells starting: the Pre is stamped 10 ms after its Post, and arrives first.
    expect(order.admit("s", "PreToolUse", "toolu_a", T + 910)).toBe("in-order");
    expect(order.admit("s", "PostToolUse", "toolu_a", T + 900)).toBe("in-order");
    // The clock did not move back: a hook fired between the two stamps is still stale.
    expect(order.admit("s", "Notification", undefined, T + 905)).toBe("stale");
  });

  test("a PostToolUse older than a hook applied AFTER its PreToolUse is still stale", () => {
    const order = createHookOrder();
    expect(order.admit("s", "PreToolUse", "toolu_a", T + 910)).toBe("in-order");
    expect(order.admit("s", "Stop", undefined, T + 3_000)).toBe("in-order");
    expect(order.admit("s", "PostToolUse", "toolu_a", T + 900)).toBe("stale");
  });

  test("sessions are independent", () => {
    const order = createHookOrder();
    order.admit("a", "Stop", undefined, T + 5_000);
    expect(order.admit("b", "PreToolUse", "x", T)).toBe("in-order");
    expect(order.admit("a", "PreToolUse", "x", T)).toBe("stale");
  });

  test("an opening read from the transcript stales a hook fired before it", () => {
    const order = createHookOrder();
    expect(order.admit("s", "Stop", undefined, T)).toBe("in-order");
    order.opened("s", T + 1_000);
    expect(order.admit("s", "Stop", undefined, T + 500)).toBe("stale");
    expect(order.admit("s", "Stop", undefined, T + 2_000)).toBe("in-order");
  });

  test("an opening older than the newest hook applied changes nothing", () => {
    const order = createHookOrder();
    expect(order.admit("s", "PreToolUse", "toolu_a", T + 2_100)).toBe("in-order");
    order.opened("s", T + 2_050);
    // The pairing still holds: the Post closes its own Pre whatever its stamp says.
    expect(order.admit("s", "PostToolUse", "toolu_a", T + 2_090)).toBe("in-order");
  });

  test("after an opening, a PostToolUse stamped before it is stale, not paired", () => {
    const order = createHookOrder();
    expect(order.admit("s", "PreToolUse", "toolu_a", T + 910)).toBe("in-order");
    order.opened("s", T + 1_000);
    expect(order.admit("s", "PostToolUse", "toolu_a", T + 900)).toBe("stale");
  });
});
