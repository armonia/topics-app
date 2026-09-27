/**
 * The Claude hold as the open windows and the resume sweep hear of it.
 *
 * Card e30f35e4 asked that a turn cut during an API blackout resume within
 * the nudge once the API answers again (about 03:20:20Z on 25/09, before the
 * manual resend at 03:22), not at the sweep's next five-minute tick: a lifted
 * hold has to nudge the sweep. And an outage hold is no plan limit: the status
 * bar's banner, which speaks of one, must not show it.
 *
 * @covers RESUME-04
 */
import { afterEach, describe, expect, test } from "bun:test";
import { clearProviderHold, holdForApiDown, liftApiDownHold, onProviderHold, resetProviderHoldStore, setProviderHold } from "./provider-hold";
import { providerHoldFrame, wireHoldToResume } from "./provider-hold-broadcast";

const NOW = Date.now();
let unwire: (() => void) | null = null;

function wired() {
  const frames: Array<ReturnType<typeof providerHoldFrame>> = [];
  let nudges = 0;
  unwire = wireHoldToResume(onProviderHold, { broadcast: (f) => frames.push(f), nudge: () => { nudges++; } });
  return { frames, nudges: () => nudges };
}

afterEach(() => {
  unwire?.();
  unwire = null;
  clearProviderHold();
  resetProviderHoldStore();
});

describe("the hold, wired to the resume sweep and the banner", () => {
  test("an answer that lifts an outage hold nudges the sweep once", () => {
    const w = wired();
    holdForApiDown(NOW);
    expect(w.nudges()).toBe(0);
    liftApiDownHold(NOW + 1_000);
    expect(w.nudges()).toBe(1);
  });

  test("an outage hold goes out as no hold; a spent plan window goes out as itself", () => {
    const w = wired();
    holdForApiDown(NOW);
    expect(w.frames.at(-1)).toEqual({ type: "provider:hold", untilMs: null, window: null, reason: null, sinceMs: null });
    setProviderHold({ untilMs: NOW + 7_200_000, window: "five_hour", reason: "finestra di 5 ore esaurita" }, NOW);
    expect(w.frames.at(-1)).toMatchObject({ type: "provider:hold", window: "five_hour", untilMs: NOW + 7_200_000 });
    expect(providerHoldFrame(null).window).toBeNull();
  });
});
