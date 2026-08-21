/**
 * The watchdog decides whether every terminal on the machine dies. Both ways of
 * getting it wrong are silent for a while and then very loud:
 * recycling a live bridge kills PTYs mid-turn (31 times before 2026-08-21), and
 * never recycling leaves a hung daemon wedged with no cure.
 */
import { describe, expect, it } from "bun:test";
import { bridgeWatchdogStep, BRIDGE_ESCALATE_MS, BRIDGE_MUTE_MS } from "./bridge-watchdog";

const NOW = 1_000_000;

describe("bridgeWatchdogStep", () => {
  it("does nothing while the pong is fresh", () => {
    expect(bridgeWatchdogStep(NOW, NOW - 1_000, NOW - 1_000, 0)).toBe("ok");
  });

  it("does nothing when the pong is late but BYTES are still arriving", () => {
    // The exact case that cost 31 recycles: a pong stuck behind a big replay.
    expect(bridgeWatchdogStep(NOW, NOW - BRIDGE_MUTE_MS - 1, NOW - 500, 0)).toBe("ok");
  });

  it("resets the socket, NOT the daemon, the first time it goes fully mute", () => {
    const mute = NOW - BRIDGE_MUTE_MS - 1;
    expect(bridgeWatchdogStep(NOW, mute, mute, 0)).toBe("soft-reset");
  });

  it("waits before escalating: a reset needs time to work", () => {
    const mute = NOW - BRIDGE_MUTE_MS - 1;
    expect(bridgeWatchdogStep(NOW, mute, mute, NOW - BRIDGE_ESCALATE_MS + 1_000)).toBe("ok");
  });

  it("SIGTERMs only when it is still mute after the reset", () => {
    const mute = NOW - BRIDGE_MUTE_MS - 1;
    expect(bridgeWatchdogStep(NOW, mute, mute, NOW - BRIDGE_ESCALATE_MS)).toBe("sigterm");
  });

  it("an armed watchdog that starts hearing bytes again stands down", () => {
    // Disarming is the caller's job (on a real pong), but a live bridge must
    // never reach the SIGTERM branch in the meantime.
    expect(bridgeWatchdogStep(NOW, NOW - BRIDGE_MUTE_MS - 1, NOW - 100, NOW - 60_000)).toBe("ok");
  });
});
