import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_PARKED_LABEL, commentAsksHuman, createTaskService, isLandActionLabel, isPublishActionLabel, LAND_ACTION_LABEL, PUBLISH_ACTION_LABEL, projectIdForPath, REQUEUE_PARKED_LABEL, TaskServiceError, type TaskService } from "./tasks";
import { PARKED_WAITED_OUT, WAIT_SERIES_MAX_MS, WAIT_STREAK_CAP, parseQuestionBlock } from "../../shared/board";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

describe("reserved action labels", () => {
  test("isLandActionLabel matches its label tolerantly, and NOT the publish one", () => {
    expect(isLandActionLabel(LAND_ACTION_LABEL)).toBe(true);
    expect(isLandActionLabel("🚀 Landa su main")).toBe(true);
    expect(isLandActionLabel("  landa   su  main. ")).toBe(true);
    expect(isLandActionLabel(PUBLISH_ACTION_LABEL)).toBe(false); // distinct action
    expect(isLandActionLabel("Rifiuta")).toBe(false);
    expect(isLandActionLabel(undefined)).toBe(false);
  });
  test("isPublishActionLabel matches its label tolerantly, and NOT the land one", () => {
    expect(isPublishActionLabel(PUBLISH_ACTION_LABEL)).toBe(true);
    expect(isPublishActionLabel("🚀 Landa e pubblica")).toBe(true);
    expect(isPublishActionLabel(LAND_ACTION_LABEL)).toBe(false); // land only, no push
    expect(isPublishActionLabel("")).toBe(false);
  });
  // `isBoardActionLabel` and the option-level rule now live in shared/board.ts,
  // because the client needs the same verdict for the review banner's title;
  // they are pinned in shared/board.test.ts. What stays here is the TEXT-level
  // entry point, which owns one rule of its own: the unparseable fence.
});

/**
 * A DELIVERY THAT WEARS A QUESTION'S CLOTHES IS STILL A DELIVERY.
 *
 * The kickoff envelope orders a landable delivery to attach
 * `options=["Landa su main"]`, and `addComment` wraps any options in a
 * ```question fence. So every reader that asked "does this contain a question
 * block" answered yes on finished work. Measured on 13/08 against the live
 * board db: of the 437 agent comments carrying that fence, 331 are deliveries.
 */
describe("commentAsksHuman", () => {
  /** Same shape addComment composes, so the test reads what production writes. */
  const block = (question: string, ...options: string[]) =>
    ["```question", question, ...options.map((o) => `- ${o}`), "```"].join("\n");

  test("a delivery whose only option is a board action is NOT a question", () => {
    expect(commentAsksHuman(block("Fatto: sei cancelli verdi.", LAND_ACTION_LABEL))).toBe(false);
    // Tolerant on the label, like the predicates it delegates to.
    expect(commentAsksHuman(block("Fatto.", "🚀  landa su  main."))).toBe(false);
    // The two answers to the parked-subtask stall come out the same way: the
    // board runs both. That block is written by `author: 'system'`, and both
    // readers of this predicate look at the AGENT's last word only, so the
    // verdict never reaches a card. Pinned here so a future reader who wires
    // this predicate to a system-authored surface sees what it says first.
    expect(commentAsksHuman(block("Fermo su 2 sottotask.", REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL))).toBe(false);
  });

  test("MIXED stays a question: one option the board cannot run needs a person", () => {
    expect(commentAsksHuman(block("Ho finito, ma il nome del flag non mi convince.", LAND_ACTION_LABEL, "Aspetta, ho un dubbio"))).toBe(true);
    expect(commentAsksHuman(block("Che approccio uso?", "JWT in cookie", "Bearer token"))).toBe(true);
    // A plan waiting for its verdict is the case this must never swallow.
    expect(commentAsksHuman(block("Ecco il piano.", "Approva il piano", "Da rivedere"))).toBe(true);
  });

  test("no options at all is still a question, and no block at all is not", () => {
    expect(commentAsksHuman(block("E adesso?"))).toBe(true);
    expect(commentAsksHuman("Fatto, guarda demo/. Niente da decidere.")).toBe(false);
    expect(commentAsksHuman("")).toBe(false);
    expect(commentAsksHuman(null)).toBe(false);
  });

  test("prose around the block does not change the verdict", () => {
    const testo = `Consegna: rifatto il gate.\n\n${block("Landa?", LAND_ACTION_LABEL)}`;
    expect(commentAsksHuman(testo)).toBe(false);
  });

  /**
   * AN UNREADABLE FENCE IS A QUESTION, and this is the regression that reading
   * the parsed options alone would have introduced.
   *
   * `parseQuestionBlock` returns null for a body that is all bullets and no
   * question line — a shape only a hand-written `comment_task` produces, since
   * `addComment` composes the canonical block whenever `options` is non-empty.
   * The rule this replaced was `content.includes("```question")`, so that shape
   * counted as a question and was exempt from the two review gates. Falling
   * through to "no block ⇒ delivery" would have given a legitimate mid-work
   * question a `delivered` chip and two 409s.
   */
  test("a question fence that does not parse stays a question", () => {
    const malformed = "```question\n- Sì\n- No\n```";
    expect(parseQuestionBlock(malformed)).toBeNull(); // the shape, pinned
    expect(commentAsksHuman(malformed)).toBe(true);
    // An empty fence is the same story: there IS a fence, we just cannot read it.
    expect(commentAsksHuman("Ho un dubbio.\n```question\n```")).toBe(true);
    // And a fence that is not a question fence must not be swept in.
    expect(commentAsksHuman("```ts\nconst x = 1;\n```")).toBe(false);
  });
});

// La DDL di `tasks` non si ricopia più qui: è TASKS_DDL, cioè la catena delle
// migration, verificata colonna per colonna da test-schema.test.ts. PRAGMA
// foreign_keys e la FK su assigned_topic_id sono fedeli alla produzione
// apposta: il guasto del segnaposto "pending:<taskId>" si riproduceva solo con
// le FK accese, e con le FK accese le tabelle-genitore devono esistere.
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    dispatch_fanout INTEGER,
    -- migration 053: mancava qui, e senza di lei ogni lettura del tetto VERO
    -- (riga '*', readGlobalCap) esplode invece di misurare.
    max_agents_auto INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  // migration 100 — le etichette. `rowToTask` la legge per OGNI riga, quindi
  // senza questa tabella non fallisce il test delle etichette: falliscono tutti.
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

// Controllable clock + counter uuid → deterministic rows.
function svc(db: Database, clock = { t: Date.parse("2026-07-09T10:00:00.000Z") }): TaskService {
  let n = 0;
  return createTaskService(db, {
    now: () => new Date(clock.t).toISOString(),
    uuid: () => `id-${++n}`,
  });
}

const PID = "topics-app-abc123";

describe("projectIdForPath", () => {
  test("basename + 6-char base36 hash, deterministic", () => {
    const a = projectIdForPath("/Users/utente/Projects/topics-app");
    const b = projectIdForPath("/Users/utente/Projects/topics-app");
    expect(a).toBe(b);
    expect(a.startsWith("topics-app-")).toBe(true);
    expect(a.slice("topics-app-".length)).toMatch(/^[0-9a-z]{1,6}$/);
  });
  // Exact-value lock: pins the format byte-for-byte so any drift from the
  // canonical algorithm in routes/topics.ts:getProjectIdForTopic breaks here.
  // (The raw path is hashed, so a trailing slash DOES change the id — matches
  // the original; topic.projectPath is stored normalized, so it never bites.)
  test("exact output is stable (regression lock)", () => {
    expect(projectIdForPath("/x/proj")).toBe("proj-xwac8t");
  });
});

describe("create", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("senza status nasce in BACKLOG, con kanban_order incrementale", () => {
    const t1 = s.create({ projectId: PID, text: "one" });
    const t2 = s.create({ projectId: PID, text: "two" });
    // `todo` è la coda di esecuzione: nascerci fa partire un agente. Chi crea
    // senza dire dove sta annotando, non dando un via — quindi il default deve
    // essere la colonna che non esegue.
    expect(t1.status).toBe("backlog");
    expect(t1.kanbanOrder).toBe(1);
    expect(t2.kanbanOrder).toBe(2);
  });

  test("«vai» si scrive: status todo esplicito resta todo", () => {
    const t = s.create({ projectId: PID, text: "one", status: "todo" });
    expect(t.status).toBe("todo");
  });

  test("idempotencyKey returns the same task, no duplicate", () => {
    const a = s.create({ projectId: PID, text: "x", idempotencyKey: "K1" });
    const b = s.create({ projectId: PID, text: "x again", idempotencyKey: "K1" });
    expect(b.id).toBe(a.id);
    expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as any).c).toBe(1);
  });

  test("planFirst persists through create → get (default false)", () => {
    const t = s.create({ projectId: PID, text: "big thing", planFirst: true });
    expect(t.planFirst).toBe(true);
    expect(s.get(t.id)!.task.planFirst).toBe(true);
    expect(s.create({ projectId: PID, text: "normal" }).planFirst).toBe(false);
  });

  test("planFirst is togglable via update (settable after creation)", () => {
    const t = s.create({ projectId: PID, text: "fuzzy bug" });
    expect(t.planFirst).toBe(false);
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { planFirst: true } }).planFirst).toBe(true);
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { planFirst: false } }).planFirst).toBe(false);
  });

  test("rejects empty text and create-done", () => {
    expect(() => s.create({ projectId: PID, text: "  " })).toThrow(TaskServiceError);
    expect(() => s.create({ projectId: PID, text: "y", status: "done" })).toThrow(/done/);
  });
});

describe("list", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    s.create({ projectId: "p1", text: "a" });
    s.create({ projectId: "p1", text: "b" });
    s.create({ projectId: "p2", text: "c" });
  });

  test("scope=project filters by project", () => {
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(2);
    expect(s.list({ scope: "project", projectId: "p2" }).length).toBe(1);
  });
  test("scope=all crosses projects", () => {
    const all = s.list({ scope: "all" });
    expect(all.length).toBe(3);
    expect(new Set(all.map(t => t.projectId))).toEqual(new Set(["p1", "p2"]));
  });
  test("scope=project without projectId throws", () => {
    expect(() => s.list({ scope: "project" })).toThrow(/projectId/);
  });

  test("rootsOnly hides subtasks from column feeds (they live in the parent's tree)", () => {
    const parent = s.create({ projectId: "p1", text: "epic" });
    s.create({ projectId: "p1", text: "step 1", parentTaskId: parent.id });
    s.create({ projectId: "p1", text: "step 2", parentTaskId: parent.id });
    // Default list still returns everything (agent surface, introspection).
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(5);
    // Board feed: roots only, on both scopes.
    const roots = s.list({ scope: "project", projectId: "p1", rootsOnly: true });
    expect(roots.length).toBe(3);
    expect(roots.every((t) => t.parentTaskId === null)).toBe(true);
    expect(s.list({ scope: "all", rootsOnly: true }).every((t) => t.parentTaskId === null)).toBe(true);
    // The steps are still reachable through the parent.
    expect(s.get(parent.id)!.children.length).toBe(2);
  });
});

describe("review gate (KANBAN-05)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("agent cannot move to done", () => {
    const t = s.create({ projectId: PID, text: "work" });
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("agent → review opens a pending review approval", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto: sintesi di consegna" });
    const r = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(r.status).toBe("review");
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.approval_type).toBe("review");
    expect(ap.status).toBe("pending");
    expect(ap.requested_by).toBe("claude");
  });

  test("mute delivery is rejected: agent → review requires an own comment", () => {
    const t = s.create({ projectId: PID, text: "work" });
    // No comments at all → coached rejection, task stays put.
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // A human/system note does NOT count — the card must carry the AGENT's word.
    s.addComment({ taskId: t.id, author: "user", content: "occhio ai test" });
    s.addComment({ taskId: t.id, author: "system", content: "requeued" });
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // The agent's own summary unlocks the handoff. Humans stay unaffected.
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, guarda demo/" });
    expect(s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }).status).toBe("review");
  });

  test("human re-drag to todo resets the retry budget (parked tasks stay re-dispatchable)", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    db.prepare("UPDATE tasks SET dispatch_attempts = 3 WHERE id = ?").run(t.id);
    const back = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });
    expect(back.dispatchAttempts).toBe(0);
    // An AGENT moving to todo does NOT refresh its own retries.
    db.prepare("UPDATE tasks SET dispatch_attempts = 3, status = 'backlog' WHERE id = ?").run(t.id);
    const agentMove = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "todo" } });
    expect(agentMove.dispatchAttempts).toBe(3);
  });

  /**
   * IL BUDGET NON ERA L'UNICA COSA CHE TENEVA FERMA LA CARD.
   *
   * `dispatch_deferred_until` è la finestra d'attesa che l'agente dichiara, e il
   * CAS del claim la rifiuta finché non è passata: fino a 24 ore. Il bottone
   * «rimetti in Todo» azzerava i tentativi e lasciava lì la finestra — la card
   * tornava in una colonna dove nessuno la prendeva, con il chip del parcheggio
   * ancora sopra a raccontare la storia di prima.
   */
  test("rimettere in Todo azzera anche la finestra di rinvio e il chip, non solo i tentativi", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    db.prepare(
      "UPDATE tasks SET dispatch_attempts = 3, dispatch_deferred_until = '2099-01-01T00:00:00.000Z', " +
        "dispatch_state = 'failed', dispatch_error = 'budget finito' WHERE id = ?",
    ).run(t.id);

    const back = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });

    expect(back.dispatchAttempts).toBe(0);
    expect(back.dispatchDeferredUntil).toBeNull();
    expect(back.dispatchState).toBeNull();
    expect(back.dispatchError).toBeNull();
    // La controprova sull'asse dei permessi: un AGENTE non si ridà niente.
    db.prepare(
      "UPDATE tasks SET status = 'backlog', dispatch_deferred_until = '2099-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(t.id);
    const agente = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "todo" } });
    expect(agente.dispatchDeferredUntil).toBe("2099-01-01T00:00:00.000Z");
  });

  test("human drag review → done clears the lingering dispatch chip", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "review" } });
    s.setDispatchState({ taskId: t.id, state: "delivered" });
    const done = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.dispatchState).toBeNull();
  });

  test("status events (kind='status') do NOT satisfy the mute-delivery gate", () => {
    const t = s.create({ projectId: PID, text: "work", status: "todo" });
    // The agent moving the task writes a status event AUTHORED by the agent —
    // it's history, not a delivery summary.
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    const evts = db.prepare("SELECT * FROM task_comments WHERE task_id = ? AND kind = 'status'").all(t.id) as any[];
    expect(evts.length).toBe(1);
    expect(evts[0].author).toBe("claude");
    expect(evts[0].content).toBe("todo→in_progress");
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
  });

  test("mute-delivery gate is PER-TURN: a stale summary from an earlier turn does not unlock a new delivery", () => {
    // The reported bug: a steered task ("altro da fare?" → review) handed back a
    // mute delivery because an OLD agent comment satisfied the gate. The gate must
    // require a comment made during THIS turn (after the newest …→in_progress).
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    s.addComment({ taskId: t.id, author: "claude", content: "riepilogo turno 1" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }); // ok: fresh
    // Age the turn-1 summary so it clearly predates the next turn (deterministic).
    db.prepare("UPDATE task_comments SET created_at = ? WHERE task_id = ? AND kind = 'comment'").run("2020-01-01T00:00:00.000Z", t.id);
    // Turn 2 starts: a NEW …→in_progress event, newer than the stale summary.
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "in_progress" } });
    // Mute re-delivery is rejected — the old summary no longer counts.
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // A fresh summary for THIS turn unlocks it.
    s.addComment({ taskId: t.id, author: "claude", content: "riepilogo turno 2" });
    expect(s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }).status).toBe("review");
  });

  test("una transizione può portare la sua RAGIONE, e resta una transizione", () => {
    const t = s.create({ projectId: PID, text: "work", status: "todo" });
    s.update({
      taskId: t.id, actor: "human", by: "system", patch: { status: "in_progress" },
      statusReason: "il land ha fatto conflitto con main",
    });
    const ev = s.get(t.id)!.comments.filter((c) => c.kind === "status");
    expect(ev.length).toBe(1);
    expect(ev[0]!.author).toBe("system");
    expect(ev[0]!.content).toBe("todo→in_progress · il land ha fatto conflitto con main");
  });

  test("il gate per-turno regge quando l'inizio del turno porta una ragione", () => {
    // Il buco che una ragione appesa avrebbe aperto in silenzio: l'inizio del
    // turno si leggeva col suffisso (`…in_progress`), e `done→in_progress · …`
    // non finisce più con lo stato. Il gate avrebbe ancorato il turno a quello
    // PRECEDENTE, e un riepilogo vecchio avrebbe sbloccato una consegna muta.
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    s.addComment({ taskId: t.id, author: "claude", content: "riepilogo turno 1" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "done" } });
    // Tutto il turno 1 è VECCHIO, e il suo riepilogo sta DOPO il suo inizio: è
    // la forma che distingue le due letture del confine (l'inizio del turno 1
    // resta l'evento più recente che *finisce* con `in_progress`).
    db.prepare("UPDATE task_comments SET created_at = ? WHERE task_id = ? AND kind = 'status'")
      .run("2020-01-01T00:00:00.000Z", t.id);
    db.prepare("UPDATE task_comments SET created_at = ? WHERE task_id = ? AND kind = 'comment'")
      .run("2020-01-01T00:00:01.000Z", t.id);
    // Il land va in conflitto: la card esce da `done` con la sua causa scritta.
    s.update({
      taskId: t.id, actor: "human", by: "system", patch: { status: "in_progress" },
      statusReason: "il land ha fatto conflitto con main",
    });
    // Turno nuovo → il riepilogo vecchio NON vale.
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    s.addComment({ taskId: t.id, author: "claude", content: "riepilogo turno 2: conflitti risolti" });
    expect(s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }).status).toBe("review");
  });

  test("status history: update, claim and reviewDecision log who moved it and when", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });
    const claimed = s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    expect(claimed).not.toBeNull();
    s.addComment({ taskId: t.id, author: "agent-x", content: "consegna" });
    s.update({ taskId: t.id, actor: "agent", by: "agent-x", patch: { status: "review" } });
    s.reviewDecision({ taskId: t.id, by: "user", decision: "approve" });

    const events = (s.get(t.id)!.comments).filter((c) => c.kind === "status");
    expect(events.map((e) => [e.content, e.author])).toEqual([
      ["backlog→todo", "user"],
      ["todo→in_progress", "dispatcher"],
      ["in_progress→review", "agent-x"],
      ["review→done", "user"],
    ]);
    // Normal comments keep kind='comment'.
    const normal = (s.get(t.id)!.comments).find((c) => c.content === "consegna");
    expect(normal?.kind).toBe("comment");
  });

  test("human approve → done, approval approved, completed_at set", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    const done = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("approved");
    expect(ap.reviewed_by).toBe("attilio");
  });

  // Uscire da review NON passa solo da `reviewDecision`: c'è il trascinamento
  // sulla board, c'è `update({status})` da MCP, c'è l'archiviazione. Prima del
  // fix la richiesta di approvazione restava 'pending' per sempre su tutte
  // quelle strade — misurate 13 righe appese su 48 nel DB reale, 9 su task già
  // 'done' — e nessuno l'avrebbe più chiusa, perché `reviewDecision` rifiuta un
  // task che non è più in review.
  test("review → done trascinato: l'approvazione si chiude come approved", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "done" } });
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("approved");
    expect(ap.reviewed_at).not.toBeNull();
  });

  test("review → backlog: l'approvazione scade, NON viene respinta", () => {
    // 'expired' e non 'rejected': nessun umano ha detto no, la domanda ha solo
    // perso l'oggetto. Confonderle mentirebbe sulla storia del task.
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "backlog" } });
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("expired");
  });

  test("un task che RESTA in review tiene la sua approvazione pendente", () => {
    // Il caso che non va toccato: 35 delle 48 righe misurate erano lavoro vero
    // in attesa di un umano.
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { text: "work rinominato" } });
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("pending");
  });

  /**
   * LE DUE STRADE CHE LASCIAVANO LA RICHIESTA APPESA.
   *
   * Il land chiude la card a SQL grezzo (`settleLanded`) e l'archiviazione la
   * toglie dalla board: nessuna delle due passava da `update`, quindi la riga
   * `pending` restava lì per sempre — il task non è più in review e
   * `reviewDecision` la rifiuterebbe. Misurate il 13/08: 13 appese su 48, 9 su
   * card già `done`. È la stessa perdita che la migration 068 aveva ripulito.
   */
  test("il LAND chiude l'approvazione pendente: approved, che è ciò che chiedeva", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    s.settleLanded({ taskId: t.id, by: "system", reason: "il land è riuscito" });

    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("approved");
    expect(ap.reviewed_at).not.toBeNull();
  });

  test("l'ARCHIVIAZIONE la fa scadere: expired, perché nessuno ha detto di no", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    s.archive({ taskId: t.id });

    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("expired");
  });

  test("human reject → in_progress + comment + approval rejected", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    const back = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "reject", comment: "manca il test" });
    expect(back.status).toBe("in_progress");
    const got = s.get(t.id)!;
    expect(got.comments.some(c => c.content === "manca il test")).toBe(true);
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("rejected");
  });

  test("reject resets the attempt budget (new work cycle); approve keeps it", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    db.prepare("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?").run(t.id);
    const back = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "reject" });
    expect(back.dispatchAttempts).toBe(0);

    const t2 = s.create({ projectId: PID, text: "work2" });
    s.addComment({ taskId: t2.id, author: "claude", content: "fatto" });
    s.update({ taskId: t2.id, actor: "agent", by: "claude", patch: { status: "review" } });
    db.prepare("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?").run(t2.id);
    const done = s.reviewDecision({ taskId: t2.id, by: "attilio", decision: "approve" });
    expect(done.dispatchAttempts).toBe(2);
  });

  test("projectId guard blocks cross-project get/update/comment", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    expect(s.get(t.id, { projectId: "p2" })).toBeNull();
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "c", projectId: "p2", patch: { status: "review" } }))
      .toThrow(/not found/);
    expect(() => s.addComment({ taskId: t.id, author: "c", content: "hi", projectId: "p2" }))
      .toThrow(/not found/);
    expect(s.get(t.id, { projectId: "p1" })).not.toBeNull();
  });

  test("human can move directly to done", () => {
    const t = s.create({ projectId: PID, text: "work", status: "in_progress" });
    const done = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
  });
});

