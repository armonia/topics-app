/**
 * BOARD WORKFLOWS on the task service (the board-workflows proposal in openspec).
 *
 * The stage rides on top of the status. There is one preset, `default`: the
 * `armonia` one (Triage, AI review, Human review) was removed, so every
 * delivery waits on a person, and a row or a stage left over from it must read
 * as the plain board without errors.
 *
 * @covers KANBAN-102
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { readBoardWorkflow, writeBoardWorkflow } from "./board-workflow";
import { awaitsHuman } from "../../shared/workflow";
import { UNOWNED_BACKLOG_MS } from "../../shared/created-by";

const WORKFLOWS_DDL = `CREATE TABLE board_workflows (scope TEXT PRIMARY KEY, preset TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const OPENER = "topic-opener";
const WORKER = "topic-worker";
const NOW = "2026-10-30T10:00:00.000Z";

function setup(): { db: Database; s: TaskService } {
  const db = freshDb();
  db.run(WORKFLOWS_DDL);
  for (const id of [OPENER, WORKER]) db.run("INSERT INTO topics (id) VALUES (?)", [id]);
  return { db, s: svc(db, { t: Date.parse(NOW) }) };
}

/** A card an agent opened, then claimed by another agent's topic. */
function agentCard(db: Database, s: TaskService, extra: Record<string, unknown> = {}) {
  const t = s.create({
    projectId: PID, text: "card opened by an agent", status: "todo",
    createdBy: "agent:api", createdByTopicId: OPENER, priority: 1, description: "bar", ...extra,
  });
  db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ?, dispatch_state = 'working' WHERE id = ?", [WORKER, t.id]);
  return t;
}

const deliver = (s: TaskService, id: string, extra: Record<string, unknown> = {}) =>
  s.update({ taskId: id, actor: "agent", by: `agent:${WORKER}`, agentTopicId: WORKER, patch: { status: "review", summary: "done, see the test", ...extra } });

describe("storage: project wins over global, nothing = default", () => {
  let db: Database;
  beforeEach(() => { ({ db } = setup()); });

  test("no row: the five columns of before", () => {
    expect(readBoardWorkflow(db, PID).preset).toBe("default");
  });
  test("the global row applies to every board, the project row wins", () => {
    writeBoardWorkflow(db, "*", "default", NOW);
    expect(readBoardWorkflow(db, PID)).toMatchObject({ preset: "default", source: "global" });
    writeBoardWorkflow(db, PID, "default", NOW);
    expect(readBoardWorkflow(db, PID)).toMatchObject({ preset: "default", source: "project" });
    writeBoardWorkflow(db, PID, null, NOW);
    expect(readBoardWorkflow(db, PID).source).toBe("global");
  });
  test("a database without the table reads as default instead of failing", () => {
    const bare = freshDb();
    expect(readBoardWorkflow(bare, PID).preset).toBe("default");
  });
  test("a row the removed preset left behind reads as the default, and cannot be written any more", () => {
    db.run("INSERT INTO board_workflows (scope, preset, updated_at) VALUES ('*', 'armonia', ?), (?, 'armonia', ?)", [NOW, PID, NOW]);
    expect(readBoardWorkflow(db, PID)).toMatchObject({ preset: "default", source: "default" });
    expect(readBoardWorkflow(db, PID).columns.map((c) => c.id)).toEqual(["backlog", "todo", "in_progress", "review", "ci", "done"]);
    expect(() => writeBoardWorkflow(db, PID, "armonia" as never, NOW)).toThrow(/unknown workflow preset/);
  });
});

describe("a board on the default workflow does not change", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { ({ db, s } = setup()); });

  test("no stage is ever written, and the card reads as before", () => {
    const h = s.create({ projectId: PID, text: "from a person", createdBy: "human" });
    expect(h.stage).toBeUndefined();
    const a = agentCard(db, s);
    const r = deliver(s, a.id);
    expect(r.status).toBe("review");
    expect(r.stage).toBeUndefined();
    expect("stage" in r).toBe(false);
    expect(awaitsHuman(r)).toBe(true);
    // The gate of before holds: the agent that opened it cannot close it.
    expect(() => s.update({ taskId: a.id, actor: "agent", by: "x", agentTopicId: OPENER, patch: { status: "done", summary: "proof" } }))
      .toThrow(/agents deliver|non è più assegnato/);
  });

  test("a stage that is not a column of the board, or contradicts the status, is refused", () => {
    const a = agentCard(db, s);
    expect(() => s.update({ taskId: a.id, actor: "human", by: "user", patch: { stage: "triage" } })).toThrow(/not a column/);
    expect(() => s.update({ taskId: a.id, actor: "human", by: "user", patch: { stage: "ci" } })).toThrow(/ci/);
  });

  test("a person's card parked in backlog is not reported as unowned", () => {
    const db2 = freshDb();
    const clock = { t: Date.parse(NOW) };
    const s2 = svc(db2, clock);
    s2.create({ projectId: PID, text: "parked by a person", createdBy: "human" });
    const mine = s2.create({ projectId: PID, text: "opened by an agent", createdBy: "agent:session" });
    clock.t += UNOWNED_BACKLOG_MS + 1000;
    expect(s2.sweepUnownedBacklog().map((t) => t.id)).toEqual([mine.id]);
  });
});

