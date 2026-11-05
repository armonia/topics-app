/**
 * `dispatchBrakes`: who the dispatcher keeps in Todo, by its own rule, for the
 * board's «Frenato» chip.
 *
 * @covers HUBBR-20
 */
import { afterEach, describe, expect, test } from "bun:test";
import { clearPlanUsage, clearProviderHold, dispatchBrakes, liftClaudeEarlyStop, recordPlanUsage, resetClaudeEarlyStopLift, setProviderHold } from "./provider-hold";
import { PLAN_DISPATCH_HOLD_AT } from "../../shared/provider-hold";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

afterEach(() => { clearProviderHold(); clearProviderHold("codex"); clearPlanUsage(); resetClaudeEarlyStopLift(); });

describe("dispatchBrakes", () => {
  test("nothing held and the window below the line: no brake", () => {
    recordPlanUsage({ fiveHour: { utilization: PLAN_DISPATCH_HOLD_AT - 1, resetsAtMs: NOW + HOUR }, sevenDay: null }, NOW);
    expect(dispatchBrakes(NOW)).toEqual([]);
  });

  test("Claude at the line with its reset ahead: held until the reset, with the share", () => {
    recordPlanUsage({ fiveHour: { utilization: 94, resetsAtMs: NOW + HOUR }, sevenDay: null }, NOW);
    expect(dispatchBrakes(NOW)).toEqual([{ provider: "claude", window: "five_hour", utilization: 94, untilMs: NOW + HOUR, liftable: true }]);
  });

  test("a hold for Codex is its own row, without a share", () => {
    setProviderHold({ untilMs: NOW + 2 * HOUR, window: "usage_limit", reason: "x", provider: "codex" }, NOW);
    expect(dispatchBrakes(NOW)).toEqual([{ provider: "codex", window: "usage_limit", utilization: null, untilMs: NOW + 2 * HOUR }]);
  });

  test("Claude's hold wins over the reading and keeps the window's share", () => {
    recordPlanUsage({ fiveHour: null, sevenDay: { utilization: 100, resetsAtMs: NOW + 48 * HOUR } }, NOW);
    setProviderHold({ untilMs: NOW + 48 * HOUR, window: "seven_day", reason: "x" }, NOW);
    expect(dispatchBrakes(NOW)).toEqual([{ provider: "claude", window: "seven_day", utilization: 100, untilMs: NOW + 48 * HOUR }]);
  });

  test("the early stop lifted: gone for this window, back for the next one", () => {
    recordPlanUsage({ fiveHour: { utilization: 94, resetsAtMs: NOW + HOUR }, sevenDay: null }, NOW);
    expect(liftClaudeEarlyStop(NOW)).toBe(true);
    expect(dispatchBrakes(NOW)).toEqual([]);
    recordPlanUsage({ fiveHour: { utilization: 92, resetsAtMs: NOW + 6 * HOUR }, sevenDay: null }, NOW + 2 * HOUR);
    expect(dispatchBrakes(NOW + 2 * HOUR)).toEqual([{ provider: "claude", window: "five_hour", utilization: 92, untilMs: NOW + 6 * HOUR, liftable: true }]);
  });

  test("a provider's wall cannot be lifted, and is not liftable", () => {
    recordPlanUsage({ fiveHour: { utilization: 100, resetsAtMs: NOW + HOUR }, sevenDay: null }, NOW);
    setProviderHold({ untilMs: NOW + HOUR, window: "five_hour", reason: "x" }, NOW);
    expect(liftClaudeEarlyStop(NOW)).toBe(false);
    expect(dispatchBrakes(NOW)[0]).not.toHaveProperty("liftable");
  });

  test("an API outage names no end", () => {
    setProviderHold({ untilMs: NOW + 600_000, window: "api-down", reason: "x" }, NOW);
    expect(dispatchBrakes(NOW)[0]).toMatchObject({ provider: "claude", window: "api-down", untilMs: null });
  });
});