describe("own steps carve-out (KANBAN-08: the agent checks off its own checklist)", () => {
  let db: Database; let s: TaskService;
  // parent = the task dispatched to topic 'top-1'; steps nest under it.
  let parentId: string;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1'), ('top-2')");
    const parent = s.create({ projectId: PID, text: "deliverable", status: "in_progress" });
    parentId = parent.id;
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(parentId);
  });

  test("agent marks its own direct step done (completed_at set)", () => {
    const step = s.create({ projectId: PID, text: "step 1", status: "backlog", parentTaskId: parentId });
    const done = s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
  });

  test("carve-out reaches any depth (step of a step)", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    const sub = s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    const done = s.update({ taskId: sub.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });

  test("STRICT: the agent still cannot close its own MAIN task", () => {
    expect(() => s.update({ taskId: parentId, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("a different agent's topic does not unlock the step", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-2", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("an unrelated top-level task stays gated even with agentTopicId set", () => {
    const other = s.create({ projectId: PID, text: "unrelated" });
    expect(() => s.update({ taskId: other.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("open_subtasks still gates a step that has its own open children", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/open subtasks/);
  });

  // L'INCIDENTE dell'11/08 (task f9d60212). Il legame che rendeva "miei" gli step
  // era `assigned_topic_id` del PADRE — cioè stato di dispatch, che vive quanto
  // il dispatch e non quanto il turno. `release()` lo azzera quando rimette in
  // coda o parcheggia, e il turno dell'agent NON muore con quella riga: da lì in
  // poi ogni `done` sulla propria checklist tornava 409, e la consegna arrivava
  // all'umano con gli step aperti (che un task con figli aperti non è nemmeno
  // approvabile). La provenienza — CHI ha scritto lo step — non cambia mai.
  test("il rimescolamento del dispatch non porta via all'agent la SUA checklist", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId, createdByTopicId: "top-1" });
    s.release({ taskId: parentId, requeue: true, reason: "rimesso in coda dal dispatcher", by: "dispatcher" });
    const done = s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });

  test("nemmeno un ri-dispatch a un ALTRO topic: gli step che ho scritto io restano miei", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId, createdByTopicId: "top-1" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-2' WHERE id = ?").run(parentId);
    const done = s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });

  test("STRICT anche sulla provenienza: un task SENZA padre creato da me resta dietro il gate", () => {
    const mine = s.create({ projectId: PID, text: "un task che ho creato io", createdByTopicId: "top-1" });
    expect(() => s.update({ taskId: mine.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("la provenienza di un ALTRO agent non apre nulla", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId, createdByTopicId: "top-1" });
    db.prepare("UPDATE tasks SET assigned_topic_id = NULL WHERE id = ?").run(parentId);
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-2", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });
});

describe("boundRootOf (dispatch root of a subtree)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("finds the bound ancestor from any depth (and self)", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const root = s.create({ projectId: PID, text: "deliverable", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(root.id);
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: root.id });
    const sub = s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    expect(s.boundRootOf(sub.id)?.id).toBe(root.id);
    expect(s.boundRootOf(step.id)?.id).toBe(root.id);
    expect(s.boundRootOf(root.id)?.id).toBe(root.id); // self counts
  });

  test("null when nothing in the chain is bound", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    expect(s.boundRootOf(b.id)).toBeNull();
  });
});

describe("taskForTopic / taskByIdPrefix (task-owned browser fork)", () => {
  let db: Database;
  // Hex uuids so `taskByIdPrefix` (guarded on hex id8) is testable end to end.
  const hexSvc = (d: Database): TaskService => {
    let n = 0;
    return createTaskService(d, {
      now: () => "2026-07-18T10:00:00.000Z",
      uuid: () => `125aafd${n++}-0e15-4aa0-ab25-f00000000000`,
    });
  };
  beforeEach(() => { db = freshDb(); });

  test("taskForTopic returns the bound task's id/project/text, null for an unbound topic", () => {
    const s = hexSvc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = s.create({ projectId: PID, text: "build the thing", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    expect(s.taskForTopic("top-1")).toEqual({ id: t.id, projectId: PID, text: "build the thing" });
    expect(s.taskForTopic("top-nope")).toBeNull();
    expect(s.taskForTopic("")).toBeNull();
  });

  test("taskForTopic prefers a non-archived, most-recent binding", () => {
    const s = hexSvc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const older = s.create({ projectId: PID, text: "older" });
    const newer = s.create({ projectId: PID, text: "newer" });
    db.prepare("UPDATE tasks SET assigned_topic_id='top-1', archived=1, updated_at='2026-07-18T09:00:00.000Z' WHERE id=?").run(older.id);
    db.prepare("UPDATE tasks SET assigned_topic_id='top-1', archived=0, updated_at='2026-07-18T11:00:00.000Z' WHERE id=?").run(newer.id);
    expect(s.taskForTopic("top-1")?.id).toBe(newer.id);
  });

  test("taskByIdPrefix resolves the `task-<id8>` hex prefix → { id, text }", () => {
    const s = hexSvc(db);
    const t = s.create({ projectId: PID, text: "hello world" });
    const id8 = t.id.slice(0, 8); // "125aafd0"
    expect(s.taskByIdPrefix(id8)).toEqual({ id: t.id, text: "hello world" });
    expect(s.taskByIdPrefix("125aafd0")).toEqual({ id: t.id, text: "hello world" });
  });

  test("taskByIdPrefix rejects non-hex / empty input and unknown prefixes", () => {
    const s = hexSvc(db);
    s.create({ projectId: PID, text: "x" });
    expect(s.taskByIdPrefix("")).toBeNull();
    expect(s.taskByIdPrefix("not-hex")).toBeNull(); // '-' and 'n/t' aren't hex
    expect(s.taskByIdPrefix("deadbeef")).toBeNull(); // valid hex, no match
  });
});

describe("moveToProject", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("moves the whole subtree; the root re-appends on the target board", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    const sub = s.create({ projectId: "pA", text: "sub", status: "backlog", parentTaskId: step.id });
    s.create({ projectId: "pB", text: "existing" }); // target board order 1
    const moved = s.moveToProject({ taskId: root.id, toProjectId: "pB" });
    expect(moved.projectId).toBe("pB");
    expect(moved.kanbanOrder).toBe(2);
    expect(s.get(step.id)!.task.projectId).toBe("pB");
    expect(s.get(sub.id)!.task.projectId).toBe("pB");
    expect(s.list({ scope: "project", projectId: "pA" }).length).toBe(0);
  });

  test("a subtask never moves alone (same-board parent invariant)", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    expect(() => s.moveToProject({ taskId: step.id, toProjectId: "pB" })).toThrow(/subtask/);
  });

  test("a task with a live agent stays put", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = s.create({ projectId: "pA", text: "x", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    expect(() => s.moveToProject({ taskId: t.id, toProjectId: "pB" })).toThrow(/live agent/);
  });

  test("a settled failed park does not travel to the target board", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    db.prepare("UPDATE tasks SET dispatch_state = 'failed', dispatch_error = 'boom on pA' WHERE id IN (?, ?)")
      .run(root.id, step.id);
    const moved = s.moveToProject({ taskId: root.id, toProjectId: "pB" });
    expect(moved.dispatchState).toBeNull();
    expect(moved.dispatchError).toBeNull();
    expect(s.get(step.id)!.task.dispatchState).toBeNull();
    expect(s.get(step.id)!.task.dispatchError).toBeNull();
  });

  test("same-board move is a no-op; projectId guard reports not_found", () => {
    const t = s.create({ projectId: "pA", text: "x" });
    expect(s.moveToProject({ taskId: t.id, toProjectId: "pA" }).projectId).toBe("pA");
    expect(() => s.moveToProject({ taskId: t.id, toProjectId: "pB", projectId: "pWRONG" })).toThrow(/not found/);
  });
});

describe("outputUrl (KANBAN-09 review panel)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("http(s) URL persists and comes back from get()", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const up = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { outputUrl: "http://localhost:5173/preview" } });
    expect(up.outputUrl).toBe("http://localhost:5173/preview");
    expect(s.get(t.id)!.task.outputUrl).toBe("http://localhost:5173/preview");
  });

  test("non-http(s) schemes are rejected (iframe target: no LFI/XSS)", () => {
    const t = s.create({ projectId: PID, text: "x" });
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x", "totally not a url"]) {
      expect(() => s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: bad } }))
        .toThrow(/http\(s\)/);
    }
  });

  test("empty string (or null) clears it", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: "https://example.com" } });
    const cleared = s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: "" } });
    expect(cleared.outputUrl).toBeNull();
  });
});

describe("archive", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("archived task drops off the list but the row is kept", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    s.archive({ taskId: t.id, projectId: "p1" });
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(0);
    expect(s.get(t.id)).not.toBeNull();
  });
  test("archive is projectId-guarded", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    expect(() => s.archive({ taskId: t.id, projectId: "p2" })).toThrow(/not found/);
  });
});

describe("comments", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("adds a comment with mentions round-trip", () => {
    const s = svc(db);
    const t = s.create({ projectId: PID, text: "work" });
    const c = s.addComment({ taskId: t.id, author: "claude", content: "fatto", mentions: ["attilio"] });
    expect(c.author).toBe("claude");
    expect(c.mentions).toEqual(["attilio"]);
    expect(s.get(t.id)!.comments.length).toBe(1);
  });

  test("dedupes identical author+content within the window", () => {
    const clock = { t: Date.parse("2026-07-09T10:00:00.000Z") };
    const s = svc(db, clock);
    const t = s.create({ projectId: PID, text: "work" });
    const a = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    const b = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    expect(b.id).toBe(a.id);
    expect(s.get(t.id)!.comments.length).toBe(1);
  });

  test("media round-trips (absolute paths only, capped at 8); attachment-only comments are legal", () => {
    const s = svc(db);
    const t = s.create({ projectId: PID, text: "x" });
    const c = s.addComment({
      taskId: t.id, author: "user", content: "guarda qui",
      media: ["/tmp/shot.png", "relative/nope.png", ...Array.from({ length: 10 }, (_, i) => `/tmp/f${i}.txt`)],
    });
    expect(c.media[0]).toBe("/tmp/shot.png");
    expect(c.media).not.toContain("relative/nope.png"); // non-absolute dropped
    expect(c.media.length).toBe(8); // capped
    expect(s.get(t.id)!.comments[0].media.length).toBe(8);
    // Attachment-only: no text → placeholder body, media kept.
    const only = s.addComment({ taskId: t.id, author: "user", content: "", media: ["/tmp/doc.pdf"] });
    expect(only.content).toBe("(allegato)");
    expect(only.media).toEqual(["/tmp/doc.pdf"]);
  });

  test("same content after the window is a new comment", () => {
    const clock = { t: Date.parse("2026-07-09T10:00:00.000Z") };
    const s = svc(db, clock);
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "same" });
    clock.t += 60_000; // past the 10s dedupe window
    const b = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    expect(s.get(t.id)!.comments.length).toBe(2);
    expect(b).toBeTruthy();
  });
});

describe("nested tasks (subtask cascade)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("creates a subtask under a parent; get() lists children; list() fills counters", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part 1", parentTaskId: parent.id });
    expect(kid.parentTaskId).toBe(parent.id);
    const got = s.get(parent.id)!;
    expect(got.children.map((c) => c.id)).toEqual([kid.id]);
    expect(got.task.subtaskCount).toBe(1);
    expect(got.task.subtaskDoneCount).toBe(0);
    const listed = s.list({ scope: "project", projectId: PID }).find((t) => t.id === parent.id)!;
    expect(listed.subtaskCount).toBe(1);
  });

  test("unlimited depth: a subtask can have its own subtasks", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", parentTaskId: b.id });
    expect(s.get(b.id)!.children.map((x) => x.id)).toEqual([c.id]);
    expect(s.get(a.id)!.children.map((x) => x.id)).toEqual([b.id]);
  });

  test("parent must exist, be alive, and live on the SAME board", () => {
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: "ghost" })).toThrow(/not found/);
    const foreign = s.create({ projectId: "other-board", text: "y" });
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: foreign.id })).toThrow(/not found/);
    const dead = s.create({ projectId: PID, text: "z" });
    s.archive({ taskId: dead.id });
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: dead.id })).toThrow(/not found/);
  });

  test("a parent with open subtasks cannot go done — any actor, update or approve", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part", parentTaskId: parent.id });
    expect(() => s.update({ taskId: parent.id, actor: "human", by: "user", patch: { status: "done" } }))
      .toThrow(/open subtasks/);
    s.addComment({ taskId: parent.id, author: "claude", content: "fatto" });
    s.update({ taskId: parent.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(() => s.reviewDecision({ taskId: parent.id, by: "user", decision: "approve" }))
      .toThrow(/open subtasks/);
    // Close the child → the parent can now complete.
    s.update({ taskId: kid.id, actor: "human", by: "user", patch: { status: "done" } });
    const done = s.reviewDecision({ taskId: parent.id, by: "user", decision: "approve" });
    expect(done.status).toBe("done");
  });

  test("archiving a parent archives the whole subtree (cascade, deep)", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", parentTaskId: b.id });
    s.archive({ taskId: a.id });
    const archived = (id: string) => (db.prepare("SELECT archived FROM tasks WHERE id = ?").get(id) as any).archived;
    expect(archived(a.id)).toBe(1);
    expect(archived(b.id)).toBe(1);
    expect(archived(c.id)).toBe(1);
  });

  test("archived subtasks don't count and unblock the parent", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part", parentTaskId: parent.id });
    s.archive({ taskId: kid.id });
    expect(s.get(parent.id)!.task.subtaskCount).toBe(0);
    const done = s.update({ taskId: parent.id, actor: "human", by: "user", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });
});

