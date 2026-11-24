/**
 * Which security checks open or close an alert card, round after round.
 *
 * @covers MACHINE-07
 */
import { describe, expect, test } from "bun:test";
import type { CheckKey, CheckMsg, CheckStatus } from "../../shared/machine-health";
import { alertKey, securityAlerts, WARN_AS_PROBLEM_MS, type MachineRound, type TrackedChecks } from "./machine-security-alerts";

const H = 3_600_000;
const round = (status: CheckStatus, key: CheckKey = "access", msgs?: CheckMsg[]): Record<string, MachineRound> => ({
  m1: { name: "Node one", security: { checked_at: 1, status: "ok", checks: [{ key, status, detail: `${key} is ${status}`, msgs }] } },
});
const KEY = alertKey("m1", "access");

/** Runs rounds in order the way the caller does, keeping the open keys. */
function play(steps: Array<[CheckStatus, number]>) {
  let tracked: TrackedChecks = {};
  const openCards = new Set<string>();
  const opened: string[] = [];
  const closed: string[] = [];
  for (const [status, at] of steps) {
    const plan = securityAlerts(tracked, round(status), openCards, at);
    for (const a of plan.open) { openCards.add(a.key); opened.push(a.key); }
    for (const c of plan.close) { openCards.delete(c.key); closed.push(c.key); }
    tracked = plan.tracked;
  }
  return { opened, closed };
}

describe("securityAlerts (MACHINE-07)", () => {
  test("two problem rounds in a row open one card with the stable key", () => {
    expect(play([["problem", 0], ["problem", H]]).opened).toEqual([KEY]);
  });

  test("back to ok closes the card with the round's outcome", () => {
    const plan = securityAlerts({}, round("ok"), new Set([KEY]), 0);
    expect(plan.close).toEqual([{ key: KEY, outcome: "access is ok" }]);
    expect(play([["problem", 0], ["ok", H]]).closed).toEqual([KEY]);
  });

  test("ok with no open card does nothing", () => {
    const plan = securityAlerts({}, round("ok"), new Set(), 0);
    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([]);
  });

  test("warn opens a card only after 24 hours, counted from the first warn", () => {
    expect(play([["warn", 0], ["warn", WARN_AS_PROBLEM_MS - 1]]).opened).toEqual([]);
    expect(play([["warn", 0], ["warn", WARN_AS_PROBLEM_MS]]).opened).toEqual([KEY]);
  });

  test("a warn carrying its own age (days >= 1) opens the card on the first round, not the next day", () => {
    const withDays = (days: number): Record<string, MachineRound> => round("warn", "access", [{ code: "updates.macWaitingOld", params: { days } }]);
    const plan = securityAlerts({}, withDays(12), new Set(), 0);
    expect(plan.open).toEqual([{ key: KEY, title: "Node one: access is warn", detail: "access is warn" }]);
  });

  test("a warn interrupted by ok starts counting again", () => {
    expect(play([["warn", 0], ["ok", 10 * H], ["warn", 20 * H], ["warn", 30 * H]]).opened).toEqual([]);
  });

  test("unknown and info never open and never close", () => {
    expect(play([["unknown", 0], ["unknown", 30 * H]]).opened).toEqual([]);
    expect(securityAlerts({}, round("unknown"), new Set([KEY]), 0).close).toEqual([]);
    expect(securityAlerts({}, round("info"), new Set([KEY]), 0)).toEqual({ open: [], close: [], tracked: {} });
  });

  test("the title carries the machine name and the sentence", () => {
    expect(securityAlerts({}, round("problem"), new Set(), 0).open[0]!.title).toBe("Node one: access is problem");
  });
});
