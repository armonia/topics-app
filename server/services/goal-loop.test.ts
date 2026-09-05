/**
 * The brakes of the auto-continuation, one test each.
 *
 * The `continue` case is one line; the rest of this file is the "no"s, and that
 * proportion is the point: a loop that spends real turns is only as safe as the
 * conditions under which it refuses to spend one.
 *
 * @covers CHAT-GOALLOOP-01
 */
import { describe, it, expect } from "bun:test";
import {
  GOAL_JUDGE_PROMPT,
  IDLE_TURNS_LIMIT,
  MAX_GOAL_CONTINUATIONS,
  goalLoopStep,
  goalNudgeText,
  goalStopNotice,
  parseGoalVerdict,
  turnCanContinueGoal,
  toolBudgetResumeStep,
  toolBudgetStopNotice,
  TOOL_BUDGET_RESUME_TEXT,
} from "./goal-loop";
import type { FinishedTurn } from "./goal-loop";
import type { TopicGoal } from "../../shared/types";

const goal = (over: Partial<TopicGoal> = {}): TopicGoal => ({
  id: "g1",
  topicId: "t1",
  content: "portare la barra a verde",
  status: "active",
  createdBy: "human",
  createdAt: "2026-09-03T00:00:00.000Z",
  closedAt: null,
  steps: [],
  continuations: 0,
  idleTurns: 0,
  loopState: "running",
  ...over,
});

const turn = (over: Partial<FinishedTurn> = {}): FinishedTurn => ({
  dispatched: false,
  end: "end_turn",
  discarded: false,
  pendingAsk: false,
  usedTools: true,
  lastAssistantText: "ho fatto meta' del lavoro",
  ...over,
});

describe("turnCanContinueGoal", () => {
  it("says yes to a clean turn with an active goal", () => {
    expect(turnCanContinueGoal(turn(), goal())).toBe(true);
  });

  it("says no without a goal, or on a goal that is not active", () => {
    expect(turnCanContinueGoal(turn(), null)).toBe(false);
    expect(turnCanContinueGoal(turn(), goal({ status: "achieved" }))).toBe(false);
  });

  it("says no on a dispatched turn: the board has its own loop", () => {
    expect(turnCanContinueGoal(turn({ dispatched: true }), goal())).toBe(false);
  });

  it("says no on a turn that did not end by itself", () => {
    for (const end of ["max_tokens", "cancelled", "error", "refusal"]) {
      expect(turnCanContinueGoal(turn({ end }), goal())).toBe(false);
    }
  });

  it("says no when the turn is parked on a question to the human", () => {
    expect(turnCanContinueGoal(turn({ pendingAsk: true }), goal())).toBe(false);
  });

  it("says no on a discarded (empty) turn", () => {
    expect(turnCanContinueGoal(turn({ discarded: true }), goal())).toBe(false);
  });

  it("says no once the loop is blocked or stopped: that is the Stop button", () => {
    expect(turnCanContinueGoal(turn(), goal({ loopState: "blocked" }))).toBe(false);
    expect(turnCanContinueGoal(turn(), goal({ loopState: "stopped" }))).toBe(false);
  });
});

describe("goalLoopStep", () => {
  const counters = { continuations: 0, idleTurns: 0, state: "running" as const };

  it("continues, and numbers the attempt", () => {
    const d = goalLoopStep({ verdict: "continue", counters, usedTools: true });
    expect(d.action).toEqual({ kind: "continue", attempt: 1 });
    expect(d.loop).toEqual({ continuations: 1, idleTurns: 0, state: "running" });
  });

  it("closes the goal when the judge says it is met", () => {
    const d = goalLoopStep({ verdict: "met", counters, usedTools: true });
    expect(d.action.kind).toBe("achieved");
    expect(d.loop.state).toBe("stopped");
  });

  it("waits for the human when the judge sees a question", () => {
    const d = goalLoopStep({ verdict: "blocked_on_user", counters: { ...counters, idleTurns: 1 }, usedTools: false });
    expect(d.action.kind).toBe("blocked");
    expect(d.loop.state).toBe("blocked");
    expect(d.loop.idleTurns).toBe(0);
  });

  it("does nothing at all when the judge is unreadable", () => {
    const d = goalLoopStep({ verdict: null, counters, usedTools: true });
    expect(d.action.kind).toBe("undecided");
    expect(d.loop).toEqual(counters);
  });

  it("stops after two turns in a row that ran no tool", () => {
    const first = goalLoopStep({ verdict: "continue", counters, usedTools: false });
    expect(first.action).toEqual({ kind: "continue", attempt: 1 });
    expect(first.loop.idleTurns).toBe(1);

    const second = goalLoopStep({ verdict: "continue", counters: first.loop, usedTools: false });
    expect(second.action.kind).toBe("stalled");
    expect(second.loop.state).toBe("stopped");
    expect(IDLE_TURNS_LIMIT).toBe(2);
  });

  it("forgets the idle streak as soon as a turn does work", () => {
    const idle = goalLoopStep({ verdict: "continue", counters, usedTools: false });
    const working = goalLoopStep({ verdict: "continue", counters: idle.loop, usedTools: true });
    expect(working.action.kind).toBe("continue");
    expect(working.loop.idleTurns).toBe(0);
  });

  it("stops at the ceiling and does not spend one more turn", () => {
    const atCap = { continuations: MAX_GOAL_CONTINUATIONS, idleTurns: 0, state: "running" as const };
    const d = goalLoopStep({ verdict: "continue", counters: atCap, usedTools: true });
    expect(d.action).toEqual({ kind: "capped", attempt: MAX_GOAL_CONTINUATIONS });
    expect(d.loop.state).toBe("stopped");
    expect(d.loop.continuations).toBe(MAX_GOAL_CONTINUATIONS);
  });

  it("spends the last continuation before the ceiling, not one less", () => {
    const d = goalLoopStep({
      counters: { continuations: MAX_GOAL_CONTINUATIONS - 1, idleTurns: 0, state: "running" },
      verdict: "continue",
      usedTools: true,
    });
    expect(d.action).toEqual({ kind: "continue", attempt: MAX_GOAL_CONTINUATIONS });
  });
});

