/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from "bun:test";
import { CONTEXT_CRITICAL_PERCENT } from "./context-thresholds";
import { summarizeRunning, contextMeasure, estimateFromHistory, estimatesByProject, foldChildren, ownOfCounter, sessionWeight, sumTranscriptUsage, taskCountdown } from "./task-countdown";

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
      subAgents: { count: 2, billableTokens: 15, costCents: 10 },
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

describe("contextMeasure", () => {
  test("a provider payload becomes a measure", () => {
    expect(contextMeasure({ usage: { used: 150_000, size: 1_000_000 }, estimated: true })).toEqual({ usedTokens: 150_000, windowTokens: 1_000_000, estimated: true });
  });
  test("nothing measured, no measure", () => {
    expect(contextMeasure(null)).toBeNull();
    expect(contextMeasure({ usage: { used: 0, size: 1_000_000 } })).toBeNull();
    expect(contextMeasure({ usage: { used: 10, size: 0 } })).toBeNull();
    expect(contextMeasure({ usage: {} })).toBeNull();
  });
});

describe("sessionWeight context", () => {
  const base = { billableTokens: 0, cacheReadTokens: 0, costCents: 0 };
  test("compaction point is the shared critical threshold, not a local number", () => {
    const w = sessionWeight({ ...base, usedTokens: 500_000, windowTokens: 1_000_000 });
    expect(w.untilCompactionTokens).toBe(1_000_000 * (CONTEXT_CRITICAL_PERCENT / 100) - 500_000);
    expect(w.percent).toBe(50);
    expect(w.level).toBe("critical"); // 500k used is past the absolute per-call threshold
  });
  test("level follows the shared thresholds", () => {
    expect(sessionWeight({ ...base, usedTokens: 100_000, windowTokens: 1_000_000 }).level).toBe("ok");
    expect(sessionWeight({ ...base, usedTokens: 700_000, windowTokens: 1_000_000 }).level).toBe("critical");
    expect(sessionWeight({ ...base, usedTokens: 150_000, windowTokens: 200_000 }).level).toBe("warn");
  });
  test("no measure, no percent, no level, no room figure", () => {
    const w = sessionWeight({ ...base, usedTokens: null, windowTokens: null });
    expect([w.percent, w.level, w.untilCompactionTokens]).toEqual([null, null, null]);
  });
});

describe("foldChildren and ownOfCounter", () => {
  test("sums the children", () => {
    expect(foldChildren([{ billableTokens: 100, costCents: 5 }, { billableTokens: 50, costCents: 0 }])).toEqual({ count: 2, billableTokens: 150, costCents: 5 });
    expect(foldChildren([])).toEqual({ count: 0, billableTokens: 0, costCents: 0 });
  });
  test("the counter already carries the children: own is what is left", () => {
    expect(ownOfCounter(1000, 300)).toBe(700);
    expect(ownOfCounter(100, 300)).toBe(0);
  });
});

describe("estimatesByProject", () => {
  test("one median per project, none below the sample floor", () => {
    const done = (projectId: string, m: number) => ({ status: "done", projectId, agentMs: m * MIN });
    const tasks = [10, 20, 30, 40, 100].map((m) => done("a", m)).concat([done("b", 5), done("b", 6)], [{ status: "in_progress", projectId: "a", agentMs: 999 * MIN }]);
    const out = estimatesByProject(tasks);
    expect(out.get("a")).toBe(30 * MIN);
    expect(out.has("b")).toBe(false);
  });
});

describe("summarizeRunning", () => {
  const estimates = new Map([["a", 30 * MIN]]);
  const card = (id: string, projectId: string, minutes: number) => ({ id, projectId, agentMs: minutes * MIN });
  test("the soonest left among the cards that have an estimate, and how many are late", () => {
    const s = summarizeRunning([card("1", "a", 10), card("2", "a", 25), card("3", "a", 40), card("4", "none", 5)], estimates);
    expect(s).toEqual({ count: 4, soonestLeftMs: 5 * MIN, over: 1 });
  });
  test("no estimate anywhere: a count and nothing to say about time", () => {
    expect(summarizeRunning([card("1", "none", 5)], estimates)).toEqual({ count: 1, soonestLeftMs: null, over: 0 });
    expect(summarizeRunning([], estimates)).toEqual({ count: 0, soonestLeftMs: null, over: 0 });
  });
});