describe("addComment — question block (server-composed)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("questionOptions compose the CANONICAL block: fences + newlines + '- ' options", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({
      taskId: t.id, author: "agent-1",
      content: "Quale approccio uso?",
      questionOptions: ["JWT in cookie", "Bearer token"],
    });
    expect(c.content).toBe("```question\nQuale approccio uso?\n- JWT in cookie\n- Bearer token\n```");
  });

  test("newlines inside the question are flattened (the block stays parseable)", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({
      taskId: t.id, author: "agent-1",
      content: "Domanda\nsu due righe?",
      questionOptions: ["sì"],
    });
    expect(c.content).toBe("```question\nDomanda su due righe?\n- sì\n```");
  });

  test("rejects fences inside a question (no nested blocks) and all-empty options", () => {
    const t = s.create({ projectId: PID, text: "w" });
    expect(() => s.addComment({ taskId: t.id, author: "a", content: "```question hack```", questionOptions: ["x"] }))
      .toThrow(TaskServiceError);
    expect(() => s.addComment({ taskId: t.id, author: "a", content: "ok?", questionOptions: ["  ", ""] }))
      .toThrow(TaskServiceError);
  });

  test("without questionOptions the content is stored verbatim", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({ taskId: t.id, author: "a", content: "nota semplice" });
    expect(c.content).toBe("nota semplice");
  });
});

describe("claim (atomic dispatch)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  const todo = () => { const t = s.create({ projectId: PID, text: "w", status: "todo" }); return t; };

  test("claims a todo task: → in_progress + 'starting', attempts=1, NO topic binding yet", () => {
    const t = todo();
    const claimed = s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("in_progress");
    // The binding arrives via bindTopic() once the REAL topic exists —
    // assigned_topic_id has a FK to topics(id), placeholders would violate it.
    expect(claimed!.assignedTopicId).toBeNull();
    expect(claimed!.dispatchState).toBe("starting");
    expect(claimed!.dispatchAttempts).toBe(1);
  });

  test("bindTopic attaches the real topic to a claimed task (FK enforced)", () => {
    const t = todo();
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const bound = s.bindTopic({ taskId: t.id, topicId: "top-1" });
    expect(bound.assignedTopicId).toBe("top-1");
    // A topic id that does not exist must be rejected by the schema.
    expect(() => s.bindTopic({ taskId: t.id, topicId: "pending:" + t.id })).toThrow();
  });

  test("idempotent: a second claim on the same task returns null (no double dispatch)", () => {
    const t = todo();
    expect(s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 })).not.toBeNull();
    expect(s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 })).toBeNull();
    expect(s.get(t.id)!.task.dispatchAttempts).toBe(1); // not double-counted
  });

  test("concurrency cap: no free slot → null, task stays todo", () => {
    const a = todo(); const b = todo();
    expect(s.claim({ taskId: a.id, cap: 1, maxAttempts: 3 })).not.toBeNull();
    const bClaim = s.claim({ taskId: b.id, cap: 1, maxAttempts: 3 });
    expect(bClaim).toBeNull();
    expect(s.get(b.id)!.task.status).toBe("todo");
    expect(s.get(b.id)!.task.dispatchAttempts).toBe(0); // not consumed when capped out
  });

  test("retry cap: attempts >= maxAttempts → null", () => {
    const t = todo();
    // burn attempts via claim+release(requeue) cycles
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.release({ taskId: t.id, requeue: true });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.release({ taskId: t.id, requeue: true });
    // attempts now 2 == cap → refuse
    expect(s.get(t.id)!.task.dispatchAttempts).toBe(2);
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 })).toBeNull();
  });

  test("only claims 'todo' — a backlog task is not eligible", () => {
    const t = s.create({ projectId: PID, text: "w", status: "backlog" });
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 3 })).toBeNull();
  });
});

describe("release", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("requeue=true → todo, binding cleared, attempts preserved, note posted", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    s.bindTopic({ taskId: t.id, topicId: "top-1" });
    const r = s.release({ taskId: t.id, requeue: true, reason: "worked in topic top-1", by: "system" });
    expect(r.status).toBe("todo");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBe("queued");
    expect(r.dispatchAttempts).toBe(1); // preserved so the retry cap still bites
    expect(s.get(t.id)!.comments.some((c) => c.content.includes("top-1"))).toBe(true);
  });

  test("requeue=false → parked in backlog with binding cleared", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    const r = s.release({ taskId: t.id, requeue: false, reason: "gave up" });
    expect(r.status).toBe("backlog");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBeNull();
  });

  // IL GUASTO DEL 12/08, alla sua strozzatura. Quattro card che aspettavano una
  // decisione umana sono finite in backlog marcate `failed` perché il land aveva
  // potato il loro ramo e il GC aveva parcheggiato la card. In backlog nessuno le
  // dispaccia e nessuno le guarda: la decisione non era rimandata, era persa.
  test("card in review → il park scioglie il legame ma NON la fa scendere in backlog", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-2')");
    s.bindTopic({ taskId: t.id, topicId: "top-2" });
    // Consegnata: lo stato si scrive a mano perché il cancello della review
    // (serve un commento di sintesi) qui non c'entra ed è collaudato altrove.
    db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(t.id);
    const attemptsPrima = s.get(t.id)!.task.dispatchAttempts;

    const r = s.release({
      taskId: t.id, requeue: false, parkState: "failed", by: "system",
      reason: "Worktree liberato: il branch del worktree non esiste più.",
    });

    expect(r.status).toBe("review");
    expect(r.assignedTopicId).toBeNull();   // il legame col worktree morto se ne va comunque
    expect(r.dispatchState).toBeNull();     // e nessun timbro `failed` addosso a chi non ha fallito
    expect(r.dispatchError).toBeNull();
    expect(r.dispatchAttempts).toBe(attemptsPrima); // il contatore non si muove
    // La ragione resta leggibile dove serve: nel thread, non come stato della card.
    expect(s.get(t.id)!.comments.some((c) => c.content.includes("non esiste più"))).toBe(true);
  });

  test("keepStatus → il park non sposta di colonna nemmeno un task attivo", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    const r = s.release({ taskId: t.id, requeue: false, keepStatus: true, parkState: "failed", reason: "consegna già su main" });
    expect(r.status).toBe("in_progress");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBeNull();
  });
});

describe("board settings", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("defaults when no row exists (auto off, worktree on)", () => {
    const bs = s.getBoardSettings(PID);
    expect(bs.autoDispatch).toBe(false);
    expect(bs.dispatchEffort).toBe("medium");
    expect(bs.dispatchUseWorktree).toBe(true);
  });

  // Il tetto NON è per board: la board non ne espone uno, e il default di
  // un'installazione nuova è quello della riga '*' — auto, che è come la
  // macchina si protegge da sé finché nessuno sceglie un numero.
  test("il tetto di default è quello GLOBALE, non un campo della board", () => {
    expect(s.getGlobalCap()).toEqual({ auto: true, max: 3 });
  });

  test("upsert persists + clamps + reads back", () => {
    const bs = s.updateBoardSettings(PID, { autoDispatch: true, dispatchTimeoutMin: 999 });
    expect(bs.autoDispatch).toBe(true);
    expect(bs.dispatchTimeoutMin).toBe(120); // clamped 1..120
    expect(s.getBoardSettings(PID).autoDispatch).toBe(true);
  });

  // Il clamp del tetto viveva su un campo per board che non limitava niente:
  // qui misura la leva che comanda davvero (riga '*'), e il suo intervallo è
  // 1..20, non l'1..10 di quel campo morto.
  test("il tetto si clampa dove vive DAVVERO: riga '*', 1..20", () => {
    expect(s.setGlobalCap({ auto: false, max: 99 })).toEqual({ auto: false, max: 20 });
    expect(s.getGlobalCap()).toEqual({ auto: false, max: 20 });
  });

  test("rejects an invalid effort", () => {
    expect(() => s.updateBoardSettings(PID, { dispatchEffort: "turbo" })).toThrow(TaskServiceError);
  });

  test("il task espone lo sforzo con cui ha girato DAVVERO, letto dal topic", () => {
    // Con la board su `auto` lo sceglie il classificatore, e senza questo campo
    // la scelta non si vede da nessuna parte: ne' sulla card ne' nell'API, solo
    // nel log del server. E' la leva di costo piu' pesante che abbiamo.
    const t = s.create({ projectId: PID, text: "x" });
    db.run("INSERT INTO topics (id, effort) VALUES ('topic-1', 'xhigh')");
    db.run("UPDATE tasks SET assigned_topic_id = 'topic-1' WHERE id = ?", [t.id]);
    expect(s.get(t.id)!.task.effort).toBe("xhigh");
  });

  test("nessun topic assegnato → effort null, non un valore inventato", () => {
    const t = s.create({ projectId: PID, text: "y" });
    expect(s.get(t.id)!.task.effort).toBeNull();
  });

  test("accetta `auto` come effort di board (lo sceglie il classificatore)", () => {
    // Senza questo, accendere l'effort dinamico e' impossibile dall'API: `auto`
    // non e' un tier della scala e verrebbe rifiutato come "turbo".
    const bs = s.updateBoardSettings(PID, { dispatchEffort: "auto" });
    expect(bs.dispatchEffort).toBe("auto");
    expect(s.getBoardSettings(PID).dispatchEffort).toBe("auto");
  });

  // Accendere l'interruttore MATERIALIZZA la riga '*', che è dove sta il tetto
  // vero: se nascesse sul default 5 della colonna legacy, un semplice ON
  // alzerebbe il tetto della macchina senza che nessuno lo abbia chiesto.
  test("enabling auto-dispatch alone keeps the GLOBAL cap at 2 (not the legacy column default 5)", () => {
    s.updateBoardSettings(PID, { autoDispatch: true });
    expect(s.getGlobalCap()).toEqual({ auto: true, max: 2 });
  });

  // The OTHER way the reserved row gets created: `INSERT OR IGNORE ... VALUES
  // (?, 2)`, which runs for any patch at all, not just the auto-dispatch one.
  // It carries the same explicit 2 and had lost its only guard — the test that
  // pinned it was rewritten onto the upsert above, so mutating this literal to 5
  // went unnoticed by the whole suite. Two seeds, two guards.
  test("ANY patch on the reserved row seeds the cap at 2, never the column default", () => {
    s.updateBoardSettings("*", { dispatchEffort: "high" });
    expect(s.getGlobalCap()).toEqual({ auto: true, max: 2 });
  });

  test("auto-dispatch is GLOBAL: flipping it from one board flips every board", () => {
    expect(s.getGlobalAutoDispatch()).toBe(false);
    s.updateBoardSettings(PID, { autoDispatch: true });
    expect(s.getGlobalAutoDispatch()).toBe(true);
    // A completely different board reads the same switch…
    expect(s.getBoardSettings("other-board-zzz999").autoDispatch).toBe(true);
    // …and the dedicated setter flips it back for everyone.
    expect(s.setGlobalAutoDispatch(false)).toBe(false);
    expect(s.getBoardSettings(PID).autoDispatch).toBe(false);
  });

  test("global switch does not leak per-board config across boards", () => {
    s.updateBoardSettings(PID, { autoDispatch: true, dispatchTimeoutMin: 45, dispatchEffort: "max" });
    const other = s.getBoardSettings("other-board-zzz999");
    expect(other.autoDispatch).toBe(true); // global
    expect(other.dispatchTimeoutMin).toBe(20); // per-board default, untouched
    expect(other.dispatchEffort).toBe("medium");
  });

  // Il gate pre-review è OPT-IN: nessuna board esistente cambia comportamento
  // finché qualcuno non dichiara cosa vuol far girare.
  test("checks pre-review: nessun comando di default", () => {
    expect(s.getBoardSettings(PID).reviewChecks).toEqual([]);
  });

  test("checks pre-review: round-trip e normalizzazione a forma lunga", () => {
    const bs = s.updateBoardSettings(PID, { reviewChecks: [{ name: "", cmd: "bun run typecheck" }] });
    expect(bs.reviewChecks).toEqual([{ name: "bun run typecheck", cmd: "bun run typecheck" }]);
    expect(s.getBoardSettings(PID).reviewChecks).toHaveLength(1);
  });

  test("checks pre-review: lista vuota SPEGNE il gate", () => {
    s.updateBoardSettings(PID, { reviewChecks: [{ name: "t", cmd: "true" }] });
    expect(s.updateBoardSettings(PID, { reviewChecks: [] }).reviewChecks).toEqual([]);
    // NULL in colonna, non "[]": "spento" è uno stato solo.
    const raw = db.prepare("SELECT review_checks FROM board_settings WHERE project_id = ?").get(PID) as any;
    expect(raw.review_checks).toBeNull();
  });

  test("checks pre-review: i comandi NON si propagano alle altre board", () => {
    s.updateBoardSettings(PID, { reviewChecks: [{ name: "t", cmd: "true" }] });
    expect(s.getBoardSettings("other-board-zzz999").reviewChecks).toEqual([]);
  });

  test("reviewDecision clears the dispatch chip on approve", () => {
    const t = s.create({ projectId: PID, text: "x" });
    // Drive it to review with a dispatch chip set, then approve.
    s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "review" } });
    s.setDispatchState({ taskId: t.id, state: "needs_input" });
    const done = s.reviewDecision({ taskId: t.id, by: "u", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.dispatchState).toBeNull();
  });
});

/**
 * 1.3 — in colonna Review una consegna dell'agente e un task che il sistema ha
 * portato lì a fine turno avevano lo stesso aspetto. Sono due domande diverse:
 * nella prima c'è un deliverable, nella seconda può non esserci niente.
 */
describe("deliveredBy (chi ha portato il task in review)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  /** Agente pronto alla consegna: il gate del sommario vuole un commento suo. */
  function readyForDelivery() {
    const t = s.create({ projectId: PID, text: "x" });
    s.addComment({ taskId: t.id, author: "agent-1", content: "fatto, guarda demo/" });
    return t;
  }

  test("un task nasce senza consegna", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(t.deliveredBy).toBeNull();
    expect(t.deliveredReason).toBeNull();
  });

  test("l'agente che consegna si firma", () => {
    const t = readyForDelivery();
    const rev = s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review" } });
    expect(rev.deliveredBy).toBe("agent");
    expect(rev.deliveredReason).toBeNull();
  });

  test("l'umano che trascina in review non è l'agente", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "review" } }).deliveredBy).toBe("human");
  });

  test("il sistema si firma 'system' e dice PERCHÉ", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const d = s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    expect(d.status).toBe("review");
    expect(d.deliveredBy).toBe("system");
    expect(d.deliveredReason).toBe("retries_exhausted");
    // Le due cause restano distinte: si decide diversamente nei due casi.
    const t2 = s.create({ projectId: PID, text: "y" });
    expect(s.deliverToReviewBySystem({ taskId: t2.id, reason: "rifiuto", cause: "model_refused" }).deliveredReason).toBe("model_refused");
  });

  test("un padre con sottotask aperti torna in CODA, non in review", () => {
    // In review sarebbe una card su cui l'umano non puo' decidere niente (il
    // gate su `done` rifiuta un padre con figli attivi) e ci tornerebbe a ogni
    // turno esaurito. Misurato il 10/08: quattro rimbalzi in un'ora.
    const p = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "passo aperto", parentTaskId: p.id });
    // «Aperto» vuol dire che qualcuno lo sta lavorando o sta per farlo: in coda.
    // Un figlio lasciato in backlog è parcheggiato e non blocca (test qui sotto).
    s.update({ taskId: kid.id, actor: "human", by: "u", patch: { status: "todo" } });
    const d = s.deliverToReviewBySystem({ taskId: p.id, reason: "budget finito", cause: "retries_exhausted" });
    expect(d.status).toBe("todo");
    // La ragione resta scritta nel thread: sparire in silenzio sarebbe peggio.
    const thread = s.get(p.id)!.comments.filter((c) => c.author === "system");
    expect(thread.some((c) => c.content.includes("budget finito"))).toBe(true);
  });

  test("un padre coi figli TUTTI chiusi consegna in review come chiunque altro", () => {
    // Il controllo del test qui sopra: il rinvio in coda non deve diventare
    // "un padre non consegna mai".
    const p = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "passo", parentTaskId: p.id });
    s.update({ taskId: kid.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.deliverToReviewBySystem({ taskId: p.id, reason: "fine", cause: "retries_exhausted" }).status).toBe("review");
  });

  test("figli SOLO parcheggiati: non è un'attesa, è una DOMANDA — e la fa", () => {
    // Nessuno dispaccia dal backlog: rimandare il padre in coda lo farebbe
    // girare ogni 10 minuti per sempre (misurati 20 padri così l'11/08). Ma
    // parcheggiare anche lui lo nascondeva nella colonna del riposo (cinque card
    // ferme il 12/08, nessuna lo diceva): la card va dove si vedono le domande,
    // con le due risposte possibili. Il resto in `tasks.parked-stall.test.ts`.
    const p = s.create({ projectId: PID, text: "epic" });
    s.create({ projectId: PID, text: "seguito rimandato", parentTaskId: p.id });
    const d = s.deliverToReviewBySystem({ taskId: p.id, reason: "fine" });
    expect(d.status).toBe("review");
    expect(d.dispatchState).toBe("needs_input");
    expect(d.deliveredReason).toBe("parked_children");
    const notes = s.get(p.id)!.comments.map((c) => c.content).join("\n");
    expect(notes).toContain("seguito rimandato");
  });

  test("senza causa nota resta 'system' e basta — mai una causa inventata", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const d = s.deliverToReviewBySystem({ taskId: t.id, reason: "boh" });
    expect(d.deliveredBy).toBe("system");
    expect(d.deliveredReason).toBeNull();
  });

  test("consegna vera DOPO una di sistema: la causa se ne va con la firma", () => {
    const t = readyForDelivery();
    s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    // Rifiutato → l'agent riparte → questa volta consegna lui.
    s.reviewDecision({ taskId: t.id, by: "u", decision: "reject" });
    s.addComment({ taskId: t.id, author: "agent-1", content: "ora sì" });
    const again = s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review" } });
    expect(again.deliveredBy).toBe("agent");
    // Una causa di sistema rimasta appiccicata direbbe "non l'ha consegnato
    // l'agent" su una consegna dell'agent.
    expect(again.deliveredReason).toBeNull();
  });

  test("la firma sopravvive all'approvazione: su done resta scritto com'è arrivato", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    const done = s.reviewDecision({ taskId: t.id, by: "u", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.deliveredBy).toBe("system");
  });

  test("un aggiornamento che NON entra in review non riscrive la firma", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.deliverToReviewBySystem({ taskId: t.id, reason: "budget finito", cause: "retries_exhausted" });
    const same = s.update({ taskId: t.id, actor: "human", by: "u", patch: { priority: 1 } });
    expect(same.deliveredBy).toBe("system");
    // …e nemmeno un re-ingresso in review da già-in-review (non è una transizione).
    const still = s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "review" } });
    expect(still.deliveredBy).toBe("system");
  });
});

