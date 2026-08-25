/**
 * CHAT-TOOL-03 — the tool-call body must not strobe.
 *
 * The requirement was named in `ToolCallRow.tsx` long before anything tested
 * it, which is the worst combination available: a source comment quoting an id
 * reads as coverage to everyone who greps for it. The rule lives in
 * `toolRowDisclosure.ts` now precisely so this file can exist.
 *
 * The two halves fail in OPPOSITE directions, and only one of them looks like
 * a bug in a screenshot:
 *
 *  - open too eagerly → a burst of sub-100 ms tools flashes panels open and
 *    shut, the transcript jumps, and whatever you were reading moves;
 *  - close too eagerly → a 500 ms tool opens a panel that is gone before you
 *    can read a line of it. That one is easy to "fix" by deleting the dwell,
 *    which is why the dwell has its own test here instead of being folded into
 *    the delay's.
 *
 * The numbers are perceptual, not arbitrary, so they are asserted as numbers:
 * a later change that halves them would keep every behavioural test green
 * while bringing the flash back.
 *
 * @covers CHAT-TOOL-03
 */
import { describe, test, expect } from "bun:test";
import {
  AUTO_OPEN_DELAY_MS,
  AUTO_OPEN_MIN_DWELL_MS,
  autoOpenSchedule,
  bodyIsOpen,
} from "./toolRowDisclosure";

/** The row's state, as the effect sees it. */
const running = (now = 0) => autoOpenSchedule(true, false, 0, now);
const finished = (autoOpen: boolean, openedAt: number, now: number) =>
  autoOpenSchedule(false, autoOpen, openedAt, now);

describe("an instant tool never opens at all", () => {
  test("while running, the only thing armed is a DELAYED open", () => {
    // The whole anti-flash rule rests on this being a timer and not an
    // immediate `setAutoOpen(true)`: React's cleanup cancels a timer, and
    // cancelling is how the instant tool ends up never having opened.
    expect(running()).toEqual({ action: "open", delayMs: AUTO_OPEN_DELAY_MS });
  });

  test("a tool that finished before opening schedules NOTHING", () => {
    // The state an instant tool lands in: not running, never auto-opened.
    // Returning a close timer here would be harmless but wrong; returning an
    // open would be the flash itself.
    expect(finished(false, 0, 100)).toBeNull();
  });

  test("the threshold is a quarter second, and that is a measurement", () => {
    // ~250 ms is the edge of noticing a panel appear. Below it the open and
    // the close read as one flicker rather than as two events. If this number
    // ever moves, it should move because someone measured again.
    expect(AUTO_OPEN_DELAY_MS).toBe(250);
  });
});

describe("a short tool stays readable", () => {
  test("finishing 100 ms after opening still buys the rest of the dwell", () => {
    const plan = finished(true, 1_000, 1_100);
    expect(plan).toEqual({ action: "close", delayMs: AUTO_OPEN_MIN_DWELL_MS - 100 });
  });

  test("the dwell is a floor of a second and a half", () => {
    expect(AUTO_OPEN_MIN_DWELL_MS).toBe(1500);
  });

  test("a long tool has already paid the dwell and closes at once", () => {
    // The other direction, and the reason the residual is computed instead of
    // re-armed: a five-second tool must not keep its panel open a further
    // 1.5 s after the turn ended, or finished rows never go back to compact.
    expect(finished(true, 1_000, 6_000)).toEqual({ action: "close", delayMs: 0 });
  });

  test("the residual never goes negative", () => {
    // `setTimeout` with a negative delay fires immediately, so this is not a
    // crash — it is the kind of arithmetic that quietly stops meaning what it
    // says the day someone adds a comparison to it.
    const plan = finished(true, 0, 10_000);
    expect(plan).not.toBeNull();
    expect(plan!.delayMs).toBeGreaterThanOrEqual(0);
  });
});

describe("an explicit toggle always wins over the automatism", () => {
  const base = { userToggled: false, open: false, isSubAgent: false, isHumanTurn: false, autoOpen: false };

  test("closed by the user stays closed even while the tool runs", () => {
    // The failure this pins is a control that fights back: you close a panel,
    // and it reopens itself a quarter second later.
    expect(bodyIsOpen({ ...base, userToggled: true, open: false, autoOpen: true })).toBe(false);
  });

  test("opened by the user stays open after the tool finishes", () => {
    expect(bodyIsOpen({ ...base, userToggled: true, open: true, autoOpen: false })).toBe(true);
  });

  test("a user toggle also overrides the always-open kinds", () => {
    // Sub-agent and human-turn rows open by default, and that default must
    // still be a default: someone who collapsed a long sub-agent log to get
    // past it does not want it back on the next render.
    expect(bodyIsOpen({ ...base, userToggled: true, open: false, isSubAgent: true })).toBe(false);
    expect(bodyIsOpen({ ...base, userToggled: true, open: false, isHumanTurn: true })).toBe(false);
  });

  test("untouched, each of the three reasons opens the body on its own", () => {
    expect(bodyIsOpen({ ...base, isSubAgent: true })).toBe(true);
    expect(bodyIsOpen({ ...base, isHumanTurn: true })).toBe(true);
    expect(bodyIsOpen({ ...base, autoOpen: true })).toBe(true);
    expect(bodyIsOpen(base), "and nothing opens it without a reason").toBe(false);
  });
});
