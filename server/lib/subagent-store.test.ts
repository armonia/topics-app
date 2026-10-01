/** @covers SUBAGENT-11, SUBAGENT-12, SUBAGENT-14, SUBAGENT-15 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { SubAgentResult } from "./subagent-result";
import {
  SUBAGENT_RESUME_WINDOW_MS,
  addPendingResult,
  allPendingResults,
  clearPendingResult,
  endedSubagents,
  getSubagent,
  insertSubagent,
  markTurnReported,
  resumeVerdict,
  runningSubagents,
  setSubagentState,
} from "./subagent-store";

const SQL = readFileSync(resolve(import.meta.dir, "../db/migrations/20261001203100-subagents.sql"), "utf8");

function db(): Database {
  const d = new Database(":memory:");
  d.exec(SQL);
  return d;
}
function child(d: Database, id: string, parent = "topic:p") {
  insertSubagent(d, {
    id, parentSessionKey: parent, name: id, model: "sonnet", agentType: "scout", effort: "low",
    promptSnippet: "find it", cwd: "/p", branch: null, claudeSessionId: `11111111-1111-4111-8111-${id.padStart(12, "0")}`,
    createdAt: "2026-10-01T10:00:00.000Z",
  });
}
const result = (turn: number, status: SubAgentResult["status"] = "completed"): SubAgentResult => ({
  agentId: "c1", name: "c1", turn, status, partial: false, text: "done", model: "claude-sonnet-5-5",
  agentType: "scout", durationMs: 1000, cwd: "/p", branch: null,
});

describe("the state of a sub-agent row", () => {
  test("born running, it holds a slot of its parent and of the machine", () => {
    const d = db();
    child(d, "c1");
    child(d, "c2", "topic:q");
    expect(runningSubagents(d, "topic:p").map((r) => r.id)).toEqual(["c1"]);
    expect(runningSubagents(d).length).toBe(2);
  });

  test("retired, stopped or lost: it holds no slot, and it is listed as ended", () => {
    const d = db();
    for (const [id, state] of [["c1", "retired"], ["c2", "stopped"], ["c3", "lost"]] as const) {
      child(d, id);
      setSubagentState(d, id, state, "2026-10-01T11:00:00.000Z");
    }
    expect(runningSubagents(d)).toEqual([]);
    expect(endedSubagents(d, "topic:p", Date.parse("2026-10-01T12:00:00.000Z")).map((r) => r.state).sort()).toEqual(["lost", "retired", "stopped"]);
  });

  test("resumed, it is running again with no end time", () => {
    const d = db();
    child(d, "c1");
    setSubagentState(d, "c1", "retired");
    setSubagentState(d, "c1", "running");
    expect(getSubagent(d, "c1")).toMatchObject({ state: "running", endedAt: null });
  });

  test("a reported turn advances the dedup and never moves it back", () => {
    const d = db();
    child(d, "c1");
    markTurnReported(d, "c1", 2, "2026-10-01T10:05:00.000Z");
    markTurnReported(d, "c1", 1);
    expect(getSubagent(d, "c1")).toMatchObject({ turnsReported: 2 });
  });

  test("past 24 hours an ended child leaves the list and its resume answers 410", () => {
    const d = db();
    child(d, "c1");
    setSubagentState(d, "c1", "stopped", "2026-10-01T10:00:00.000Z");
    const now = Date.parse("2026-10-01T10:00:00.000Z") + SUBAGENT_RESUME_WINDOW_MS + 1;
    expect(endedSubagents(d, "topic:p", now)).toEqual([]);
    expect(resumeVerdict(getSubagent(d, "c1")!, now)).toMatchObject({ ok: false, status: 410 });
    expect(resumeVerdict(getSubagent(d, "c1")!, now - 2)).toEqual({ ok: true });
  });

  test("a running child is not resumed, and one with no session cannot be", () => {
    const d = db();
    child(d, "c1");
    expect(resumeVerdict(getSubagent(d, "c1")!)).toMatchObject({ ok: false, status: 409 });
    expect(resumeVerdict({ ...getSubagent(d, "c1")!, state: "stopped", claudeSessionId: null })).toMatchObject({ ok: false, status: 410 });
  });
});

describe("results owed to the parent chat", () => {
  test("held at once, found again after a restart, dropped once delivered", () => {
    const d = db();
    child(d, "c1");
    addPendingResult(d, "c1", result(1));
    addPendingResult(d, "c1", result(1));
    addPendingResult(d, "c1", result(2));
    expect(allPendingResults(d)[0]!.results.map((r) => r.turn)).toEqual([1, 2]);
    clearPendingResult(d, "c1", 1, "completed");
    clearPendingResult(d, "c1", 2, "completed");
    expect(allPendingResults(d)).toEqual([]);
  });

  test("a database without the table answers as if there were no rows", () => {
    const bare = new Database(":memory:");
    expect(runningSubagents(bare)).toEqual([]);
    expect(getSubagent(bare, "x")).toBeNull();
    expect(() => insertSubagent(bare, { id: "x", parentSessionKey: "p", name: "x", model: null, agentType: null, effort: null, promptSnippet: null, cwd: "/", branch: null, claudeSessionId: null, createdAt: "now" })).not.toThrow();
  });
});
