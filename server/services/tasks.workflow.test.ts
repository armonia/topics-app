/**
 * BOARD WORKFLOWS on the task service (the board-workflows proposal in openspec).
 *
 * The stage rides on top of the status: a board with no workflow row behaves
 * exactly as before; on the `armonia` preset a card from a person is born in
 * Triage, a delivery on a card an agent opened goes back to that agent (AI
 * review) and only a delivery with a question for the person reaches Human
 * review. The agent that opened the card is the one that closes it, with the
 * proof (rule of 28/10: whoever opens a card closes it).
 *
 * @covers KANBAN-102
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { readBoardWorkflow, writeBoardWorkflow } from "./board-workflow";
import { AI_REVIEW_REMIND_MS, AI_REVIEW_RETRY_MS, awaitsHuman, columnOfTask } from "../../shared/workflow";
import { _resetAiReviewNotices, _takeWaitingAiReviewNotices } from "./ai-review-notice";
import { UNOWNED_BACKLOG_MS } from "../../shared/created-by";

const WORKFLOWS_DDL = `CREATE TABLE board_workflows (scope TEXT PRIMARY KEY, preset TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const OPENER = "topic-opener";
const WORKER = "topic-worker";
const OTHER = "topic-other";

function setup(): { db: Database; s: TaskService } {
  const db = freshDb();
  db.run(WORKFLOWS_DDL);
  for (const id of [OPENER, WORKER, OTHER]) db.run("INSERT INTO topics (id) VALUES (?)", [id]);
  return { db, s: svc(db, { t: Date.parse("2026-10-30T10:00:00.000Z") }) };
}

/** A card an agent opened, then claimed by another agent's topic. */
function agentCard(db: Database, s: TaskService, extra: Record<string, unknown> = {}) {
  const t = s.create({
    projectId: PID, text: "card opened by an agent", status: "todo",
    createdBy: "agent:session", createdByTopicId: OPENER, ...extra,
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
    writeBoardWorkflow(db, "*", "armonia", "2026-10-30T10:00:00.000Z");
    expect(readBoardWorkflow(db, PID)).toMatchObject({ preset: "armonia", source: "global" });
    writeBoardWorkflow(db, PID, "default", "2026-10-30T10:00:00.000Z");
    expect(readBoardWorkflow(db, PID)).toMatchObject({ preset: "default", source: "project" });
    writeBoardWorkflow(db, PID, null, "2026-10-30T10:00:00.000Z");
    expect(readBoardWorkflow(db, PID).source).toBe("global");
  });
  test("a database without the table reads as default instead of failing", () => {
    const bare = freshDb();
    expect(readBoardWorkflow(bare, PID).preset).toBe("default");
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
});

describe("armonia: triage, AI review, human review", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    ({ db, s } = setup());
    writeBoardWorkflow(db, PID, "armonia", "2026-10-30T10:00:00.000Z");
  });
  const columns = () => readBoardWorkflow(db, PID).columns;

  test("a card from a person is born in Triage; a complete card from an agent is not", () => {
    const h = s.create({ projectId: PID, text: "from a person", createdBy: "human" });
    expect(h.stage).toBe("triage");
    expect(columnOfTask(columns(), h)?.id).toBe("triage");
    const done = s.create({ projectId: PID, text: "shaped", createdBy: "agent:jarvis", priority: 1, description: "bar: tests green" });
    expect(done.stage).toBeUndefined();
    const raw = s.create({ projectId: PID, text: "raw", createdBy: "agent:jarvis" });
    expect(raw.stage).toBe("triage");
  });

  test("triage sends the card to Todo: stage todo moves the status and clears the stage", () => {
    const h = s.create({ projectId: PID, text: "from a person", createdBy: "human" });
    const t = s.update({ taskId: h.id, actor: "agent", by: "agent:coordinator", agentTopicId: OTHER, patch: { stage: "todo", priority: 1 } });
    expect(t.status).toBe("todo");
    expect(t.stage).toBeUndefined();
    expect(t.priority).toBe(1);
  });

  test("a stage that is not on the board, or contradicts the status, is refused", () => {
    const h = s.create({ projectId: PID, text: "x", createdBy: "human" });
    expect(() => s.update({ taskId: h.id, actor: "human", by: "u", patch: { stage: "qa" } })).toThrow(/not a column/);
    expect(() => s.update({ taskId: h.id, actor: "human", by: "u", patch: { stage: "human_review", status: "todo" } })).toThrow(/holds cards in status/);
  });

  test("a delivery on a card an agent opened goes to AI review, which does not wait on the person", () => {
    const a = agentCard(db, s);
    const r = deliver(s, a.id);
    expect(r.status).toBe("review");
    expect(r.stage).toBe("ai_review");
    expect(columnOfTask(columns(), r)?.id).toBe("ai_review");
    expect(awaitsHuman(r)).toBe(false);
  });

  test("with a question for the person it reaches Human review", () => {
    const a = agentCard(db, s);
    const r = deliver(s, a.id, { humanAsk: "is the copy of the empty state right?" });
    expect(r.stage).toBe("human_review");
    expect(r.humanAsk).toBe("is the copy of the empty state right?");
    expect(awaitsHuman(r)).toBe(true);
  });

  test("a card a person opened goes to the person", () => {
    const h = s.create({ projectId: PID, text: "from a person", createdBy: "human", status: "todo" });
    db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ? WHERE id = ?", [WORKER, h.id]);
    expect(deliver(s, h.id).stage).toBe("human_review");
  });

  test("whoever opened the card closes it from AI review, with the proof in the thread", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    expect(() => s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { status: "done" } }))
      .toThrow(/proof/);
    const closed = s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { status: "done", summary: "bun test exit 0, screenshot in the thread" } });
    expect(closed.status).toBe("done");
    expect(closed.stage).toBeUndefined();
    const thread = s.get(a.id)!.comments.map((c) => c.content);
    expect(thread).toContain("bun test exit 0, screenshot in the thread");
  });

  test("nobody else closes it: not the worker, not another agent", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    for (const topic of [WORKER, OTHER]) {
      expect(() => s.update({ taskId: a.id, actor: "agent", by: `agent:${topic}`, agentTopicId: topic, patch: { status: "done", summary: "proof" } }))
        .toThrow();
    }
  });

  test("a card in Human review stays a person's: the opener cannot close it", () => {
    const a = agentCard(db, s);
    deliver(s, a.id, { humanAsk: "look at this" });
    expect(() => s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { status: "done", summary: "proof" } }))
      .toThrow(/agents deliver|non è più assegnato/);
  });

  test("the opener can hand it to the person, but only with the question", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    expect(() => s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { stage: "human_review" } }))
      .toThrow(/human_ask|question/);
    const t = s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { stage: "human_review", humanAsk: "which of the two layouts?" } });
    expect(t.status).toBe("review");
    expect(t.stage).toBe("human_review");
    expect(awaitsHuman(t)).toBe(true);
  });

  test("an agent never names ai_review itself", () => {
    const a = agentCard(db, s);
    deliver(s, a.id, { humanAsk: "q" });
    expect(() => s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { stage: "ai_review" } }))
      .toThrow(/ai_review/);
  });

  test("a person can still drag anything anywhere, and the stage follows", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    const back = s.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "todo" } });
    expect(back.stage).toBeUndefined();
    const toAi = s.update({ taskId: a.id, actor: "human", by: "u", patch: { stage: "human_review" } });
    expect(toAi.status).toBe("review");
    expect(toAi.stage).toBe("human_review");
    const done = s.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });
});

