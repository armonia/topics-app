import { describe, expect, test } from "bun:test";
import { estimateFromHistory, sessionWeight, sumTranscriptUsage, taskCountdown } from "./task-countdown";

const MIN = 60_000;

describe("estimateFromHistory", () => {
  test("no estimate below the sample floor", () => {
    expect(estimateFromHistory([{ agentMs: MIN }, { agentMs: 2 * MIN }])).toBeNull();
  });
  test("median of closed cards", () => {
    const xs = [10, 20, 30, 40, 100].map((m) => ({ agentMs: m * MIN }));
    expect(estimateFromHistory(xs)).toBe(30 * MIN);
  });
});

describe("taskCountdown", () => {
  test("no estimate, nothing", () => {
    expect(taskCountdown({ estimateMs: null, elapsedMs: 5 * MIN })).toBeNull();
  });
  test("counts down", () => {
    expect(taskCountdown({ estimateMs: 20 * MIN, elapsedMs: 8 * MIN })).toEqual({ kind: "left", remainingMs: 12 * MIN });
  });
  test("overrun is reported as overrun", () => {
    expect(taskCountdown({ estimateMs: 20 * MIN, elapsedMs: 28 * MIN })).toEqual({ kind: "over", overMs: 8 * MIN });
  });
  test("steps correct the estimate", () => {
    const c = taskCountdown({ estimateMs: 20 * MIN, elapsedMs: 10 * MIN, stepsDone: 1, stepsTotal: 4 });
    // pace says 40 min total, history says 20: blend 30, 10 spent
    expect(c).toEqual({ kind: "left", remainingMs: 20 * MIN });
  });
});

describe("sessionWeight", () => {
  test("transcript sum counts each message id once", () => {
    const rows = [
      { id: "a", input: 100, output: 50, cacheWrite: 10, cacheRead: 1000 },
      { id: "a", input: 100, output: 50, cacheWrite: 10, cacheRead: 1000 },
      { id: "b", input: 20, output: 5, cacheWrite: 0, cacheRead: 500 },
    ];
    expect(sumTranscriptUsage(rows)).toEqual({ billable: 185, cacheRead: 1500 });
  });
  test("percent, compaction headroom and children", () => {
    const w = sessionWeight({
      usedTokens: 100_000, windowTokens: 200_000, billableTokens: 185, cacheReadTokens: 1500, costCents: 40,
      children: { count: 2, billableTokens: 15, costCents: 10 },
    });
    expect(w.percent).toBe(50);
    expect(w.untilCompactionTokens).toBe(80_000);
    expect(w.totalBillableTokens).toBe(200);
    expect(w.totalCostCents).toBe(50);
  });
  test("no measured context, no percent", () => {
    const w = sessionWeight({ usedTokens: null, windowTokens: null, billableTokens: 1, cacheReadTokens: 0, costCents: 0 });
    expect(w.percent).toBeNull();
    expect(w.untilCompactionTokens).toBeNull();
  });
});