describe("recordChecks (evidenza dei checks pre-review)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  const read = (id: string) => s.get(id, { projectId: PID })!.task;

  test("un task nasce SENZA esito: null non è un verde", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(t.checksState).toBeNull();
    expect(t.checksAt).toBeNull();
    expect(t.checksCommit).toBeNull();
    expect(t.checks).toBeNull();
  });

  test("pass: stato, commit ed evidenza comando-per-comando rileggibili", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const runs = [{ name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 1200, timedOut: false, tail: "" }];
    s.recordChecks({ taskId: t.id, state: "pass", commit: "abc1234", runs });
    const got = read(t.id);
    expect(got.checksState).toBe("pass");
    expect(got.checksCommit).toBe("abc1234");
    expect(got.checksAt).toBeTruthy();
    expect(got.checks).toEqual(runs);
  });

  test("running: nessun 'quando è finito', perché non è finito", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({ taskId: t.id, state: "running", commit: "abc1234", runs: null });
    const got = read(t.id);
    expect(got.checksState).toBe("running");
    expect(got.checksAt).toBeNull();
    expect(got.checks).toBeNull();
  });

  test("fail: la coda dell'output sopravvive al giro in DB (è l'unica prova che resta)", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({
      taskId: t.id, state: "fail", commit: "deadbee",
      runs: [
        { name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 900, timedOut: false, tail: "" },
        { name: "test", cmd: "bun test", ok: false, code: 1, ms: 4200, timedOut: false, tail: "1 fail\nexpected true" },
      ],
    });
    const got = read(t.id);
    expect(got.checksState).toBe("fail");
    expect(got.checks).toHaveLength(2);
    expect(got.checks![1].ok).toBe(false);
    expect(got.checks![1].tail).toContain("expected true");
  });

  test("un giro nuovo SOSTITUISCE il precedente: niente verde scaduto appiccicato", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({ taskId: t.id, state: "fail", commit: "old", runs: [{ name: "t", cmd: "false", ok: false, code: 1, ms: 5, timedOut: false, tail: "boom" }] });
    s.recordChecks({ taskId: t.id, state: "pass", commit: "new", runs: [{ name: "t", cmd: "true", ok: true, code: 0, ms: 5, timedOut: false, tail: "" }] });
    const got = read(t.id);
    expect(got.checksState).toBe("pass");
    expect(got.checksCommit).toBe("new");
    expect(got.checks).toHaveLength(1);
    expect(got.checks![0].ok).toBe(true);
  });

  test("reset a null: 'mai girati' è uno stato raggiungibile", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.recordChecks({ taskId: t.id, state: "fail", commit: "abc", runs: [{ name: "t", cmd: "false", ok: false, code: 1, ms: 5, timedOut: false, tail: "boom" }] });
    s.recordChecks({ taskId: t.id, state: null, commit: null, runs: null });
    const got = read(t.id);
    expect(got.checksState).toBeNull();
    expect(got.checksCommit).toBeNull();
    expect(got.checks).toBeNull();
  });

  test("un JSON storto in colonna vale 'nessuna evidenza', non un'eccezione a ogni lettura", () => {
    const t = s.create({ projectId: PID, text: "x" });
    db.prepare("UPDATE tasks SET checks_state = 'fail', checks_json = ? WHERE id = ?").run("{non json", t.id);
    const got = read(t.id);
    expect(got.checksState).toBe("fail");
    expect(got.checks).toBeNull();
  });

  test("task inesistente → not_found, non una UPDATE a vuoto", () => {
    expect(() => s.recordChecks({ taskId: "nope", state: "pass", commit: null, runs: null })).toThrow(TaskServiceError);
  });

  /**
   * «running» è una promessa che qualcuno scriverà l'esito, e chi la mantiene è
   * una corsa che vive nel processo. Un riavvio la porta via: senza questa
   * pulizia la card fila per sempre, che è il guasto misurato il 13/08.
   */
  test("al boot le spie 'running' si spengono, e SOLO quelle", () => {
    const gira = s.create({ projectId: PID, text: "sta girando" });
    const verde = s.create({ projectId: PID, text: "verde" });
    const rosso = s.create({ projectId: PID, text: "rosso" });
    s.recordChecks({ taskId: gira.id, state: "running", commit: "abc", runs: null });
    s.recordChecks({ taskId: verde.id, state: "pass", commit: "abc", runs: [{ name: "t", cmd: "true", ok: true, code: 0, ms: 5, timedOut: false, tail: "" }] });
    s.recordChecks({ taskId: rosso.id, state: "fail", commit: "abc", runs: [{ name: "t", cmd: "false", ok: false, code: 1, ms: 5, timedOut: false, tail: "boom" }] });

    expect(s.clearStaleChecksRuns()).toBe(1);
    expect(read(gira.id).checksState).toBeNull();
    expect(read(verde.id).checksState).toBe("pass");
    expect(read(rosso.id).checksState).toBe("fail");
    // L'ultima misura vera resta: si spegne la spia, non l'evidenza.
    expect(read(rosso.id).checks).toHaveLength(1);
    expect(s.clearStaleChecksRuns()).toBe(0);
  });
});

describe("blocked-by dependency", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("claim refuses a todo whose blocker is still open; unblocks at done", () => {
    const a = s.create({ projectId: PID, text: "blocker", status: "todo" });
    const b = s.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id, status: "todo" });
    expect(b.blockedByTaskId).toBe(a.id);
    expect(s.isDispatchBlocked(b.id)).toBe(true);
    expect(s.claim({ taskId: b.id, cap: 5, maxAttempts: 3 })).toBeNull();
    // Blocker completes → same claim now succeeds.
    s.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.isDispatchBlocked(b.id)).toBe(false);
    expect(s.claim({ taskId: b.id, cap: 5, maxAttempts: 3 })).not.toBeNull();
  });

  test("an archived blocker does not block", () => {
    const a = s.create({ projectId: PID, text: "blocker" });
    const b = s.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id });
    s.archive({ taskId: a.id });
    expect(s.isDispatchBlocked(b.id)).toBe(false);
  });

  test("il bloccante arriva RISOLTO nel payload, anche quando NON è nella lista della board", () => {
    // Un sottotask come bloccante: la board fetcha `rootsOnly`, quindi il client
    // non ce l'ha mai in mano — ed è esattamente il caso in cui il chip spariva.
    const parent = s.create({ projectId: PID, text: "epica" });
    const step = s.create({ projectId: PID, text: "lo step che blocca", parentTaskId: parent.id });
    const dep = s.create({ projectId: PID, text: "dipendente", blockedByTaskId: step.id, status: "todo" });
    expect(dep.blockedBy).toEqual({ id: step.id, text: "lo step che blocca", status: "backlog", archived: false });

    const roots = s.list({ scope: "project", projectId: PID, rootsOnly: true });
    expect(roots.map((t) => t.id)).not.toContain(step.id); // fuori dalla lista…
    expect(roots.find((t) => t.id === dep.id)?.blockedBy?.text).toBe("lo step che blocca"); // …ma risolto lo stesso

    // Anche in lettura singola e — cosa che conta per il WS — in SCRITTURA:
    // ogni `task:updated` porta il bloccante risolto, non solo i fetch pieni.
    expect(s.get(dep.id)?.task.blockedBy?.text).toBe("lo step che blocca");
    const touched = s.update({ taskId: dep.id, actor: "human", by: "u", patch: { priority: 3 } });
    expect(touched.blockedBy?.text).toBe("lo step che blocca");
  });

  test("il contatore «N in attesa» lo risolve il server: conta anche i dipendenti fuori dalla lista", () => {
    // L'altra metà del legame. Il client contava i dipendenti fra i task
    // fetchati — un progetto, `rootsOnly`, non archiviati: un dipendente che è
    // un sottotask, o che sta in un altro progetto, non veniva contato e la
    // card del bloccante si presentava libera.
    const bloccante = s.create({ projectId: PID, text: "bloccante", status: "todo" });
    const epica = s.create({ projectId: PID, text: "epica" });
    const sottotask = s.create({ projectId: PID, text: "step", parentTaskId: epica.id, blockedByTaskId: bloccante.id });
    const altroProgetto = s.create({ projectId: "altro-progetto-x", text: "fuori progetto", blockedByTaskId: bloccante.id });
    const inLista = s.create({ projectId: PID, text: "dipendente in lista", blockedByTaskId: bloccante.id, status: "todo" });

    const roots = s.list({ scope: "project", projectId: PID, rootsOnly: true });
    const card = roots.find((t) => t.id === bloccante.id);
    expect(roots.map((t) => t.id)).not.toContain(sottotask.id);   // fuori dalla lista…
    expect(roots.map((t) => t.id)).not.toContain(altroProgetto.id); // …e anche questo…
    expect(card?.waitingOnCount).toBe(3);                          // …ma contati lo stesso

    // In lettura singola e — cosa che conta per il WS — in SCRITTURA: ogni
    // `task:updated` porta il contatore, non solo i fetch pieni.
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(3);
    expect(s.update({ taskId: bloccante.id, actor: "human", by: "u", patch: { priority: 3 } }).waitingOnCount).toBe(3);

    // Vivi = non done e non archiviati: gli stessi che il gate di dispatch tiene
    // fermi e che ripartono quando il bloccante chiude.
    s.update({ taskId: inLista.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(2);
    s.archive({ taskId: altroProgetto.id });
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(1);
    // Sciolto il legame, il contatore va a zero (e chi non blocca nessuno sta a 0).
    s.update({ taskId: sottotask.id, actor: "human", by: "u", patch: { blockedByTaskId: null } });
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(0);
    expect(s.get(epica.id)?.task.waitingOnCount).toBe(0);
  });

  test("done e archiviato viaggiano nel payload: sono i due bit che spengono il chip", () => {
    const a = s.create({ projectId: PID, text: "bloccante" });
    const b = s.create({ projectId: PID, text: "dipendente", blockedByTaskId: a.id });
    s.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.get(b.id)?.task.blockedBy).toMatchObject({ status: "done", archived: false });
    // Archiviato: la riga esce dalla board ma il link resta, e il payload lo dice
    // (un `null` muto non distinguerebbe "non blocca più" da "non lo trovo").
    s.archive({ taskId: a.id });
    expect(s.get(b.id)?.task.blockedBy).toMatchObject({ id: a.id, archived: true });
  });

  test("self-block and cycles are rejected; clearing works", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b" });
    s.update({ taskId: b.id, actor: "human", by: "u", patch: { blockedByTaskId: a.id } });
    expect(() => s.update({ taskId: a.id, actor: "human", by: "u", patch: { blockedByTaskId: a.id } })).toThrow();
    // a ← b already; blocking a on b would close the loop.
    expect(() => s.update({ taskId: a.id, actor: "human", by: "u", patch: { blockedByTaskId: b.id } })).toThrow();
    const cleared = s.update({ taskId: b.id, actor: "human", by: "u", patch: { blockedByTaskId: null } });
    expect(cleared.blockedByTaskId).toBeNull();
  });

  test("listBlockedBy returns the alive dependents", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", blockedByTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", blockedByTaskId: a.id });
    s.archive({ taskId: c.id });
    const deps = s.listBlockedBy(a.id).map((t) => t.id);
    expect(deps).toEqual([b.id]);
  });

  test("model and reuseBlockerContext persist through create/update", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", blockedByTaskId: a.id, reuseBlockerContext: true, model: "claude-fable-5" });
    expect(b.model).toBe("claude-fable-5");
    expect(b.reuseBlockerContext).toBe(true);
    const upd = s.update({ taskId: b.id, actor: "human", by: "u", patch: { model: null, reuseBlockerContext: false } });
    expect(upd.model).toBeNull();
    expect(upd.reuseBlockerContext).toBe(false);
  });
});

describe("priorità automatica", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("auto finché nessuno la sceglie; un write esplicito la fissa", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(t.priorityAuto).toBe(true);
    const chosen = s.create({ projectId: PID, text: "y", priority: 4 });
    expect(chosen.priorityAuto).toBe(false);
    const upd = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { priority: 3 } });
    expect(upd.priority).toBe(3);
    expect(upd.priorityAuto).toBe(false);
  });
});

describe("review-evidence promotion — preview_image garantita dal commento di consegna", () => {
  let db: Database;
  const mk = (exists: (p: string) => boolean) => {
    let n = 500;
    return createTaskService(db, {
      now: () => new Date().toISOString(),
      uuid: () => `pv-${++n}`,
      fileExists: exists,
    });
  };
  beforeEach(() => { db = freshDb(); });

  const preview = (id: string) =>
    (db.prepare("SELECT preview_image FROM tasks WHERE id = ?").get(id) as any)?.preview_image ?? null;

  test("comment-first: il media del commento diventa preview al passaggio in review", () => {
    const s = mk(() => true);
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto", media: ["/Users/x/.topics/media/evidenza.png"] });
    expect(preview(t.id)).toBeNull(); // non ancora in review: nessuna promozione
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe("/Users/x/.topics/media/evidenza.png");
  });

  test("evidenza arrivata DOPO la review (commento di consegna solo testo) riempie la preview", () => {
    const s = mk(() => true);
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, evidenza a seguire" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBeNull();
    s.addComment({ taskId: t.id, author: "claude", content: "evidenza", media: ["/Users/x/.topics/media/clip.webm"] });
    expect(preview(t.id)).toBe("/Users/x/.topics/media/clip.webm");
  });

  test("una preview esplicita non viene mai sovrascritta", () => {
    const s = mk(() => true);
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: "/Users/x/.topics/media/scelta.png" } });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto", media: ["/Users/x/.topics/media/altra.png"] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe("/Users/x/.topics/media/scelta.png");
  });

  test("file inesistente o non-previewable (pdf/log) non viene promosso", () => {
    const s = mk((p) => p.endsWith(".png") === false ? true : false); // il png "non esiste", il resto sì
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto", media: ["/Users/x/.topics/media/morto.png", "/Users/x/.topics/media/report.pdf"] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBeNull(); // png inesistente, pdf non previewable
  });

  test("più commenti: vince il media del commento più recente", () => {
    const clock = { t: Date.parse("2026-07-20T10:00:00.000Z") };
    let n = 900;
    const s = createTaskService(db, {
      now: () => new Date(clock.t).toISOString(),
      uuid: () => `pv2-${++n}`,
      fileExists: () => true,
    });
    const t = s.create({ projectId: PID, text: "fix ui" });
    s.addComment({ taskId: t.id, author: "claude", content: "progress", media: ["/m/vecchia.png"] });
    clock.t += 60_000;
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: ["/m/finale.png"] });
    clock.t += 60_000;
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe("/m/finale.png");
  });
});