describe("triage is the coordinator's: a card left in Triage is reported like an unowned one", () => {
  test("a person's card in Triage past ten minutes is reported; on the default workflow it is not", () => {
    const db = freshDb();
    db.run(WORKFLOWS_DDL);
    const clock = { t: Date.parse("2026-10-30T10:00:00.000Z") };
    const s = svc(db, clock);
    const plain = s.create({ projectId: PID, text: "parked by a person", createdBy: "human" });
    writeBoardWorkflow(db, PID, "armonia", "2026-10-30T10:00:00.000Z");
    const triage = s.create({ projectId: PID, text: "to be triaged", createdBy: "human" });
    expect(triage.stage).toBe("triage");
    clock.t += UNOWNED_BACKLOG_MS + 1000;
    expect(s.sweepUnownedBacklog().map((t) => t.id)).toEqual([triage.id]);
    expect(s.sweepUnownedBacklog()).toEqual([]);
    expect(plain.stage).toBeUndefined();
  });
});

/**
 * THE INDEPENDENT REVIEW OF 31/10, one defect per block: each test fails on
 * the first delivery of this branch.
 */
describe("review of 31/10: whoever opens a card closes it, and review only with a question", () => {
  let db: Database; let s: TaskService; let clock: { t: number };
  beforeEach(() => {
    db = freshDb();
    db.run(WORKFLOWS_DDL);
    for (const id of [OPENER, WORKER, OTHER]) db.run("INSERT INTO topics (id) VALUES (?)", [id]);
    clock = { t: Date.parse("2026-10-30T10:00:00.000Z") };
    s = svc(db, clock);
    writeBoardWorkflow(db, PID, "armonia", "2026-10-30T10:00:00.000Z");
    _resetAiReviewNotices();
  });

  /** A card the board API opened (`agent:api`): no chat behind it. */
  function apiCard() {
    const t = s.create({ projectId: PID, text: "card from the board API", status: "todo", createdBy: "agent:api", priority: 1, description: "bar" });
    db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ?, dispatch_state = 'working' WHERE id = ?", [WORKER, t.id]);
    return t;
  }

  test("1. entering AI review tells whoever has to close it, from every door", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    const [n] = _takeWaitingAiReviewNotices();
    expect(n).toMatchObject({ taskId: a.id, openerTopicId: OPENER, createdBy: "agent:session", reminder: false });
    expect(s.get(a.id)!.comments.some((c) => c.kind === "service" && c.content.startsWith("AI review:"))).toBe(true);
    // A delivery with a question is the person's: nobody else is told.
    const b = agentCard(db, s);
    deliver(s, b.id, { humanAsk: "which one?" });
    expect(_takeWaitingAiReviewNotices()).toEqual([]);
  });

  test("1. a card left in AI review is reminded to the coordinator once per touch", () => {
    const a = apiCard();
    deliver(s, a.id);
    _takeWaitingAiReviewNotices();
    expect(s.sweepStaleAiReview()).toEqual([]);
    clock.t += AI_REVIEW_REMIND_MS + 1000;
    expect(s.sweepStaleAiReview().map((t) => t.id)).toEqual([a.id]);
    expect(_takeWaitingAiReviewNotices()).toMatchObject([{ taskId: a.id, reminder: true }]);
    expect(s.sweepStaleAiReview()).toEqual([]);
  });

  test("2. the coordinator closes a card from the board API in its opener's place, with the proof", () => {
    const a = apiCard();
    expect(deliver(s, a.id).stage).toBe("ai_review");
    const asCoordinator = (patch: Record<string, unknown>) =>
      s.update({ taskId: a.id, actor: "agent", by: "agent:coordinator", asCoordinator: true, patch });
    expect(() => asCoordinator({ status: "done" })).toThrow(/proof/);
    const closed = asCoordinator({ status: "done", summary: "bun test exit 0" });
    expect(closed.status).toBe("done");
    // Without the coordinator's flag (an ordinary agent with no topic) it stays refused.
    const b = apiCard();
    deliver(s, b.id);
    expect(() => s.update({ taskId: b.id, actor: "agent", by: "agent:x", patch: { status: "done", summary: "p" } })).toThrow(/agents deliver/);
  });

  test("2. the coordinator's carve-out is AI review only: a card in Human review stays the person's", () => {
    const a = apiCard();
    deliver(s, a.id, { humanAsk: "look" });
    expect(() => s.update({ taskId: a.id, actor: "agent", by: "agent:coordinator", asCoordinator: true, patch: { status: "done", summary: "p" } }))
      .toThrow(/agents deliver/);
  });

  test("3. the system delivery follows the workflow: an agent's card goes to AI review, not to the person", () => {
    const a = agentCard(db, s);
    s.addComment({ taskId: a.id, author: `agent:${WORKER}`, content: "renamed the route" });
    const d = s.deliverToReviewBySystem({ taskId: a.id, reason: "turn over" });
    expect(d.status).toBe("review");
    expect(d.stage).toBe("ai_review");
    expect(awaitsHuman(d)).toBe(false);
    expect(_takeWaitingAiReviewNotices().map((n) => n.taskId)).toEqual([a.id]);
  });

  test("3. a system delivery whose last word is a question for the person reaches Human review with it", () => {
    const a = agentCard(db, s);
    s.addComment({ taskId: a.id, author: `agent:${WORKER}`, content: "Which layout?", questionOptions: ["A", "B"] });
    const d = s.deliverToReviewBySystem({ taskId: a.id, reason: "turn over" });
    expect(d.stage).toBe("human_review");
    expect(d.humanAsk).toBe("Which layout?");
    expect(awaitsHuman(d)).toBe(true);
  });

  test("3. a person's card delivered by the system goes to the person", () => {
    const h = s.create({ projectId: PID, text: "from a person", createdBy: "human", status: "todo" });
    db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ? WHERE id = ?", [WORKER, h.id]);
    expect(s.deliverToReviewBySystem({ taskId: h.id, reason: "turn over" }).stage).toBe("human_review");
  });

  test("4. `stage: null` from an agent is a move to Human review, with its gates", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    expect(() => s.update({ taskId: a.id, actor: "agent", by: `agent:${OTHER}`, agentTopicId: OTHER, patch: { stage: null } }))
      .toThrow(/neither in triage nor yours/);
    expect(() => s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { stage: null } }))
      .toThrow(/human_ask|question/);
    expect(s.get(a.id)!.task.stage).toBe("ai_review");
    const t = s.update({ taskId: a.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { stage: null, humanAsk: "ok?" } });
    expect(t.stage).toBe("human_review");
  });

  test("5. a person's rejection ends the column: the next system delivery is routed afresh", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    const rejected = s.reviewDecision({ taskId: a.id, by: "u", decision: "reject", comment: "not yet" });
    expect(rejected.stage).toBeUndefined();
    expect(rejected.humanAsk).toBeUndefined();
    s.addComment({ taskId: a.id, author: `agent:${WORKER}`, content: "Keep the old copy?", questionOptions: ["yes", "no"] });
    const d = s.deliverToReviewBySystem({ taskId: a.id, reason: "turn over" });
    expect(d.stage).toBe("human_review");
    expect(awaitsHuman(d)).toBe(true);
  });

  test("6. back to the default preset, a card left in AI review waits on the person again", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    const moved = s.applyBoardWorkflow({ scope: PID, preset: "default" });
    expect(moved.map((t) => t.id)).toEqual([a.id]);
    const t = s.get(a.id)!.task;
    expect(t.status).toBe("review");
    expect(t.stage).toBeUndefined();
    expect(awaitsHuman(t)).toBe(true);
  });

  test("6. the global row reaches only the boards without a row of their own", () => {
    writeBoardWorkflow(db, PID, null, "2026-10-30T10:00:00.000Z");
    writeBoardWorkflow(db, "*", "armonia", "2026-10-30T10:00:00.000Z");
    const a = agentCard(db, s);
    deliver(s, a.id);
    // A project row that keeps armonia shields its cards from the global switch.
    writeBoardWorkflow(db, PID, "armonia", "2026-10-30T10:00:00.000Z");
    expect(s.applyBoardWorkflow({ scope: "*", preset: "default" })).toEqual([]);
    writeBoardWorkflow(db, PID, null, "2026-10-30T10:00:00.000Z");
    expect(s.applyBoardWorkflow({ scope: "*", preset: null }).map((t) => t.id)).toEqual([a.id]);
  });
});

