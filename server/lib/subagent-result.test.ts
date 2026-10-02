/**
 * One result per turn of a `spawn_agent` child, from transcript fixtures in
 * `tests/fixtures/subagent/` shaped like the CLI's own records (the cases are
 * the production ones of 08/09-29/09: a prompt that never arrived, a stop on a
 * working sentence, a spend limit, a child steered into a second turn).
 * @covers SUBAGENT-11
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  UNDELIVERED_AFTER_MS,
  childModel,
  classifyChildTurn,
  endingChildTurn,
  pendingChildTurns,
  promptCount,
  resultKey,
  turnDurationMs,
} from "./subagent-result";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../tests/fixtures/subagent", `${name}.jsonl`), "utf-8").split("\n").filter(Boolean);
const idle = { turnsReported: 0, seededAt: 0, now: 1_000, undeliveredReported: false };

describe("classifyChildTurn", () => {
  test("a finished turn is reported without the process exiting", () => {
    expect(classifyChildTurn(fixture("completed"), 1)).toEqual({ status: "completed", partial: false, text: "Report: 3 files" });
  });

  test("a turn still working has nothing to report until something ends it", () => {
    expect(classifyChildTurn(fixture("stopped-midturn"), 1)).toBeNull();
  });

  test("a stop mid-turn is partial, its working sentence the last line seen", () => {
    expect(classifyChildTurn(fixture("stopped-midturn"), 1, { ending: "stopped" })).toEqual({
      status: "stopped", partial: true, text: "Sto mappando dove il tool_result finisce", reason: { code: "stopped-by-parent" },
    });
  });

  test("a spend limit is a failure with its line as the reason", () => {
    expect(classifyChildTurn(fixture("spend-limit"), 1)).toEqual({
      status: "failed", partial: false, text: "", reason: { code: "api-error", detail: "You've hit your monthly spend limit" },
    });
  });

  test("a prompt that never arrived is named undelivered once the child ends", () => {
    expect(classifyChildTurn(fixture("startup-only"), 1, { ending: "stopped" })).toEqual({
      status: "undelivered", partial: false, text: "", reason: { code: "no-prompt" },
    });
  });

  test("a lost terminal with no transcript at all", () => {
    expect(classifyChildTurn(null, 1, { ending: "lost" })).toEqual({ status: "lost", partial: false, text: "", reason: { code: "no-transcript" } });
  });
});

describe("what is not a prompt, and a turn that waits for its background work", () => {
  const bg = fixture("background-task");
  // Up to the first end_turn: the suite still runs in the background.
  const beforeNotification = bg.slice(0, 5);

  test("a task notification continues the turn instead of opening one", () => {
    expect(promptCount(bg)).toBe(1);
  });

  test("an end_turn with background work not yet reported is not the turn's end", () => {
    expect(classifyChildTurn(beforeNotification, 1)).toBeNull();
    expect(pendingChildTurns(beforeNotification, idle)).toEqual([]);
  });

  test("once the work reported and the child answered it, one result with the real outcome", () => {
    expect(classifyChildTurn(bg, 1)).toEqual({ status: "completed", partial: false, text: "Suite: 412 pass, 0 fail." });
    expect(pendingChildTurns(bg, idle)).toEqual([{ turn: 1, outcome: { status: "completed", partial: false, text: "Suite: 412 pass, 0 fail." } }]);
  });

  test("stopped while it waited, the promise is the last line seen, not a result", () => {
    expect(classifyChildTurn(beforeNotification, 1, { ending: "stopped" })).toEqual({
      status: "stopped", partial: true, text: "The suite is running in the background; I will report when it finishes.", reason: { code: "stopped-by-parent" },
    });
  });

  test("a compact summary is not a prompt: the turn goes on through it", () => {
    const lines = fixture("compact-midturn");
    expect(promptCount(lines)).toBe(1);
    expect(classifyChildTurn(lines, 1)).toEqual({ status: "completed", partial: false, text: "Callers: 3 files." });
  });
});

describe("pendingChildTurns", () => {
  test("two turns, two results, each with its own number", () => {
    const lines = fixture("two-turns");
    expect(pendingChildTurns(lines, idle).map((p) => [p.turn, p.outcome.text])).toEqual([
      [1, "Report: 3 files"],
      [2, "Two tests: a.test.ts and b.test.ts"],
    ]);
    // Turn 1 already reported: only the second one is left.
    expect(pendingChildTurns(lines, { ...idle, turnsReported: 1 }).map((p) => p.turn)).toEqual([2]);
    expect(pendingChildTurns(lines, { ...idle, turnsReported: 2 })).toEqual([]);
  });

  test("a turn still open reports nothing", () => {
    expect(pendingChildTurns(fixture("stopped-midturn"), idle)).toEqual([]);
  });

  test("a seed with no prompt record is undelivered after 60 s, once", () => {
    const lines = fixture("startup-only");
    expect(pendingChildTurns(lines, { ...idle, now: UNDELIVERED_AFTER_MS - 1 })).toEqual([]);
    expect(pendingChildTurns(lines, { ...idle, now: UNDELIVERED_AFTER_MS })).toEqual([
      { turn: 1, outcome: { status: "undelivered", partial: false, text: "", reason: { code: "no-prompt" } } },
    ]);
    expect(pendingChildTurns(lines, { ...idle, now: UNDELIVERED_AFTER_MS, undeliveredReported: true })).toEqual([]);
    expect(pendingChildTurns(lines, { ...idle, seededAt: null, now: 10 * UNDELIVERED_AFTER_MS })).toEqual([]);
  });
});

describe("endingChildTurn", () => {
  test("a stop on an idle child whose turn was reported produces no second result", () => {
    expect(endingChildTurn(fixture("completed"), { turnsReported: 1, undeliveredReported: false, ending: "stopped", exitCode: null })).toBeNull();
  });

  test("a stop mid-turn after a reported first turn reports the second as cut", () => {
    const lines = [...fixture("completed"), JSON.stringify({ type: "user", message: { role: "user", content: "and the tests?" } })];
    expect(endingChildTurn(lines, { turnsReported: 1, undeliveredReported: false, ending: "stopped", exitCode: null })).toEqual({
      turn: 2, outcome: { status: "stopped", partial: false, text: "", reason: { code: "stopped-by-parent" } },
    });
  });

  test("an undelivered prompt already reported is not reported again at the stop", () => {
    expect(endingChildTurn(fixture("startup-only"), { turnsReported: 0, undeliveredReported: true, ending: "stopped", exitCode: null })).toBeNull();
    expect(endingChildTurn(fixture("startup-only"), { turnsReported: 0, undeliveredReported: false, ending: "stopped", exitCode: null })?.outcome.status).toBe("undelivered");
  });

  test("a Reload mid-turn is stopped, and the resume's synthetic line is not taken for the child's text", () => {
    // What `--resume` of a turn cut by the Reload appends: a meta nudge and a synthetic answer, no end_turn.
    const lines = [
      ...fixture("stopped-midturn"),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] } }),
      JSON.stringify({ type: "assistant", message: { model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: "No response requested." }] } }),
    ];
    expect(classifyChildTurn(lines, 1)).toBeNull();
    expect(endingChildTurn(lines, { turnsReported: 0, undeliveredReported: false, ending: "reloaded", exitCode: null })).toEqual({
      turn: 1, outcome: { status: "stopped", partial: true, text: "Sto mappando dove il tool_result finisce", reason: { code: "reloaded" } },
    });
  });

  test("a Reload before the prompt arrived reports nothing: the undelivered clock still runs", () => {
    expect(endingChildTurn(fixture("startup-only"), { turnsReported: 0, undeliveredReported: false, ending: "reloaded", exitCode: null })).toBeNull();
    expect(endingChildTurn(null, { turnsReported: 0, undeliveredReported: false, ending: "reloaded", exitCode: null })).toBeNull();
  });

  test("a completed turn the monitor had not seen yet is still completed at the stop", () => {
    expect(endingChildTurn(fixture("completed"), { turnsReported: 0, undeliveredReported: false, ending: "stopped", exitCode: null })).toEqual({
      turn: 1, outcome: { status: "completed", partial: false, text: "Report: 3 files" },
    });
  });
});

describe("what a result carries", () => {
  test("the model the child really ran, never the synthetic one", () => {
    expect(childModel(fixture("completed"))).toBe("claude-sonnet-5-5");
    expect(childModel(fixture("spend-limit"))).toBeNull();
  });

  test("the duration of a turn, from its prompt to its last record", () => {
    expect(turnDurationMs(fixture("completed"), 1)).toBe(40_000);
    expect(turnDurationMs(fixture("two-turns"), 2)).toBe(30_000);
    expect(turnDurationMs(fixture("startup-only"), 1)).toBeNull();
  });

  test("the dedup key is per agent and turn, and an early undelivered has its own", () => {
    expect(resultKey({ agentId: "a1", turn: 2, status: "completed" })).toBe("a1:2");
    expect(resultKey({ agentId: "a1", turn: 1, status: "undelivered" })).not.toBe(resultKey({ agentId: "a1", turn: 1, status: "completed" }));
  });
});