// ── Il park deve essere autoritativo ───────────────────────────────────────
//
// `release()` toglie il task all'agente (azzera `assigned_topic_id`), ma il suo
// TURNO non muore con quella riga: continua a girare. La sua `update_task`
// passava senza che nessuno controllasse se quel task gli appartenesse ancora.
// Misurato: parcheggiato alle 22:48, tornato `in_progress` 79 secondi dopo, e
// rimasto lì SETTE GIORNI — nessun reaper lo guardava, perché per il DB stava
// lavorando, e falsava anche la capacità di dispatch.
describe("il park è autoritativo: l'agente scartato non si riprende il task", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1'), ('top-2')");
  });

  function dispatched(): string {
    const t = s.create({ projectId: PID, text: "lavoro", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    return t.id;
  }

  test("dopo il PARK l'agente non può riportarlo in_progress", () => {
    const id = dispatched();
    s.release({ taskId: id, requeue: false, parkState: "failed", reason: "tentativi esauriti" });
    expect(s.get(id)!.task.status).toBe("backlog");

    expect(() => s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "in_progress" },
    })).toThrow(/non è più assegnato a te/);

    // E lo stato NON si è mosso: è la parte che contava.
    expect(s.get(id)!.task.status).toBe("backlog");
  });

  test("dopo un REQUEUE vale lo stesso (il task è tornato in coda, non è più tuo)", () => {
    const id = dispatched();
    s.release({ taskId: id, requeue: true, reason: "rimesso in coda" });
    expect(s.get(id)!.task.status).toBe("todo");
    expect(() => s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "in_progress" },
    })).toThrow(/non è più assegnato a te/);
  });

  test("un task MAI dispacciato resta lavorabile: la guardia non deve allargarsi", () => {
    // Nessun legame e nessuna firma di rilascio: qui nessuno ha tolto niente a
    // nessuno, e bloccare sarebbe impedire lavoro legittimo.
    const t = s.create({ projectId: PID, text: "mai dispacciato", status: "todo" });
    const out = s.update({
      taskId: t.id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "in_progress" },
    });
    expect(out.status).toBe("in_progress");
  });

  test("il task di un ALTRO agente resta intoccabile", () => {
    const id = dispatched(); // legato a top-1
    expect(() => s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-2",
      patch: { status: "review" },
    })).toThrow(/non è più assegnato a te/);
  });

  test("l'agente legittimo continua a lavorare normalmente", () => {
    const id = dispatched();
    s.addComment({ taskId: id, author: "claude", content: "fatto: sintesi" });
    const out = s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "review" },
    });
    expect(out.status).toBe("review");
  });

  test("un UMANO può sempre rimetterci le mani dopo un park", () => {
    // La guardia è sull'agente: il park non deve incastrare anche te.
    const id = dispatched();
    s.release({ taskId: id, requeue: false, parkState: "failed" });
    const out = s.update({ taskId: id, actor: "human", by: "user", patch: { status: "todo" } });
    expect(out.status).toBe("todo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Il ramo DIAGRAMMA, e i due controlli che lo accompagnano.
//
// `PREVIEW_RULE` ha un terzo ramo per le consegne senza superficie renderizzata
// (un piano, un'architettura, una migrazione): si consegna un diagramma `.svg`.
// Senza `svg` fra le estensioni promuovibili quel ramo nasceva morto — l'agente
// allegava il diagramma e la card restava cieca. Qui i file sono VERI su disco:
// il gate di forma legge l'header, e con path finti non misurerebbe niente.
// ─────────────────────────────────────────────────────────────────────────────
describe("anteprima: ramo diagramma, gate di forma, duplicati", () => {
  let db: Database;
  let dir: string;
  let n = 0;
  const mk = () => createTaskService(db, { now: () => new Date().toISOString(), uuid: () => `dg-${++n}` });
  beforeEach(() => { db = freshDb(); dir = mkdtempSync(join(tmpdir(), "task-preview-")); });

  const preview = (id: string) =>
    (db.prepare("SELECT preview_image FROM tasks WHERE id = ?").get(id) as any)?.preview_image ?? null;
  const notes = (id: string) =>
    (db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'review-note'").all(id) as any[])
      .map((r) => r.content as string);

  const write = (name: string, bytes: Buffer | string): string => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  };
  /** Header PNG (firma + IHDR): è tutto ciò che il gate di forma legge. */
  const png = (name: string, w: number, h: number): string => {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
    return write(name, b);
  };
  const svg = (name: string, w: number, h: number): string =>
    write(name, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="40" height="20"/></svg>`);

  // ── Il ritiro è uno STATO, non un messaggio ───────────────────────────────
  // La bonifica delle anteprime false ha scritto «⚠️ Anteprima RITIRATA…» nel
  // thread di 23 card. Un messaggio non invecchia: dove l'anteprima è tornata
  // continua a dire il contrario. Il fatto vive in colonna, e quello che si
  // prova qui è che si SPEGNE da solo — perché è quella la differenza fra uno
  // stato e una nota.
  const retired = (id: string) =>
    db.prepare("SELECT preview_retired_at AS at, preview_retired_reason AS why FROM tasks WHERE id = ?").get(id) as
      { at: string | null; why: string | null };

  test("ritirare l'anteprima toglie l'immagine E scrive il motivo sulla card", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna con evidenza falsa" });
    const shot = png("schermata.png", 1440, 760);
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: shot } });
    expect(preview(t.id)).toBe(shot);

    const dopo = s.retirePreview({ taskId: t.id, reason: "identica a quella di altre 12 card" });
    expect(preview(t.id)).toBeNull();
    expect(dopo.previewImage).toBeNull();
    expect(dopo.previewRetiredAt).not.toBeNull();
    expect(dopo.previewRetiredReason).toBe("identica a quella di altre 12 card");
    expect(retired(t.id).why).toBe("identica a quella di altre 12 card");
  });

  test("un'anteprima NUOVA spegne il ritiro: lo stato non sopravvive al fatto", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "riconsegna" });
    s.retirePreview({ taskId: t.id, reason: "placeholder, non evidenza" });
    expect(retired(t.id).at).not.toBeNull();

    const buona = png("vera.png", 1440, 760);
    const dopo = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: buona } });
    expect(dopo.previewImage).toBe(buona);
    expect(dopo.previewRetiredAt).toBeNull();
    expect(dopo.previewRetiredReason).toBeNull();
  });

  test("anche l'adozione automatica dal commento di consegna spegne il ritiro", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna via allegato" });
    s.retirePreview({ taskId: t.id, reason: "503, non evidenza" });
    const buona = png("consegnata.png", 1440, 760);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [buona] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(buona);
    expect(retired(t.id).at).toBeNull();
  });

  // Azzerare a mano NON è un ritiro: chi toglie l'immagine senza dare un motivo
  // non sta dicendo «era falsa», e la card non deve inventarsi una spiegazione.
  test("azzerare l'anteprima con una stringa vuota non accende nessuno stato", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "ripensamento" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: png("a.png", 1440, 760) } });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { previewImage: "" } });
    expect(preview(t.id)).toBeNull();
    expect(retired(t.id).at).toBeNull();
  });

  test("un .svg allegato al commento di consegna DIVENTA l'anteprima della card", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "piano di migrazione" });
    const diagram = svg("piano.svg", 900, 420);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna: lo schema del piano", media: [diagram] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(diagram);
    expect(s.get(t.id)!.task.previewImage).toBe(diagram); // e arriva fino al client
  });

  test("una consegna SENZA nessun allegato lo dice: la card cieca non resta muta", () => {
    // Misurato il 14/08 sulla board di topics: 186 card su 393 senza anteprima,
    // e ZERO scartate per forma — cioè l'unico ramo che parlava non era mai
    // scattato, e chi apriva la card non sapeva se l'evidenza mancasse, fosse
    // fallita o non servisse.
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna a parole" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, cinque cancelli verdi" });
    const after = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    expect(after.status).toBe("review");          // resta un SEGNALE, non un blocco
    expect(preview(t.id)).toBeNull();
    expect(notes(t.id)[0]).toContain("SENZA anteprima");
    expect(notes(t.id)[0]).toContain(".webm");    // porta con sé i tre rami
  });

  test("con un allegato promosso non si scrive nessuna nota di card cieca", () => {
    // La negazione: il segnale deve dipendere dall'ASSENZA, non essere un
    // rumore che accompagna ogni consegna.
    const s = mk();
    const t = s.create({ projectId: PID, text: "consegna con schema" });
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [svg("schema.svg", 900, 420)] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(notes(t.id).some((n) => n.includes("SENZA anteprima"))).toBe(false);
  });

  test("un'immagine più alta che larga (h/w > 0.7) non viene promossa e lascia una nota", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "piano fotografato" });
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [png("intero-piano.png", 1200, 4000)] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    expect(preview(t.id)).toBeNull();
    expect(notes(t.id)[0]).toContain("1200×4000");
    expect(notes(t.id)[0]).toContain("DIAGRAMMA");
  });

  test("il rifiuto NON blocca la consegna: il task resta in review, l'allegato nel thread", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "piano fotografato" });
    const tall = png("alta.png", 1000, 3000);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [tall] });
    const after = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });

    expect(after.status).toBe("review");
    const thread = s.get(t.id)!.comments;
    expect(thread.some((c) => (c.media ?? []).includes(tall))).toBe(true);
  });

  test("la nota non si ripete: la promozione ripassa dallo stesso file a ogni commento", () => {
    // Clock che avanza: la promozione legge i commenti ORDER BY created_at DESC,
    // e con timestamp identici l'ordine è arbitrario (visto: il test passava da
    // solo e cadeva nella suite intera).
    const clock = { t: Date.parse("2026-08-10T09:00:00.000Z") };
    let k = 0;
    const s = createTaskService(db, { now: () => new Date(clock.t).toISOString(), uuid: () => `dgn-${++k}` });
    const t = s.create({ projectId: PID, text: "piano" });
    const tall = png("alta.png", 800, 2400);
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [tall] });
    clock.t += 60_000;
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    clock.t += 60_000;
    s.addComment({ taskId: t.id, author: "claude", content: "e ancora", media: [tall] });
    expect(notes(t.id).length).toBe(1);
    // Un file DIVERSO è un rifiuto diverso, e quello si dice.
    clock.t += 60_000;
    s.addComment({ taskId: t.id, author: "claude", content: "un'altra", media: [png("alta2.png", 800, 2400)] });
    expect(notes(t.id).length).toBe(2);
  });

  test("appena sotto la soglia passa: il gate taglia il documento fotografato, non il quasi-quadrato", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "un pannello" });
    const ok = png("pannello.png", 1000, 690); // 0.69
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [ok] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(ok);
    expect(notes(t.id)).toEqual([]);
  });

  test("forma non misurabile (un video, un formato che non si legge) ⇒ si promuove lo stesso", () => {
    const s = mk();
    const t = s.create({ projectId: PID, text: "comportamento" });
    const clip = write("clip.webm", Buffer.alloc(2048)); // nessun header leggibile
    s.addComment({ taskId: t.id, author: "claude", content: "consegna", media: [clip] });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(preview(t.id)).toBe(clip);
  });

  test("anteprima byte-identica a quella di un altro task: SEGNALE, non blocco", () => {
    const s = mk();
    const a = s.create({ projectId: PID, text: "il primo task" });
    const b = s.create({ projectId: PID, text: "il secondo task" });
    const one = svg("uno.svg", 600, 300);
    const clone = write("due.svg", readFileSync(one)); // stesso contenuto, altro path

    s.update({ taskId: a.id, actor: "agent", by: "claude", patch: { previewImage: one } });
    const after = s.update({ taskId: b.id, actor: "agent", by: "claude", patch: { previewImage: clone } });

    expect(after.previewImage).toBe(clone);      // messa comunque: è un segnale
    expect(notes(b.id)[0]).toContain("IDENTICA");
    expect(notes(b.id)[0]).toContain(a.id);
    expect(notes(a.id)).toEqual([]);             // il primo non c'entra niente
  });

  test("anteprime diverse: nessun rumore nel thread", () => {
    const s = mk();
    const a = s.create({ projectId: PID, text: "primo" });
    const b = s.create({ projectId: PID, text: "secondo" });
    s.update({ taskId: a.id, actor: "agent", by: "claude", patch: { previewImage: svg("a.svg", 600, 300) } });
    s.update({ taskId: b.id, actor: "agent", by: "claude", patch: { previewImage: svg("b.svg", 640, 300) } });
    expect(notes(b.id)).toEqual([]);
  });
});

/**
 * L'esito di un land è un FATTO, e lo stato della card lo deve dire in ENTRAMBI
 * i versi. Misurato l'11/08: land fallito → card in `done` col codice fuori da
 * main; land riuscito → card `in_progress` con un agente sopra a rifarlo.
 */
describe("settleLanded / verdetto testimoniato", () => {
  let db: Database; let svc: TaskService;
  beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

  const nuovo = (patch = "") => {
    const t = svc.create({ projectId: "pX", text: "feature" });
    if (patch) db.prepare(`UPDATE tasks SET ${patch} WHERE id = ?`).run(t.id);
    return t.id;
  };

  test("una card viva chiusa dal land: done, chip spento, e la riga di storico dice perché", () => {
    const id = nuovo("status = 'in_progress', dispatch_state = 'working'");
    const after = svc.settleLanded({ taskId: id, by: "system", reason: "il land è riuscito: il codice è su main" });
    expect(after?.status).toBe("done");
    // Il chip spento è ciò che toglie la card dalla presa del dispatcher.
    expect(after?.dispatchState).toBe(null);
    const ev = svc.get(id)!.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");
    expect(ev.content).toContain("il codice è su main");
  });

  test("su una card già chiusa e ferma non scrive NIENTE: nessuna riga done→done", () => {
    const id = nuovo("status = 'done'");
    const before = svc.get(id)!.comments.length;
    svc.settleLanded({ taskId: id, by: "system", reason: "x" });
    expect(svc.get(id)!.comments.length).toBe(before);
    expect(svc.get(id)!.task.status).toBe("done");
  });

  test("una card chiusa ma col chip ANCORA acceso si ripulisce, senza una nuova transizione", () => {
    // Il caso in mezzo: `done` con `dispatch_state` vivo è claimabile-adiacente
    // e mostra un chip che mente. Si spegne, ma la card non è "ri-chiusa".
    const id = nuovo("status = 'done', dispatch_state = 'working'");
    const before = svc.get(id)!.comments.filter((c) => c.kind === "status").length;
    const after = svc.settleLanded({ taskId: id, by: "system", reason: "x" });
    expect(after?.dispatchState).toBe(null);
    expect(svc.get(id)!.comments.filter((c) => c.kind === "status").length).toBe(before);
  });

  test("chiudere è chiudere: la card non resta «riaperta» sopra un done, e dice CHI l'ha chiusa", () => {
    // Questa porta scrive `done` a SQL grezzo: senza le due colonne messe a mano
    // resterebbe `reopened_actor` acceso e `done_actor` vuoto, cioè «riaperta da
    // attilio» stampato sopra una card chiusa. Uno stato che `update()` non
    // produce mai.
    const id = nuovo("status = 'in_progress', dispatch_state = 'working'");
    db.prepare("UPDATE tasks SET reopened_at = '2026-08-12T00:00:00Z', reopened_by = 'attilio', reopened_actor = 'human' WHERE id = ?").run(id);

    const dopo = svc.settleLanded({ taskId: id, by: "system", reason: "il land è riuscito" })!;

    expect(dopo.status).toBe("done");
    expect(dopo.reopenedActor).toBeNull();
    expect(dopo.reopenedAt).toBeNull();
    expect(dopo.reopenedBy).toBeNull();
    expect(dopo.doneActor).toBe("system");
  });

  test("un verdetto umano NON si riscrive a nome del sistema", () => {
    // La controprova del COALESCE: se una persona aveva già chiuso questa card,
    // il verdetto è suo. Sovrascriverlo sarebbe la stessa bugia al contrario.
    const id = nuovo("status = 'done', dispatch_state = 'working', done_actor = 'human'");
    const dopo = svc.settleLanded({ taskId: id, by: "system", reason: "il land è riuscito" })!;
    expect(dopo.doneActor).toBe("human");
  });

  /**
   * IL LAND NON CHIUDE UN PADRE CON STEP APERTI.
   *
   * `settleLanded` era l'unica porta verso `done` che saltasse l'invariante:
   * scrive SQL grezzo, quindi il cancello di `update()` e dell'approvazione non
   * la incontrava. «Landa su main» chiudeva il padre e i suoi passi restavano
   * appesi sotto una card chiusa — fuori dalle colonne (il feed è `rootsOnly`),
   * fuori dalla presa del dispatcher (uno step non lo claima nessuno), cioè
   * lavoro irraggiungibile.
   */
  test("un padre con step aperti NON si chiude col land, ma il chip si spegne lo stesso", () => {
    const padre = nuovo("status = 'review', dispatch_state = 'working', dispatch_deferred_until = '2099-01-01T00:00:00Z'");
    const figlio = svc.create({ projectId: "pX", text: "passo aperto", parentTaskId: padre });

    const dopo = svc.settleLanded({ taskId: padre, by: "system", reason: "il land è riuscito" })!;

    expect(dopo.status).toBe("review");   // resta dov'era: il merge non la chiude
    expect(svc.get(figlio.id)!.task.status).not.toBe("done");
    // Il merge però è avvenuto: la card non deve restare claimabile, o un agente
    // riparte a rifare ciò che sta su main.
    expect(dopo.dispatchState).toBeNull();
    expect(dopo.dispatchDeferredUntil).toBeNull();
    // E nessuna riga di storico per una transizione che non c'è stata.
    expect(svc.get(padre)!.comments.filter((c) => c.kind === "status")).toEqual([]);
  });

  test("chiuso l'ultimo step, lo stesso land chiude il padre", () => {
    // La controprova: senza di questa il cancello sopra potrebbe essere «non
    // chiude mai» e passerebbe uguale.
    const padre = nuovo("status = 'review', dispatch_state = 'working'");
    const figlio = svc.create({ projectId: "pX", text: "passo", parentTaskId: padre });
    svc.update({ taskId: figlio.id, actor: "human", by: "attilio", patch: { status: "done" } });

    expect(svc.settleLanded({ taskId: padre, by: "system", reason: "il land è riuscito" })!.status).toBe("done");
  });

  test("un ATTERRAGGIO testimoniato esce dai candidati della passata: non lo si rideduce", () => {
    const dedotto = nuovo();
    const visto = nuovo();
    for (const id of [dedotto, visto]) {
      svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "c".repeat(40) });
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    }
    svc.recordLandingState({ taskId: dedotto, state: "unlanded", checkedAt: "2026-08-11T00:00:00Z" });
    svc.recordLandingState({ taskId: visto, state: "landed", checkedAt: "2026-08-11T00:00:00Z", witnessed: true });

    const candidati = svc.listLandingAuditCandidates().map((c) => c.id);
    expect(candidati).toContain(dedotto);   // dedotto: si può riprovare
    expect(candidati).not.toContain(visto); // visto: non c'è niente da aggiungere
  });

  /**
   * L'ALTRA METÀ DELLA TESTIMONIANZA, e non è simmetrica.
   *
   * «È atterrato» è un fatto che non scade: quel contenuto su main ci resta.
   * «NON è atterrato» è un fatto su un ISTANTE — il land che non è riuscito — e
   * il giorno dopo qualcuno può aver cherry-piccato quel lavoro a mano. Tenendo
   * fuori dall'audit anche questo verdetto, l'accusa si congelava: misurate il
   * 13/08 due card in Done che dicevano «non su main» con il commit di consegna
   * ANTENATO di main.
   */
  test("un MANCATO atterraggio testimoniato torna fra i candidati: il mondo va avanti", () => {
    const id = nuovo();
    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "d".repeat(40) });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    svc.recordLandingState({ taskId: id, state: "unlanded", checkedAt: "2026-08-11T00:00:00Z", witnessed: true });

    expect(svc.listLandingAuditCandidates().map((c) => c.id)).toContain(id);
    // La testimonianza resta, ed è giusto: dice ancora CHI ha risposto. A
    // cadere è solo l'esenzione dal ricontrollo.
    expect(atterraggio(id).w).toBe(1);
  });

  test("una CONSEGNA nuova fa cadere la testimonianza: era su un'altra consegna", () => {
    const id = nuovo();
    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "a".repeat(40) });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    svc.recordLandingState({ taskId: id, state: "landed", checkedAt: "2026-08-11T00:00:00Z", witnessed: true });
    expect(svc.listLandingAuditCandidates().map((c) => c.id)).not.toContain(id);

    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "b".repeat(40) });
    expect(svc.listLandingAuditCandidates().map((c) => c.id)).toContain(id);
  });

  /**
   * Lo scatto della consegna descrive un lavoro CONSEGNATO. Una card che rientra
   * in coda non lo sta più consegnando: o è stata rifiutata, o qualcuno l'ha
   * riaperta per chiedere dell'altro. Tenerlo la fa parlare di un frutto che non
   * è più suo — e il dispatcher su quel campo ci CHIUDE la card («è già su main»),
   * quindi la richiesta nuova morirebbe sul commit vecchio senza via d'uscita:
   * solo una consegna nuova riscrive quel campo, e per consegnare serve il
   * dispatch che il cancello blocca.
   */
  const conConsegna = (stato: string) => {
    const id = nuovo();
    svc.recordDelivery({ taskId: id, branch: "topics/x", commit: "a".repeat(40) });
    svc.recordLandingState({ taskId: id, state: "landed", checkedAt: "2026-08-12T00:00:00Z", witnessed: true });
    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(stato, id);
    return id;
  };
  const atterraggio = (id: string) =>
    db.prepare("SELECT landing_state AS s, landing_checked_at AS c, landing_witnessed AS w FROM tasks WHERE id = ?").get(id) as any;

  test("una card riaperta da done torna in coda SENZA la consegna di prima", () => {
    const id = conConsegna("done");
    expect(svc.get(id)!.task.deliveryCommit).toBe("a".repeat(40));

    const dopo = svc.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "todo" } });

    expect(dopo.deliveryCommit).toBeNull();
    expect(dopo.deliveryBranch).toBeNull();
    // Il verdetto sull'atterraggio cade col suo commit: senza, il prossimo
    // giudizio nascerebbe già «visto» su una consegna che non esiste più.
    expect(atterraggio(id)).toEqual({ s: null, c: null, w: 0 });
  });

  test("stessa cosa uscendo da review: un rifiuto non lascia in mano il frutto rifiutato", () => {
    // La stessa strada di `done`, da un'altra porta: chi trascina una card da
    // Review a Todo sta chiedendo di rifarla, esattamente come chi la riapre.
    const id = conConsegna("review");
    const dopo = svc.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(dopo.deliveryCommit).toBeNull();
    expect(atterraggio(id).w).toBe(0);
  });

  test("verso done e verso review lo scatto RESTA: è ciò che il reviewer guarda", () => {
    // La controprova, e non è pedanteria: azzerare qui cancellerebbe la sola
    // descrizione di ciò che è stato approvato, cioè quello che il land legge.
    const inReview = conConsegna("review");
    const approvata = svc.update({ taskId: inReview, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(approvata.deliveryCommit).toBe("a".repeat(40));
    expect(atterraggio(inReview).w).toBe(1);

    const chiusa = conConsegna("done");
    const riletta = svc.update({ taskId: chiusa, actor: "human", by: "attilio", patch: { status: "review" } });
    expect(riletta.deliveryCommit).toBe("a".repeat(40));
  });

  test("una card che non è mai stata consegnata non perde niente: il campo era già vuoto", () => {
    const id = nuovo("status = 'done'");
    const dopo = svc.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(dopo.deliveryCommit).toBeNull();
    expect(dopo.status).toBe("todo");
  });
});

/**
 * Il segnale «chi lavora questo sottotask» esce da `rowToTask`, cioè da OGNI
 * payload di task — non solo da `list`/`get`. Qui si pinna la risalita vera sul
 * DB: la CTE, la guardia che la tiene spenta sul caso normale, e i due modi in
 * cui la catena può essere storta (padre sparito, ciclo).
 */
describe("subtaskWork: chi lavora un sottotask senza agente suo", () => {
  let db: Database;
  let s: TaskService;
  // `get` torna la busta {task, comments, children}: qui interessa solo il task.
  const work = (id: string) => s.get(id)!.task.subtaskWork;
  beforeEach(() => {
    db = freshDb();
    db.run("INSERT INTO topics (id) VALUES ('t-parent')");
    s = svc(db);
  });

  // Un padre col suo agente dentro un turno: topic + chip + in_progress.
  function workingParent(text = "il padre") {
    const p = s.create({ projectId: PID, text, status: "backlog" });
    db.run(
      "UPDATE tasks SET status='in_progress', assigned_topic_id='t-parent', dispatch_state='working' WHERE id = ?",
      [p.id],
    );
    return p;
  }
  // Uno step della checklist come lo crea l'agente: figlio, mai dispacciato.
  function step(parentId: string, text = "lo step") {
    const c = s.create({ projectId: PID, text, status: "backlog", parentTaskId: parentId });
    db.run("UPDATE tasks SET status='in_progress' WHERE id = ?", [c.id]);
    return c;
  }

  test("(a) lo step lo lavora il padre nel suo turno: il payload dice chi", () => {
    const p = workingParent();
    const c = step(p.id);
    expect(work(c.id)).toEqual({
      kind: "parent-turn", ancestor: { id: p.id, text: "il padre" },
    });
  });

  test("(b) il padre è tornato indietro senza topic: nessuno lo lavora", () => {
    const p = workingParent();
    const c = step(p.id);
    // Il caso misurato sul DB vivo: il padre torna in backlog e molla il topic.
    db.run("UPDATE tasks SET status='backlog', assigned_topic_id=NULL, dispatch_state=NULL WHERE id = ?", [p.id]);
    expect(work(c.id)).toEqual({ kind: "unattended" });
  });

  test("un padre archiviato non lavora niente", () => {
    const p = workingParent();
    const c = step(p.id);
    db.run("UPDATE tasks SET archived=1 WHERE id = ?", [p.id]);
    expect(work(c.id)).toEqual({ kind: "unattended" });
  });

  test("risale oltre il padre diretto: vince il primo antenato AL LAVORO", () => {
    const nonno = workingParent("il nonno");
    const padre = step(nonno.id, "lo step di mezzo");
    const nipote = step(padre.id, "il sotto-step");
    // Il padre diretto è a sua volta un sottotask senza agente: chi tiene il
    // turno è il nonno, ed è lui che va nominato.
    expect(work(nipote.id)).toEqual({
      kind: "parent-turn", ancestor: { id: nonno.id, text: "il nonno" },
    });
  });

  test("la domanda non si pone: con un topic suo, con un chip suo, o da fermo", () => {
    const p = workingParent();
    const own = step(p.id, "step con agente suo");
    db.run("UPDATE tasks SET assigned_topic_id='t-parent', dispatch_state='working' WHERE id = ?", [own.id]);
    // Ha già il deep-link e lo stato sulla card: `null` = niente da dire, che
    // NON è «non lo lavora nessuno».
    expect(work(own.id)).toBeNull();

    const parked = step(p.id, "step fermo");
    db.run("UPDATE tasks SET status='todo' WHERE id = ?", [parked.id]);
    expect(work(parked.id)).toBeNull();

    // Un task radice in corso senza chip non è questa storia.
    const root = s.create({ projectId: PID, text: "radice", status: "backlog" });
    db.run("UPDATE tasks SET status='in_progress' WHERE id = ?", [root.id]);
    expect(work(root.id)).toBeNull();
  });

  test("il chip del padre vale solo se è ATTIVO: consegnato o in attesa non lavora", () => {
    const p = workingParent();
    const c = step(p.id);
    for (const dead of ["delivered", "needs_input", "waiting", "failed"]) {
      db.run("UPDATE tasks SET dispatch_state = ? WHERE id = ?", [dead, p.id]);
      expect(work(c.id)).toEqual({ kind: "unattended" });
    }
    for (const alive of ["queued", "starting", "working"]) {
      db.run("UPDATE tasks SET dispatch_state = ? WHERE id = ?", [alive, p.id]);
      expect(work(c.id)!.kind).toBe("parent-turn");
    }
  });

  test("catena storta: padre sparito e ciclo non appendono la lettura", () => {
    // Edge orfano: il padre non c'è più (FK spenta a mano, come una riga vecchia).
    db.run("PRAGMA foreign_keys = OFF");
    const p = workingParent();
    const c = step(p.id);
    db.run("DELETE FROM tasks WHERE id = ?", [p.id]);
    expect(work(c.id)).toEqual({ kind: "unattended" });

    // Ciclo: due righe che si fanno da padre l'una all'altra. Non deve girare
    // all'infinito — il tetto sulla profondità è lì per questo.
    const a = s.create({ projectId: PID, text: "a", status: "backlog" });
    const b = s.create({ projectId: PID, text: "b", status: "backlog", parentTaskId: a.id });
    db.run("UPDATE tasks SET parent_task_id = ? WHERE id = ?", [b.id, a.id]);
    db.run("UPDATE tasks SET status='in_progress' WHERE id IN (?, ?)", [a.id, b.id]);
    expect(work(b.id)).toEqual({ kind: "unattended" });
  });
});

// L'11/08 Attilio: «avevo visto il task fatto nella tab kanban, ora non lo vedo
// più». Misurato: undici card uscite da `done` in sei ore, nessuna persa — ma la
// board non lo diceva. Il motivo viveva nel thread; chi guarda la colonna vedeva
// un buco. Due fatti sulla card, entrambi leggibili dall'API della board: chi ha
// chiuso (`doneActor`) e che è stata riaperta (`reopened*`).
describe("uscita da done: la traccia sulla card e chi può riaprirla", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  /** Una card chiusa da un UMANO che approva la review (il caso di Attilio). */
  function doneByHuman(): string {
    const t = s.create({ projectId: PID, text: "consegna", status: "in_progress" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, guarda demo/" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.reviewDecision({ taskId: t.id, by: "attilio", decision: "approve" });
    return t.id;
  }

  /** Una card `done` senza passare da una review: `create` rifiuta `done` diretto. */
  function doneByDrag(text: string): { id: string } {
    const t = s.create({ projectId: PID, text, status: "review" });
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "done" } });
    return { id: t.id };
  }

  test("chi ha chiuso resta scritto: approvazione umana → 'human', step chiuso dall'agent → 'agent'", () => {
    const approved = doneByHuman();
    expect(s.get(approved)!.task.doneActor).toBe("human");

    // Lo step di checklist di un agent: lo chiude lui, non passa da una review.
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const root = s.create({ projectId: PID, text: "task dell'agent", status: "in_progress" });
    s.bindTopic({ taskId: root.id, topicId: "top-1" });
    const step = s.create({ projectId: PID, text: "passo 1", parentTaskId: root.id });
    s.update({ taskId: step.id, actor: "agent", by: "claude", patch: { status: "done" }, agentTopicId: "top-1" });
    expect(s.get(step.id)!.task.doneActor).toBe("agent");
  });

  test("una card che esce da done lo DICE sulla card: reopenedAt/By/Actor, leggibili da get e list", () => {
    const id = doneByHuman();
    const before = s.get(id)!.task;
    expect(before.reopenedAt).toBeNull();

    s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "in_progress" } });

    const after = s.get(id)!.task;
    expect(after.status).toBe("in_progress");
    expect(after.reopenedAt).not.toBeNull();
    expect(after.reopenedBy).toBe("attilio");
    expect(after.reopenedActor).toBe("human");
    // …e sulla LISTA della board, che è ciò che disegna la colonna.
    const listed = s.list({ scope: "project", projectId: PID }).find((t) => t.id === id)!;
    expect(listed.reopenedAt).toBe(after.reopenedAt);
    expect(listed.reopenedBy).toBe("attilio");
    // Chiudere il ciclo azzera il segno: una card di nuovo `done` non è «riaperta».
    s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "done" } });
    const redone = s.get(id)!.task;
    expect(redone.reopenedAt).toBeNull();
    expect(redone.reopenedBy).toBeNull();
    expect(redone.doneActor).toBe("human");
  });

  test("un agent NON riapre un done deciso da un umano (approvazione o trascinamento)", () => {
    const approved = doneByHuman();
    expect(() => s.update({ taskId: approved, actor: "agent", by: "claude", patch: { status: "in_progress" } }))
      .toThrow(/decisione umana/);
    expect(s.get(approved)!.task.status).toBe("done"); // la card non si è mossa
    expect(s.get(approved)!.task.reopenedAt).toBeNull(); // e nessuna traccia falsa

    // Stessa cosa per un done messo a mano trascinando sulla board.
    const dragged = s.create({ projectId: PID, text: "chiusa a mano", status: "review" });
    s.update({ taskId: dragged.id, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(() => s.update({ taskId: dragged.id, actor: "agent", by: "claude", patch: { status: "todo" } }))
      .toThrow(/decisione umana/);

    // L'umano invece riapre sempre: il cancello è sull'agent, non sulla board.
    expect(s.update({ taskId: approved, actor: "human", by: "attilio", patch: { status: "review" } }).status).toBe("review");
  });

  test("il proprio sottotask, chiuso dall'agent e mai passato da una review, resta riapribile", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-2')");
    const root = s.create({ projectId: PID, text: "task dell'agent", status: "in_progress" });
    s.bindTopic({ taskId: root.id, topicId: "top-2" });
    const step = s.create({ projectId: PID, text: "passo 1", parentTaskId: root.id });
    s.update({ taskId: step.id, actor: "agent", by: "claude", patch: { status: "done" }, agentTopicId: "top-2" });

    const back = s.update({ taskId: step.id, actor: "agent", by: "claude", patch: { status: "in_progress" }, agentTopicId: "top-2" });
    expect(back.status).toBe("in_progress");
    // Anche questa riapertura lascia il segno: è comunque una cosa fatta che sparisce.
    expect(back.reopenedActor).toBe("agent");
    expect(back.reopenedBy).toBe("claude");
  });

  test("storico senza prova (done_actor NULL): l'agent la riapre, e la traccia si scrive lo stesso", () => {
    // Le card chiuse PRIMA della migration che non portano un'approvazione
    // approvata restano «non si sa». Il cancello le lascia passare di proposito:
    // murare a posteriori bloccherebbe proprio i sottotask che gli agenti
    // chiudono da soli. Ciò che NON si perde è il segno — questo è il punto
    // della card, e vale anche qui.
    const legacy = doneByDrag("chiusa nel 2025");
    db.run("UPDATE tasks SET done_actor = NULL WHERE id = ?", [legacy.id]);

    const back = s.update({ taskId: legacy.id, actor: "agent", by: "claude", patch: { status: "todo" } });
    expect(back.status).toBe("todo");
    expect(back.reopenedActor).toBe("agent");
    expect(back.reopenedAt).not.toBeNull();
  });

  test("anche le porte di SISTEMA lasciano il segno: requeue, attesa dichiarata, consegna forzata", () => {
    // Non passano da `update()` — scrivono lo status a SQL grezzo. Erano tre
    // modi di far uscire una card da `done` senza che la board lo dicesse.
    const requeued = doneByDrag("rimessa in coda");
    s.release({ taskId: requeued.id, requeue: true, reason: "server ripartito", by: "dispatcher" });
    const r = s.get(requeued.id)!.task;
    expect(r.status).toBe("todo");
    expect(r.reopenedActor).toBe("system");
    expect(r.reopenedAt).not.toBeNull();
    expect(r.doneActor).toBeNull();

    const waiting = doneByDrag("in attesa");
    s.deferForWait({ taskId: waiting.id, reason: "aspetto il server", minutes: 5, by: "claude" });
    expect(s.get(waiting.id)!.task.reopenedActor).toBe("agent");

    const forced = doneByDrag("consegna di sistema");
    s.deliverToReviewBySystem({ taskId: forced.id, reason: "tentativi esauriti", cause: "retries_exhausted" });
    const f = s.get(forced.id)!.task;
    expect(f.status).toBe("review");
    expect(f.reopenedActor).toBe("system");
    expect(f.reopenedBy).toBe("dispatcher");
  });

  test("il ritiro della MACCHINA non si firma «da te»: attore = permesso, firma = chi", () => {
    // Il land in conflitto (routes/tasks.ts, ramo "conflict") ritira la card da
    // `done` con `actor: "human"` — è l'asse dei PERMESSI, l'unico che può
    // riportare indietro una card chiusa — ma `by: "system"`. Leggendo l'attore,
    // il chip avrebbe detto «riaperta da te» di una cosa che l'umano non ha
    // deciso: la stessa bugia che questa card toglie, un livello più giù.
    const landata = doneByDrag("consegna landata");
    const back = s.update({
      taskId: landata.id, actor: "human", by: "system",
      patch: { status: "in_progress" }, statusReason: "il land ha fatto conflitto con main",
    });
    expect(back.reopenedActor).toBe("system");
    expect(back.reopenedBy).toBe("system");
  });

  test("una card che NON era done non prende una traccia falsa da nessuna porta", () => {
    const vivo = s.create({ projectId: PID, text: "mai chiusa", status: "in_progress" });
    s.update({ taskId: vivo.id, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(s.get(vivo.id)!.task.reopenedAt).toBeNull();
    s.release({ taskId: vivo.id, requeue: false, by: "dispatcher" });
    expect(s.get(vivo.id)!.task.reopenedAt).toBeNull();
    s.deliverToReviewBySystem({ taskId: vivo.id, reason: "boh", cause: "retries_exhausted" });
    expect(s.get(vivo.id)!.task.reopenedAt).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // USCIRE DA REVIEW VALE QUANTO USCIRE DA DONE
  //
  // Il 12/08 alle 18:26 Attilio ha chiesto un cambio di rotta e ha trascinato
  // `d6baaf5e` da `review` a `in corso`. Il segno di riapertura si accendeva
  // solo uscendo da `done`, quindi per il campo nessuno aveva riaperto niente:
  // il mattino dopo la chiusura automatica del dispatcher ha chiuso la card
  // sopra la consegna di CINQUE GIORNI prima, e la richiesta è finita
  // archiviata dentro una card `done`. Il segnale non può dipendere da quale
  // casella ha attraversato il dito.
  // ───────────────────────────────────────────────────────────────────────────

  /** Una card in review con una consegna registrata: lo stato di `d6baaf5e`. */
  function inReviewConConsegna(text: string): string {
    const t = s.create({ projectId: PID, text, status: "in_progress" });
    s.addComment({ taskId: t.id, author: "claude", content: "consegnato" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    s.recordDelivery({ taskId: t.id, branch: "topics/x", commit: "f".repeat(40) });
    return t.id;
  }

  test.each(["in_progress", "todo", "backlog"] as const)(
    "trascinata da review a %s: è una riapertura umana, e la consegna vecchia non la segue",
    (destinazione: "in_progress" | "todo" | "backlog") => {
      const id = inReviewConConsegna(`review → ${destinazione}`);
      expect(s.get(id)!.task.deliveryCommit).not.toBeNull();

      s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: destinazione } });

      const after = s.get(id)!.task;
      expect(after.status).toBe(destinazione);
      expect(after.reopenedActor).toBe("human");
      expect(after.reopenedBy).toBe("attilio");
      expect(after.reopenedAt).not.toBeNull();
      expect(after.deliveryCommit).toBeNull();
    },
  );

  test("il rifiuto in review lascia lo stesso segno: è la quarta uscita umana", () => {
    const id = inReviewConConsegna("rifiutata");
    // Un commento umano su una card in review arriva qui come reject-con-testo
    // (routes/tasks.ts): è LA porta da cui è passato Attilio alle 18:25.
    const rejected = s.reviewDecision({ taskId: id, by: "attilio", decision: "reject", comment: "cambia rotta" });
    expect(rejected.status).toBe("in_progress");

    const after = s.get(id)!.task;
    expect(after.reopenedActor).toBe("human");
    expect(after.reopenedBy).toBe("attilio");
    expect(after.deliveryCommit).toBeNull();
    expect(after.landingState).toBeNull();
  });

  test("uscire da review non spegne un done_actor che quel salto non tocca", () => {
    // `done_actor` racconta chi ha CHIUSO. Una card in review non ne ha uno, e
    // azzerarlo da qui riscriverebbe una decisione presa da un'altra parte.
    const id = doneByHuman();
    expect(s.get(id)!.task.doneActor).toBe("human");
    s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "review" } });
    expect(s.get(id)!.task.doneActor).toBeNull(); // uscita da done: quello sì

    s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "done" } });
    s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "review" } });
    db.run("UPDATE tasks SET done_actor = 'human' WHERE id = ?", [id]);
    s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(s.get(id)!.task.doneActor).toBe("human"); // review → todo non lo tocca
  });

  test("consegnare di nuovo chiude il ciclo: rientrare in review spegne il segno", () => {
    const id = inReviewConConsegna("riconsegnata");
    s.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "in_progress" } });
    expect(s.get(id)!.task.reopenedActor).toBe("human");

    s.addComment({ taskId: id, author: "claude", content: "rifatto" });
    s.update({ taskId: id, actor: "agent", by: "claude", patch: { status: "review" } });
    // Il rientro non riaccende il segno su sé stesso…
    expect(s.get(id)!.task.reopenedActor).toBe("human");
    s.reviewDecision({ taskId: id, by: "attilio", decision: "approve" });
    // …e l'approvazione lo spegne: il ciclo si è chiuso.
    expect(s.get(id)!.task.reopenedAt).toBeNull();
  });

  test("un rientro in coda deciso dalla MACCHINA non si firma «umano» e tiene la consegna", () => {
    // È l'altro errore, e costa quanto il primo: la chiusura automatica esiste
    // proprio per riconoscere il lavoro già atterrato quando una card rientra da
    // sola (orfana rilasciata). Cancellarle il commit sotto le mani la
    // spegnerebbe su tutte le strade della macchina.
    const id = inReviewConConsegna("orfana rilasciata");
    s.release({ taskId: id, requeue: true, reason: "server ripartito", by: "dispatcher" });
    const after = s.get(id)!.task;
    expect(after.status).toBe("todo");
    expect(after.reopenedActor).toBe("system");
    expect(after.deliveryCommit).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L'ATTESA DICHIARATA HA UN CONTATORE SUO
//
// Il guasto che questi test chiudono: `wait_for_condition` restituiva lo slot ma
// NON il tentativo, che la claim si era già preso prima che l'agent potesse
// sapere di dover aspettare. Con `dispatch_retry_cap` a 2 si potevano dichiarare
// due attese, e alla terza il task non veniva più reclamato: la spazzata dei
// tentativi esauriti lo parcheggiava `failed`, «guarda cosa lo fa fallire», per
// un'attesa deliberata e corretta (card e285d5d8 sulla board quadra, due volte
// in un giorno).
// ─────────────────────────────────────────────────────────────────────────────
describe("attesa dichiarata: rimborso del tentativo e contatore separato", () => {
  let db: Database; let s: TaskService;
  const T0 = Date.parse("2026-08-12T09:00:00.000Z");
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  /** Il tetto dei tentativi VERO della board (default 2): è quello che mordeva. */
  const CAP = 2;
  /** Un giro completo: la claim spende il tentativo, poi l'agent dichiara l'attesa. */
  const attende = (id: string, reason: string, minutes = 15) => {
    const claimed = s.claim({ taskId: id, cap: 5, maxAttempts: CAP });
    expect(claimed).not.toBeNull();
    return s.deferForWait({ taskId: id, reason, minutes, by: "claude" });
  };
  /** Il tempo passa oltre la finestra, così la claim successiva è ammessa. */
  const passa = (minuti: number) => { clock.t += minuti * 60_000; };

  test("il tentativo speso dalla claim torna indietro: `dispatch_attempts` com'era prima", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    const claimed = s.claim({ taskId: t.id, cap: 5, maxAttempts: CAP })!;
    expect(claimed.dispatchAttempts).toBe(1); // la claim l'ha già speso

    const atteso = s.deferForWait({ taskId: t.id, reason: "la CI sta girando", minutes: 15, by: "claude" });
    expect(atteso.dispatchAttempts).toBe(0);  // rimborsato
    expect(atteso.status).toBe("todo");
    expect(atteso.dispatchState).toBe("waiting");
    expect(atteso.waitStreak).toBe(1);        // contata sulla SUA grandezza
    expect(atteso.waitSince).not.toBeNull();
  });

  test("con cap 2 anche la QUINTA attesa è ancora reclamabile: era qui che la card veniva accusata", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    for (let i = 1; i <= 5; i++) {
      // Col vecchio codice la claim numero 3 tornava `null` (attempts 2 >= cap)
      // e il task restava fermo finché la spazzata non lo dava per fallito.
      const atteso = attende(t.id, "la CI sta girando");
      expect(atteso.status).toBe("todo");
      expect(atteso.waitStreak).toBe(i);
      passa(16);
    }
    const finale = s.get(t.id)!.task;
    expect(finale.dispatchAttempts).toBe(0);
    expect(finale.dispatchState).toBe("waiting");
    expect(finale.dispatchState).not.toBe("failed");
  });

  test("la serie è per RAGIONE: una condizione diversa la fa ricominciare da uno", () => {
    const t = s.create({ projectId: PID, text: "aspetta", status: "todo" });
    attende(t.id, "la CI sta girando"); passa(16);
    const due = attende(t.id, "  LA CI   STA GIRANDO "); // stessa cosa, riscritta a mano
    expect(due.waitStreak).toBe(2);                      // normalizzata: la serie continua
    const inizioSerie = due.waitSince;
    passa(16);

    const altra = attende(t.id, "aspetto la risposta di Attilio");
    expect(altra.waitStreak).toBe(1);                    // altra condizione, altra serie
    expect(altra.waitSince).not.toBe(inizioSerie);
  });

  test("alla soglia il task si ferma, ma col chip `waited_out` e senza la parola «fallito»", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    for (let i = 0; i < WAIT_STREAK_CAP; i++) {
      expect(attende(t.id, "la CI sta girando").status).toBe("todo");
      passa(16);
    }
    const parked = attende(t.id, "la CI sta girando"); // la prima oltre il tetto

    expect(parked.status).toBe("backlog");
    expect(parked.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(parked.dispatchState).not.toBe("failed");
    expect(parked.dispatchDeferredUntil).toBeNull();    // non riparte da solo
    expect(parked.dispatchAttempts).toBe(0);            // rimborsato anche qui
    expect(parked.waitStreak).toBe(WAIT_STREAK_CAP + 1);

    // Il testo: dice quante attese, per cosa, e di chi è la decisione. NON dice
    // «fallito» — nemmeno negato, che sarebbe lo stesso nominarlo.
    const nota = parked.dispatchError ?? "";
    expect(nota).toContain(`${WAIT_STREAK_CAP + 1} attese di fila`);
    expect(nota).toContain("la CI sta girando");
    expect(nota).toContain("la decisione torna a te");
    expect(nota).toContain("Rimetti il task in Todo");
    expect(nota.toLowerCase()).not.toContain("fallit");
    // E la stessa riga è nel thread, non solo nel tooltip.
    expect(s.get(t.id)!.comments.map((c) => c.content).join("\n")).toContain("la decisione torna a te");
  });

  test("l'altro tetto è l'OROLOGIO: due attese lunghissime fermano il task quanto sette corte", () => {
    const t = s.create({ projectId: PID, text: "aspetta la finestra notturna", status: "todo" });
    const una = attende(t.id, "la finestra notturna", 1440);
    expect(una.status).toBe("todo");
    expect(una.waitStreak).toBe(1);

    passa(1441); // la finestra di 24h passa, e con essa il tetto sulla durata
    const parked = attende(t.id, "la finestra notturna", 1440);
    expect(parked.status).toBe("backlog");
    expect(parked.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(parked.waitStreak).toBe(2);                          // due sole attese
    expect(parked.waitStreak).toBeLessThan(WAIT_STREAK_CAP);    // il conteggio non c'entra
    expect(WAIT_SERIES_MAX_MS).toBeLessThan(1441 * 60_000);     // è stato il tempo
    expect(parked.dispatchError ?? "").toContain("ore");
  });

  test("il rientro in Todo dell'umano chiude la serie: il bottone rimette in coda davvero", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    for (let i = 0; i <= WAIT_STREAK_CAP; i++) { attende(t.id, "la CI sta girando"); passa(16); }
    expect(s.get(t.id)!.task.status).toBe("backlog");

    const back = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(back.waitStreak).toBe(0);
    expect(back.waitReason).toBeNull();
    expect(back.waitSince).toBeNull();
    expect(back.dispatchAttempts).toBe(0);

    // Senza l'azzeramento questa ripartirebbe già oltre il tetto e si
    // riparcheggerebbe subito: il bottone non rimetterebbe in coda niente.
    const di_nuovo = attende(t.id, "la CI sta girando");
    expect(di_nuovo.status).toBe("todo");
    expect(di_nuovo.waitStreak).toBe(1);
  });

  test("anche la consegna chiude la serie: le attese di prima non si portano dietro", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    attende(t.id, "la CI sta girando"); passa(16);
    attende(t.id, "la CI sta girando");
    expect(s.get(t.id)!.task.waitStreak).toBe(2);

    const consegnato = s.deliverToReviewBySystem({ taskId: t.id, reason: "tempo scaduto", cause: "retries_exhausted" });
    expect(consegnato.status).toBe("review");
    expect(consegnato.waitStreak).toBe(0);
    expect(consegnato.waitReason).toBeNull();
    expect(consegnato.waitSince).toBeNull();
  });

  test("un turno che muore DAVVERO consuma ancora il tentativo: il rimborso è solo dell'attesa", () => {
    const t = s.create({ projectId: PID, text: "questo esplode", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: CAP });
    s.release({ taskId: t.id, requeue: true, reason: "timeout del turno", by: "dispatcher" });

    const dopo = s.get(t.id)!.task;
    expect(dopo.dispatchAttempts).toBe(1);  // NON rimborsato: qui il freno serve
    expect(dopo.waitStreak).toBe(0);        // e non era un'attesa
    expect(dopo.waitSince).toBeNull();
  });
});

/**
 * IL COSTO DI UNA LISTA, MISURATO IN STATEMENT E IN BYTE.
 *
 * Misurato il 15/08 su `GET /api/all-boards/tasks` contro il database vivo
 * (2.135 task, 651 MB): 467 radici, 1.435.735 byte, 145 ms. Il mappatore faceva
 * da 4 a 7 query PER RIGA — etichette, bloccante, topic, dipendenti, stato del
 * padre, e per ogni card in `todo` due COUNT correlati sull'intera coda — cioè
 * O(N) statement più O(Q²) scansioni: ~1.500 statement per una lista sola.
 *
 * Due cancelli, e sono su due grandezze diverse apposta. Il primo conta gli
 * STATEMENT: è la forma del guasto (per riga invece che per lotto), e va rosso
 * il giorno in cui qualcuno rimette una lettura dentro il ciclo, qualunque sia
 * la sua durata su questa macchina. Il secondo conta i BYTE per task: è il
 * grasso nuovo, quello che nessun invariante conosce ancora.
 */
describe("il costo di una lista non cresce con le righe", () => {
  /**
   * Conta le COMPILAZIONI, non le esecuzioni. È la grandezza giusta: una query
   * dentro il ciclo si vede qui anche quando SQLite se la cava in un
   * microsecondo, mentre un tempo misurato su questa macchina direbbe cose
   * diverse su un'altra.
   *
   * Si intercetta `prepare` e BASTA: in `bun:sqlite` è `db.query` a chiamarlo
   * (e a tenersi il risultato in cache per la stessa SQL), quindi contare
   * entrambi conterebbe due volte ogni `query` e nasconderebbe proprio il
   * risparmio della cache.
   */
  function countStatements<T>(db: Database, run: () => T): { n: number; out: T } {
    const raw = db.prepare.bind(db);
    let n = 0;
    (db as unknown as { prepare: unknown }).prepare =
      (...a: unknown[]) => { n++; return (raw as unknown as (...x: unknown[]) => unknown)(...a); };
    try {
      const out = run();
      return { n, out };
    } finally {
      (db as unknown as { prepare: unknown }).prepare = raw;
    }
  }

  /** 300 righe, 100 delle quali radici in coda: la forma del feed vero. */
  function seed(db: Database, opts: { description?: string; rows?: number } = {}): void {
    const totale = opts.rows ?? 300;
    const ins = db.prepare(
      `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, created_at, updated_at, checks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const checks = JSON.stringify([
      { name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 4210, timedOut: false, tail: "x".repeat(600) },
    ]);
    for (let i = 0; i < totale; i++) {
      const status = i < totale / 3 ? "todo" : i < (2 * totale) / 3 ? "review" : "done";
      ins.run(
        `t-${i}`, `board-${i % 5}`, `task numero ${i}`, opts.description ?? null,
        status, i % 5, i, `2026-08-${String((i % 27) + 1).padStart(2, "0")}T10:00:00.000Z`,
        "2026-08-15T10:00:00.000Z", checks,
      );
    }
  }

  test("300 task, 100 in coda: una lista sta sotto i 25 statement (ne faceva ~1500)", () => {
    const db = freshDb();
    const s = svc(db);
    seed(db);
    const { n, out } = countStatements(db, () => s.list({ scope: "all", rootsOnly: true }));
    expect(out.length).toBe(300);
    expect(n).toBeLessThan(25);
  });

  test("e non cresce: dieci volte le righe, lo STESSO numero di statement", () => {
    // La controprova che rende il numero sopra un INVARIANTE e non una soglia
    // calibrata: stessa forma, dieci volte le righe. Se una lettura tornasse
    // dentro il ciclo questo conto si moltiplicherebbe, anche lasciando il primo
    // cancello verde su una board piccola.
    const piccolo = freshDb(); seed(piccolo, { rows: 30 });
    const grande = freshDb(); seed(grande, { rows: 300 });
    const a = countStatements(piccolo, () => svc(piccolo).list({ scope: "all", rootsOnly: true })).n;
    const b = countStatements(grande, () => svc(grande).list({ scope: "all", rootsOnly: true })).n;
    expect(b).toBe(a);
  });

  /**
   * IL BUDGET IN BYTE, e il numero non è quello che sembrava.
   *
   * La descrizione da 2.500 caratteri è la coda misurata sul database vivo
   * (massimo 5.140 byte, 470 KB sul feed); i `checks` sono l'altra metà del
   * grasso (217 KB). Nessuno dei due viaggia nella proiezione magra.
   *
   * Il tetto è 1.700 e non 700 perché 700 sta SOTTO IL PAVIMENTO: un task con
   * ogni campo a null pesa già ~1.500 byte, che sono i nomi delle chiavi e i
   * loro `null`. Il tetto è salito da 1.600 il 16/08, quando le tre colonne
   * dell'entità della consegna (`deliveryFilesChanged`/`Insertions`/`Deletions`,
   * migration 20260816174500) hanno aggiunto ~53 byte per task: misurato 1.653.
   * Alzarlo è legittimo SOLO perché il pavimento è cresciuto per una ragione
   * dichiarata — tre campi che la card in review disegna — e non perché il
   * payload si è ingrassato di nascosto. La controprova sotto, che è la parte
   * che non si ricalibra, resta identica. Restano poi due campi che non sono grasso ma contenuto —
   * l'anteprima (263 byte, ed è ciò che la card disegna) e `queueReason`
   * (242 byte, la frase che dice perché la card non parte). Sotto i 700 non ci
   * si arriva accorciando: ci si arriva togliendo chiavi, che è un altro
   * cambio, con un altro client da avvisare.
   *
   * La CONTROPROVA sotto è la parte che non si può ricalibrare: il payload
   * magro non deve contenere né la descrizione intera né la coda dell'output
   * dei check, e quella condizione va rossa il giorno in cui uno dei due torna,
   * qualunque soglia si scriva sopra.
   */
  test("proiezione magra: sotto i 1700 byte per task, con descrizioni da 2500 caratteri", () => {
    const db = freshDb();
    const s = svc(db);
    seed(db, { description: "d".repeat(2500) });
    const magra = s.list({ scope: "all", rootsOnly: true });
    expect(magra.length).toBe(300);
    const testo = JSON.stringify({ tasks: magra });
    expect(testo.length / magra.length).toBeLessThan(1700);
    // Strutturale: i due pesi che questo cambio toglie non sono nel payload.
    expect(testo).not.toContain("d".repeat(300));  // la descrizione intera
    expect(testo).not.toContain("x".repeat(300));  // la coda dei check
    // E il confronto con la proiezione di prima, che li portava entrambi.
    // `withDescription` è l'interruttore che resta acceso per le due letture
    // che il testo intero lo LEGGONO (proposta di collegamento, lista di un
    // agente): la lista che disegna card non lo accende mai.
    const grassa = s.list({ scope: "all", rootsOnly: true, withDescription: true });
    expect(JSON.stringify({ tasks: grassa }).length / grassa.length).toBeGreaterThan(2500);
  });

  test("la lista porta l'anteprima della descrizione, il dettaglio la porta intera", () => {
    const db = freshDb();
    const s = svc(db);
    seed(db, { description: "d".repeat(2500) });
    const [primo] = s.list({ scope: "all", rootsOnly: true });
    expect(primo!.descriptionPreview!.length).toBe(240);
    expect(primo!.checks).toBeNull();          // fuori dalla proiezione della lista
    const dettaglio = s.get(primo!.id)!.task;
    expect(dettaglio.description!.length).toBe(2500);
    expect(dettaglio.checks!.length).toBe(1);  // il dettaglio li porta
  });
});

describe("la lista: filtro per id, stato validato, commenti sulla card", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  /**
   * IL PREDICATO DI AUTORIZZAZIONE ARRIVA FINO A SQL.
   *
   * Il feed dell'ospite idratava OGNI task del database — etichette, bloccante,
   * ragione di coda, commenti — per poi tenere in JS i due condivisi con lui.
   * Pagava l'intera board per rispondere «due card».
   */
  test("`ids` taglia in SQL, e l'insieme VUOTO vale «nessuna riga»", () => {
    const a = s.create({ projectId: PID, text: "condivisa" });
    s.create({ projectId: PID, text: "privata" });

    expect(s.list({ scope: "all", rootsOnly: true, ids: [a.id] }).map((t) => t.text)).toEqual(["condivisa"]);
    // Vuoto = niente, non «nessun filtro»: sbagliare qui vorrebbe dire mostrare
    // a un ospite l'intera board.
    expect(s.list({ scope: "all", rootsOnly: true, ids: [] })).toEqual([]);
    // E si compone con gli altri tagli invece di sostituirli.
    expect(s.list({ scope: "all", rootsOnly: true, status: "done", ids: [a.id] })).toEqual([]);
  });

  /**
   * UNO STATO CHE NON ESISTE È UN ERRORE, NON UNA BOARD VUOTA. Il filtro
   * arrivava dal query string con un `as any` e finiva in `WHERE status = ?`,
   * dove non matcha niente: 200 con zero card, cioè una risposta perfettamente
   * plausibile sopra un refuso.
   */
  test("uno stato inesistente è invalid_input, non una lista vuota", () => {
    s.create({ projectId: PID, text: "c'è" });
    expect(() => s.list({ scope: "all", status: "in-progress" as never }))
      .toThrow(TaskServiceError);
    expect(s.list({ scope: "all", status: "backlog" }).length).toBe(1); // il caso buono resta
  });

  /**
   * I COMMENTI DELLA CARD VIAGGIANO CON LA LISTA. Senza, la board apriva un
   * `GET /api/tasks/:id` per ogni card in review solo per leggere il fondo del
   * thread — e quel dettaglio carica l'INTERO thread.
   */
  test("recentComments: gli ultimi tre PARLATI, senza cronologia né contabilità", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    for (const n of [1, 2, 3, 4]) s.addComment({ taskId: t.id, author: "claude", content: `parola ${n}` });
    // `status` (transizioni) e `service` (contabilità del dispatcher) non sono
    // le parole di nessuno: stesso taglio di `isThreadSpeech`.
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { priority: 1 } });
    s.addComment({ taskId: t.id, author: "system", kind: "service", content: "in coda" });

    const [card] = s.list({ scope: "all", rootsOnly: true });
    expect(card!.recentComments.map((c) => c.content)).toEqual(["parola 2", "parola 3", "parola 4"]);
    // E su OGNI payload, anche su quelli che le scritture ribaltano sul WS: un
    // campo riempito solo in lettura si spegnerebbe al primo giro di WS.
    const dopoScrittura = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { priority: 3 } });
    expect(dopoScrittura.recentComments.map((c) => c.content)).toEqual(["parola 2", "parola 3", "parola 4"]);
  });

  /**
   * I COMMENTI VIAGGIANO SOLO DOVE LA CARD LI DISEGNA.
   *
   * Misurato il 15/08 su `GET /api/all-boards/tasks`: 731 KB di commenti
   * attaccati a 455 schede su 467, per le 11 in review che li leggono. Il
   * predicato è lo stesso del client (`showsCardThread`), e il verso conta:
   * allargarlo qui è peso che non serve, stringerlo è una card muta.
   */
  test("fuori dalla review i commenti non partono, e tornano appena la card ci entra", () => {
    const t = s.create({ projectId: PID, text: "work", status: "todo" });
    s.addComment({ taskId: t.id, author: "claude", content: "una parola" });

    const inCoda = s.list({ scope: "all", rootsOnly: true })[0]!;
    expect(inCoda.recentComments).toEqual([]);
    // Il thread c'è, ed è il dettaglio a portarlo: la lista non lo nasconde,
    // semplicemente non è lei a doverlo spedire.
    expect(s.get(t.id)!.comments.map((c) => c.content)).toContain("una parola");

    // Entrare in review fa scrivere al servizio la sua nota di evidenza: la
    // parola dell'agente è quella davanti, e la nota è la coda del thread.
    const inReview = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "review" } });
    expect(inReview.recentComments.map((c) => c.content)).toContain("una parola");
  });

  /**
   * IL TESTO È TAGLIATO, MA NON DENTRO UNA ```question.
   *
   * Il blocco domanda non è prosa: la card ne ricava i bottoni di risposta
   * rapida. Tagliato a metà `parseQuestionBlock` torna `null` e la card perde i
   * bottoni stampando il recinto grezzo, senza che niente diventi rosso.
   */
  test("il contenuto viaggia tagliato, e i tre campi sono quelli che la card legge", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    s.addComment({ taskId: t.id, author: "user", content: `chiedo: ${"x".repeat(3000)}` });
    s.addComment({ taskId: t.id, author: "claude", content: `rispondo: ${"y".repeat(3000)}` });

    const [card] = s.list({ scope: "all", rootsOnly: true });
    const [contesto, ultima] = card!.recentComments;
    // L'ultima parola la card la stampa intera: 1.200 caratteri. Quelle prima
    // stanno in una riga sola già tagliata dal CSS: 200 bastano.
    expect(ultima!.content.length).toBe(1201);
    expect(contesto!.content.length).toBe(201);
    expect(Object.keys(ultima!).sort()).toEqual(["author", "content", "kind"]);
  });

  test("una ```question più lunga del tetto viaggia INTERA: i bottoni sopravvivono", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    const domanda = `Ho finito.\n${"prosa lunga. ".repeat(90)}\n\`\`\`question\nChe faccio?\n- Vai\n- Fermati\n\`\`\`\ncoda`;
    expect(domanda.length).toBeGreaterThan(1200);
    s.addComment({ taskId: t.id, author: "claude", content: domanda });

    const [card] = s.list({ scope: "all", rootsOnly: true });
    const testo = card!.recentComments[0]!.content;
    expect(testo).toContain("```question");
    expect(testo).toContain("- Fermati");
    // Il recinto è chiuso: è la condizione che `parseQuestionBlock` chiede.
    expect(testo.split("```").length - 1).toBe(2);
    // E il taglio c'è comunque: la coda dopo il recinto non viaggia.
    expect(testo).not.toContain("coda");
  });
});