describe("third review of 31/10: the agent's question is a question, however it is asked", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    ({ db, s } = setup());
    writeBoardWorkflow(db, PID, "armonia", "2026-10-30T10:00:00.000Z");
    _resetAiReviewNotices();
  });

  function apiCard() {
    const t = s.create({ projectId: PID, text: "card from the board API", status: "todo", createdBy: "agent:api", priority: 1, description: "bar" });
    db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ?, dispatch_state = 'working' WHERE id = ?", [WORKER, t.id]);
    return t;
  }
  const ask = (id: string, content = "Which layout do you prefer?") =>
    s.addComment({ taskId: id, author: `agent:${WORKER}`, content, questionOptions: ["A (recommended)", "B"] });

  test("2. a question in the thread, then the delivery without human_ask: Human review with the question", () => {
    const a = apiCard();
    ask(a.id);
    const d = deliver(s, a.id);
    expect(d.stage).toBe("human_review");
    expect(d.humanAsk).toBe("Which layout do you prefer?");
    expect(awaitsHuman(d)).toBe(true);
    expect(_takeWaitingAiReviewNotices()).toEqual([]);
  });

  test("2. a question written AFTER the delivery takes the card out of AI review", () => {
    const a = apiCard();
    expect(deliver(s, a.id).stage).toBe("ai_review");
    ask(a.id);
    const t = s.get(a.id)!.task;
    expect(t.stage).toBe("human_review");
    expect(t.humanAsk).toBe("Which layout do you prefer?");
    expect(awaitsHuman(t)).toBe(true);
  });

  test("2. options that are only board actions are not a question, and neither is an answered one", () => {
    const a = apiCard();
    s.addComment({ taskId: a.id, author: `agent:${WORKER}`, content: "Delivered", questionOptions: ["Landa su main"] });
    expect(deliver(s, a.id).stage).toBe("ai_review");
    const b = apiCard();
    ask(b.id);
    s.addComment({ taskId: b.id, author: "user", content: "A" });
    expect(deliver(s, b.id).stage).toBe("ai_review");
  });

  test("2. the opener's move to Human review accepts the question already in the thread", () => {
    const a = agentCard(db, s);
    deliver(s, a.id);
    s.addComment({ taskId: a.id, author: `agent:${OPENER}`, content: "Ship it?", questionOptions: ["Yes", "No"] });
    // The comment alone already moved it; a plain stage move on a fresh card needs the ask.
    expect(s.get(a.id)!.task.stage).toBe("human_review");
    const b = agentCard(db, s);
    deliver(s, b.id);
    expect(() => s.update({ taskId: b.id, actor: "agent", by: "x", agentTopicId: OPENER, patch: { stage: "human_review" } }))
      .toThrow(/human_ask/);
  });
});