describe("what the removed preset left on cards", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { ({ db, s } = setup()); });

  test("a card stored in ai_review, human_review or triage reads in its plain column and waits on the person", () => {
    for (const [status, stage] of [["review", "ai_review"], ["review", "human_review"], ["backlog", "triage"]] as const) {
      const t = s.create({ projectId: PID, text: `left in ${stage}`, createdBy: "human", status });
      db.run("UPDATE tasks SET stage = ? WHERE id = ?", [stage, t.id]);
      const read = s.get(t.id)!.task;
      expect(readBoardWorkflow(db, PID).columns.some((c) => c.id === stage)).toBe(false);
      if (status === "review") expect(awaitsHuman(read)).toBe(true);
    }
  });

  test("applying the default clears the stages the board no longer has", () => {
    const t = s.create({ projectId: PID, text: "left in ai_review", createdBy: "human", status: "review" });
    db.run("UPDATE tasks SET stage = 'ai_review' WHERE id = ?", [t.id]);
    expect(s.applyBoardWorkflow({ scope: PID, preset: "default" }).map((c) => c.id)).toEqual([t.id]);
    expect(s.get(t.id)!.task.stage).toBeUndefined();
  });
});

describe("a delivery carries the question for the person, however it is asked", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { ({ db, s } = setup()); });

  const ask = (id: string, content = "Which layout do you prefer?") =>
    s.addComment({ taskId: id, author: `agent:${WORKER}`, content, questionOptions: ["A (recommended)", "B"] });

  test("a question in the thread, then the delivery without human_ask: the question is the human_ask", () => {
    const a = agentCard(db, s);
    ask(a.id);
    const d = deliver(s, a.id);
    expect(d.stage).toBeUndefined();
    expect(d.humanAsk).toBe("Which layout do you prefer?");
    expect(awaitsHuman(d)).toBe(true);
  });

  test("the system delivery reads the same question, and a card without one still says what to look at", () => {
    const a = agentCard(db, s);
    ask(a.id, "Which layout?");
    const d = s.deliverToReviewBySystem({ taskId: a.id, reason: "turn over" });
    expect(d.stage).toBeUndefined();
    expect(d.humanAsk).toBe("Which layout?");
    expect(awaitsHuman(d)).toBe(true);
    const h = s.create({ projectId: PID, text: "from a person", createdBy: "human", status: "todo" });
    db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ? WHERE id = ?", [WORKER, h.id]);
    const dh = s.deliverToReviewBySystem({ taskId: h.id, reason: "turn over" });
    expect(dh.stage).toBeUndefined();
    expect(awaitsHuman(dh)).toBe(true);
  });

  test("options that are only board actions are not a question, and neither is an answered one", () => {
    const a = agentCard(db, s);
    s.addComment({ taskId: a.id, author: `agent:${WORKER}`, content: "Delivered", questionOptions: ["Landa su main"] });
    expect(deliver(s, a.id).humanAsk).toBeUndefined();
    const b = agentCard(db, s);
    ask(b.id);
    s.addComment({ taskId: b.id, author: "user", content: "A" });
    expect(deliver(s, b.id).humanAsk).toBeUndefined();
  });

  test("a card a failed land withdraws from done waits on the person", () => {
    const a = agentCard(db, s);
    deliver(s, a.id, { humanAsk: "look at the layout" });
    const approved = s.reviewDecision({ taskId: a.id, by: "user", decision: "approve" });
    expect(approved.status).toBe("done");
    const back = s.update({ taskId: a.id, actor: "human", by: "system", patch: { status: "review" }, statusReason: "il land non è riuscito" });
    expect(back.status).toBe("review");
    expect(awaitsHuman(back)).toBe(true);
  });
});