/**
 * IL LOTTO DEVE DIRE ESATTAMENTE CIÒ CHE DICEVA LA RIGA-PER-RIGA.
 *
 * Il rischio di questo cambio non è la lentezza, è il SILENZIO: una query di
 * lotto che dimentica una colonna, o una `JOIN` che perde la riga senza legame,
 * non fa fallire niente — spegne un campo su una card, e chi la guarda pensa
 * che il dato non ci sia. Nessuno dei test sopra lo vedrebbe: guardano un campo
 * alla volta, quindi coprono i campi a cui qualcuno ha già pensato.
 *
 * Qui il confronto è STRUTTURALE, chiave per chiave, fra le due porte che il
 * lotto ha separato: `list` (proiezione + mappatore a lotti) e `get`
 * (`SELECT *` + lotto da una riga). L'unica differenza ammessa è dichiarata e
 * pinzata sotto: `checks`, che la lista non porta apposta.
 */
describe("la lista e il dettaglio dicono la stessa cosa, campo per campo", () => {
  /** Il valore che ogni colonna nullable riceve, per tipo: vedi `tuttoPieno`. */
  const TS = "2026-07-09T09:00:00.000Z";

  /**
   * Un task con OGNI colonna di `tasks` valorizzata, più tutto ciò che il
   * mappatore va a cercare FUORI dalla riga: etichette, bloccante, topic,
   * padre, un figlio aperto, dipendenti e commenti.
   *
   * `dispatch_deferred_until` è nel PASSATO di proposito: sul futuro la ragione
   * di coda porta i minuti che mancano, arrotondati, e le due letture avvengono
   * a due istanti diversi — un confronto che fallisce una volta su ventimila
   * non è un cancello, è un rumore.
   */
  function tuttoPieno(db: Database, s: TaskService): { id: string; altri: string[] } {
    db.run("INSERT INTO topics (id, effort) VALUES ('top-1', 'xhigh')");
    db.run("INSERT INTO agent_profiles (id) VALUES ('ap-1')");
    const bloccante = s.create({ projectId: PID, text: "prima questo" });
    const padre = s.create({ projectId: PID, text: "il padre" });
    const t = s.create({ projectId: PID, text: "tutto pieno", parentTaskId: padre.id });
    const passo = s.create({ projectId: PID, text: "un passo ancora aperto", parentTaskId: t.id });
    // Una radice in coda: è l'unica forma per cui la ragione di coda calcola la
    // FILA, cioè il ramo che il lotto ha riscritto con la ricerca binaria.
    const inCoda = s.create({ projectId: PID, text: "in coda", status: "todo" });
    // Un dipendente vivo, così `waitingOnCount` non è zero da entrambe le parti.
    const dipendente = s.create({ projectId: PID, text: "aspetta il pieno" });
    db.run("UPDATE tasks SET blocked_by_task_id = ? WHERE id = ?", [t.id, dipendente.id]);
    for (const label of ["visibile", "bugfix"]) {
      db.run("INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, 'human', ?)", [t.id, label, TS]);
    }
    s.addComment({ taskId: t.id, author: "user", content: "una parola" });
    s.addComment({ taskId: t.id, author: "claude", content: "un'altra parola" });

    db.run(
      `UPDATE tasks SET
         description = ?, status = 'review', priority = 3, kanban_order = 7,
         assigned_to = 'il-reviewer', fingerprint = 'fp-1', due_date = ?, chat_id = 'chat-1',
         created_at = ?, completed_at = ?, updated_at = ?, assigned_agent_id = 'ap-1',
         in_progress_at = ?, archived = 0, assigned_topic_id = 'top-1', claude_task_id = 'ct-1',
         dispatch_attempts = 2, dispatch_state = 'working', dispatch_error = 'un errore',
         output_url = 'https://example.invalid/x', plan_first = 1, agent_ms = 1234,
         agent_tokens = 5678, model = 'claude-opus-5', blocked_by_task_id = ?,
         reuse_blocker_context = 1, priority_auto = 0, agent_cache_read_tokens = 90,
         preview_image = '/tmp/x.png', dispatch_deferred_until = ?, delivery_branch = 'topics/x',
         delivery_commit = 'abc1234', landing_state = 'landed', landing_checked_at = ?,
         checks_state = 'green', checks_at = ?, checks_commit = 'abc1234', checks_json = ?,
         delivered_by = 'claude', delivered_reason = 'finito', dispatch_weight = 'heavy',
         created_by_topic_id = 'top-1', plan_comment_id = 'id-9', done_actor = 'human',
         reopened_at = ?, reopened_by = 'il-reviewer', reopened_actor = 'human',
         landing_witnessed = 1, wait_streak = 2, wait_reason = 'aspetto il gate',
         wait_since = ?, preview_retired_at = ?, preview_retired_reason = 'sostituita',
         interrupt_claimed_at = ?,
         -- L'entita' della consegna (migration 20260816174500). Il cancello
         -- sotto ha preso questa dimenticanza da solo, che e' il motivo per cui
         -- esiste: senza, lista e dettaglio avrebbero potuto divergere sui tre
         -- campi nuovi senza che nessuno se ne accorgesse.
         -- (Niente backtick nei commenti SQL: questo DDL vive in un template
         -- literal e un backtick apre un'interpolazione JS. Seconda volta oggi.)
         delivery_files_changed = 7, delivery_insertions = 120, delivery_deletions = 30
       WHERE id = ?`,
      [
        // UNA DESCRIZIONE CON CARATTERI FUORI DAL PIANO BASE. `substr` di SQLite
        // conta CARATTERI, `String.slice` conta unità UTF-16: su un'emoji le due
        // porte tagliavano in due punti diversi, ed è esattamente la forma di
        // divergenza che questo confronto esiste per prendere.
        `🎯${"d".repeat(400)}`,
        TS, TS, TS, TS, TS, bloccante.id, "2020-01-01T00:00:00.000Z",
        TS, TS, JSON.stringify([{ name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 10, timedOut: false, tail: "ok" }]),
        TS, TS, TS, TS, t.id,
      ],
    );
    return { id: t.id, altri: [padre.id, passo.id, bloccante.id, inCoda.id, dipendente.id] };
  }

  test("nessuna colonna resta a NULL: «tutti i campi» è verificato, non promesso", () => {
    const db = freshDb();
    const { id } = tuttoPieno(db, svc(db));
    const riga = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
    // Una colonna aggiunta domani entra in questo cancello da sola: se la
    // migration non la valorizza qui, il confronto sotto non la copre e questo
    // test lo dice invece di passare in silenzio.
    expect(Object.entries(riga).filter(([, v]) => v === null).map(([k]) => k)).toEqual([]);
  });

  test("list() e get() concordano su OGNI chiave, tranne le due dichiarate", () => {
    const db = freshDb();
    const s = svc(db);
    const { id, altri } = tuttoPieno(db, s);
    const listati = new Map(s.list({ scope: "all" }).map((x) => [x.id, x]));

    for (const each of [id, ...altri]) {
      const dallaLista = listati.get(each);
      const dalDettaglio = s.get(each)?.task;
      expect(dallaLista).toBeDefined();
      expect(dalDettaglio).toBeDefined();
      // `checks` e `description` fuori dal confronto e pinzate a parte: sono le
      // DUE differenze volute fra le due porte, quindi vanno nominate invece
      // che tollerate. Tutto il resto deve coincidere, campo per campo.
      const senzaGrasso = { checks: null, description: null };
      expect({ ...dallaLista!, ...senzaGrasso }).toEqual({ ...dalDettaglio!, ...senzaGrasso });
    }

    expect(listati.get(id)!.checks).toBeNull();          // la lista non li porta
    expect(s.get(id)!.task.checks!.length).toBe(1);      // il dettaglio sì
    // La descrizione: sulla lista solo l'anteprima, sul dettaglio il testo.
    expect(listati.get(id)!.description).toBeNull();
    expect(listati.get(id)!.descriptionPreview).toBe(s.get(id)!.task.descriptionPreview);
    expect(s.get(id)!.task.description!.length).toBe(402); // 400 «d» + l'emoji, che sono due unità UTF-16
    // E la prova che il confronto ha davvero guardato dei valori, non due
    // oggetti vuoti che si somigliano.
    expect(listati.get(id)!.labels.map((l) => l.label)).toEqual(["bugfix", "visibile"]);
    expect(listati.get(id)!.blockedBy?.text).toBe("prima questo");
    expect(listati.get(id)!.waitingOnCount).toBe(1);
    expect(listati.get(id)!.recentComments.length).toBe(2);
    expect(listati.get(id)!.effort).toBe("xhigh");
    expect(listati.get(id)!.model).toBe("claude-opus-5");
  });
});
