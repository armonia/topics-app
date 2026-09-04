/**
 * The provider hold: one memo for every clock that would otherwise find out on
 * its own that the plan's window is spent.
 *
 * @covers RESUME-04
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { providerHold, setProviderHold, clearProviderHold, onProviderHold, holdUntilLabel } from "./provider-hold";

const NOW = 1_800_000_000_000;

describe("provider hold", () => {
  beforeEach(() => clearProviderHold());

  test("a hold is in force until its end, then forgotten by itself", () => {
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "finestra di 5 ore del piano esaurita" }, NOW);
    expect(providerHold(NOW)?.untilMs).toBe(NOW + 60_000);
    expect(providerHold(NOW + 59_999)).not.toBeNull();
    expect(providerHold(NOW + 60_000)).toBeNull();
  });

  test("a later end replaces an earlier one; a shorter one does not shorten it", () => {
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "a" }, NOW);
    setProviderHold({ untilMs: NOW + 120_000, window: "seven_day", reason: "b" }, NOW);
    expect(providerHold(NOW)?.reason).toBe("b");
    setProviderHold({ untilMs: NOW + 30_000, window: "five_hour", reason: "c" }, NOW);
    expect(providerHold(NOW)?.reason).toBe("b");
  });

  test("a successful request lifts it, and the listeners hear both ends", () => {
    const seen: (number | null)[] = [];
    const off = onProviderHold((h) => seen.push(h?.untilMs ?? null));
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "a" }, NOW);
    clearProviderHold();
    clearProviderHold(); // idempotent: no second null
    off();
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "a" }, NOW);
    expect(seen).toEqual([NOW + 60_000, null]);
  });

  test("the label is an hour a person reads", () => {
    expect(holdUntilLabel({ untilMs: NOW })).toMatch(/^\d{2}:\d{2}$/);
  });
});