describe("parseGoalVerdict", () => {
  it("reads the three bare answers", () => {
    expect(parseGoalVerdict("met")).toBe("met");
    expect(parseGoalVerdict(" continue\n")).toBe("continue");
    expect(parseGoalVerdict("blocked_on_user")).toBe("blocked_on_user");
  });

  it("takes the FIRST verdict of a verbose answer, which is the pick", () => {
    expect(parseGoalVerdict("continue, it is not met yet")).toBe("continue");
    expect(parseGoalVerdict("blocked_on_user - it asked a question, so not continue")).toBe("blocked_on_user");
  });

  it("does not read a verdict out of a word that merely contains one", () => {
    expect(parseGoalVerdict("the metrics are unmet")).toBe(null);
    expect(parseGoalVerdict("")).toBe(null);
    expect(parseGoalVerdict("I cannot answer")).toBe(null);
  });
});

describe("the texts", () => {
  it("puts the objective in the prompt and asks for one word", () => {
    const p = GOAL_JUDGE_PROMPT({
      goal: "portare la barra a verde",
      steps: [{ content: "scrivere il test", status: "completed" }],
      lastAssistantText: "ho scritto il test",
    });
    expect(p).toContain("portare la barra a verde");
    expect(p).toContain("scrivere il test");
    expect(p).toContain("ho scritto il test");
    expect(p).toContain("blocked_on_user");
  });

  it("clips a long last message instead of shipping the whole turn", () => {
    const p = GOAL_JUDGE_PROMPT({ goal: "g", steps: [], lastAssistantText: "x".repeat(5000) });
    expect(p.length).toBeLessThan(3000);
    expect(p).toContain("[...]");
  });

  it("names both exits in the nudge: close it, or ask and stop", () => {
    const t = goalNudgeText("portare la barra a verde");
    expect(t).toContain("portare la barra a verde");
    expect(t).toContain("close_goal");
    expect(t).toContain("stop");
  });

  it("writes a notice only for the stops that need explaining", () => {
    expect(goalStopNotice({ kind: "capped", attempt: 20 }, "g")).toContain(String(MAX_GOAL_CONTINUATIONS));
    expect(goalStopNotice({ kind: "stalled" }, "g")).toContain("no tool");
    expect(goalStopNotice({ kind: "continue", attempt: 1 }, "g")).toBe(null);
    expect(goalStopNotice({ kind: "achieved" }, "g")).toBe(null);
    expect(goalStopNotice({ kind: "blocked" }, "g")).toBe(null);
  });
});

describe("our tool budget is a machine end, not a decision", () => {
  it("a turn cut by our tool budget is a candidate for the goal loop; a real provider error is not", () => {
    expect(turnCanContinueGoal(turn({ end: "error", cause: "tool-budget" }), goal())).toBe(true);
    expect(turnCanContinueGoal(turn({ end: "error", cause: "provider-error" }), goal())).toBe(false);
    expect(turnCanContinueGoal(turn({ end: "error", cause: "process-died" }), goal())).toBe(false);
    expect(turnCanContinueGoal(turn({ end: "cancelled", cause: "watchdog" }), goal())).toBe(false);
  });

  it("the budget keeps the other brakes: dispatched, parked on a question, loop not running", () => {
    const cut = { end: "error", cause: "tool-budget" } as const;
    expect(turnCanContinueGoal(turn({ ...cut, dispatched: true }), goal())).toBe(false);
    expect(turnCanContinueGoal(turn({ ...cut, pendingAsk: true }), goal())).toBe(false);
    expect(turnCanContinueGoal(turn(cut), goal({ loopState: "stopped" }))).toBe(false);
  });

  it("without a goal: one resume, then stop, and nothing for any other end", () => {
    const cut = turn({ end: "error", cause: "tool-budget" });
    expect(toolBudgetResumeStep(cut, false)).toBe("resume");
    expect(toolBudgetResumeStep(cut, true)).toBe("stop");
    expect(toolBudgetResumeStep(turn({ end: "error", cause: "provider-error" }), false)).toBe("none");
    expect(toolBudgetResumeStep(turn(), false)).toBe("none");
    expect(toolBudgetResumeStep(turn({ end: "error", cause: "tool-budget", dispatched: true }), false)).toBe("none");
    expect(toolBudgetResumeStep(turn({ end: "error", cause: "tool-budget", pendingAsk: true }), false)).toBe("none");
    expect(toolBudgetResumeStep(turn({ end: "error", cause: "tool-budget", discarded: true }), false)).toBe("none");
  });

  it("the stop notice names the budget and hands over to the human", () => {
    const notice = toolBudgetStopNotice(300);
    expect(notice).toContain("300 giri di tool");
    expect(notice.startsWith("⚠️ ")).toBe(true);
    expect(TOOL_BUDGET_RESUME_TEXT).toContain("not by your choice");
  });
});