describe("fourth review of 31/10: the reminder retries, the column follows the board, and Human review needs a question at birth", () => {
  let db: Database; let s: TaskService; let clock: { t: number };
  beforeEach(() => {
    db = freshDb();
    db.run(WORKFLOWS_DDL);
    for (const id of [OPENER, WORKER, OTHER]) db.run("INSERT INTO topics (id) VALUES (?)", [id]);
    clock = { t: Date.parse("2026-10-30T10:00:00.000Z") };
    s = svc(db, clock);
    writeBoardWorkflow(db, PID, "armonia", "2026-10-30T10:00:00.000Z");
    _resetAiReviewNotices();
  });

  function apiCard() {
    const t = s.create({ projectId: PID, text: "card from the board API", status: "todo", createdBy: "agent:api", priority: 1, description: "bar" });
    db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ?, dispatch_state = 'working' WHERE id = ?", [WORKER, t.id]);
    return t;
  }
  const sweepIds = () => s.sweepStaleAiReview().map((t) => t.id);

  test("3. a reminder that reached nobody is sent again at a later sweep; a delivered one is not", () => {
    const a = apiCard();
    deliver(s, a.id);
    _takeWaitingAiReviewNotices();
    clock.t += AI_REVIEW_REMIND_MS + 60_000;
    expect(sweepIds()).toEqual([a.id]);
    const [failed] = _takeWaitingAiReviewNotices();
    expect(failed).toMatchObject({ taskId: a.id, reminder: true });
    failed!.onUndelivered!();
    // Not at the very next reconcile (the retry floor), but at a later sweep.
    clock.t += 10_000;
    expect(sweepIds()).toEqual([]);
    clock.t += AI_REVIEW_RETRY_MS;
    expect(sweepIds()).toEqual([a.id]);
    const [delivered] = _takeWaitingAiReviewNotices();
    expect(delivered).toMatchObject({ taskId: a.id, reminder: true });
    // This one reached somebody: once per touch, no matter how long the card stays.
    clock.t += AI_REVIEW_REMIND_MS + 1;
    expect(sweepIds()).toEqual([]);
    clock.t += 24 * 60 * 60 * 1000;
    expect(sweepIds()).toEqual([]);
  });

  test("3. a reminder that keeps failing keeps coming back", () => {
    const a = apiCard();
    deliver(s, a.id);
    _takeWaitingAiReviewNotices();
    clock.t += AI_REVIEW_REMIND_MS + 60_000;
    for (let i = 0; i < 3; i++) {
      expect(sweepIds()).toEqual([a.id]);
      _takeWaitingAiReviewNotices()[0]!.onUndelivered!();
      clock.t += AI_REVIEW_RETRY_MS + 1;
    }
  });

  test("4. a card moved to a board without AI review waits on the person there", () => {
    const opened = s.create({ projectId: PID, text: "opened from a chat", status: "todo", createdBy: "agent:session", createdByTopicId: OPENER, priority: 1, description: "bar" });
    db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ?, dispatch_state = 'working' WHERE id = ?", [OPENER, opened.id]);
    s.update({ taskId: opened.id, actor: "agent", by: `agent:${OPENER}`, agentTopicId: OPENER, patch: { status: "review", summary: "done" } });
    db.run("UPDATE tasks SET assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", [opened.id]);
    expect(s.get(opened.id)!.task.stage).toBe("ai_review");
    const moved = s.moveToProject({ taskId: opened.id, toProjectId: "pB" });
    expect(moved.status).toBe("review");
    expect(moved.stage).toBeUndefined();
    expect(awaitsHuman(moved)).toBe(true);
    // A board that has the column keeps it.
    writeBoardWorkflow(db, "pC", "armonia", "2026-10-30T10:00:00.000Z");
    const b = apiCard();
    deliver(s, b.id);
    db.run("UPDATE tasks SET assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", [b.id]);
    expect(s.moveToProject({ taskId: b.id, toProjectId: "pC" }).stage).toBe("ai_review");
  });

  test("5. a card a failed land withdraws from done waits on the person, not on its opener", () => {
    const a = apiCard();
    deliver(s, a.id, { humanAsk: "look at the layout" });
    const approved = s.reviewDecision({ taskId: a.id, by: "user", decision: "approve" });
    expect(approved.status).toBe("done");
    const back = s.update({ taskId: a.id, actor: "human", by: "system", patch: { status: "review" }, statusReason: "il land non è riuscito" });
    expect(back.status).toBe("review");
    expect(back.stage).not.toBe("ai_review");
    expect(awaitsHuman(back)).toBe(true);
    // Closed from AI review by the coordinator, then withdrawn: the person's too.
    const b = apiCard();
    deliver(s, b.id);
    s.update({ taskId: b.id, actor: "agent", by: "agent:coordinator", asCoordinator: true, patch: { status: "done", summary: "bun test exit 0" } });
    _takeWaitingAiReviewNotices();
    const back2 = s.update({ taskId: b.id, actor: "human", by: "system", patch: { status: "review" } });
    expect(awaitsHuman(back2)).toBe(true);
    expect(_takeWaitingAiReviewNotices()).toEqual([]);
  });

  test("7. a machine card is born in Human review only with a question", () => {
    expect(() => s.create({ projectId: PID, text: "x", status: "review", stage: "human_review", createdBy: "agent:api" })).toThrow(/human_ask/);
    expect(() => s.create({ projectId: PID, text: "x", status: "review", stage: null, createdBy: "agent:api" })).toThrow(/human_ask/);
    const routed = s.create({ projectId: PID, text: "x", status: "review", createdBy: "agent:api" });
    expect(routed.stage).toBe("ai_review");
    expect(awaitsHuman(routed)).toBe(false);
    expect(_takeWaitingAiReviewNotices().map((n) => n.taskId)).toEqual([routed.id]);
    const asked = s.create({ projectId: PID, text: "y", status: "review", stage: "human_review", createdBy: "agent:api", humanAsk: "which one?" });
    expect(asked.stage).toBe("human_review");
    expect(asked.humanAsk).toBe("which one?");
    const asked2 = s.create({ projectId: PID, text: "z", status: "review", createdBy: "cron:nightly", humanAsk: "ok?" });
    // No stage = the default review column, which is Human review.
    expect(asked2.stage).not.toBe("ai_review");
    expect(asked2.humanAsk).toBe("ok?");
    expect(awaitsHuman(asked2)).toBe(true);
    // A person's card is unchanged: Human review, no question needed.
    const human = s.create({ projectId: PID, text: "h", status: "review", createdBy: "human" });
    expect(awaitsHuman(human)).toBe(true);
    // On the default workflow nothing changes.
    writeBoardWorkflow(db, PID, null, "2026-10-30T10:00:00.000Z");
    const plain = s.create({ projectId: PID, text: "p", status: "review", createdBy: "agent:api" });
    expect(plain.stage).toBeUndefined();
  });
});
