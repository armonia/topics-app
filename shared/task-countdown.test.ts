/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from "bun:test";
import { CONTEXT_CRITICAL_PERCENT } from "./context-thresholds";
import { summarizeRunning, contextMeasure, estimateBasis, estimatesByProject, foldChildren, ownOfCounter, revisedEstimate, sessionWeight, taskCountdown, type EstimateBasis } from "./task-countdown";

const MIN = 60_000;

describe("estimateFromHistory", () => {
  test("only the most recent cards count", () => {
    const old = Array.from({ length: 60 }, () => ({ agentMs: 500 * MIN }));
    const recent = Array.from({ length: 50 }, () => ({ agentMs: 10 * MIN }));
    expect(estimateBasis([...recent, ...old])?.departureMs).toBe(10 * MIN);
  });
});

/** A history whose departure figure is 20 min, with a long tail: what the boards really close. */
const basisOf = (minutes: number[]): EstimateBasis => estimateBasis(minutes.map((m) => ({ agentMs: m * MIN }))) as EstimateBasis;
const tail = basisOf([5, 8, 10, 12, 14, 16, 18, 20, 22, 30, 45, 60, 90, 120, 240]);

describe("revisedEstimate", () => {
  test("before half way the departure figure holds", () => {
    const r = revisedEstimate(tail, 0.4 * tail.departureMs);
    expect(r).toEqual({ totalMs: tail.departureMs, revisedAt: null });
  });
  test("half way: the cards still at work at that point raise the figure", () => {
    const at = 0.5 * tail.departureMs;
    const r = revisedEstimate(tail, at);
    expect(r.revisedAt).toBe(0.5);
    expect(r.totalMs).toBeGreaterThan(tail.departureMs);
  });
  test("it never goes below the time spent and never comes down", () => {
    let last = 0;
    for (let m = 1; m <= 600; m += 7) {
      const r = revisedEstimate(tail, m * MIN);
      expect(r.totalMs).toBeGreaterThan(m * MIN);
      expect(r.totalMs).toBeGreaterThanOrEqual(last);
      last = r.totalMs;
    }
  });
  test("past the history, the time still to go is taken equal to the time spent", () => {
    const short = basisOf([10, 10, 10, 10, 10]);
    // 10 min: half at 5 (nothing lasted past 5... all lasted: 10 > 5, quantile 10, no raise), 3/4 at 7.5 (same), end at 10: 2 * 10 = 20.
    expect(revisedEstimate(short, 12 * MIN)).toEqual({ totalMs: 20 * MIN, revisedAt: 1 });
  });
  test("the same elapsed time always draws the same figure", () => {
    expect(revisedEstimate(tail, 77 * MIN)).toEqual(revisedEstimate(tail, 77 * MIN));
  });
});

describe("taskCountdown", () => {
  const flat = basisOf([20, 20, 20, 20, 20]);
  test("no estimate, nothing", () => {
    expect(taskCountdown({ basis: null, elapsedMs: 5 * MIN })).toBeNull();
  });
  test("counts down", () => {
    expect(taskCountdown({ basis: flat, elapsedMs: 8 * MIN })).toEqual({ remainingMs: 12 * MIN, totalMs: 20 * MIN, departureMs: 20 * MIN, revisedAt: null });
  });
  test("past the figure it is re-estimated, never shown as overrun", () => {
    const c = taskCountdown({ basis: flat, elapsedMs: 28 * MIN });
    expect(c?.revisedAt).toBe(1);
    expect(c?.remainingMs).toBeGreaterThan(0);
    expect(c?.departureMs).toBe(20 * MIN);
  });
  test("steps correct the estimate", () => {
    const c = taskCountdown({ basis: flat, elapsedMs: 9 * MIN, stepsDone: 1, stepsTotal: 4 });
    // pace says 36 min total, the figure says 20: blend 28, 9 spent
    expect(c?.remainingMs).toBe(19 * MIN);
  });
  test("on the closed cards' own tail, a card that runs long ends inside its last figure more often than not", () => {
    // Walk-forward on this history: every card of it, run against the others.
    let inside = 0;
    for (const m of [30, 45, 60, 90, 120]) {
      const shown = revisedEstimate(tail, (m - 1) * MIN).totalMs;
      if (m * MIN <= shown) inside += 1;
    }
    expect(inside).toBeGreaterThanOrEqual(3);
  });
});

describe("sessionWeight", () => {
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
  test("one estimate per project, the most recent cards first, none below the sample floor", () => {
    const done = (projectId: string, m: number) => ({ status: "done", projectId, agentMs: m * MIN });
    const tasks = [10, 20, 30, 40, 100].map((m) => done("a", m)).concat([done("b", 5), done("b", 6)], [{ status: "in_progress", projectId: "a", agentMs: 999 * MIN }]);
    const out = estimatesByProject(tasks);
    expect(out.get("a")?.departureMs).toBe(38 * MIN);
    expect(out.get("a")?.historyMs).toEqual([10, 20, 30, 40, 100].map((m) => m * MIN));
    expect(out.has("b")).toBe(false);
  });
});

describe("summarizeRunning", () => {
  const estimates = new Map([["a", basisOf([30, 30, 30, 30, 30])]]);
  const card = (id: string, projectId: string, minutes: number) => ({ id, projectId, agentMs: minutes * MIN });
  test("the soonest left among the cards that have an estimate, and how many were re-estimated", () => {
    const s = summarizeRunning([card("1", "a", 10), card("2", "a", 25), card("3", "a", 40), card("4", "none", 5)], estimates);
    expect(s).toEqual({ count: 4, soonestLeftMs: 5 * MIN, revised: 1 });
  });
  test("no estimate anywhere: a count and nothing to say about time", () => {
    expect(summarizeRunning([card("1", "none", 5)], estimates)).toEqual({ count: 1, soonestLeftMs: null, revised: 0 });
    expect(summarizeRunning([], estimates)).toEqual({ count: 0, soonestLeftMs: null, revised: 0 });
  });
});
