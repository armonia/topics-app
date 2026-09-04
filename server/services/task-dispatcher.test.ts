/**
 * @covers KANBAN-10
 *
 * Dispatch resumption after a server restart: this file and
 * task-dispatcher-interrupted.test.ts are where that requirement is exercised.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitIsIn } from "./own-commits";
import { commitStatusFromRepo } from "./branch-status";
import { classifyLanding } from "./landing-audit";
import { PARKED_WAITED_OUT, PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL, PREVIEW_CARD_MAX_RATIO, PREVIEW_RULE, WAIT_STREAK_CAP, extractPreviewRule, formatStatusEvent } from "../../shared/board";
import { toolsForProfile } from "../mcp/topics-mcp-server";
import { createTaskService, LAND_ACTION_LABEL, type TaskService } from "./tasks";
import { createTaskDispatcher, rotateFrom, summarizeToolInput, type DispatcherDeps } from "./task-dispatcher";
import { cancelled, type TurnEndInfo, describeTurnEnd } from "../providers/stop-reason";
import { beginAsk, endAsk } from "../lib/ask-user-bridge";
import { beginPermission, endPermission } from "../lib/permission-bridge";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";
import { gitEnv } from "../../tests/setup/bun-test-preload";

// Lo schema di `tasks` arriva da TASKS_DDL: è la catena delle migration, e una
// colonna nuova non fa più rosso QUI alla fusione. PRAGMA foreign_keys e la FK
// su assigned_topic_id sono fedeli alla produzione apposta: il guasto del
// segnaposto "pending:<taskId>" si riproduceva solo con le FK accese, e con le
// FK accese la tabella-genitore deve esistere (TASKS_FK_STUBS_DDL).
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    -- I comandi che l'envelope nomina alla consegna. Senza questa colonna il
    -- ramo dei check del kickoff non era raggiungibile da qui, cioe' proprio
    -- le righe che nessun test leggeva.
    review_checks TEXT,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    -- Il freno di QUESTA board (migration 20260816142059): senza la colonna il
    -- ramo che la legge non e' raggiungibile da qui.
    dispatch_paused INTEGER NOT NULL DEFAULT 0
  )`);
  // I tentativi in parallelo: servono al fan-out, che è l'unico posto in cui
  // DUE sessioni vive convivono sullo stesso task.
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

const PID = "alpha-abc123";

let seq = 0;
function seedTask(
  db: Database,
  o: { id?: string; status?: string; attempts?: number; assignedTopicId?: string | null; dispatchState?: string | null; createdAt?: string; parentTaskId?: string | null; text?: string; deliveryBranch?: string | null; deliveryCommit?: string | null } = {},
): string {
  const id = o.id ?? `t${++seq}`;
  const ts = o.createdAt ?? new Date(Date.now() + seq).toISOString();
  // FK: a seeded binding needs its topics row, like in prod.
  if (o.assignedTopicId) db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [o.assignedTopicId]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, assigned_topic_id, dispatch_state, parent_task_id, delivery_branch, delivery_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, PID, o.text ?? ("task " + id), o.status ?? "todo", ts, ts, o.attempts ?? 0, o.assignedTopicId ?? null, o.dispatchState ?? null, o.parentTaskId ?? null, o.deliveryBranch ?? null, o.deliveryCommit ?? null],
  );
  return id;
}

/** A controllable harness: real service, fake host side-effects, manual turn control. */
function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const events: any[] = [];
  const worktreesCreated: string[] = [];
  const topicsCreated: { name: string; projectPath: string; worktreeId?: string; effort?: string; model?: string; standalone?: boolean }[] = [];
  const turns: { sessionKey: string; content: string; contextMode?: "full" | "lean"; timeoutMs?: number; idleMs?: number }[] = [];
  let resolveTurn: ((info?: TurnEndInfo) => void) | null = null;
  let rejectTurn: ((e: unknown) => void) | null = null;

  const deps: DispatcherDeps = {
    svc,
    // Lo store dei tentativi c'è sempre: senza, il fan-out non è nemmeno
    // raggiungibile da un test, ed è l'unico posto in cui due sessioni vive
    // convivono su un task.
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: (opts) => {
      topicsCreated.push({ name: opts.name, projectPath: opts.projectPath, worktreeId: opts.worktreeId, effort: opts.effort, model: opts.model, standalone: opts.standalone });
      const n = topicsCreated.length;
      // The real host persists the topic row; the FK on assigned_topic_id
      // requires it to exist before bindTopic().
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => { worktreesCreated.push(storeId); return `wt-${storeId}`; },
    runTurn: (sessionKey, content, opts) =>
      new Promise<TurnEndInfo | void>((res, rej) => {
        turns.push({ sessionKey, content, contextMode: opts?.contextMode, timeoutMs: opts?.timeoutMs, idleMs: opts?.idleMs });
        resolveTurn = res; rejectTurn = rej;
      }),
    broadcast: (m) => events.push(m),
    graceMs: 10,
    retryBackoffMs: 0, // instant harness turns must not wait out the outage backoff
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, events, worktreesCreated, topicsCreated, turns,
    /**
     * Un RIAVVIO del server: stesso DB, memoria nuova. Tutto ciò che vive solo
     * nel processo (turni in volo, timer, attese di uno slot) non c'è più —
     * ed è l'unica differenza che distingue un fantasma da un'attesa viva.
     */
    restart: () => { dispatcher.shutdown(); return createTaskDispatcher(deps); },
    finishTurn: () => { resolveTurn?.(); },
    /** Chiude il turno DICENDO perché è finito (0.4) — come fa il provider vero. */
    finishTurnWith: (info: TurnEndInfo) => { resolveTurn?.(info); },
    failTurn: (e: unknown) => { rejectTurn?.(e); },
    task: (id: string) => svc.get(id)?.task,
  };
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("task-dispatcher", () => {
  it("is a no-op when auto_dispatch is off", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("todo");
    expect(h.turns.length).toBe(0);
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("claims + launches a todo: worktree → topic → working chip → turn", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-1");      // rebound from placeholder → real topic
    expect(t.dispatchState).toBe("working");
    expect(t.dispatchAttempts).toBe(1);
    expect(h.worktreesCreated).toEqual(["store-1"]);
    expect(h.topicsCreated[0].worktreeId).toBe("wt-store-1");
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:sk1");
    expect(h.turns[0].content).toContain("exclusive owner of task");
    expect(h.dispatcher.isInFlight("t1")).toBe(true);
  });

  it("una domanda a META' TURNO porta il chip a needs_input, e il rilascio lo riporta a working", async () => {
    // Il buco piu' caro trovato dal confronto board/chat: `ask_user_question`
    // aperta mentre il turno e' vivo lasciava la card su `working`. La board
    // diceva «sto lavorando» sopra una sessione ferma su una persona.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const sk = h.turns[0].sessionKey;
    expect(h.task("t1")!.dispatchState).toBe("working");

    const awaiting = () => h.events.filter((e) => e.type === "task:awaiting-human");
    beginAsk(sk);
    await flush();
    expect(awaiting().at(-1)).toMatchObject({ taskId: "t1", waiting: true, source: "ask" });
    // E NON in DB: `needs_input` persistito farebbe uscire il task dalla porta
    // del recupero orfani (ACTIVE_DISPATCH_STATES), congelandolo dopo un riavvio.
    expect(h.task("t1")!.dispatchState).toBe("working");

    endAsk(sk);
    await flush();
    expect(awaiting().at(-1)).toMatchObject({ taskId: "t1", waiting: false });
    h.dispatcher.shutdown();
  });

  it("lo stesso vale per un PERMESSO, ed e' lo stesso chip", async () => {
    // Per chi guarda la board «domanda» e «permesso» sono lo stesso fatto:
    // il turno aspetta una persona. Un secondo vocabolario sarebbe rumore.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const sk = h.turns[0].sessionKey;

    const awaiting = () => h.events.filter((e) => e.type === "task:awaiting-human");
    beginPermission(sk, "tool-1");
    await flush();
    expect(awaiting().at(-1)).toMatchObject({ taskId: "t1", waiting: true, source: "permission" });
    expect(h.task("t1")!.dispatchState).toBe("working");

    endPermission(sk, "tool-1");
    await flush();
    expect(awaiting().at(-1)).toMatchObject({ taskId: "t1", waiting: false });
    h.dispatcher.shutdown();
  });

  it("dopo shutdown() il chip NON si muove piu': l'iscrizione e' la causa", async () => {
    // La controprova dei due test qui sopra. Senza, "il chip diventa
    // needs_input" potrebbe essere vero per un'altra ragione e i test
    // passerebbero comunque: qui si toglie l'unica causa possibile e si pretende
    // che l'effetto sparisca. Pinna anche l'unsubscribe di shutdown(), senza il
    // quale un dispatcher spento continuerebbe a scrivere su un DB non suo.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const sk = h.turns[0].sessionKey;
    expect(h.task("t1")!.dispatchState).toBe("working");

    h.dispatcher.shutdown();
    const before = h.events.filter((e) => e.type === "task:awaiting-human").length;
    beginAsk(sk);
    await flush();
    expect(h.events.filter((e) => e.type === "task:awaiting-human")).toHaveLength(before); // nessuno ascolta piu'
    endAsk(sk);
  });

  it("l'attesa di una sessione ESTRANEA non tocca nessun chip", async () => {
    // Le chat normali passano dalle stesse due porte: se il dispatcher
    // reagisse a tutte, una domanda in una chat qualunque muoverebbe la card
    // di un task che non c'entra niente.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    beginAsk("topic:una-chat-qualunque");
    await flush();
    expect(h.events.filter((e) => e.type === "task:awaiting-human")).toHaveLength(0);
    expect(h.task("t1")!.dispatchState).toBe("working");
    endAsk("topic:una-chat-qualunque");
    h.dispatcher.shutdown();
  });

  it("board su effort 'auto': lo sforzo lo sceglie il classificatore, task per task", async () => {
    // La leva piu' pesante che abbiamo: sullo stesso micro-task `medium` costa
    // 61,1k token di lavoro e `xhigh` 108,8k. Fissarla per tutta una board vuol
    // dire pagarla uguale su un typo e su un refactor.
    const h = harness({
      pickAutoModel: async () => ({ model: "claude-opus-5[1m]", effort: "xhigh" }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchEffort: "auto" });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated[0].effort).toBe("xhigh");
    expect(h.topicsCreated[0].model).toBe("claude-opus-5[1m]");
    h.dispatcher.shutdown();
  });

  it("board con un effort FISSATO: comanda la board, il classificatore non la scavalca", async () => {
    // Il controllo del test qui sopra: senza, un classificatore che risponde
    // sempre farebbe passare entrambi i casi e nessuno dei due proverebbe niente.
    const h = harness({
      pickAutoModel: async () => ({ model: "claude-opus-5[1m]", effort: "xhigh" }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchEffort: "high" });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated[0].effort).toBe("high");
    h.dispatcher.shutdown();
  });

  it("board su 'auto' ma giudice muto: resta medium, cioe' come stavano le cose", async () => {
    // `effort: null` significa «non lo so», e un «non lo so» non deve spostare
    // niente: si ricade su cio' che la board faceva prima che l'auto esistesse.
    const h = harness({
      pickAutoModel: async () => ({ model: "claude-opus-5[1m]", effort: null }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchEffort: "auto" });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated[0].effort).toBe("medium");
    h.dispatcher.shutdown();
  });

  it("self-heals a DEAD binding: a todo bound to a reaped topic dispatches again", async () => {
    // A task that ran before, reached done, then was dragged back to todo — its
    // agent topic was reaped in between, so `assigned_topic_id` now dangles.
    // Without the heal it would be skipped forever by the `!assignedTopicId`
    // eligibility filter and sit in todo with no chip.
    const h = harness({ topicExists: (id) => id !== "reaped-topic" });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo", assignedTopicId: "reaped-topic" });
    // Reap the topic row the way prod does — via a path that bypasses the FK
    // (the topics(id) FK on assigned_topic_id has no ON DELETE SET NULL, so a
    // normal delete is refused; the dangling binding is precisely what results).
    h.db.run("PRAGMA foreign_keys=OFF");
    h.db.run("DELETE FROM topics WHERE id = ?", ["reaped-topic"]);
    h.db.run("PRAGMA foreign_keys=ON");

    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");        // claimed, not stranded
    expect(t.assignedTopicId).toBe("topic-1");   // dead link cleared → rebound to a fresh topic
    expect(t.dispatchState).toBe("working");
    expect(h.turns.length).toBe(1);              // an agent turn actually started
  });

  it("leaves a todo bound to a LIVE topic untouched (no false heal)", async () => {
    // A live binding means a dispatch is already in flight for it — the heal
    // must not release it. topicExists returns true, so it stays as-is.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo", assignedTopicId: "live-topic", dispatchState: "working" });

    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task("t1")!;
    expect(t.assignedTopicId).toBe("live-topic"); // untouched
    expect(h.turns.length).toBe(0);               // never re-claimed
  });

  it("never claims a STEP as an independent task (todo subtask = checklist, not work item)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const parentId = seedTask(h.db, { id: "root1", status: "in_progress" });
    // A step sitting in todo (human dragged it, or created it there).
    const step = h.svc.create({ projectId: PID, text: "step", parentTaskId: parentId, status: "todo" });

    // Neither the enter-todo signal nor the poll may touch it.
    h.dispatcher.onEnterTodo(PID, step.id);
    await new Promise((r) => setTimeout(r, 30)); // past graceMs=10
    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task(step.id)!;
    expect(t.status).toBe("todo");
    expect(t.dispatchState).toBeNull(); // no stranded "queued" chip either
    expect(t.assignedTopicId).toBeNull();
    expect(h.turns.length).toBe(0);
  });

  it("agent-declared wait releases the slot → todo + waiting chip + note, never review", async () => {
    // VERIFICA: a task depending on a never-satisfied external condition must
    // return to the queue with a note within its window — NOT hang holding a
    // slot, NOT arrive in review as if delivered.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.dispatchState).toBe("working");
    expect(h.dispatcher.isInFlight("t1")).toBe(true);

    // The agent calls wait_for_condition mid-turn (route → dispatcher.deferWait).
    const deferred = h.dispatcher.deferWait("t1", "il servizio X è giù", 30);
    expect(deferred.status).toBe("todo");
    expect(deferred.dispatchState).toBe("waiting");
    expect(deferred.assignedTopicId).toBeNull();          // slot released
    expect(deferred.dispatchDeferredUntil).toBeTruthy();
    expect(Date.parse(deferred.dispatchDeferredUntil!)).toBeGreaterThan(Date.now());

    // The turn winds down: onTurnEnd must leave the waiting chip intact.
    h.finishTurn();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");
    expect(t.status).not.toBe("review");
    expect(t.dispatchState).toBe("waiting");
    expect(h.dispatcher.isInFlight("t1")).toBe(false);    // slot freed for others
    // The note explaining the wait is on the thread.
    const notes = h.svc.get("t1")!.comments.map((c) => c.content).join("\n");
    expect(notes).toContain("il servizio X è giù");
  });

  it("a deferred waiting task is NOT re-claimed until its window elapses, then re-dispatches", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.dispatcher.deferWait("t1", "carico alto", 30);
    h.finishTurn();
    await flush();
    const turnsAfterWait = h.turns.length;

    // Window still open → tick must skip it (no claim, no new turn).
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("todo");
    expect(h.turns.length).toBe(turnsAfterWait);

    // Fast-forward past the window → tick re-dispatches on a FRESH topic.
    h.db.run("UPDATE tasks SET dispatch_deferred_until = ? WHERE id = 't1'", [
      new Date(Date.now() - 1000).toISOString(),
    ]);
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.dispatchState).toBe("working");
    expect(t.dispatchDeferredUntil).toBeNull();           // cleared on re-claim
    expect(h.turns.length).toBe(turnsAfterWait + 1);
  });

  it("con cap 2, TRE attese dichiarate di fila ripartono tutte: nessuna finisce `failed`", async () => {
    // IL GUASTO, end-to-end. La claim spende il tentativo prima che l'agent
    // possa sapere di dover aspettare: senza rimborso, alla terza passata
    // `dispatch_attempts` era 2, il task non veniva più reclamato e la spazzata
    // dei tentativi esauriti lo parcheggiava `failed` con «guarda cosa lo fa
    // fallire». Per un'attesa dichiarata bene (card e285d5d8, board quadra).
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 2 });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });

    for (let giro = 1; giro <= 3; giro++) {
      await h.dispatcher.tick(PID);
      await flush();
      // Il terzo giro è quello che prima non partiva nemmeno.
      expect(h.task("t1")!.dispatchState).toBe("working");

      h.dispatcher.deferWait("t1", "il servizio X è giù", 30);
      h.finishTurn();
      await flush();
      const dopo = h.task("t1")!;
      expect(dopo.status).toBe("todo");
      expect(dopo.dispatchState).toBe("waiting");
      expect(dopo.dispatchAttempts).toBe(0);  // rimborsato ogni volta
      expect(dopo.waitStreak).toBe(giro);     // conta la grandezza SUA
      h.db.run("UPDATE tasks SET dispatch_deferred_until = ? WHERE id = 't1'", [
        new Date(Date.now() - 1000).toISOString(),
      ]);
    }
    const finale = h.task("t1")!;
    expect(finale.dispatchState).not.toBe("failed");
    expect(finale.status).not.toBe("backlog");
  });

  it("sfondato il tetto delle attese la card resta `waited_out`: onTurnEnd non la azzera", async () => {
    // La trappola di `PARKED_STOPPED`, di nuovo: `deferForWait` parcheggia la
    // card DA SÉ a metà turno, e il turno finisce subito dopo. Senza guardia, la
    // coda di `onTurnEnd` rimette il chip a null e la card torna muta in
    // Backlog, indistinguibile da una fermata a mano.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    // La serie è già a un passo dal tetto (la chiave è normalizzata: minuscole).
    h.db.run("UPDATE tasks SET wait_streak = ?, wait_reason = ?, wait_since = ? WHERE id = 't1'", [
      WAIT_STREAK_CAP, "il servizio x è giù", new Date().toISOString(),
    ]);

    const parked = h.dispatcher.deferWait("t1", "il servizio X è giù", 30);
    expect(parked.status).toBe("backlog");
    expect(parked.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(parked.dispatchDeferredUntil).toBeNull();

    h.finishTurn();
    await flush();
    const t = h.task("t1")!;
    expect(t.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(t.dispatchState).not.toBeNull();
    expect(t.status).toBe("backlog");
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("sfondato il tetto delle attese il fronte `task:parked` ESCE: il park che dice «decidi tu» non può essere muto", async () => {
    // Era l'unico park terminale senza fronte, e per una ragione strutturale:
    // lo decide `deferForWait` dentro il service, quindi non passa da
    // `releaseAndEmit` come gli altri nove siti che rilasciano. Il chip
    // compariva sulla board in tempo reale e nessuno veniva avvisato.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo", text: "Aspetta che la CI torni su" });
    await h.dispatcher.tick(PID);
    await flush();

    // Un'attesa NORMALE non si annuncia: riparte da sola, e un banner per ogni
    // attesa sarebbe rumore. È la stessa riga che separa il park dal requeue.
    h.dispatcher.deferWait("t1", "la CI sta girando", 30);
    expect(h.events.filter((e) => e.type === "task:parked")).toHaveLength(0);

    // Serie a un passo dal tetto: la prossima sfonda.
    h.db.run("UPDATE tasks SET wait_streak = ?, wait_reason = ?, wait_since = ? WHERE id = 't1'", [
      WAIT_STREAK_CAP, "la ci sta girando", new Date().toISOString(),
    ]);
    h.dispatcher.deferWait("t1", "la CI sta girando", 30);

    const parked = h.events.filter((e) => e.type === "task:parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      projectId: PID,
      taskId: "t1",
      taskTitle: "Aspetta che la CI torni su",
      // Lo stato SUO, non 'failed' e non 'blocked': quei due titoli
      // accuserebbero di un difetto un turno che ha fatto la cosa giusta.
      state: PARKED_WAITED_OUT,
    });
  });

  it("books wall-clock + usage delta (billable + cache reads) on the task at each turn end", async () => {
    // Fake transcript usage: zeros before the turn, real numbers after it.
    let usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, billableTokens: 0 };
    const h = harness({ getSessionUsage: () => usage });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    // The turn consumed these (billable = in+out+cacheWrite, dedup upstream).
    usage = { inputTokens: 34, outputTokens: 200, cacheWriteTokens: 1000, cacheWrite1hTokens: 1000, cacheReadTokens: 55_000, billableTokens: 1234 };
    h.finishTurn();
    await flush();

    const t = h.task("t1")!;
    expect(t.agentTokens).toBe(1234);
    expect(t.agentCacheReadTokens).toBe(55_000);
    expect(t.agentMs).toBeGreaterThanOrEqual(0);
    // The metric update is broadcast so the open drawer refreshes live.
    expect(h.events.some((e) => e.type === "task:updated" && e.task?.agentTokens === 1234)).toBe(true);
  });

  // ── Il conto dei token: assoluto, monotono, per sessione ──────────────────
  //
  // I tre casi qui sotto sono quelli che un avversario ha MISURATO sul primo
  // tentativo di correzione, e che l'hanno mandato indietro. Sono scritti come
  // comportamento (che numero deve avere la card) e non come meccanismo, così
  // restano validi se il meccanismo cambia ancora.

  /** Una lettura di transcript, con i soli campi che il conto guarda. */
  const reading = (billable: number, cacheRead = 0) => ({
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0,
    cacheReadTokens: cacheRead, billableTokens: billable,
  });

  it("un turno SEPOLTO a metà non porta via i suoi token: li recupera il turno dopo", async () => {
    // Il guasto misurato: 884 token in tabella contro 188.936 nel transcript.
    // Un run che la rete di liveness seppellisce esce PRIMA di contabilizzare,
    // e il turno dopo si ri-ancora su una lettura più avanti — quindi quei
    // token non li scrive più nessuno. Col totale assoluto il buco si richiude
    // da solo: il secondo turno porta un totale che li contiene già.
    let usage = reading(0);
    const h = harness({ livenessGraceMs: 0, isTurnAlive: () => false, getSessionUsage: () => usage });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    usage = reading(40_000);            // il primo turno ha bruciato 40k…
    await h.dispatcher.reconcile();     // …e la rete lo seppellisce (due sweep)
    await flush();
    await h.dispatcher.reconcile();
    await flush();
    expect(h.task("t1")!.agentTokens).toBe(40_000);

    usage = reading(90_000);            // il turno di recupero ne brucia altri 50k
    h.finishTurn();
    await flush();
    // 90k, non 50k: il totale è quello della sessione, non la somma dei delta
    // che qualcuno è riuscito a scrivere.
    expect(h.task("t1")!.agentTokens).toBe(90_000);
  });

  it("una lettura che CROLLA a zero non azzera il conto e non lo raddoppia", async () => {
    // `getSessionUsage` che non riesce a leggere (transcript ruotato, riga
    // assente) rispondeva zero, indistinguibile da «non ha consumato niente».
    // Col delta e il clamp, il crollo valeva 0 e la risalita valeva TUTTO da
    // capo: 40k + 90k = 130k su 90k davvero bruciati.
    let usage: ReturnType<typeof reading> | undefined = reading(0);
    const h = harness({ livenessGraceMs: 0, isTurnAlive: () => false, getSessionUsage: () => usage as never });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    // La rete chiude un turno ogni due sweep, sempre sulla STESSA sessione.
    const closeOneTurn = async () => {
      await h.dispatcher.reconcile(); await flush();
      await h.dispatcher.reconcile(); await flush();
    };

    usage = reading(40_000);
    await closeOneTurn();
    expect(h.task("t1")!.agentTokens).toBe(40_000);

    usage = undefined;                 // la lettura non c'è: non si sa
    await closeOneTurn();
    expect(h.task("t1")!.agentTokens).toBe(40_000);   // non azzerato

    usage = reading(90_000);           // e quando torna, il totale è quello vero
    await closeOneTurn();
    expect(h.task("t1")!.agentTokens).toBe(90_000);   // non 130.000
  });

  it("DUE sessioni vive sullo stesso task si SOMMANO (il fan-out), non si sovrascrivono", async () => {
    // Il caso che ha demolito il primo tentativo: con UNA sola ancora per task,
    // la seconda sessione riusa l'ancoraggio della prima e il totale collassa
    // sul massimo invece di essere la somma — 40.000 bruciati che spariscono.
    // Il fan-out è il posto in cui la situazione è NORMALE e non un incidente:
    // N agenti, N sessioni, un task solo.
    const usage = new Map<string, ReturnType<typeof reading>>([
      ["topic:sk1", reading(0)], ["topic:sk2", reading(0)],
    ]);
    const finiti: (() => void)[] = [];
    const h = harness({
      getSessionUsage: (k) => usage.get(k) as never,
      runTurn: (sessionKey) => new Promise<void>((res) => {
        finiti.push(() => res());
        // Ogni tentativo brucia sulla SUA sessione, e i due numeri sono diversi
        // apposta: se uno soppiantasse l'altro, il totale sarebbe 50.000.
        usage.set(sessionKey, reading(sessionKey.endsWith("1") ? 40_000 : 50_000));
      }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchFanOut: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(finiti.length).toBe(2);          // due sessioni vive insieme
    for (const f of finiti) f();
    await flush(20);

    expect(h.task("t1")!.agentTokens).toBe(90_000);
  });

  it("un ancoraggio non si prende su una lettura FALLITA: sarebbe un doppio conteggio", async () => {
    // 80.000 al posto di 40.000, misurato dall'avversario sul primo tentativo.
    // La card porta già 40.000 (turni di prima, in tabella). Se l'ancoraggio si
    // prende mentre il transcript non si legge — e la lettura fallita valeva
    // ZERO, indistinguibile da «non ha consumato niente» — l'offset resta 0 su
    // una base che quei token li contiene già, e alla lettura buona il conto li
    // somma una seconda volta. Il pavimento MAX non protegge: il numero gonfio
    // è il più grande, quindi vince.
    let usage: ReturnType<typeof reading> | undefined;   // il transcript non si legge
    const h = harness({ livenessGraceMs: 0, isTurnAlive: () => false, getSessionUsage: () => usage as never });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });
    h.svc.recordAgentUsage({ taskId: "t1", addMs: 0, addTokens: 40_000, addCacheReadTokens: 0 });

    await h.dispatcher.tick(PID);      // il turno parte SENZA poter leggere
    await flush();
    usage = reading(40_000);           // la lettura torna: è il totale di sempre
    await h.dispatcher.reconcile(); await flush();
    await h.dispatcher.reconcile(); await flush();

    expect(h.task("t1")!.agentTokens).toBe(40_000);   // non 80.000
  });

  it("anche un turno ADOTTATO dal broker scrive i suoi token", async () => {
    // Il reattach è uno dei tre posti in cui si contabilizza, ed era quello
    // senza nessun test: toglierne la scrittura lasciava la suite verde.
    let usage = reading(0);
    let closeReattach: (() => void) | null = null;
    const h = harness({
      topicExists: () => true,
      hasLiveSession: async () => true,
      getSessionUsage: () => usage,
      reattach: () => new Promise<void>((res) => { closeReattach = () => res(); }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();
    usage = reading(12_345, 6_000);
    closeReattach!();
    await flush();

    expect(h.task("t1")!.agentTokens).toBe(12_345);
    expect(h.task("t1")!.agentCacheReadTokens).toBe(6_000);
  });

  // ── Il chip del TRIAGE: i primi minuti, in cui la card sembra ferma ───────
  //
  // Il primo turno non comincia dal lavoro: comincia dall'inquadrarlo (leggere
  // la card, riscrivere il titolo grezzo, giudicare la priorità che nessuno ha
  // scelto). Per chi guarda la board sono minuti identici a quelli di prima, e
  // l'unica cosa che si muove è un cronometro. Il chip dice cosa sta succedendo,
  // e si spegne al primo SEGNO che l'agente lascia — non a scadenza.

  /** L'ultima anteprima viva emessa per un task. */
  const ultimaLive = (h: ReturnType<typeof harness>, taskId: string) =>
    [...h.events].reverse().find((e) => e.type === "task:usage-live" && e.taskId === taskId);

  it("un turno che parte annuncia il TRIAGE, e lo spegne appena l'agente riscrive il titolo", async () => {
    const h = harness({ usageTickMs: 5 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo", text: "non vedo piu i token e dovrei" });
    await h.dispatcher.tick(PID);
    await flush();

    // Subito: la card è ancora quella buttata giù di fretta.
    expect(ultimaLive(h, "t1")?.triage).toBe(true);

    // Il titolo riscritto È l'atto che il kickoff chiede «appena hai inquadrato
    // il lavoro»: da qui in poi il chip mentirebbe.
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { text: "Token vivi fermi sulle card in lavorazione" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(ultimaLive(h, "t1")?.triage).toBe(false);

    h.finishTurn();
    await flush();
  });

  it("le note del dispatcher NON spengono il triage: il segno dev'essere dell'agente", async () => {
    // «todo→in_progress» e «Nuovo worktree» le scrive il server, prima ancora
    // che l'agente abbia letto la card. Contarle spegnerebbe il chip su ogni
    // task, sempre, un istante dopo averlo acceso.
    const h = harness({ usageTickMs: 5 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    h.svc.addComment({ taskId: "t1", author: "system", content: "Nuovo worktree: `topics/x`" });
    await new Promise((r) => setTimeout(r, 20));
    expect(ultimaLive(h, "t1")?.triage).toBe(true);

    // Il primo commento SUO, invece, sì: da lì in avanti sta lavorando.
    h.svc.addComment({ taskId: "t1", author: "claude", content: "Inquadrato: parto dal dispatcher." });
    await new Promise((r) => setTimeout(r, 20));
    expect(ultimaLive(h, "t1")?.triage).toBe(false);

    h.finishTurn();
    await flush();
  });

  it("una RIPRESA non è mai triage: quel lavoro è già inquadrato", async () => {
    const h = harness({ usageTickMs: 5 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    // Un turno di lavoro già speso su questa card: non è il primo giro.
    h.svc.recordAgentUsage({ taskId: "t1", addMs: 120_000, addTokens: 4_000, addCacheReadTokens: 0 });
    await h.dispatcher.tick(PID);
    await flush();

    expect(ultimaLive(h, "t1")?.triage).toBe(false);
    h.finishTurn();
    await flush();
  });

  // ── The dead turn the dispatcher retries: the card must KNOW ───────────────
  //
  // On the turn-died-and-I-retry branch no column moves: the chip stays
  // `working`, and the client drops the live chip only on the first
  // `task:updated` with a different chip, which never comes here. During a
  // provider outage the board claimed work on every stalled card, stopwatch
  // climbing. Measured 2026-09-03 on 12 cards.

  it("un turno morto per il provider chiude il chip vivo e annuncia l'ATTESA, con il perché", async () => {
    const h = harness({ usageTickMs: 5, retryBackoffMs: 60 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const before = Date.now();
    h.finishTurnWith({ end: "error", cause: "provider-error", detail: "503 overloaded" });
    await flush();

    const live = h.events.filter((e) => e.type === "task:usage-live" && e.taskId === "t1");
    // First the END of the turn, then the wait: two facts, in the order they happen.
    const ended = live.findIndex((e) => e.ended === true);
    expect(ended).toBeGreaterThan(0);
    const wait = live[live.length - 1];
    expect(wait.retry).toBeDefined();
    expect(wait.retry.at).toBeGreaterThanOrEqual(before + 60);
    expect(wait.retry.cap).toBe(3);
    expect(wait.retry.free).toBe(true); // a provider error does not cost an attempt
    expect(wait.retry.reason).toBe(describeTurnEnd({ end: "error", cause: "provider-error" }));
    expect(wait.retry.detail).toBe("503 overloaded");
    expect(live.indexOf(wait)).toBeGreaterThan(ended);

    // Once the wait elapses a turn starts, and the new turn's first live event
    // carries no wait: the chip is a stopwatch again.
    await new Promise((r) => setTimeout(r, 90));
    await flush();
    expect(h.turns.length).toBe(2);
    expect(ultimaLive(h, "t1")?.retry).toBeUndefined();
    h.finishTurn();
    await flush();
  });

  it("il chip vivo porta COSA sta facendo la sessione: il tool in corso, letto dal tracker", async () => {
    // The event used to carry model, time and tokens: a 14-minute stopwatch
    // did not tell a suite running for nine minutes from a stuck agent.
    const h = harness({
      usageTickMs: 5,
      sessionActivity: (sessionKey) => sessionKey === "topic:sk1"
        ? { name: "Bash", input: { command: "bun run test:unit", description: "Run the unit suite" }, since: 1_000 }
        : null,
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(ultimaLive(h, "t1")?.lastTool).toEqual({ name: "Bash", input: "bun run test:unit", since: 1_000 });
    h.finishTurn();
    await flush();
  });

  it("senza un tool in corso (o senza tracker) l'evento dice null, non inventa", async () => {
    const h = harness({ usageTickMs: 5 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(ultimaLive(h, "t1")?.lastTool).toBeNull();
    h.finishTurn();
    await flush();
  });

  it("summarizeToolInput: una riga per tool, mai un JSON", () => {
    expect(summarizeToolInput("Bash", { command: "bun   run\n test:unit", description: "x" })).toBe("bun run test:unit");
    expect(summarizeToolInput("Edit", { file_path: "/a/b/c.ts", old_string: "x", new_string: "y" })).toBe("/a/b/c.ts");
    expect(summarizeToolInput("Grep", { pattern: "foo", path: "/a" })).toBe("foo");
    expect(summarizeToolInput("mcp__x__y", { query: "q" })).toBe("q");
    expect(summarizeToolInput("Bash", { command: "" })).toBeNull();
    expect(summarizeToolInput("Bash", null)).toBeNull();
    expect(summarizeToolInput("Bash", { command: "a".repeat(300) })!.length).toBe(200);
  });

  it("leaves a task alone when the turn ends in review", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // Agent moved it to review mid-turn (allowed: agent→review, after its summary).
    h.svc.addComment({ taskId: "t1", author: "claude", content: "fatto" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    h.finishTurn();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("review");
    expect(t.assignedTopicId).toBe("topic-1");   // binding preserved for the human
    // Clean delivery (last agent word is NOT a question) → "delivered", not a
    // stale "working" nor a false "serve te".
    expect(t.dispatchState).toBe("delivered");
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  // ── snellimento del worktree alla consegna ────────────────────────────
  //
  // Una card consegnata aspetta un umano per giorni tenendosi ~260 MB di
  // dipendenze. Alla consegna quel peso se ne va — ma DOPO l'anteprima, che è
  // un `bun run dev` dentro quello stesso worktree.

  async function deliver(h: ReturnType<typeof harness>) {
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.svc.addComment({ taskId: "t1", author: "claude", content: "fatto" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    h.finishTurn();
    await flush();
  }

  it("consegna → il worktree si snellisce, ma solo DOPO l'anteprima", async () => {
    const ordine: string[] = [];
    let unlockPreview: (() => void) | null = null;
    const h = harness({
      preparePreview: (id) => new Promise<void>((res) => {
        ordine.push(`anteprima:${id}`);
        unlockPreview = () => res();
      }),
      slimWorktree: async (id) => { ordine.push(`slim:${id}`); },
    });
    await deliver(h);
    // L'anteprima è ancora in piedi: togliere `node_modules` ora la ucciderebbe.
    expect(ordine).toEqual(["anteprima:t1"]);
    unlockPreview!();
    await flush();
    expect(ordine).toEqual(["anteprima:t1", "slim:t1"]);
  });

  it("un'anteprima che fallisce non impedisce di liberare lo spazio", async () => {
    const slimmed: string[] = [];
    const h = harness({
      preparePreview: async () => { throw new Error("porta occupata"); },
      slimWorktree: async (id) => { slimmed.push(id); },
    });
    await deliver(h);
    expect(slimmed).toEqual(["t1"]);
  });

  it("uno slim che esplode non tocca la consegna", async () => {
    const h = harness({ slimWorktree: async () => { throw new Error("permessi"); } });
    await deliver(h);
    expect(h.task("t1")!.status).toBe("review");
    expect(h.task("t1")!.dispatchState).toBe("delivered");
  });

  it("un turno che NON consegna non snellisce niente", async () => {
    const slimmed: string[] = [];
    const h = harness({ slimWorktree: async (id) => { slimmed.push(id); } });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn();   // finito senza arrivare in review
    await flush();
    expect(slimmed).toEqual([]);
  });

  it("a question as the agent's last word flips the chip to needs_input ('serve te')", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // The agent asks (server-composed question block) and hands off to review.
    h.svc.addComment({ taskId: "t1", author: "claude", content: "Quale opzione?", questionOptions: ["A", "B"] });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    h.finishTurn();
    await flush();
    expect(h.task("t1")!.dispatchState).toBe("needs_input");
  });

  it("continues the SAME session when a turn ends without reaching review", async () => {
    const h = harness();
    // cap 3 → the 2nd turn is a NORMAL continuation (not yet last-chance), so
    // this test exercises the plain "continua sulla stessa sessione" path.
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); // wall-clock timeout cuts the agent mid-work
    await flush();
    const t = h.task("t1")!;
    // NOT released back to todo: the conversation (and its worktree) survives,
    // the agent resumes where it was instead of re-planning from scratch.
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-1");
    expect(t.dispatchAttempts).toBe(2); // the continuation costs an attempt
    expect(h.topicsCreated.length).toBe(1); // no fresh topic
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].sessionKey).toBe("topic:topic-1"); // same tab resumed (prod sessionKey convention)
    expect(h.turns[1].content).toContain("was interrupted");
    // Kickoff turn carries the FULL context envelope; the continuation is LEAN
    // (the persistent session already has CLAUDE.md/README/awareness — resending
    // them only compounds cache write/read).
    expect(h.turns[0].contextMode).toBe("full");
    expect(h.turns[1].contextMode).toBe("lean");
    // The thread explains what happened (visible history, not a silent retry).
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("stessa sessione"))).toBe(true);
  });

  // ── 0.4 — il PERCHÉ del turno arriva fin qui e decide la politica ─────────
  // Prima il dispatcher lo indovinava dalla durata («probabile timeout»,
  // «probabile problema momentaneo del provider») e trattava tutte le fini allo
  // stesso modo: un rifiuto del modello girava fino a bruciare il budget, e uno
  // stop premuto da un umano costava un tentativo all'agent.

  it("un RIFIUTO del modello va subito all'umano: nessun ritentativo, ragione scritta", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurnWith({ end: "refusal" });
    await flush();
    const t = h.task("t1")!;
    // Riprovare identico otterrebbe lo stesso rifiuto: non si riprende.
    expect(t.status).toBe("review");
    expect(h.turns.length).toBe(1);
    const notes = h.svc.get("t1")!.comments.map((c) => c.content).join("\n");
    expect(notes).toContain("rifiutato");
    // 1.3 — e la card lo dice da sé: non è una consegna dell'agent, e la causa
    // è quella per cui rimandarlo indietro identico non serve a niente.
    expect(t.deliveredBy).toBe("system");
    expect(t.deliveredReason).toBe("model_refused");
  });

  it("uno STOP dell'umano riprende senza costare un tentativo", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurnWith(cancelled("user"));
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.dispatchAttempts).toBe(1); // NON bumpato: non è un fallimento dell'agent
    expect(h.turns.length).toBe(2); // ma il lavoro riprende
    const notes = h.svc.get("t1")!.comments.map((c) => c.content).join("\n");
    expect(notes).toContain("Turno fermato a mano");
    expect(notes).toContain("non conteggiato");
  });

  it("lo STOP dalla board parcheggia e la chip «fermato» sopravvive al turno tagliato", async () => {
    // L'ordine dello stop umano: la route PARCHEGGIA prima (release → backlog,
    // chip 'stopped') e taglia il turno DOPO. Qui si simula esattamente quello,
    // perché è l'`onTurnEnd` del turno abortito il punto in cui la cosa poteva
    // rompersi in due modi: rimettere in coda un task che l'umano ha fermato, o
    // riazzerare la chip e lasciare la card muta in Backlog.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.dispatchAttempts).toBe(1);
    h.svc.release({ taskId: "t1", requeue: false, by: "user", parkState: "stopped" });
    h.finishTurnWith(cancelled("user"));
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("stopped"); // né null (muta) né 'failed' (accusa)
    expect(t.dispatchAttempts).toBe(1);      // fermare non consuma un tentativo
    expect(h.turns.length).toBe(1);          // e non riparte da solo
  });

  it("una raffica di errori del PROVIDER non brucia i tentativi (ma un guasto cronico sì)", async () => {
    // Misurato il 10/08: durante una raffica di dispatch paralleli, VENTI task
    // sono finiti in review a mano vuote — «Errore del provider: riprovo tra 60s
    // (tentativo 2/2)» e poi consegna forzata. Con il tetto a 2, due singhiozzi
    // del provider uccidono una card che non ha ancora scritto una riga: lavoro
    // zero, review sporca, e i token dello spawn pagati per niente.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    for (let i = 0; i < 3; i++) {
      h.finishTurnWith({ end: "error" } as TurnEndInfo);
      await flush();
      // Il backoff dell'outage rimanda il resume: qui lo si lascia scattare.
      await flush();
    }
    const t = h.task("t1")!;
    // Tre errori, tetto 2: senza il perdono la card sarebbe già in review vuota.
    expect(t.status).toBe("in_progress");
    expect(t.dispatchAttempts).toBe(1);
    expect(h.svc.get("t1")!.comments.some((c) => c.content.includes("non conteggiato"))).toBe(true);
  });

  it("…ma il TETTO A OROLOGIO sì, o il freno non frenerebbe mai", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurnWith(cancelled("wall-clock"));
    await flush();
    const t = h.task("t1")!;
    expect(t.dispatchAttempts).toBe(2);
    const notes = h.svc.get("t1")!.comments.map((c) => c.content).join("\n");
    // The CONTRACT: the note says the declared cause instead of guessing. It is
    // taken from `describeTurnEnd`, not copied here, so rewording the sentence
    // never turns an honest fix into a red (that is what happened on
    // 2026-08-21, when the cap stopped counting elapsed time and its old
    // wording became false).
    expect(notes).toContain(describeTurnEnd(cancelled("wall-clock")));
    expect(notes).not.toContain("probabile"); // niente più indovinelli
  });

  it("il CONTESTO PIENO si riprende e lo dice: non è un fallimento", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurnWith({ end: "max_tokens" });
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(2);
    expect(h.svc.get("t1")!.comments.map((c) => c.content).join("\n")).toContain("Contesto pieno");
  });

  it("un turno morto per errore dice l'errore, e la promise rotta viene classificata", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.failTurn(new Error("PROCESS_DIED_137"));
    await flush();
    const notes = h.svc.get("t1")!.comments.map((c) => c.content).join("\n");
    expect(notes).toContain("processo dell'agente è morto");
    expect(h.turns.length).toBe(2); // un guasto si riprende
  });

  it("parks in backlog when the retry budget is exhausted mid-continuation", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); await flush(); // attempt 1 → continuation (attempt 2)
    h.finishTurn(); await flush(); // attempt 2 → continuation (attempt 3)
    h.finishTurn(); await flush(); // attempt 3 → cap: park
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("failed"); // no agent output → genuine failure
    expect(t.assignedTopicId).toBeNull();
    expect(h.turns.length).toBe(3);
  });

  it("default retry cap is 2: parks after the 2nd turn, last-chance nudge on turn 2", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true }); // no cap → default 2
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); await flush(); // attempt 1 → continuation (attempt 2 = cap)
    // The single continuation is already the LAST chance (deliver-what-you-have).
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].content).toContain("LAST TURN");
    h.finishTurn(); await flush(); // attempt 2 at cap → park, no 3rd turn
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("failed");
    expect(h.turns.length).toBe(2);
  });

  it("HANDS an exhausted-but-worked task to review instead of failing it", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // The agent left a real comment trail (worked) but never moved to review.
    h.svc.addComment({ taskId: "t1", author: "agent", content: "Ecco il piano: 1) … 2) …" });
    h.finishTurn(); await flush(); // attempt 1 → continuation
    h.finishTurn(); await flush(); // attempt 2 → continuation
    h.finishTurn(); await flush(); // attempt 3 → exhausted, but agent spoke
    const t = h.task("t1")!;
    expect(t.status).toBe("review");            // handed to the human, NOT failed
    expect(t.dispatchState).toBe("needs_input");
    expect(t.assignedTopicId).not.toBeNull();   // binding kept: a reject resumes it
    // 1.3 — la card non si spaccia per una consegna dell'agent, e dice la causa
    // giusta: qui i tentativi sono finiti, quindi rimandarlo indietro RIPARTE.
    expect(t.deliveredBy).toBe("system");
    expect(t.deliveredReason).toBe("retries_exhausted");
  });

  it("RECOVERS the agent's last words into the SYSTEM note when a worked turn dies before review", async () => {
    // The agent worked and summarised in its LAST session message but ran out of
    // turns before reaching review. Its turn is over — it can't comment itself —
    // so its words are recovered into the SYSTEM delivery note (honest, never a
    // faked agent comment) and the task is handed to review instead of parked.
    const h = harness({ getLastAgentText: () => "Ho implementato login e i test. Guarda /demo." });
    h.svc.updateBoardSettings(PID, { autoDispatch: true }); // default cap 2
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); await flush(); // attempt 1 → last-chance continuation
    h.finishTurn(); await flush(); // attempt 2 at cap → exhausted
    const t = h.task("t1")!;
    expect(t.status).toBe("review");             // handed to the human, not failed
    expect(t.assignedTopicId).not.toBeNull();
    const comments = h.svc.get("t1")!.comments;
    // Recovered into the SYSTEM note — never faked as an agent comment.
    expect(comments.some((c) => c.author === "system" && c.content.includes("Ho implementato login"))).toBe(true);
    expect(comments.some((c) => c.author !== "user" && c.author !== "system" && c.content.includes("Ho implementato login"))).toBe(false);
  });

  it("still parks when the agent produced NOTHING (no comment AND no final message)", async () => {
    const h = harness({ getLastAgentText: () => null });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); await flush();
    h.finishTurn(); await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("failed"); // genuinely empty → failure, not review
    // Nessuno l'ha consegnato: il timbro resta vuoto, non 'system'.
    expect(t.deliveredBy).toBeNull();
    expect(t.deliveredReason).toBeNull();
  });

  it("l'inizio del turno si legge anche quando la transizione porta la sua RAGIONE", async () => {
    // La forma vera del land in conflitto: l'agent aveva consegnato (commento),
    // l'umano ha cliccato «Landa su main», il merge è andato in conflitto e la
    // card è tornata `in_progress` con la causa scritta sulla transizione.
    // Quel commento è del turno PRIMA: se il confine del turno si legge col
    // suffisso (`…in_progress`), la riga con la ragione non viene vista, il
    // confine resta indietro e la consegna vecchia passa per fresca — cioè
    // l'ultima parola dell'agent di QUESTO turno non viene recuperata.
    const h = harness({ getLastAgentText: () => "Ho risolto i conflitti col main." });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.svc.addComment({ taskId: "t1", author: "claude", content: "Consegna del turno prima del land." });
    // Il nuovo turno si apre DOPO quel commento, e la sua riga porta la ragione.
    h.db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('s-land', 't1', 'system', ?, 'status', ?)",
    ).run(
      formatStatusEvent("done", "in_progress", "il land ha fatto conflitto con main"),
      new Date(Date.now() + 1000).toISOString(),
    );
    h.finishTurn(); await flush();
    h.finishTurn(); await flush();
    const comments = h.svc.get("t1")!.comments;
    // Nessun riepilogo per QUESTO turno → le ultime parole finiscono nella nota
    // di sistema, invece di lasciare al reviewer la consegna pre-conflitto.
    expect(comments.some((c) => c.author === "system" && c.content.includes("Ho risolto i conflitti"))).toBe(true);
  });

  it("does NOT recover into the note when the agent already left a fresh comment", async () => {
    // Recovery is a fallback for the system-delivery path only: an agent that DID
    // leave a fresh comment must not get its last session message duplicated.
    const h = harness({ getLastAgentText: () => "Questo NON deve comparire." });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.svc.addComment({ taskId: "t1", author: "claude", content: "Consegna: fatto tutto." });
    h.finishTurn(); await flush(); // attempt 1 → continuation
    h.finishTurn(); await flush(); // attempt 2 → exhausted, but agent already spoke
    const t = h.task("t1")!;
    expect(t.status).toBe("review");
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.content.includes("Questo NON deve comparire"))).toBe(false);
  });

  it("respects the concurrency cap", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    // The concurrency cap is a single MACHINE-WIDE budget (getGlobalCap) and
    // there IS no per-board one — pin it to 1 explicitly (auto off) so the
    // harness's default doesn't let both tasks through. That default is
    // (auto, max 2): turning autoDispatch on seeds the reserved '*' row at
    // max_agents 2, and with no `recommendedCap` dep the effective cap is 2.
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    seedTask(h.db, { id: "t2", status: "todo", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress"); // oldest claimed
    expect(h.task("t2")!.status).toBe("todo");         // cap hit → stays queued
    expect(h.turns.length).toBe(1);
  });

  it("chi resta in coda per il tetto lo DICE, e dice i numeri", async () => {
    // Il tetto pieno era l'unica delle tre attese a restare muta: il pesante lo
    // diceva, la sessione esterna lo diceva, questa lasciava la card su `queued`
    // e basta. Cinque card ferme senza una riga sembrano un sistema rotto, non
    // un sistema che sta aspettando (misurato il 12/08).
    const h = harness({ capacity: () => ({ load1: 13, cores: 12, reason: "12 core → base 4" }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    seedTask(h.db, { id: "t2", status: "todo", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();

    const nota = h.svc.get("t2")!.comments.find((c) => c.author === "system" && c.content.includes("In coda"));
    expect(nota).toBeTruthy();
    expect(nota!.content).toContain("1 agent al lavoro su un tetto di 1"); // il numero
    expect(nota!.content).toContain("12 core → base 4");                   // e da dove esce
    expect(h.task("t2")!.dispatchState).toBe("queued");

    // Una nota per EPISODIO: il poll ogni 10s non deve riempire il thread.
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.svc.get("t2")!.comments.filter((c) => c.content.includes("In coda")).length).toBe(1);
  });

  it("la nota del tetto non parla quando il posto c'è", async () => {
    // La guardia opposta: una riga «sei in coda» su una card che sta partendo
    // è peggio del silenzio, perché insegna a non leggere le note di servizio.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 3 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    seedTask(h.db, { id: "t2", status: "todo", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns.length).toBe(2);
    for (const id of ["t1", "t2"]) {
      expect(h.svc.get(id)!.comments.some((c) => c.content.includes("In coda"))).toBe(false);
    }
  });

  it("il tetto vale anche sul RESUME: un rifiuto non apre un agente in più", async () => {
    // Il tetto viveva dentro tick(), quindi governava solo i dispatch: ogni
    // rifiuto in review faceva ripartire un agente FUORI dal tetto. Misurato il
    // 09/08: 12 task in corso col tetto a 6, e metà erano rifiuti in fila.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    seedTask(h.db, { id: "t2", status: "todo", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns.length).toBe(1); // t1 occupa l'unico posto, t1 è ancora in volo

    // t2 arriva in review e viene rifiutato: prima ripartiva subito, tetto o no.
    h.svc.update({ taskId: "t2", actor: "human", by: "u", patch: { status: "in_progress" } });
    h.db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", ["topic-2"]);
    h.db.run("UPDATE tasks SET assigned_topic_id = ? WHERE id = ?", ["topic-2", "t2"]);
    await h.dispatcher.resume("t2", "riprova");
    await flush();

    expect(h.turns.length).toBe(1); // nessun secondo turno: il posto è uno
    // E non è perso in silenzio: la card lo dice, nel thread E nel chip.
    expect(h.svc.get("t2")!.comments.some((c) => c.content.includes("In attesa di uno slot"))).toBe(true);
    // Senza il chip la card resta `in_progress` senza turno vivo: il tempo non
    // scorre e sembra piantata — una coda invisibile.
    expect(h.task("t2")!.dispatchState).toBe("queued");
  });

  it("il resume che rinuncia perché la card è chiusa non lascia residui", async () => {
    // Una card in attesa di posto può essere approvata mentre aspetta. Il
    // ritentativo la ritrova chiusa e rinuncia — giusto — ma se non ripulisce
    // l'insieme di chi aspetta, la PROSSIMA attesa vera di quella card non
    // verrebbe più annunciata: il commento «in coda» è guardato da lì.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    seedTask(h.db, { id: "t2", status: "todo", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();

    h.db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", ["topic-2"]);
    const bindT2 = () => {
      h.svc.update({ taskId: "t2", actor: "human", by: "u", patch: { status: "in_progress" } });
      h.db.run("UPDATE tasks SET assigned_topic_id = ? WHERE id = ?", ["topic-2", "t2"]);
    };
    bindT2();
    await h.dispatcher.resume("t2", "riprova");   // aspetta un posto, lo annuncia
    await flush();
    const primo = h.svc.get("t2")!.comments.filter((c) => c.content.includes("In attesa di uno slot")).length;
    expect(primo).toBe(1);

    // Approvata mentre aspettava: il ritentativo rinuncia.
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", ["t2"]);
    await h.dispatcher.resume("t2", "riprova");
    await flush();

    // Ora torna in lavorazione e aspetta di nuovo: deve tornare a dirlo.
    // Il tetto cambia apposta — `addComment` deduplica i testi identici, quindi
    // con lo stesso numero il secondo annuncio sparirebbe per un motivo che non
    // c'entra con ciò che stiamo misurando.
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t3", status: "todo", createdAt: "2020-01-03T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns.length).toBe(2); // due posti, due turni vivi: il tetto e' pieno
    bindT2();
    await h.dispatcher.resume("t2", "riprova ancora");
    await flush();
    const testi = h.svc.get("t2")!.comments.filter((c) => c.content.includes("In attesa di uno slot")).map((c) => c.content);
    expect(testi.length).toBe(2);
    expect(testi.some((t) => t.includes("(2)"))).toBe(true);
  });

  it("parks (does not run in-place) when a worktree is required but unavailable", async () => {
    const h = harness({ resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: null }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");          // parked, NOT run in the live repo
    expect(t.dispatchState).toBe("blocked");   // config issue (fixable), not a failure
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchError).toContain("worktree");
    expect(h.turns.length).toBe(0);
  });

  it("runs in-place (no worktree) when the board opts out", async () => {
    const h = harness({ resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: null }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.worktreesCreated.length).toBe(0);
    expect(h.topicsCreated[0].worktreeId).toBeUndefined();
    expect(h.turns.length).toBe(1);
  });

  it("marks the session STANDALONE only for the catch-all path (project-less task), not a real project", async () => {
    // Catch-all: resolved path === catchAllProjectPath → standalone session.
    const catchAll = "/Users/x/.openclaw/workspace/generale";
    const h = harness({
      catchAllProjectPath: catchAll,
      resolveProject: () => ({ path: catchAll, projectStoreId: null }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated[0].standalone).toBe(true);

    // A real project at a different path → NOT standalone (grouped as usual).
    const h2 = harness({
      catchAllProjectPath: catchAll,
      resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: null }),
    });
    h2.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h2.db, { id: "t1", status: "todo" });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.topicsCreated[0].standalone).toBeFalsy();
  });

  it("gives each catch-all task a PRIVATE per-task cwd (unique projectPath) but leaves a real project alone", async () => {
    const catchAll = "/Users/x/.openclaw/workspace/generale";
    const taskDir = (id: string) => `/Users/x/.openclaw/workspace/tasks/${id.slice(0, 8)}`;

    // Two catch-all tasks → two DISTINCT per-task dirs, both standalone.
    const h = harness({
      catchAllProjectPath: catchAll,
      catchAllTaskDir: taskDir,
      resolveProject: () => ({ path: catchAll, projectStoreId: null }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    h.svc.setGlobalCap({ auto: false, max: 5 }); // tetto fuori strada: i due task devono partire entrambi
    seedTask(h.db, { id: "aaaaaaaa-1", status: "todo" });
    seedTask(h.db, { id: "bbbbbbbb-2", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const paths = h.topicsCreated.map((t) => t.projectPath).sort();
    expect(paths).toEqual([taskDir("aaaaaaaa-1"), taskDir("bbbbbbbb-2")].sort());
    expect(paths[0]).not.toBe(paths[1]);          // distinct workspaces
    expect(h.topicsCreated.every((t) => t.standalone)).toBe(true);
    expect(paths.every((p) => p !== catchAll)).toBe(true); // never the shared dir

    // A real project is NOT given a per-task dir — it runs in the project cwd.
    const h2 = harness({
      catchAllProjectPath: catchAll,
      catchAllTaskDir: taskDir,
      resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    });
    h2.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h2.db, { id: "t1", status: "todo" });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.topicsCreated[0].projectPath).toBe("/Users/x/Projects/alpha");
    expect(h2.topicsCreated[0].standalone).toBeFalsy();
  });

  it("onEnterTodo debounces then launches after the grace window", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    h.dispatcher.onEnterTodo(PID, "t1");
    expect(h.task("t1")!.dispatchState).toBe("queued"); // chip shows immediately
    expect(h.turns.length).toBe(0);                     // but no launch yet
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
  });

  it("onEnterTodo does nothing when auto_dispatch is off (no lingering chip)", async () => {
    const h = harness(); // auto_dispatch defaults off
    seedTask(h.db, { id: "t1", status: "todo" });
    h.dispatcher.onEnterTodo(PID, "t1");
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.dispatchState).toBeNull();
    expect(h.task("t1")!.status).toBe("todo");
    expect(h.turns.length).toBe(0);
  });

  it("onLeaveTodo cancels a queued launch inside the grace window", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    h.dispatcher.onEnterTodo(PID, "t1");
    h.dispatcher.onLeaveTodo("t1"); // dragged back out immediately
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.status).toBe("todo");
    expect(h.task("t1")!.dispatchState).toBeNull();
    expect(h.turns.length).toBe(0);
  });

  // ── IL GIRO Todo → Backlog → «Ferma» ───────────────────────────────────────
  //
  // Il test qui sopra copre il trascinamento IMMEDIATO, dentro la finestra di
  // grazia. Il giro segnalato è l'altro: una card rimasta in Todo abbastanza da
  // vedere il suo tick, NON reclamata (tetto pieno, notte, pesante in attesa) e
  // trascinata fuori dopo. Lì il timer non c'è più, e il chip `queued` restava
  // acceso per sempre su una colonna che il `claim` non guarda: una promessa di
  // partenza che non arriverà mai, e con lei il bottone «Ferma» per un agente
  // mai nato. Premerlo non muoveva niente e non diceva niente.
  it("onLeaveTodo spegne il chip «in coda» anche FUORI dalla finestra di grazia", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    // Il chip che il tick le ha scritto senza reclamarla, e nessun timer: è lo
    // stato di una card che aspetta il suo turno da minuti, non da millisecondi.
    seedTask(h.db, { id: "t1", status: "backlog", dispatchState: "queued" });
    h.dispatcher.onLeaveTodo("t1");
    await flush();
    expect(h.task("t1")!.dispatchState).toBeNull();
  });

  it("onLeaveTodo NON tocca un turno vivo: `working` resta, lo chiude onTurnEnd", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", dispatchState: "working", assignedTopicId: "topic-7" });
    h.dispatcher.onLeaveTodo("t1");
    await flush();
    expect(h.task("t1")!.dispatchState).toBe("working");
  });

  it("reconcile raccoglie i chip «in coda» già rimasti accesi in Backlog", async () => {
    const h = harness();
    // Anche a interruttore SPENTO: un chip che mente va spento comunque, e il
    // cancello globale del passo 2 sta dopo questa passata apposta.
    seedTask(h.db, { id: "t1", status: "backlog", dispatchState: "queued" });
    seedTask(h.db, { id: "t2", status: "todo", dispatchState: "queued" }); // in coda per davvero
    await h.dispatcher.reconcile();
    await flush();
    expect(h.task("t1")!.dispatchState).toBeNull();
    expect(h.task("t2")!.dispatchState).toBe("queued");
  });

  it("resume re-kicks the SAME topic with the human message", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });

    const p = h.dispatcher.resume("t1", "usa l'opzione B");
    await flush();
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:" + "topic-42".slice(0, 8)); // derived, same tab
    expect(h.turns[0].content).toContain("usa l'opzione B");
    expect(h.task("t1")!.dispatchState).toBe("working");
    // Agent finishes back into review (its earlier comments already count).
    h.svc.addComment({ taskId: "t1", author: "claude", content: "sistemato con opzione B" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    h.finishTurn();
    await p;
    await flush();
    expect(h.task("t1")!.status).toBe("review");
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("il feedback scritto a turno VIVO non rifiuta la consegna: resta nel thread, con l'ora", async () => {
    // THE MUTE BOUNCE. The message is buffered while the turn is alive, and the
    // NORMAL way that turn ends is by taking the card to review: from there it
    // went through the automatic rejection, and the card was back in progress
    // twenty seconds after the delivery, signed "user", with not one line in the
    // thread. Three times on the night of 2026-09-04 (18bdf214, cdeb9868,
    // d2a4a907), a wasted turn each, with the agent hunting for the hole in a
    // delivery nobody had objected to. The feedback is not lost: it is in the
    // thread, and the note quotes it back.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });

    const p = h.dispatcher.resume("t1", "primo giro");
    await flush();
    expect(h.turns.length).toBe(1);

    void h.dispatcher.resume("t1", "aspetta: il caso B è sbagliato");
    await flush();
    expect(h.turns.length).toBe(1);            // turno vivo: imbucato, non un secondo agente

    h.svc.addComment({ taskId: "t1", author: "claude", content: "consegnato" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    h.finishTurn();
    await p;
    await flush();

    expect(h.turns.length).toBe(1);                     // nessun secondo turno
    expect(h.task("t1")!.status).toBe("review");        // la consegna regge
    expect(h.task("t1")!.dispatchState).toBe("delivered");
    const nota = h.svc.get("t1")!.comments.find((c) => c.kind === "service" && c.content.includes("mentre l'agent stava consegnando"));
    expect(nota).toBeTruthy();
    expect(nota!.content).toContain("caso B");          // il testo è lì da leggere
    expect(nota!.content).toMatch(/\d\d:\d\d/);         // e con l'ora in cui fu scritto
  });

  it("la card che aveva CHIESTO riprende, ma la riapertura dice cosa consegna", async () => {
    // The only automatic reopen left: the message is the ANSWER to a question the
    // agent asked (chip "serve te"), and that session is sitting there waiting
    // for it. No mute status change here either: the note says why the card went
    // back to work and what was handed over.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });

    const p = h.dispatcher.resume("t1", "primo giro");
    await flush();
    void h.dispatcher.resume("t1", "usa la B");
    await flush();

    h.svc.addComment({ taskId: "t1", author: "claude", content: "Quale opzione?", questionOptions: ["A", "B"] });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "serve una decisione" } });
    h.finishTurn();
    await p;
    await flush();

    expect(h.turns.length).toBe(2);
    expect(h.turns[1].content).toContain("usa la B");
    expect(h.task("t1")!.status).toBe("in_progress");
    const nota = h.svc.get("t1")!.comments.find((c) => c.kind === "service" && c.content.includes("Riaperta per consegnare"));
    expect(nota).toBeTruthy();
    expect(nota!.content).toContain("usa la B");
  });

  it("un messaggio vuoto non è un messaggio: non si imbuca e non riapre niente", async () => {
    // The third case of that night (`d2a4a907`): the queue held no human feedback
    // at all, it held an empty string left by the continuation nudge ("turn ended
    // without reaching review"), which against a live turn has nothing to say.
    // The buffer kept it anyway, and at turn end it counted as much as a
    // sentence: a reopen, and a message with no text for the agent.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });

    const p = h.dispatcher.resume("t1", "primo giro");
    await flush();
    void h.dispatcher.resume("t1", "   ");
    await flush();

    h.svc.addComment({ taskId: "t1", author: "claude", content: "consegnato" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    h.finishTurn();
    await p;
    await flush();

    expect(h.turns.length).toBe(1);
    expect(h.task("t1")!.status).toBe("review");
    // Not even a note: nothing happened that is worth telling.
    expect(h.svc.get("t1")!.comments.some((c) => c.kind === "service" && c.content.includes("Feedback arrivato"))).toBe(false);
  });

  it("il feedback imbucato si ANNUNCIA sulla card, una volta sola", async () => {
    // Senza la nota, scrivere a un agent che lavora non produce niente di
    // visibile: il messaggio entra in una Map e ricompare solo a turno finito.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });
    const p = h.dispatcher.resume("t1", "primo giro");
    await flush();

    void h.dispatcher.resume("t1", "primo feedback");
    void h.dispatcher.resume("t1", "secondo feedback");
    await flush();
    const notes = () => h.svc.get("t1")!.comments.filter((c) => c.kind === "service" && c.content.includes("mentre l'agent sta lavorando"));
    expect(notes().length).toBe(1);
    expect(h.events.some((e) => e.type === "task:updated" && e.task?.id === "t1")).toBe(true);

    h.svc.addComment({ taskId: "t1", author: "claude", content: "consegnato" });
    h.finishTurn();
    await p;
    await flush();
    // Consegnati ENTRAMBI, nell'ordine in cui sono stati scritti.
    expect(h.turns.at(-1)!.content).toContain("primo feedback");
    expect(h.turns.at(-1)!.content).toContain("secondo feedback");
  });

  it("se la card è tornata in coda il feedback non si perde: resta nel thread e lo dice", async () => {
    // `wait_for_condition` a metà turno riporta la card a todo col chip
    // `waiting`: non c'è nessun turno da riprendere adesso, e il ramo del
    // resume qui sopra non scatta. Il messaggio è comunque nel thread.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });
    const p = h.dispatcher.resume("t1", "primo giro");
    await flush();

    void h.dispatcher.resume("t1", "guarda anche il caso C");
    await flush();
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "todo" } });
    h.svc.setDispatchState({ taskId: "t1", state: "waiting" });
    h.finishTurn();
    await p;
    await flush();

    expect(h.turns.length).toBe(1);                       // nessun agente svegliato
    expect(h.task("t1")!.dispatchState).toBe("waiting");  // l'attesa dichiarata resta
    const notes = h.svc.get("t1")!.comments.filter((c) => c.kind === "service" && c.content.includes("resta nel thread"));
    expect(notes.length).toBe(1);
  });

  it("resume is a no-op when the task has no bound topic", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: null });
    await h.dispatcher.resume("t1", "hey");
    await flush();
    expect(h.turns.length).toBe(0);
  });

  it("reconcile requeues an orphaned (mid-dispatch) in-progress task whose session is gone, refunding the attempt", async () => {
    const h = harness({ topicExists: () => false });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 1, dispatchState: "working" });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");            // requeued
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchAttempts).toBe(0);       // restart refunds the interrupted attempt
  });

  it("reconcile ALWAYS requeues a restart orphan with no session left (never parks): a restart is not a failure", async () => {
    // Even at the cap, a server restart must not park the task — it rolls the
    // interrupted attempt back and requeues, so deploys can't bounce a healthy
    // task into backlog "per errore".
    const h = harness({ topicExists: () => false });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 3, dispatchState: "working" });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");            // requeued, NOT parked
    expect(t.dispatchAttempts).toBe(2);       // 3 → 2 (refunded), gets a fair retry
  });

  it("un task fermo su una DOMANDA tiene un chip che il recupero orfani ACCETTA", async () => {
    // La regressione che questo test esiste per impedire, trovata da un critico
    // e non da me. La prima versione dell'annuncio scriveva `needs_input` in
    // dispatch_state; ma la porta del recupero orfani e' ACTIVE_DISPATCH_STATES
    // = {working, starting} (task-dispatcher.ts:356, usata a :2052), perche'
    // `needs_input` significava «l'ha messa qui una persona, non toccarla». Un
    // task fermo su un pannello usciva quindi da quella porta: server riavviato
    // — e con TOPICS_SERVER_WATCH=1 basta salvare un file sotto server/ — e
    // restava in_progress PER SEMPRE, senza reattach ne' resume ne' un commento
    // che lo dicesse. Prima della modifica veniva ripreso.
    //
    // L'invariante che lo impedisce: mentre l'attesa e' aperta, lo stato
    // PERSISTITO (l'unica cosa che sopravvive a un riavvio) deve restare uno di
    // quelli che il recupero accetta. Che poi da quello stato il task venga
    // davvero ripreso lo prova il test "reconcile ALWAYS requeues a restart
    // orphan" qui sopra, che parte esattamente da dispatchState: "working".
    const RECUPERABILI = ["working", "starting"];
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const sk = h.turns[0].sessionKey;

    beginAsk(sk);
    await flush();
    expect(RECUPERABILI).toContain(h.task("t1")!.dispatchState ?? "");

    beginPermission(sk, "tool-1"); // anche l'altra porta dell'attesa
    await flush();
    expect(RECUPERABILI).toContain(h.task("t1")!.dispatchState ?? "");

    endAsk(sk);
    endPermission(sk, "tool-1");
    h.dispatcher.shutdown();
  });

  it("reconcile leaves a human-moved bound task alone (chip not active)", async () => {
    // A human dragged a review/done card (dispatch_state null) into In Progress —
    // it's bound but NOT a dead dispatch, so reconcile must not "orphan" it.
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: null });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-live");
  });

  it("reconcile RESUMES a working restart-orphan on its own session (no requeue, no attempt burn)", async () => {
    // KANBAN-10: everything the turn needs survived the restart (topic, worktree,
    // CLI --resume conversation) — only the in-memory driver died. The orphan
    // must continue IN PLACE, never restart from zero on a fresh topic.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");           // never bounced through todo
    expect(t.assignedTopicId).toBe("topic-live");   // SAME topic (same worktree, same conversation)
    expect(t.dispatchAttempts).toBe(1);             // a restart consumes nothing
    expect(t.dispatchState).toBe("working");
    expect(h.topicsCreated.length).toBe(0);         // no fresh topic spawned
    expect(h.turns.length).toBe(1);                 // one continuation turn on the SAME session
    expect(h.turns[0].sessionKey).toBe("topic:" + "topic-live".slice(0, 8));
    expect(h.turns[0].contextMode).toBe("lean");    // envelope already in the session history
    expect(h.turns[0].content).toContain("Resume where you were");
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("riprendo la stessa sessione"))).toBe(true);
  });

  it("reconcile REATTACHES in place (not resume) when a live broker session survived the restart", async () => {
    // ai-bridge: the turn kept running in the detached daemon → adopt it, don't
    // re-run. hasLiveSession true routes to reattach; NO continuation turn fires.
    const reattached: string[] = [];
    const h = harness({
      topicExists: () => true,
      hasLiveSession: async () => true,
      // Stay in-flight (like the harness runTurn) so onTurnEnd doesn't fire and
      // spawn a follow-up — we only assert the REATTACH branch was chosen.
      reattach: (sk: string) => { reattached.push(sk); return new Promise<void>(() => {}); },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    expect(reattached).toEqual(["topic:" + "topic-live".slice(0, 8)]); // adopted in place
    expect(h.turns.length).toBe(0);                 // NO resume/continuation turn
    expect(h.task("t1")!.dispatchAttempts).toBe(1); // a restart consumes nothing
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("ripreso in diretta"))).toBe(true);
  });

  it("reconcile's REATTACH also passes dispatchIdleMin as idleMs, not just the kickoff/resume turns", async () => {
    const reattachOpts: { timeoutMs?: number; idleMs?: number }[] = [];
    const h = harness({
      topicExists: () => true,
      hasLiveSession: async () => true,
      reattach: (_sk: string, opts?: { timeoutMs?: number; idleMs?: number }) => {
        reattachOpts.push(opts ?? {});
        return new Promise<void>(() => {}); // stay in-flight: only the wiring is under test
      },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchTimeoutMin: 30, dispatchIdleMin: 9 });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    expect(reattachOpts).toEqual([{ timeoutMs: 30 * 60_000, idleMs: 9 * 60_000 }]);
  });

  it("runtime NATIVO: un turno interrotto riprende la stessa sessione senza consumare un tentativo", async () => {
    // BARRA-1, riscritta sulla realta' misurata (card f832b25a). Il ramo di
    // riadozione dal broker non e' degradato: e' IRRAGGIUNGIBILE per le card,
    // per costruzione. `hasLiveSession` interroga solo il provider claude-code,
    // le card girano sul runtime nativo `topics`, che non ha `reattach` e la cui
    // rotta risponde `reattach_unsupported`. Un turno nativo vive DENTRO il
    // processo del server: quando il server muore non resta nessun figlio da
    // adottare. Misura: 365 riprese in diretta il 13/08, zero dal 17/08, e 303
    // riprese da capo il 18/08; il muro e' il 16/08, quando le card sono
    // passate al nativo.
    //
    // Quindi la garanzia che va inchiodata NON e' «il figlio sopravvive», che
    // sul nativo non puo' succedere: e' che il turno riparta sulla STESSA
    // sessione (stesso topic, stesso worktree, stessa conversazione) e che il
    // riavvio non venga addebitato all'agent come tentativo fallito.
    const reattached: string[] = [];
    const h = harness({
      topicExists: () => true,
      // Cablati come in produzione: la coppia c'e', ma sul nativo la sonda non
      // trova mai un figlio staccato perche' un figlio staccato non esiste.
      hasLiveSession: async () => false,
      reattach: (sk: string) => { reattached.push(sk); return new Promise<void>(() => {}); },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(reattached).toEqual([]);                 // niente riadozione: sul nativo non c'e' nulla da adottare
    expect(t.dispatchAttempts).toBe(1);             // il riavvio non e' colpa dell'agent: nessun tentativo bruciato
    expect(t.status).toBe("in_progress");           // mai un rimbalzo da todo
    expect(t.assignedTopicId).toBe("topic-live");   // STESSO topic: stesso worktree, stessa conversazione
    expect(h.topicsCreated.length).toBe(0);         // nessun topic nuovo, nessuna ripartenza da zero
    expect(h.turns.length).toBe(1);                 // un solo turno di continuazione
    expect(h.turns[0].sessionKey).toBe("topic:" + "topic-live".slice(0, 8));
    expect(h.turns[0].contextMode).toBe("lean");    // la busta e' gia' nella storia della sessione
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("nessun tentativo consumato"))).toBe(true);
  });

  it("due riavvii ravvicinati sullo stesso task lasciano UNA riga di interruzione", async () => {
    // Il 13/08, sul database vivo, il task ae61fb5a portava quattro note per un
    // riavvio solo: tre «Server ripartito a metà turno» a quindici secondi
    // l'una dall'altra, poi «ripreso in diretta». Ogni scrittore raccontava la
    // sua versione, e la dedupe dei commenti non le vedeva: guarda testo
    // IDENTICO entro dieci secondi, e queste dicono la stessa cosa con parole
    // diverse. Qui le parole cambiano apposta fra i due giri (il broker c'è,
    // poi non c'è più): è il caso che solo la rivendicazione a finestra copre.
    let live = true;
    const h = harness({
      topicExists: () => true,
      hasLiveSession: async () => live,
      reattach: () => new Promise<void>(() => {}),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();
    // Secondo riavvio: processo NUOVO, memoria vuota, stesso DB. È il caso che
    // un insieme in RAM non coprirebbe — chi scrive terzo è appena nato.
    live = false;
    const dopo = h.restart();
    await dopo.reconcile();
    await flush();

    const righe = h.svc.get("t1")!.comments.filter((c) => /ripartit|Riavvio del server/.test(c.content));
    expect(righe.map((c) => c.content)).toEqual(["Riavvio del server: ripreso in diretta, nessun tentativo consumato."]);
    expect(righe[0]!.kind).toBe("service"); // si piega nel fold del thread
  });

  it("reconcile is idempotent under the poll: a resumed turn is never doubled", async () => {
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();
    await h.dispatcher.reconcile(); // the 10s poll fires while the resumed turn is still live
    await flush();

    expect(h.turns.length).toBe(1); // inFlight guard: no double-fire
    expect(h.dispatcher.isInFlight("t1")).toBe(true);
  });

  it("reconcile re-dispatches FRESH a working orphan whose topic died during the downtime", async () => {
    // No session left to resume → the requeue+re-claim path: rollback the
    // interrupted attempt, clear the dead binding, and (dispatch on) re-launch
    // from scratch on a brand-new topic.
    const h = harness({ topicExists: () => false });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-1");                    // FRESH topic, not the dead one
    expect(t.dispatchAttempts).toBe(1);                            // rolled back to 0, re-claim bumped to 1
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].content).toContain("exclusive owner of task"); // kickoff da capo
  });

  it("reconcile with the global switch OFF keeps the orphan's session: no turn starts, nothing is thrown away", async () => {
    // The human turned auto-dispatch off: no agent may relaunch. But the
    // session and the worktree are still there, and on 2026-09-04 03:54 a
    // boot with the switch off requeued twelve cards at once, binding
    // released, eight worktrees with uncommitted work left behind. A switch
    // that is off may stop turns; it may not throw sessions away.
    const h = harness({ topicExists: () => true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");            // never bounced through todo
    expect(t.assignedTopicId).toBe("topic-live");    // SAME session, same worktree
    expect(t.dispatchAttempts).toBe(1);              // a restart consumes nothing, refunds nothing
    expect(t.dispatchState).toBe("queued");          // the chip says it waits, not that it works
    expect(h.turns.length).toBe(0);                  // off: nothing started
    expect(h.topicsCreated.length).toBe(0);          // and no fresh topic
    expect(h.svc.get("t1")!.comments.some((c) => c.author === "system" && c.content.includes("Dispatch spento al riavvio"))).toBe(true);

    // The switch comes back on: the poll resumes the very same session.
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    await h.dispatcher.reconcile();
    await flush();
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:" + "topic-live".slice(0, 8));
    expect(h.turns[0].content).toContain("Resume where you were");
    expect(h.topicsCreated.length).toBe(0);
    h.dispatcher.shutdown();
  });

  it("reconcile LIBERA un orfano fermo su `queued` con la board SPENTA", async () => {
    // Il fantasma misurato l'11/08: sette card in_progress col chip `queued`,
    // ferme da 40 minuti, nessun turno vivo. Nascono da un'attesa che vive in
    // memoria (il rinvio del resume quando il tetto è pieno): il riavvio si
    // porta via il timer e lascia il chip, e la card resta in_progress PER
    // SEMPRE — il recupero orfani la saltava perché guardava solo
    // {working, starting}.
    //
    // The board being off is the hard case: it claims nothing. Since 2026-09-04
    // the card is NOT released any more: its session exists, and releasing it
    // meant a new, empty worktree at redispatch. It stays queued, with the chip
    // saying so and a note saying why, and resumes on the SAME session as soon
    // as the board is switched back on (the poll sees bound + queued + on).
    const h = harness({ topicExists: () => true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "queued" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-live");   // the session is still its own
    expect(t.dispatchAttempts).toBe(1);             // a restart consumes no attempt
    expect(t.dispatchState).toBe("queued");         // the chip tells the truth: it waits
    expect(h.turns.length).toBe(0);                 // off: no agent restarts
    expect(h.svc.get("t1")!.comments.some((c) => c.content.includes("Dispatch spento al riavvio"))).toBe(true);
  });

  it("reconcile RIPRENDE un orfano fermo su `queued` con la board ACCESA, sulla sua sessione", async () => {
    // Same ghost, board on. It used to go through `todo` and come back with a
    // new topic: the worktree with the work stayed behind. Now the card resumes
    // on the SAME session (or re-enters a LIVE slot wait when the cap is full):
    // the invariant holds, no card survives in_progress + `queued` without a
    // turn or a wait in memory.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "queued" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-live");                    // SAME session, same worktree
    expect(t.dispatchAttempts).toBe(1);                              // no attempt consumed
    expect(t.dispatchState).toBe("working");                         // the seat really works
    expect(h.topicsCreated.length).toBe(0);                          // no new topic
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:" + "topic-live".slice(0, 8));
    expect(h.turns[0].content).toContain("Resume where you were");   // a resume, not a kickoff
  });

  it("un'attesa di slot VIVA non è un orfano: reconcile la lascia stare, il riavvio no", async () => {
    // La collisione fra due pezzi che presi da soli sono giusti: il rinvio del
    // resume a tetto pieno lascia la card `in_progress` col chip `queued`, e il
    // recupero orfani ha imparato ad accettare `queued` proprio per liberare le
    // card che quel rinvio si lascia dietro quando il processo muore.
    //
    // Ma un'attesa VIVA non ha un turno, quindi non compare in `inFlight`: da
    // fuori è identica al fantasma. Senza il registro, il poll di reconcile (10s)
    // se la mangerebbe prima ancora che i 5s del ritentativo siano passati — e
    // sarebbe il guasto di prima al contrario: il messaggio dell'umano muore col
    // timer e la card riparte su un topic nuovo.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns.length).toBe(1); // t1 si prende l'unico posto e lo tiene

    // t2 rifiutato in review: il resume non trova posto e si mette in attesa.
    seedTask(h.db, { id: "t2", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.resume("t2", "riprova da qui");
    await flush();
    expect(h.turns.length).toBe(1);                     // il posto è ancora uno
    expect(h.task("t2")!.dispatchState).toBe("queued"); // l'attesa è viva, e lo dice

    // Il poll passa MENTRE l'attesa è viva.
    await h.dispatcher.reconcile();
    await flush();

    const waiting = h.task("t2")!;
    expect(waiting.status).toBe("in_progress");             // non requeuata
    expect(waiting.assignedTopicId).toBe("topic-live");     // stessa sessione: il messaggio è ancora suo
    expect(waiting.dispatchState).toBe("queued");
    expect(waiting.dispatchAttempts).toBe(1);               // nessun tentativo toccato
    expect(h.turns.length).toBe(1);                         // e nessun agente in più
    expect(waiting.dispatchState === "queued" && h.svc.get("t2")!.comments.some((c) => c.content.includes("rimesso in coda"))).toBe(false);

    // Restart: the new process has neither the timer nor the registry. The WAIT
    // died, the SESSION did not: the card resumes on its topic (or waits for a
    // seat again), without passing through todo and without a new worktree.
    const topicsBefore = h.topicsCreated.length;
    const restarted = h.restart();
    await restarted.reconcile({ reason: "boot" });
    await flush();

    const kept = h.task("t2")!;
    expect(kept.status).toBe("in_progress");                // never went through todo
    expect(kept.assignedTopicId).toBe("topic-live");        // same session, same worktree
    expect(kept.dispatchAttempts).toBe(1);                  // a restart consumes no attempt
    expect(h.topicsCreated.length).toBe(topicsBefore);      // no new topic
    expect(h.svc.get("t2")!.comments.some((c) => c.content.includes("aspettava uno slot: riprendo la stessa sessione"))).toBe(true);
    expect(h.svc.get("t2")!.comments.some((c) => c.content.includes("lo rimetto in coda"))).toBe(false);
    restarted.shutdown();
  });

  it("a planned restart DRAINS the fleet: the queue starts nothing, a resume parks on its own session, the next boot resumes it", async () => {
    // `restart-when-idle` waits for zero card turns. With a queue behind a full
    // cap that never came (18,482 s on 2026-09-04): a turn started the second
    // one ended. Draining closes the door; nothing is lost across the boot.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });
    seedTask(h.db, { id: "t2", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    h.dispatcher.drain("restart-when-idle");
    await h.dispatcher.tick(PID);
    await h.dispatcher.resume("t2", "e adesso finisci");
    await flush();

    expect(h.turns.length).toBe(0);                           // the door is closed
    expect(h.task("t1")!.status).toBe("todo");                // still first in line
    expect(h.task("t2")!.status).toBe("in_progress");
    expect(h.task("t2")!.assignedTopicId).toBe("topic-live"); // binding intact
    expect(h.task("t2")!.dispatchState).toBe("queued");
    expect(h.svc.get("t2")!.comments.some((c) => c.content.includes("Riavvio del server in arrivo"))).toBe(true);
    expect(h.dispatcher.busyCount()).toBe(0);                 // what the restart waits on

    // The new process has no drain and no timers: it resumes t2 on its session
    // and picks t1 from the queue.
    const restarted = h.restart();
    await restarted.reconcile({ reason: "boot" });
    await restarted.tick(PID);
    await flush();
    expect(h.turns.some((x) => x.sessionKey === "topic:" + "topic-live".slice(0, 8))).toBe(true);
    expect(h.task("t2")!.assignedTopicId).toBe("topic-live");
    expect(h.task("t1")!.status).toBe("in_progress");
    restarted.shutdown();
  });

  it("un resume che parte EREDITA il messaggio dell'attesa che spegne", async () => {
    // Il registro tiene una attesa sola per task, quindi un resume che trova il
    // posto libero spegne il timer di quella pendente. Il timer aveva in mano un
    // messaggio dell'umano: spegnerlo e basta lo perderebbe — la stessa perdita
    // che il registro esiste per evitare, solo per un'altra strada. Va dove
    // vanno i messaggi arrivati a turno vivo, e `onTurnEnd` lo consegna.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();

    seedTask(h.db, { id: "t2", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.resume("t2", "il PRIMO messaggio");
    await flush();
    expect(h.turns.length).toBe(1); // in attesa: il posto è di t1

    // Si libera posto (il tetto sale) e arriva un secondo messaggio.
    h.svc.setGlobalCap({ auto: false, max: 5 });
    void h.dispatcher.resume("t2", "il SECONDO messaggio"); // parte davvero: il turno resta in volo
    await flush();
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].content).toContain("il SECONDO messaggio");

    // E il primo non è morto col timer: arriva col turno successivo.
    h.finishTurn();
    await flush();
    expect(h.turns.length).toBe(3);
    expect(h.turns[2].content).toContain("il PRIMO messaggio");
  });

  it("reconcile requeues a starting orphan (kickoff may never have reached the CLI)", async () => {
    // Crash in the claim→bind window: there may be NO session to resume, so a
    // clean re-claim beats resuming into a possibly-empty conversation.
    const h = harness({ topicExists: () => true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: null, attempts: 1, dispatchState: "starting" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("todo");        // auto off here → waits in todo
    expect(t.dispatchAttempts).toBe(0);   // refunded
    expect(h.turns.length).toBe(0);
  });

  it("reconcile resume at the retry cap delivers the last-chance nudge (a restart never parks)", async () => {
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true }); // default retry cap = 2
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 2, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");     // resumed, not parked
    expect(t.dispatchAttempts).toBe(2);       // still no burn
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].content).toContain("LAST TURN"); // budget exhausted → deliver-now nudge
  });

  it("launch parks (not requeues) when setup fails and attempts are exhausted", async () => {
    const h = harness({ createWorktree: async () => { throw new Error("git worktree add failed"); } });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo", attempts: 2 }); // claim bumps to 3 = cap
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");   // parked, not stranded in todo
    expect(t.dispatchState).toBe("failed");
    expect(t.dispatchError).toContain("fallito");
    expect(h.turns.length).toBe(0);
  });

  it("parks todos with a visible reason when the board can't be resolved", async () => {
    const h = harness({ resolveProject: () => null });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo", dispatchState: "queued" });
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");                       // parked, not stranded on "queued"
    expect(t.dispatchState).toBe("blocked");                // config issue, human must fix
    expect(t.dispatchError).toContain("directory del progetto");
    expect(h.turns.length).toBe(0);
    // The reason is also in the thread, so the human sees WHY from the card.
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.content.includes("directory del progetto"))).toBe(true);
  });

  // dispatchIdleMin: the stall detector's silence threshold, wired next to
  // dispatchTimeoutMin (now reporting-only) on EVERY runTurn call — kickoff
  // and resume both. Without this wiring, the host would fall back to its own
  // default and the board's setting would silently do nothing.
  it("passes dispatchIdleMin as idleMs on both the kickoff turn and a resume", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchTimeoutMin: 30, dispatchIdleMin: 7 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].timeoutMs).toBe(30 * 60_000);
    expect(h.turns[0].idleMs).toBe(7 * 60_000);

    h.finishTurn(); // continuation → goes through resume()'s own settings read
    await flush();
    expect(h.turns[1].idleMs).toBe(7 * 60_000);
  });

  it("passes the board's dispatch effort to the agent topic", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchEffort: "max" });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated[0].effort).toBe("max");
  });

  it("kickoff instructs update_task with the real tool signature (no project_id)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain('update_task(task_id="t1", status="review")');
    expect(h.turns[0].content).not.toContain("project_id");
  });

  it("plan-first kickoff demands a plan in review BEFORE implementing", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, text: "refactor grosso", status: "todo", planFirst: true });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain("PLAN FIRST");
    expect(h.turns[0].content).toContain("Approva il piano");
    // A normal task never carries the plan contract.
    const h2 = harness();
    h2.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h2.db, { id: "t1", status: "todo" });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.turns[0].content).not.toContain("PLAN FIRST");
  });

  it("kickoff teaches the step checklist (nested subtasks, self-closable) and the tab+file delivery model", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const kickoff = h.turns[0].content;
    expect(kickoff).toContain('parent_task_id="t1"');
    expect(kickoff).toContain('status="done"'); // marca ogni step done
    expect(kickoff).toContain("ALL your steps must be done");
    // Consegna = tab del task + file consegnati, niente concetto "Output":
    // l'agente deve sapere che una pagina viva si apre come TAB, non si dichiara
    // come url in un campo a parte.
    expect(kickoff).toContain("open_browser_pane");
    expect(kickoff).toContain("DELIVERED FILES");
    expect(kickoff).not.toContain("output_url");
  });

  /**
   * Il gemello del test omonimo in `task-dispatcher-fanout.test.ts`: qui la board
   * NON dichiara `reviewChecks` (nessuna board lo faceva l'11/08, ed è per questo
   * che tre card di fila hanno lasciato main con `check:deadcode` rosso).
   */
  it("kickoff nomina i QUATTRO cancelli e la regola dello script che nessuno importa", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const kickoff = h.turns[0].content;
    for (const gate of ["typecheck", "lint", "check:deadcode", "test:unit"]) expect(kickoff).toContain(gate);
    expect(kickoff).toContain("knip.jsonc");
    expect(kickoff).toContain("scripts/disk-report.ts!");
  });

  /**
   * Il bump di versione è UN comando, e il kickoff lo nomina.
   *
   * `tests/unit/version-lockstep.test.ts` prendeva già i bump fatti a mano — due
   * volte nella notte dell'11-12/08, sul `Cargo.lock` entrambe le volte — ma un
   * cancello che non nomina il rimedio si paga con un riallineamento a mano ogni
   * volta. I nomi si scrivono qui a mano, non interpolati da `VERSION_BUMP_RULE`.
   */
  it("kickoff nomina il GESTO del bump (un comando), non i file da aprire", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const kickoff = h.turns[0].content;
    expect(kickoff).toContain("bun run bump");
    expect(kickoff).toContain("bun run bump sync");
    expect(kickoff).toContain("lockfile");
  });

  it("kickoff carries the OPEN subtasks already on the board (accorpare non fa sparire il lavoro)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    seedTask(h.db, { id: "kid1", status: "todo", parentTaskId: "t1", text: "cassetto cookie al contrario" });
    seedTask(h.db, { id: "kid2", status: "done", parentTaskId: "t1", text: "già chiuso" });
    await h.dispatcher.tick(PID);
    await flush();
    const kickoff = h.turns[0].content;
    expect(kickoff).toContain("cassetto cookie al contrario");
    expect(kickoff).toContain("[kid1]");
    expect(kickoff).toContain("1 open subtask(s)");
    // I figli chiusi sono storia: ripassarli invita a rifarli.
    expect(kickoff).not.toContain("già chiuso");
  });

  it("kickoff names the files attached to the card (a task born with a screenshot)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    // The board composer writes them like this at birth: a human comment
    // carrying the paths. Without the kickoff line the agent reads "as in the
    // picture" and has no picture.
    h.svc.addComment({ taskId: "t1", author: "human", content: "Allegati al task.", media: ["/tmp/shot.png"] });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain("/tmp/shot.png");
  });

  it("buffers a resume landing while the turn is in flight and delivers it on the same tab at turn end", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // Agent delivers to review mid-turn (the turn has NOT ended yet)…
    h.svc.addComment({ taskId: "t1", author: "claude", content: "fatto" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    // …and the human answers in that window: reject + resume (the route path).
    h.svc.reviewDecision({ taskId: "t1", by: "user", decision: "reject", comment: "aggiusta X" });
    void h.dispatcher.resume("t1", "aggiusta X");
    await flush();
    expect(h.turns.length).toBe(1); // buffered, not dropped, not double-run
    h.finishTurn();
    await flush();
    await new Promise((r) => setTimeout(r, 10)); // deferred delivery tick
    await flush();
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].content).toContain("aggiusta X");
    expect(h.turns[1].sessionKey).toBe("topic:" + "topic-1".slice(0, 8)); // SAME tab
    expect(h.task("t1")!.status).toBe("in_progress"); // not requeued as an orphan
  });

  it("onEnterTodo re-dispatches a task dragged back from review (clears stale binding)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    // Bound task now sitting in todo (human dragged it back from review).
    seedTask(h.db, { id: "t1", status: "todo", assignedTopicId: "topic-old", dispatchState: "needs_input" });
    h.dispatcher.onEnterTodo(PID, "t1");
    // Binding cleared immediately so it's eligible for a fresh claim.
    expect(h.task("t1")!.assignedTopicId).toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.task("t1")!.assignedTopicId).toBe("topic-1"); // fresh topic, not the old one
  });
});

describe("blocked-by + context reuse", () => {
  it("a blocked todo WAITS: no claim, no queued chip; onBlockerDone dispatches it", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const a = h.svc.create({ projectId: PID, status: "todo", text: "blocker" });
    const b = h.svc.create({ projectId: PID, status: "todo", text: "dependent", blockedByTaskId: a.id });
    // Blocker parked out of the way (only b is an eligible todo).
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "backlog" } });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task(b.id)!.status).toBe("todo");        // untouched, still waiting
    expect(h.task(b.id)!.dispatchState).toBeNull();    // no stranded "queued" chip
    expect(h.turns.length).toBe(0);
    // onEnterTodo on a blocked task is a no-op too (no chip, no grace timer).
    h.dispatcher.onEnterTodo(PID, b.id);
    expect(h.task(b.id)!.dispatchState).toBeNull();
    // Blocker completes → the nudge dispatches the dependent.
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    h.dispatcher.onBlockerDone(a.id);
    await new Promise((r) => setTimeout(r, 30)); // grace (10ms in harness) + tick
    await flush();
    expect(h.task(b.id)!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
  });

  it("a dependent that ALREADY DELIVERED is not re-dispatched by onBlockerDone", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const a = h.svc.create({ projectId: PID, status: "todo", text: "blocker" });
    const b = h.svc.create({ projectId: PID, status: "todo", text: "already delivered", blockedByTaskId: a.id });
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "backlog" } });
    // b carries the marks of a finished job: a delivery commit, and a landing
    // verdict saying the content is on main.
    h.db.prepare("UPDATE tasks SET delivery_commit = 'abc1234', landing_state = 'landed' WHERE id = ?").run(b.id);
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    h.dispatcher.onBlockerDone(a.id);
    await new Promise((r) => setTimeout(r, 30)); // grace (10ms in harness) + tick
    await flush();
    expect(h.task(b.id)!.status).toBe("todo");      // no claim
    expect(h.task(b.id)!.landingState).toBe("landed"); // and the git fact survives
    expect(h.turns.length).toBe(0);
  });

  it("reuseBlockerContext rides the blocker's topic (no fresh topic/worktree)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const a = h.svc.create({ projectId: PID, status: "todo", text: "blocker" });
    const b = h.svc.create({ projectId: PID, status: "todo", text: "dependent", blockedByTaskId: a.id, reuseBlockerContext: true });
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "backlog" } });
    // The blocker worked in its own topic and was approved to done.
    h.db.run("INSERT OR IGNORE INTO topics (id) VALUES ('topic-blocker')");
    h.svc.bindTopic({ taskId: a.id, topicId: "topic-blocker" });
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task(b.id)!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-blocker");   // SAME conversation
    expect(h.topicsCreated.length).toBe(0);             // no fresh topic
    expect(h.worktreesCreated.length).toBe(0);          // topic carries its own cwd
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:topic-bl"); // topic:<id8>
    expect(h.turns[0].content).toContain("SAME session as the previous one");
  });

  it("passes the task's model override to the fresh agent topic", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, status: "todo", text: "with model", model: "claude-fable-5" });
    await h.dispatcher.tick(PID);
    await flush();
    expect((h.topicsCreated[0] as any).model).toBe("claude-fable-5");
  });

  it("auto model: calls the classifier and passes its pick to the fresh topic", async () => {
    const picked: string[] = [];
    const h = harness({
      pickAutoModel: async (t) => { picked.push(t.text); return { model: "claude-opus-4-8" }; },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, status: "todo", text: "refactor pesante" }); // model null = auto
    await h.dispatcher.tick(PID);
    await flush();
    expect(picked).toEqual(["refactor pesante"]);
    expect((h.topicsCreated[0] as any).model).toBe("claude-opus-4-8");
  });

  it("auto model: an EXPLICIT model skips the classifier entirely", async () => {
    let called = false;
    const h = harness({
      pickAutoModel: async () => { called = true; return { model: "claude-opus-4-8" }; },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, status: "todo", text: "chosen", model: "claude-haiku-4-5" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(called).toBe(false);
    expect((h.topicsCreated[0] as any).model).toBe("claude-haiku-4-5");
  });

  it("auto model: a null pick keeps the provider default (undefined model, dispatch not blocked)", async () => {
    const h = harness({ pickAutoModel: async () => ({ model: null }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, status: "todo", text: "auto" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task(h.svc.list({ scope: "project", projectId: PID })[0].id)!.status).toBe("in_progress");
    expect((h.topicsCreated[0] as any).model).toBeUndefined();
  });

  it("auto model: a vague task still selects a model but never flips plan-first (opt-in only)", async () => {
    const h = harness({ pickAutoModel: async () => ({ model: "claude-sonnet-5" }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const created = h.svc.create({ projectId: PID, status: "todo", text: "sistema la roba" }); // vague, model auto
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task(created.id)!;
    // The classifier's model is still applied…
    expect((h.topicsCreated[0] as any).model).toBe("claude-sonnet-5");
    // …and a vague task no longer forces plan-first: that's opt-in now.
    expect(t.planFirst).toBe(false);
    expect(h.turns[0].content).not.toContain("PLAN FIRST");
    const comments = h.svc.get(created.id)!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("plan-first"))).toBe(false);
  });

  it("auto model: an explicit model skips the classifier entirely (no auto plan-first)", async () => {
    // Explicit model → classifier never runs.
    let called = false;
    const h = harness({ pickAutoModel: async () => { called = true; return { model: "x" }; } });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const created = h.svc.create({ projectId: PID, status: "todo", text: "chiaro", model: "claude-haiku-4-5" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(called).toBe(false);
    expect(h.task(created.id)!.planFirst).toBe(false);
  });
});

describe("priority", () => {
  it("serves the queue by priority (4 first), age as tie-break", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    // Global cap of 1 (see "respects the concurrency cap") so exactly one task
    // wins this tick and priority ordering — not the cap — decides which.
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "old-low", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    const urgent = h.svc.create({ projectId: PID, status: "todo", text: "fuoco", priority: 4 });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task(urgent.id)!.status).toBe("in_progress"); // newer but urgent wins
    expect(h.task("old-low")!.status).toBe("todo");
  });

  it("kickoff asks the agent to set the priority ONLY when nobody chose one", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    const auto = h.svc.create({ projectId: PID, status: "todo", text: "senza priorità" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain("AUTOMATIC PRIORITY");
    h.finishTurn(); await flush();
    const h2 = harness();
    h2.svc.updateBoardSettings(PID, { autoDispatch: true });
    h2.svc.create({ projectId: PID, status: "todo", text: "scelta umana", priority: 3 });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.turns[0].content).not.toContain("AUTOMATIC PRIORITY");
    expect(auto.priorityAuto).toBe(true);
  });

  describe("external-session guard", () => {
    const intruder = [{ cwd: "/Users/x/Projects/alpha", branch: "main" }];

    it("HOLDS in-place dispatch (queued chip + one note), then RESUMES by itself when the repo frees", async () => {
      let sessions: Array<{ cwd: string; branch: string | null }> = intruder;
      const h = harness({ externalSessionsAt: () => sessions });
      h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
      seedTask(h.db, { id: "t1", status: "todo" });

      await h.dispatcher.tick(PID);
      await flush();

      const t = h.task("t1")!;
      expect(t.status).toBe("todo");            // held, never claimed
      expect(t.dispatchState).toBe("queued");   // a visible hold, not a silent skip
      expect(h.turns.length).toBe(0);
      const notes = h.svc.get("t1")!.comments.filter((c) => c.author === "system");
      expect(notes.length).toBe(1);
      expect(notes[0].content).toContain("sessione Claude esterna viva");
      expect(notes[0].content).toContain("riparte da solo");

      // Still busy next tick → no duplicate note (one per hold episode).
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.svc.get("t1")!.comments.filter((c) => c.author === "system").length).toBe(1);

      // Repo frees → the next reconcile tick dispatches with NO human touch.
      sessions = [];
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.task("t1")!.status).toBe("in_progress");
      expect(h.turns.length).toBe(1);
    });

    it("notes AGAIN on a NEW hold episode after the repo freed in between", async () => {
      let sessions: Array<{ cwd: string; branch: string | null }> = intruder;
      const h = harness({ externalSessionsAt: () => sessions });
      h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
      // Global cap 1: on the free tick t1 is claimed, t2 stays in todo — the
      // surviving todo is the one that can experience a SECOND hold episode.
      h.svc.setGlobalCap({ auto: false, max: 1 });
      seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
      seedTask(h.db, { id: "t2", status: "todo" });

      await h.dispatcher.tick(PID); await flush();  // hold #1 → both noted
      sessions = [];
      await h.dispatcher.tick(PID); await flush();  // free: episodes cleared, t1 claimed (cap 1)
      expect(h.task("t1")!.status).toBe("in_progress");
      expect(h.task("t2")!.status).toBe("todo");
      // Different branch → different wording, so the svc's short-window comment
      // dedupe (same author+content) can't mask the second note.
      sessions = [{ cwd: "/Users/x/Projects/alpha", branch: "feature" }];
      await h.dispatcher.tick(PID); await flush();  // hold #2 → t2 noted a SECOND time
      // Si contano le note DELLA sessione esterna, non tutte quelle di servizio:
      // sul tick libero t1 si è preso l'unico posto, quindi t2 ha incassato
      // anche la riga del tetto pieno, che è un'altra attesa e la dice da sé.
      const esterne = h.svc.get("t2")!.comments.filter((c) => c.author === "system" && c.content.includes("sessione Claude esterna viva"));
      expect(esterne.length).toBe(2);
    });

    it("in-place dispatch on a FREE repo is untouched by the guard", async () => {
      const h = harness({ externalSessionsAt: () => [] });
      h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
      seedTask(h.db, { id: "t1", status: "todo" });

      await h.dispatcher.tick(PID);
      await flush();

      expect(h.task("t1")!.status).toBe("in_progress");
      expect(h.turns.length).toBe(1);
    });

    it("worktree dispatch PROCEEDS but warns in the thread (isolated files, contended branch)", async () => {
      const h = harness({ externalSessionsAt: () => intruder });
      h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true });
      seedTask(h.db, { id: "t1", status: "todo" });

      await h.dispatcher.tick(PID);
      await flush();

      expect(h.task("t1")!.status).toBe("in_progress");
      expect(h.turns.length).toBe(1);
      const notes = h.svc.get("t1")!.comments.filter((c) => c.author === "system");
      expect(notes.some((c) => c.content.includes("sessione Claude esterna viva"))).toBe(true);
    });

    it("no warning when the repo is free", async () => {
      const h = harness({ externalSessionsAt: () => [] });
      h.svc.updateBoardSettings(PID, { autoDispatch: true });
      seedTask(h.db, { id: "t1", status: "todo" });

      await h.dispatcher.tick(PID);
      await flush();

      expect(h.svc.get("t1")!.comments.some((c) => c.content.includes("esterna"))).toBe(false);
    });

    it("a throwing probe never blocks dispatch (fail-open on a broken census)", async () => {
      const h = harness({ externalSessionsAt: () => { throw new Error("fs gone"); } });
      h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
      seedTask(h.db, { id: "t1", status: "todo" });

      await h.dispatcher.tick(PID);
      await flush();

      expect(h.task("t1")!.status).toBe("in_progress");
    });
  });
});

/**
 * Il buco che questa rete chiude: `inFlight` è SOLO memoria. Se il server resta
 * vivo ma la sessione sotto muore senza che la promise del turno settli mai, il
 * task è invisibile a ogni sweep (`reconcile` salta tutto ciò che è inFlight) e
 * la card resta ferma su `working` fino al wall-clock — 20 minuti nel caso
 * migliore. Qui la memoria viene incrociata con la liveness reale del processo.
 *
 * Il contrappeso, altrettanto testato: un agente che pensa a lungo è MUTO ma
 * vivo, e un reaper a inattività aveva già ucciso turni vivi (fix 1790f859). Da
 * qui l'isteresi a due sweep, la grazia sui run appena nati e la regola che
 * "non lo so" non è mai "è morto".
 */
describe("task-dispatcher — rete di sicurezza sulla liveness", () => {
  /** Harness + un interruttore sulla liveness del processo (il probe del provider). */
  function liveness(initial: boolean | null = true, extra: Partial<DispatcherDeps> = {}) {
    const probe = { alive: initial as boolean | null, calls: 0 };
    const h = harness({
      // La grazia protegge la finestra di spawn, non il test: qui i turni
      // nascono già "vecchi" così lo sweep può giudicarli subito.
      livenessGraceMs: 0,
      isTurnAlive: () => { probe.calls++; return probe.alive; },
      ...extra,
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    return { ...h, probe };
  }

  /** Un task dispatchato e col turno APERTO (la promise non settla mai). */
  async function dispatched(h: ReturnType<typeof liveness>) {
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);
  }

  const deathNote = (h: ReturnType<typeof liveness>) =>
    h.svc.get("t1")!.comments.some((c) => c.author === "system" && c.content.includes("sessione dell'agent è morta"));

  it("un sweep solo NON tocca niente, due sweep consecutivi recuperano il task", async () => {
    const h = liveness(true);
    await dispatched(h);

    h.probe.alive = false;
    await h.dispatcher.reconcile();
    await flush();
    // Primo sweep: sospetto, non sentenza.
    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);
    expect(deathNote(h)).toBe(false);
    expect(h.task("t1")!.dispatchAttempts).toBe(1);

    await h.dispatcher.reconcile();
    await flush();
    // Secondo sweep: il turno è chiuso e il task riprende sulla STESSA sessione.
    expect(deathNote(h)).toBe(true);
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.task("t1")!.assignedTopicId).toBe("topic-1"); // stesso tab, stesso worktree
    expect(h.task("t1")!.dispatchAttempts).toBe(2);
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].sessionKey).toBe("topic:topic-1");
    expect(h.turns[1].contextMode).toBe("lean");
    expect(h.dispatcher.isInFlight("t1")).toBe(true); // il run nuovo tiene lo slot
  });

  it("una sessione VIVA ma muta non viene mai toccata (pensare a lungo non è morire)", async () => {
    const h = liveness(true);
    await dispatched(h);

    for (let i = 0; i < 5; i++) { await h.dispatcher.reconcile(); await flush(); }

    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);          // nessun turno nuovo: quello vivo prosegue
    expect(h.task("t1")!.dispatchAttempts).toBe(1);
    expect(deathNote(h)).toBe(false);
    expect(h.probe.calls).toBeGreaterThan(0); // il probe è stato davvero interrogato
  });

  it("'non lo so' non è 'è morto': un probe che non sa non seppellisce nulla", async () => {
    const h = liveness(null);
    await dispatched(h);

    for (let i = 0; i < 5; i++) { await h.dispatcher.reconcile(); await flush(); }

    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);
    expect(deathNote(h)).toBe(false);
  });

  it("un probe che LANCIA vale 'non lo so' (fail-safe, mai un turno ucciso su un errore)", async () => {
    const h = liveness(true, { isTurnAlive: () => { throw new Error("provider gone"); } });
    await dispatched(h);

    for (let i = 0; i < 5; i++) { await h.dispatcher.reconcile(); await flush(); }

    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);
    expect(deathNote(h)).toBe(false);
  });

  it("un run appena nato è immune: il figlio può non essere ancora spawnato", async () => {
    // Grazia lunga = ogni turno di questo test è "giovane": il provider non ha
    // ancora registrato il processo (assemblaggio del contesto) e rispondere
    // 'morto' è normale, non una sentenza.
    const h = liveness(false, { livenessGraceMs: 60_000 });
    await dispatched(h);

    for (let i = 0; i < 5; i++) { await h.dispatcher.reconcile(); await flush(); }

    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);
    expect(deathNote(h)).toBe(false);
  });

  it("un sweep vivo AZZERA il sospetto: due morti NON consecutive non bastano", async () => {
    const h = liveness(true);
    await dispatched(h);

    h.probe.alive = false;
    await h.dispatcher.reconcile(); await flush();  // sospetto 1
    h.probe.alive = true;
    await h.dispatcher.reconcile(); await flush();  // vivo → azzerato
    h.probe.alive = false;
    await h.dispatcher.reconcile(); await flush();  // sospetto 1 di nuovo, non 2

    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);
    expect(deathNote(h)).toBe(false);
  });

  it("il task sepolto NON riceve anche il recupero da riavvio (una morte, una nota)", async () => {
    const h = liveness(true);
    await dispatched(h);

    h.probe.alive = false;
    await h.dispatcher.reconcile(); await flush();
    await h.dispatcher.reconcile(); await flush();

    const notes = h.svc.get("t1")!.comments.filter((c) => c.author === "system");
    expect(notes.some((c) => c.content.includes("Il server è ripartito"))).toBe(false);
    expect(notes.filter((c) => c.content.includes("sessione dell'agent è morta")).length).toBe(1);
  });

  it("lo zombie che settla DOPO non contabilizza due volte né sfratta il run nuovo", async () => {
    // Il turno morto resta appeso finché il wall-clock non lo taglia, minuti dopo:
    // quando finalmente settla, il task ha già un altro run vivo addosso.
    const resolvers: Array<() => void> = [];
    const h = liveness(true, {
      runTurn: (sessionKey, content, opts) =>
        new Promise<void>((res) => {
          (h as any).turns.push({ sessionKey, content, contextMode: opts?.contextMode });
          resolvers.push(res);
        }),
    });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(resolvers.length).toBe(1);

    h.probe.alive = false;
    await h.dispatcher.reconcile(); await flush();
    await h.dispatcher.reconcile(); await flush();
    expect(resolvers.length).toBe(2);                 // il run di recupero è partito
    expect(h.task("t1")!.dispatchAttempts).toBe(2);

    // Ora il primo turno (lo zombie) settla finalmente.
    resolvers[0]!();
    await flush();

    expect(h.dispatcher.isInFlight("t1")).toBe(true); // lo slot è ancora del run nuovo
    expect(h.task("t1")!.dispatchAttempts).toBe(2);   // nessun secondo onTurnEnd
    expect(resolvers.length).toBe(2);                 // e nessun terzo turno
    expect(h.task("t1")!.status).toBe("in_progress");
  });

  it("senza il probe la rete è spenta: il comportamento resta quello di prima", async () => {
    const h = harness();                              // niente isTurnAlive
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    for (let i = 0; i < 5; i++) { await h.dispatcher.reconcile(); await flush(); }

    expect(h.dispatcher.isInFlight("t1")).toBe(true);
    expect(h.turns.length).toBe(1);
  });

  it("budget esaurito: la sessione morta consegna il lavoro all'umano invece di riprovare a vuoto", async () => {
    const h = liveness(true);
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 1 });
    await dispatched(h);
    // L'agente aveva lavorato e commentato prima di morire: la consegna di
    // sistema deve portarlo in review, non parcheggiarlo come fallito.
    h.svc.addComment({ taskId: "t1", author: "claude", content: "Fatto metà lavoro." });

    h.probe.alive = false;
    await h.dispatcher.reconcile(); await flush();
    await h.dispatcher.reconcile(); await flush();

    expect(h.task("t1")!.status).toBe("review");
    expect(h.turns.length).toBe(1);                   // nessun turno in più: budget finito
    expect(h.dispatcher.isInFlight("t1")).toBe(false); // slot libero
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La regola dell'anteprima vive in UN posto solo.
//
// Era scritta cinque volte — protocollo, kickoff, resume, schema del tool MCP,
// commento del componente — e divergeva: gli envelope dicevano DUE rami
// (UI statica → screenshot, UI dinamica → video), così una consegna senza
// superficie renderizzata (un piano, un'architettura) cadeva nel ramo
// «statica» e l'agente fotografava il documento. Ora la stringa è
// `PREVIEW_RULE` in shared/board.ts e questi test sono ciò che impedisce alla
// sesta copia di nascere.
// ─────────────────────────────────────────────────────────────────────────────
describe("PREVIEW_RULE — una stringa sola, in tutti gli envelope", () => {
  it("il kickoff porta la regola VERBATIM (tre rami, non due)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    const kickoff = h.turns[0].content;
    // Estratta per STRUTTURA (dalla riga «REVIEW EVIDENCE» a «One single
    // gate»), non cercando la costante: un test che cerca la stringa che ha
    // appena interpolato non può fallire.
    const kickoffPreviewRule = extractPreviewRule(kickoff);
    expect(kickoffPreviewRule).toBe(PREVIEW_RULE);
    // E una sola volta: due blocchi nello stesso envelope sarebbero già la
    // divergenza che ricomincia.
    expect(kickoff.split(PREVIEW_RULE).length - 1).toBe(1);
    expect(kickoff).toContain("· DIAGRAM");
    expect(kickoff).not.toContain("UI STATICA");   // il vecchio ramo a due vie è sparito
    expect(kickoff).not.toContain("· DIAGRAMMA");  // e nemmeno la versione italiana
  });

  it("il resume porta la STESSA regola, non un riassunto che perde un ramo", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });

    void h.dispatcher.resume("t1", "riprendi");
    await flush();

    const resumePreviewRule = extractPreviewRule(h.turns[0].content);
    expect(resumePreviewRule).toBe(PREVIEW_RULE);
  });

  it("lo schema del tool MCP `update_task.preview_image` È la regola", () => {
    const updateTask = toolsForProfile("dispatch").find((t) => t.name === "update_task");
    const mcpToolSchema = updateTask!.inputSchema.properties as Record<string, { description: string }>;
    expect(mcpToolSchema.preview_image.description).toBe(PREVIEW_RULE);
  });

  it("i criteri sono MISURABILI: la soglia della card esce dal numero, non da un aggettivo", () => {
    // 0.7 = il tetto `max-h-[min(70cqw,320px)] object-cover` della card. Era
    // 144/268 quando il tetto era un'altezza fissa: un numero vero in una sola
    // larghezza di colonna su tre. Se qualcuno cambia il layout e non la
    // costante, la regola mente agli agenti.
    expect(PREVIEW_CARD_MAX_RATIO).toBeCloseTo(0.7, 3);
    expect(PREVIEW_RULE).toContain(PREVIEW_CARD_MAX_RATIO.toFixed(2));
    expect(PREVIEW_RULE).toContain("≤20s");        // il tetto del video
    expect(PREVIEW_RULE).toContain("TWO OR MORE STATES"); // il criterio del ramo video
  });

  it("la soglia del protocollo È il CSS della card, non un numero che gli somiglia", () => {
    // Il buco che questo chiude: la costante e la classe Tailwind vivevano in
    // due file e nessuno le confrontava, quindi `max-h-36` poteva restare 144px
    // mentre `PREVIEW_CARD_MAX_RATIO` diceva tutt'altro — ed è esattamente ciò
    // che era successo. Qui il tetto scritto nel componente si legge e si
    // misura contro le costanti che il protocollo dà agli agenti.
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "client", "src", "components", "Board", "PreviewMedia.tsx"),
      "utf-8",
    );
    const ratio = /max-h-\[(\d+)cqw\]/.exec(src);
    expect(ratio, "il tetto della card deve essere un rapporto in `cqw`").not.toBeNull();
    expect(Number(ratio![1]) / 100).toBeCloseTo(PREVIEW_CARD_MAX_RATIO, 3);

    // NESSUN tetto in larghezza: la miniatura riempie la card. Una fascia vuota
    // a destra in una colonna larga si legge come un difetto (Attilio, 12/08),
    // e il rapporto da solo tiene già la promessa fatta agli agenti. Questa
    // asserzione presidia il verso: se qualcuno rimette un `max-w` in px sul
    // riquadro, il rapporto smette di valere a ogni larghezza e il numero del
    // protocollo torna vero solo in certe colonne.
    expect(/max-w-\[(\d+)px\]/.test(src), "nessun tetto in px sul riquadro dell'anteprima").toBe(false);

    // `cqw` senza un contenitore dichiarato risale al VIEWPORT: il tetto
    // tornerebbe a guardare la finestra invece del riquadro, in silenzio.
    expect(src).toContain("@container");
  });

  it("promoteReviewPreview non scrive piu' il paragrafo istruttivo nel thread", () => {
    // Prima scriveva «Consegna SENZA anteprima» nel thread dell'umano:
    // 39 copie nel DB (18/08), 26 card distinte. Il pubblico era sbagliato:
    // istruzioni operative recapitate a chi decide, che non puo' eseguirle.
    // La regola vive ora nell'envelope dell'agente (PREVIEW_RULE).
    const db = freshDb();
    const PID_LOCAL = "proj-preview-test";
    db.run("INSERT INTO topics (id) VALUES ('topic-x')");
    const svc = createTaskService(db, { now: () => new Date().toISOString(), uuid: () => `upr-${Math.random()}` });
    const t = svc.create({ projectId: PID_LOCAL, text: "consegna senza allegati" });
    svc.addComment({ taskId: t.id, author: "claude", content: "cinque cancelli verdi" });
    svc.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });

    const notes = (db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'review-note'").all(t.id) as Array<{ content: string }>)
      .map((r) => r.content);
    expect(notes.some((n) => n.includes("Consegna SENZA anteprima"))).toBe(false);
    expect(notes).toHaveLength(0);
  });

  it("nessuna sesta copia: il testo dei rami esiste solo in shared/board.ts", () => {
    // Il marcatore è una riga della costante. Chi riscrive la regola a mano in
    // un altro file la ricopia quasi certamente da qui — e questo test lo vede.
    const MARK = "· DIAGRAM .svg";
    const roots = ["server", "scripts", "shared", "client/src"];
    const repo = join(import.meta.dir, "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        if (readFileSync(p, "utf8").includes(MARK)) hits.push(p.slice(repo.length + 1));
      }
    };
    for (const r of roots) walk(join(repo, r));
    expect(hits.sort()).toEqual(["server/services/task-dispatcher.test.ts", "shared/board.ts"]);
  });
});

describe("la coda deve dire il vero", () => {
  it("budget finito = parcheggiata con la ragione, non ferma in coda a fingersi lavorabile", async () => {
    // Misurato l'11/08: 19 card in colonna «coda», interruttore acceso, macchina
    // libera, zero agenti. Il tick le scartava in silenzio perché avevano finito
    // i tentativi — nessun chip, nessuna riga — e il board contava come lavoro
    // ciò che era fermo per sempre.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 2 });
    seedTask(h.db, { id: "t1", status: "todo", attempts: 2 });
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");        // fuori dalla coda
    expect(t.dispatchState).toBe("failed");  // e lo dice
    const riga = h.svc.get("t1")!.comments.map((c) => c.content).join("\n");
    expect(riga).toContain("Budget dei tentativi finito");
    // La riga dice cosa è successo e cosa fare. NON manda a cercare un guasto:
    // «guarda cosa lo fa fallire» presumeva un difetto da trovare, e ci finiva
    // dentro anche chi aveva soltanto dichiarato due attese.
    expect(riga).toContain("senza arrivare in review");
    expect(riga).toContain("Rimettilo in Todo");
    expect(riga).not.toContain("guarda cosa lo fa fallire");
    expect(h.turns.length).toBe(0);          // nessun turno sprecato
  });

  it("…ma chi ASPETTA non è esaurito: la finestra scorre, il parcheggio no", async () => {
    // L'11/08, dal vivo: un agente aveva dichiarato «UAT su CI, 8 shard, ~14
    // minuti, riprovo fra 15» e il parcheggio degli esauriti — messo prima del
    // cancello dell'attesa — l'ha ucciso mentre la finestra scorreva. Il bound
    // sugli aspettatori eterni resta: scatta quando la finestra è passata.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 2 });
    seedTask(h.db, { id: "t1", status: "todo", attempts: 2, dispatchState: "waiting" });
    const fra10min = new Date(Date.now() + 10 * 60_000).toISOString();
    h.db.run("UPDATE tasks SET dispatch_deferred_until = ? WHERE id = ?", [fra10min, "t1"]);
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");            // aspetta ancora, non parcheggiato
    expect(t.dispatchState).toBe("waiting");
    expect(h.turns.length).toBe(0);           // e nemmeno reclamato
  });

  it("il padre che finisce il turno coi figli aperti non paga il tentativo, e aspetta", () => {
    // Era questo a fabbricare le 19 zombie: il rimando in coda del padre
    // lasciava il contatore com'era, e al secondo giro la card rientrava già al
    // tetto — invisibile, senza chip, mai più reclamabile.
    const h = harness();
    seedTask(h.db, { id: "padre", status: "in_progress", attempts: 2, assignedTopicId: "topic-padre" });
    // Il figlio è DAVVERO in volo. Uno step in `todo` non lo è: non lo dispaccia
    // nessuno, quindi il padre non lo starebbe aspettando — lo chiederebbe, ed è
    // il test qui sotto.
    seedTask(h.db, { id: "figlio", status: "in_progress", parentTaskId: "padre" });
    h.svc.deliverToReviewBySystem({ taskId: "padre", reason: "turno finito" });
    const p = h.task("padre")!;
    expect(p.status).toBe("todo");
    expect(p.dispatchAttempts).toBe(1);          // il tentativo torna indietro
    expect(p.dispatchState).toBe("waiting");     // e il board dice perché
    expect(p.dispatchDeferredUntil).toBeTruthy(); // niente giro a vuoto immediato
  });

  it("…ma se i figli sono SOLO parcheggiati non c'è nulla da aspettare: CHIEDE", () => {
    // Nessuno dispaccia dal backlog: rimandarlo in coda sarebbe un giro
    // perpetuo ogni 10 minuti. Parcheggiarlo in backlog, però, lo nascondeva
    // nella colonna dove «ferma» è l'aspetto normale — cinque card così il
    // 12/08. Non è un blocco, è una domanda: va dove si vedono le domande.
    const h = harness();
    seedTask(h.db, { id: "padre", status: "in_progress", assignedTopicId: "topic-padre" });
    seedTask(h.db, { id: "figlio", status: "backlog", parentTaskId: "padre" });
    h.svc.deliverToReviewBySystem({ taskId: "padre", reason: "turno finito" });
    const p = h.task("padre")!;
    expect(p.status).toBe("review");
    expect(p.dispatchState).toBe("needs_input");
    expect(p.deliveredReason).toBe("parked_children");
  });

  it("l'ordine dei board gira a ogni giro, o il tetto globale affama chi sta in fondo", () => {
    // Il tetto dei posti è GLOBALE: chi viene interrogato per primo li riempie.
    // Misurato l'11/08 sul DB vivo: una board 26 claim su 31 in un'ora, un'altra
    // con tre card in coda ZERO — non per priorità, per posizione nella lista,
    // che era sempre la stessa a ogni reconcile.
    //
    // Qui si fissa la sola aritmetica dell'ordine, e una versione inerte (che
    // restituisse la lista com'è) fallirebbe ogni riga con cursore > 0. NON
    // copre il giro intero reconcile→claim: il banco di prova non riesce a far
    // reclamare una seconda board, quindi la fame vera resta dimostrata dalla
    // misura sul DB, non da un test — ed è bene saperlo invece di crederla
    // coperta.
    const b = ["alpha", "beta", "gamma"];
    expect(rotateFrom(b, 0)).toEqual(["alpha", "beta", "gamma"]);
    expect(rotateFrom(b, 1)).toEqual(["beta", "gamma", "alpha"]);
    expect(rotateFrom(b, 2)).toEqual(["gamma", "alpha", "beta"]);
    expect(rotateFrom(b, 3)).toEqual(["alpha", "beta", "gamma"]);
    // Ogni board apre il giro esattamente una volta ogni tre.
    expect(new Set([0, 1, 2].map((c) => rotateFrom(b, c)[0])).size).toBe(3);
    // Casi limite: una board sola, lista vuota, cursore negativo.
    expect(rotateFrom(["solo"], 5)).toEqual(["solo"]);
    expect(rotateFrom([], 2)).toEqual([]);
    expect(rotateFrom(b, -1)).toEqual(["gamma", "alpha", "beta"]);
  });
});

describe("cancello: non si ridispaccia lavoro già su main", () => {
  /** Banco di prova con la sonda del commit di consegna sotto controllo. */
  function withProbe(risposta: boolean | null | (() => Promise<never>)) {
    const chieste: Array<{ repoPath: string; commit: string }> = [];
    const h = harness({
      deliveryLanded: async (repoPath, commit) => {
        chieste.push({ repoPath, commit });
        if (typeof risposta === "function") return risposta();
        return risposta;
      },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.setGlobalCap({ auto: false, max: 2 });
    return { h, chieste };
  }

  it("card con delivery_commit già antenato di main: NON parte, e si chiude", async () => {
    // Il difetto misurato l'11 e il 12/08: 32 ridispacci in un giorno, e le sole
    // `4ec47331` e `e54a9be6` hanno bruciato 3,26M token e 91M di cache read per
    // riprodurre codice che su main c'era già. Il land ha il suo cancello; qui si
    // copre la strada da cui la card RIENTRA in coda dopo essere atterrata.
    const { h, chieste } = withProbe(true);
    seedTask(h.db, { id: "t1", status: "todo", deliveryBranch: "topics/ardent-grouse", deliveryCommit: "c2d20879ffffffffffffffffffffffffffffffff" });

    await h.dispatcher.tick(PID);
    await flush();

    // Nessun agente: niente worktree, niente topic, nessun turno pagato.
    expect(h.turns.length).toBe(0);
    expect(h.worktreesCreated).toEqual([]);
    expect(h.topicsCreated).toEqual([]);
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
    // E la card è CHIUSA, non lasciata in coda a ripresentarsi al giro dopo.
    const t = h.task("t1")!;
    expect(t.status).toBe("done");
    expect(t.dispatchState).toBeNull();
    expect(t.dispatchAttempts).toBe(0);
    // La domanda è stata fatta al repo del progetto, sul COMMIT (non sul ramo,
    // che dopo il land è potato).
    expect(chieste).toEqual([{ repoPath: "/Users/x/Projects/alpha", commit: "c2d20879ffffffffffffffffffffffffffffffff" }]);
    // …e DICE perché: la riga di storico porta la ragione, non un `done` muto.
    const storico = h.svc.get("t1")!.comments.filter((c) => c.kind === "status").map((c) => c.content).join("\n");
    expect(storico).toContain("c2d20879");
    expect(storico).toContain("già dentro main");
    h.dispatcher.shutdown();
  });

  it("stessa card, commit NON su main: parte come sempre", async () => {
    // La controprova. Senza, «non parte» potrebbe essere vero per un'altra
    // ragione (la sonda mai chiamata, il claim rotto) e il test sopra passerebbe
    // lo stesso.
    const { h, chieste } = withProbe(false);
    seedTask(h.db, { id: "t1", status: "todo", deliveryCommit: "deadbeef00000000000000000000000000000000" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(chieste.length).toBe(1);
    expect(h.turns.length).toBe(1);
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.task("t1")!.dispatchState).toBe("working");
    h.dispatcher.shutdown();
  });

  it("«non lo so» non chiude niente: sull'ignoranza si dispaccia", async () => {
    // Chiudere una card su un `null` (sha potato, repo irraggiungibile) sarebbe
    // l'errore opposto e più caro: butta via il lavoro che manca davvero.
    const { h } = withProbe(null);
    seedTask(h.db, { id: "t1", status: "todo", deliveryCommit: "0000000000000000000000000000000000000000" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
    h.dispatcher.shutdown();
  });

  it("una sonda che ESPLODE non ferma il dispatch", async () => {
    const { h } = withProbe(() => Promise.reject(new Error("git è esploso")));
    seedTask(h.db, { id: "t1", status: "todo", deliveryCommit: "abc1230000000000000000000000000000000000" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
    h.dispatcher.shutdown();
  });

  it("il caso VERO: il land RICOPIA i commit, e il cancello lo riconosce lo stesso", async () => {
    // Il land non fonde, ricopia (`cherry-pick -C <sha>`, task-automerge.ts): dopo
    // un land riuscito il commit di consegna NON è antenato di main. Un cancello
    // basato sulla sola discendenza sarebbe quindi inerte proprio sul caso
    // normale — e passerebbe lo stesso i test con la sonda finta. Qui la sonda è
    // quella VERA dell'ospite, su un repo vero in cui la consegna è stata
    // ricopiata e il ramo poi potato.
    const repo = mkdtempSync(join(tmpdir(), "redispatch-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
      return new TextDecoder().decode(r.stdout).trim();
    };
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "base.txt"), "base\n");
      git("add", "-A"); git("commit", "-q", "-m", "base");

      git("checkout", "-q", "-b", "topics/consegna");
      writeFileSync(join(repo, "lavoro.ts"), "export const fatto = true;\n");
      git("add", "-A"); git("commit", "-q", "-m", "il lavoro della card");
      const consegna = git("rev-parse", "HEAD");

      // Main intanto è andato avanti — è la norma, non un caso limite: è per
      // questo che il land ricopia invece di fondere. Serve anche a rendere il
      // test DETERMINISTICO: ricopiare sullo stesso genitore, nello stesso
      // secondo e con la stessa identità rigenererebbe lo SHA identico (un
      // commit è l'hash di albero+genitore+autore+data+messaggio), e la consegna
      // risulterebbe antenata di main per coincidenza invece che per contenuto.
      git("checkout", "-q", "main");
      writeFileSync(join(repo, "altro.txt"), "un'altra card\n");
      git("add", "-A"); git("commit", "-q", "-m", "lavoro di un'altra card");

      // Il land: si ricopia su main, e il ramo si pota.
      git("cherry-pick", consegna);
      git("branch", "-q", "-D", "topics/consegna");

      // IL PUNTO: per la discendenza la consegna è FUORI da main. Se il cancello
      // si fermasse qui non scatterebbe mai nel caso normale.
      expect(await commitIsIn(repo, consegna, "main")).toBe(false);

      const h = harness({
        resolveProject: () => ({ path: repo, projectStoreId: "store-1" }),
        // La stessa composizione che server.ts passa al dispatcher.
        deliveryLanded: async (repoPath, commit) => {
          const state = classifyLanding(await commitStatusFromRepo(repoPath, commit));
          return state === "unverifiable" ? null : state === "landed";
        },
      });
      h.svc.updateBoardSettings(PID, { autoDispatch: true });
      h.svc.setGlobalCap({ auto: false, max: 2 });
      seedTask(h.db, { id: "t1", status: "todo", deliveryBranch: "topics/consegna", deliveryCommit: consegna });

      await h.dispatcher.tick(PID);
      await flush();

      expect(h.turns.length).toBe(0);
      expect(h.worktreesCreated).toEqual([]);
      expect(h.task("t1")!.status).toBe("done");
      h.dispatcher.shutdown();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }, 60_000);

  it("la strada che RESTA al cancello: l'orfano che la macchina rimette in coda da sé", async () => {
    // La controprova delle tre guardie qui sotto. Tolte le riaperture umane, le
    // card senza consegna registrata e i padri con figli aperti, il cancello
    // deve conservare il caso per cui esiste: il server è ripartito a metà
    // turno, il rilascio ha rimesso la card in coda da solo, e nessuno ha
    // chiesto altro lavoro. Se una modifica futura marcasse un rilascio come
    // «riaperto da un umano», il cancello morirebbe in silenzio e questo test è
    // l'unico posto che lo direbbe.
    const { h, chieste } = withProbe(true);
    seedTask(h.db, { id: "t1", status: "in_progress", dispatchState: "working", deliveryCommit: "eeee5555".repeat(5) });

    const rimessa = h.svc.release({ taskId: "t1", requeue: true, by: "dispatcher", reason: "il server è ripartito" });
    expect(rimessa.status).toBe("todo");
    expect(rimessa.reopenedActor).toBeNull();      // la macchina non lascia il marchio dell'umano
    expect(rimessa.deliveryCommit).not.toBeNull(); // né tocca lo scatto della consegna

    await h.dispatcher.tick(PID);
    await flush();

    expect(chieste.length).toBe(1);
    expect(h.turns.length).toBe(0);
    expect(h.task("t1")!.status).toBe("done");
    h.dispatcher.shutdown();
  });

  it("una card che un UMANO ha riaperto RIPARTE: il cancello non ribalta una decisione presa", async () => {
    // Lo specchio dell'invariante dell'11/08 («una card chiusa da un UMANO non
    // la riapre un agente»): se la decisione di una persona non la ribalta la
    // macchina in un verso, non la ribalta nemmeno nell'altro. Chi riapre una
    // card atterrata sta chiedendo un SEGUITO — richiuderla gli risponde con una
    // riga di storico che non leggerà, e la richiesta muore lì.
    const { h } = withProbe(true);
    seedTask(h.db, { id: "t1", status: "done", deliveryBranch: "topics/x", deliveryCommit: "aaaa1111".repeat(5) });

    h.svc.update({ taskId: "t1", actor: "human", by: "attilio", patch: { status: "todo", text: "aggiungi anche il caso limite X" } });
    // E la riapertura non le lascia addosso la consegna di prima: senza questo
    // il guasto non sarebbe nemmeno recuperabile, perché `delivery_commit` lo
    // riscrive solo una consegna nuova e per consegnare serve il dispatch che il
    // cancello blocca. Chiusa a ogni tick, per sempre, e a mano non si esce
    // (il tick reclama solo i `todo`).
    expect(h.task("t1")!.deliveryCommit).toBeNull();

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
    h.dispatcher.shutdown();
  });

  it("trascinata fuori da REVIEW da un umano: il cancello la lascia ripartire come da done", async () => {
    // Il guasto del 12-13/08 su `d6baaf5e`. Il marchio della riapertura si
    // accendeva solo uscendo da `done`, e Attilio era passato da `review` a
    // `in corso` dopo aver chiesto un cambio di rotta: per il campo nessuno
    // aveva riaperto niente, e il mattino dopo il cancello ha chiuso la card
    // sopra una consegna di cinque giorni prima. Due salti, un solo esito.
    for (const passaggio of ["in_progress", "todo"] as const) {
      const { h, chieste } = withProbe(true);
      seedTask(h.db, { id: "t1", status: "review", deliveryBranch: "topics/x", deliveryCommit: "dddd6666".repeat(5) });

      h.svc.update({ taskId: "t1", actor: "human", by: "attilio", patch: { status: passaggio } });
      expect(h.task("t1")!.reopenedActor).toBe("human");
      if (passaggio === "in_progress") {
        // Il dispatcher reclama solo dai `todo`: la card trascinata «in corso»
        // resta ferma finché qualcuno non la rimette in coda (14 ore, quel
        // giorno), ed è LÌ che il cancello la incontra.
        h.svc.update({ taskId: "t1", actor: "human", by: "attilio", patch: { status: "todo" } });
      }

      await h.dispatcher.tick(PID);
      await flush();

      expect(h.task("t1")!.status).toBe("in_progress");
      expect(h.turns.length).toBe(1);
      // A git non si chiede nemmeno: la risposta non cambierebbe la decisione.
      expect(chieste).toEqual([]);
      h.dispatcher.shutdown();
    }
  });

  it("il marchio dell'umano vale anche quando in coda ce l'ha rimessa la macchina", async () => {
    // La riapertura pulisce lo scatto della consegna, ma il marchio `reopened_actor`
    // resta finché la card non richiude il ciclo. Quindi lo stato «consegna
    // registrata + riaperta da un umano» esiste eccome: umano riapre → l'agente
    // consegna di nuovo (`recordDelivery` riscrive il commit) → la macchina la
    // rimette in coda a SQL grezzo (i sottotask aperti di `deliverToReviewBySystem`,
    // il rilascio di un orfano), e `markReopened` non tocca niente perché non si
    // usciva da `done`. Da lì il cancello la rivede, e la sonda dice «atterrato»
    // di una consegna vecchia. Deve dispacciare lo stesso.
    const { h, chieste } = withProbe(true);
    seedTask(h.db, { id: "t1", status: "todo", deliveryCommit: "bbbb2222".repeat(5) });
    h.db.run("UPDATE tasks SET reopened_actor = 'human', reopened_by = 'attilio' WHERE id = ?", ["t1"]);

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
    // E a git non si chiede nemmeno: la risposta non cambierebbe la decisione.
    expect(chieste).toEqual([]);
    h.dispatcher.shutdown();
  });

  it("un padre con sottotask aperti non lo chiude nessuno, nemmeno questo cancello", async () => {
    // `done` con figli aperti è uno stato che la board non sa raccontare, e le
    // porte normali lo rifiutano (`update` e l'approvazione in review lanciano
    // `open_subtasks`). La chiusura del cancello passa da `settleLanded`, che
    // scrive SQL grezzo e non ripassava da lì: senza guardia il padre finiva
    // `done` col figlio ancora in Todo.
    //
    // La guardia adesso sta DENTRO `settleLanded`, cioè nella stessa porta che
    // la applica all'approvazione e al trascinamento. Perciò a git si chiede
    // eccome — un predicato solo, e sta a valle della sonda — e la card, non
    // essendosi chiusa, prosegue fino al claim: ha una checklist da muovere, e
    // saltarla la lascerebbe ferma per sempre. Il conto della sonda è UNA
    // chiamata, non una per tick per card.
    const { h, chieste } = withProbe(true);
    seedTask(h.db, { id: "padre", status: "todo", deliveryCommit: "cccc3333".repeat(5) });
    seedTask(h.db, { id: "figlio", status: "todo", parentTaskId: "padre" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("padre")!.status).not.toBe("done");
    expect(h.task("padre")!.status).toBe("in_progress");
    expect(h.task("figlio")!.status).toBe("todo");
    expect(chieste.length).toBe(1);
    // …e la porta normale la pensa uguale, sulla stessa riga di DB.
    expect(() => h.svc.update({ taskId: "padre", actor: "human", by: "attilio", patch: { status: "done" } }))
      .toThrow(/open subtasks/i);
    h.dispatcher.shutdown();
  });

  it("card senza consegna registrata: a git non si chiede niente", async () => {
    // Il cancello costa una chiamata a git, e la stragrande maggioranza delle
    // card in coda non ha mai consegnato nulla: su quelle non deve costare poco,
    // deve costare NIENTE.
    const { h, chieste } = withProbe(true);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(chieste).toEqual([]);
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
    h.dispatcher.shutdown();
  });

  it("REJECTED in review: the delivery drops, the mark stays, and the gate lets it restart", async () => {
    // The fifth door, and the only one writing the status as raw SQL:
    // `reviewDecision(reject)`. A rejection left the delivery stamp on the card
    // and did not mark the reopen, so the gate saw a card still delivered and
    // still landed. Measured on 13/08 on `d6baaf5e`: the human moved it back to
    // the queue at 09:05:44.156Z and the system closed it again at
    // 09:05:50.325Z, six seconds later.
    //
    // The other four exits from review go through `update()` and have their
    // test in tasks.test.ts; this one closes the loop all the way to the gate,
    // which is where the damage showed.
    const { h, chieste } = withProbe(true);
    seedTask(h.db, { id: "t1", status: "review", deliveryBranch: "topics/x", deliveryCommit: "cccc7777".repeat(5) });

    const rejected = h.svc.reviewDecision({ taskId: "t1", by: "attilio", decision: "reject", comment: "cambia rotta" });
    expect(rejected.status).toBe("in_progress");
    expect(rejected.deliveryCommit).toBeNull();
    expect(rejected.deliveryBranch).toBeNull();
    expect(rejected.reopenedActor).toBe("human");
    expect(rejected.reopenedBy).toBe("attilio");

    // The dispatcher only claims from `todo`: that is where the card meets the
    // gate, exactly as it did that day.
    h.svc.update({ taskId: "t1", actor: "human", by: "attilio", patch: { status: "todo" } });
    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
    // Git is not even asked: two independent guards (no delivery, human
    // reopen), and neither of them needs the answer.
    expect(chieste).toEqual([]);
    h.dispatcher.shutdown();
  });
});

/**
 * THE DELIVERY CHIP, and why it almost always said "serve te".
 *
 * The envelope orders the agent to attach `options=["Landa su main"]` to a
 * landable delivery, and the service wraps EVERY `options` in a ```question
 * block. The chip was decided by looking for that fence, so every finished
 * delivery introduced itself as a question. Measured on 13/08 against the live
 * board db: 4 of the 8 cards holding the `needs_input` chip were deliveries,
 * and across the whole thread history 331 of the 437 agent comments carrying
 * the fence are deliveries, not questions. Whoever looked at the board had no
 * way to tell the real questions from the rest.
 */
describe("chip at delivery: delivery versus question", () => {
  /** Drives a card to end-of-turn in review, with the agent's last word set. */
  async function consegna(h: ReturnType<typeof harness>, content: string, options?: string[]) {
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.svc.addComment({ taskId: "t1", author: "claude", content, questionOptions: options });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    h.finishTurn();
    await flush();
  }

  it("«Landa su main» as the only option: a DELIVERY, chip `delivered`", async () => {
    const h = harness();
    await consegna(h, "Fatto: sei cancelli verdi, commit sul branch.", [LAND_ACTION_LABEL]);
    expect(h.task("t1")!.status).toBe("review");
    expect(h.task("t1")!.dispatchState).toBe("delivered");
    h.dispatcher.shutdown();
  });

  it("MIXED question: one option the system cannot run and the chip stays `needs_input`", async () => {
    // The case the fix must not run over: "Landa su main" next to an option
    // that asks for a choice is still a question, and the card says so.
    const h = harness();
    await consegna(h, "Ho finito, ma il nome del flag non mi convince.", [LAND_ACTION_LABEL, "Aspetta, ho un dubbio"]);
    expect(h.task("t1")!.dispatchState).toBe("needs_input");
    h.dispatcher.shutdown();
  });

  it("a real question with no action labels stays `needs_input`", async () => {
    const h = harness();
    await consegna(h, "Quale approccio uso?", ["JWT in cookie", "Bearer token"]);
    expect(h.task("t1")!.dispatchState).toBe("needs_input");
    h.dispatcher.shutdown();
  });
});

/**
 * IL PAVIMENTO DI CPU DEL RECONCILE.
 *
 * Gira ogni 10 secondi, sempre, e il suo primo gesto era: idrata OGNI todo di
 * OGNI board — payload completo per riga: etichette, bloccante, ragione di coda,
 * commenti recenti — poi leggine solo `projectId` e butta il resto. Con
 * l'interruttore globale SPENTO quel lavoro finiva comunque nel cestino, perché
 * ogni `tick` esce alla seconda riga.
 *
 * Si misura in STATEMENT e non in millisecondi apposta: è la FORMA del guasto
 * (per riga invece che per lotto, e prima dell'interruttore invece che dopo), e
 * il numero non cambia da una macchina all'altra.
 */
describe("il reconcile non idrata la board per contare le board", () => {
  function countStatement<T>(db: Database, run: () => Promise<T>): Promise<number> {
    const raw = db.prepare.bind(db);
    let n = 0;
    (db as unknown as { prepare: unknown }).prepare =
      (...a: unknown[]) => { n++; return (raw as unknown as (...x: unknown[]) => unknown)(...a); };
    return run().then(
      () => { (db as unknown as { prepare: unknown }).prepare = raw; return n; },
      (e) => { (db as unknown as { prepare: unknown }).prepare = raw; throw e; },
    );
  }

  /** 100 radici in coda su 5 board, che è la forma della coda vera. */
  function seedCoda(db: Database): void {
    for (let i = 0; i < 100; i++) {
      const ts = new Date(Date.UTC(2026, 7, 15, 0, 0, i)).toISOString();
      db.run(
        `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at)
         VALUES (?, ?, ?, 'todo', ?, ?)`,
        [`q-${i}`, `board-${i % 5}`, `card ${i}`, ts, ts],
      );
    }
  }

  it("interruttore SPENTO: un reconcile sta sotto i 15 statement (ne faceva centinaia)", async () => {
    const h = harness();
    seedCoda(h.db);
    // L'interruttore è la riga globale `*`, e di serie è spento.
    expect(h.svc.getGlobalAutoDispatch()).toBe(false);

    const n = await countStatement(h.db, () => h.dispatcher.reconcile());

    expect(n).toBeLessThan(15);
    h.dispatcher.shutdown();
  });

  it("e non cresce con la coda: dieci volte le card, lo stesso conto", async () => {
    // La controprova che rende il numero un INVARIANTE e non una soglia
    // calibrata su questo seed.
    const piccola = harness();
    for (let i = 0; i < 10; i++) {
      const ts = new Date(Date.UTC(2026, 7, 15, 0, 0, i)).toISOString();
      piccola.db.run(
        "INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES (?, ?, ?, 'todo', ?, ?)",
        [`q-${i}`, `board-${i % 5}`, `card ${i}`, ts, ts],
      );
    }
    const grande = harness();
    seedCoda(grande.db);

    const a = await countStatement(piccola.db, () => piccola.dispatcher.reconcile());
    const b = await countStatement(grande.db, () => grande.dispatcher.reconcile());

    expect(b).toBe(a);
    piccola.dispatcher.shutdown();
    grande.dispatcher.shutdown();
  });

  it("acceso, la coda si guarda ancora: il risparmio non è «non fare niente»", async () => {
    // Il cancello sopra passerebbe anche se il reconcile fosse rotto. Questa dice
    // che con l'interruttore acceso le board con roba in coda vengono servite.
    const h = harness();
    h.svc.setGlobalAutoDispatch(true);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.reconcile();
    await flush();

    expect(h.task("t1")!.status).toBe("in_progress");
    h.dispatcher.shutdown();
  });
});

/**
 * L'ENVELOPE È IN INGLESE, TUTTO, E QUESTO È IL CANCELLO CHE LO TIENE.
 *
 * È un contratto di runtime letto da un modello, sta nel codice, e in questo
 * repo il codice è in inglese (`docs/board-protocol.md` §DUE LINGUE). La ragione
 * per cui serve un cancello e non una lettura attenta: l'envelope si compone da
 * quattro funzioni e tre costanti condivise, e ognuna ha rami che si accendono
 * solo su una certa forma di task (plan-first, priorità automatica, sottotask
 * aperti, cancelli della board). Un envelope mezzo tradotto è peggio di
 * entrambe le lingue: il modello imita quella che vede per ultima.
 *
 * Le ETICHETTE DEI BOTTONI restano italiane ed escono dal confronto: il server
 * le scrive, il client e le rotte le confrontano PER VALORE
 * (`isLandActionLabel`, `hasPlanApproveOption`), quindi tradurne una sola parte
 * romperebbe la app. Si tolgono prima, per nome, invece di allargare il
 * dizionario: così restano visibili come eccezione dichiarata.
 */
describe("l'envelope non parla italiano", () => {
  /**
   * Parole funzione italiane che NON sono anche parole inglesi. `per`, `come`,
   * `in`, `a` e `no` restano fuori apposta: compaiono in inglese («one tab per
   * surface»), e un cancello che urla su un testo giusto lo si spegne.
   */
  const ITALIANO = /\b(?:il|lo|la|le|gli|un|una|uno|del|dello|della|dei|delle|degli|che|non|con|sul|sulla|nel|nella|dal|dalla|alla|questo|questa|quello|quella|quando|perché|perche|già|gia|senza|sempre|anche|ancora|adesso|quindi|invece|oppure|ogni|tutti|tutte|nessuno|niente|appena|subito|mentre|sotto|sono|essere|fare|fatto|deve|devi|puoi|può|puo|cosa|dove|più|piu|sei|tuo|tua|tuoi|suo|sua)\b|è/i;

  /** L'envelope meno le etichette che il resto della app confronta per valore. */
  function withoutLabels(envelope: string): string {
    return [LAND_ACTION_LABEL, PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL, "Pubblica"]
      .reduce((testo, etichetta) => testo.split(etichetta).join("<label>"), envelope);
  }

  /** Le righe che tradiscono la lingua, per poterle NOMINARE quando è rosso. */
  const italianRows = (envelope: string): string[] =>
    withoutLabels(envelope).split("\n").filter((r) => ITALIANO.test(r));

  /**
   * Un task fatto apposta per accendere OGNI ramo dell'envelope: plan-first,
   * priorità non scelta, un sottotask aperto, i cancelli della board. Testo e
   * descrizione in inglese perché sono DATI, e il dato lo scrive una persona
   * nella sua lingua: il cancello guarda le istruzioni, non il task.
   */
  async function envelopeDiKickoff(fanOut?: number): Promise<{ h: ReturnType<typeof harness>; kickoff: string }> {
    const h = harness();
    h.svc.updateBoardSettings(PID, {
      autoDispatch: true,
      reviewChecks: [{ name: "types", cmd: "bun run typecheck" }],
      ...(fanOut ? { dispatchFanOut: fanOut } : {}),
    });
    if (fanOut) h.svc.setGlobalCap({ auto: false, max: 5 });
    const t = h.svc.create({
      projectId: PID, status: "todo", text: "Rename the stale flag",
      description: "The gate reads the old name.", planFirst: true,
    });
    h.svc.create({ projectId: PID, text: "Find every reader", parentTaskId: t.id });
    await h.dispatcher.tick(PID);
    await flush();
    return { h, kickoff: h.turns[0]!.content };
  }

  it("il kickoff, con TUTTI i suoi rami accesi", async () => {
    const { h, kickoff } = await envelopeDiKickoff();
    // I rami che devono essere davvero nel testo: senza questa riga il cancello
    // sotto passerebbe anche su un envelope a cui manca metà.
    for (const ramo of ["PLAN FIRST", "AUTOMATIC PRIORITY", "open subtask(s)", "PRE-REVIEW CHECKS", "REVIEW EVIDENCE", "THE SEVEN CODE GATES", "THE REPO IS ENGLISH", "A VERSION BUMP IS ONE COMMAND", "Start now."]) {
      expect(kickoff).toContain(ramo);
    }
    expect(italianRows(kickoff)).toEqual([]);
    h.dispatcher.shutdown();
  });

  it("il kickoff di fan-out, che è un contratto diverso e quindi un testo diverso", async () => {
    const { h, kickoff } = await envelopeDiKickoff(2);
    expect(kickoff).toContain("ATTEMPT 1 of 2");
    expect(italianRows(kickoff)).toEqual([]);
    h.dispatcher.shutdown();
  });

  it("il resume: l'unico testo davanti a un agente che riparte", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live" });
    // Non si aspetta la promessa: il turno finto dell'harness si chiude a
    // comando, quindi attenderla qui vorrebbe dire attendere per sempre.
    void h.dispatcher.resume("t1", "also rename the docs");
    await flush();

    const testo = h.turns[0]!.content;
    expect(testo).toContain("Human update on task");
    expect(italianRows(testo)).toEqual([]);
    h.dispatcher.shutdown();
  });

  /**
   * Il sollecito automatico dopo un turno finito senza consegna. Ha DUE forme, e
   * la seconda (budget finito) si accende solo al tetto dei tentativi: il modo
   * di raggiungerle è il turno vero che si chiude, non una chiamata diretta.
   */
  async function envelopeDiSollecito(retryCap: number): Promise<{ h: ReturnType<typeof harness>; testo: string }> {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: retryCap });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn();
    await flush();
    return { h, testo: h.turns[1]!.content };
  }

  it("il sollecito, in ENTRAMBE le forme: quella normale e quella col budget finito", async () => {
    const normale = await envelopeDiSollecito(3);
    expect(normale.testo).toContain("was interrupted");
    expect(italianRows(normale.testo)).toEqual([]);
    normale.h.dispatcher.shutdown();

    const ultimo = await envelopeDiSollecito(2);
    expect(ultimo.testo).toContain("LAST TURN");
    expect(italianRows(ultimo.testo)).toEqual([]);
    ultimo.h.dispatcher.shutdown();
  });

  it("e il cancello sa dire di no: una riga italiana la vede", () => {
    // La controprova. Senza, «nessuna riga italiana» potrebbe voler dire
    // «il filtro non guarda niente», e passerebbe su qualunque testo.
    expect(italianRows("- Lavora SOLO questo task, in questa working directory.")).toHaveLength(1);
    expect(italianRows("- Work ONLY this task, in this working directory.")).toEqual([]);
  });
});

/**
 * PERCHÉ LA CODA È FERMA, detto dove qualcuno lo legge.
 *
 * Il pavimento di risorse (RAM/disco sotto la soglia) blocca ogni claim, ed è
 * giusto: sotto quella riga la macchina va in swap. Il problema era che non lo
 * diceva a NESSUNO — il chip sulla card scrive «in coda», il commento accanto
 * rimanda «il perché sta nel log del server», e nel log non finiva niente. Il
 * messaggio composto da `dispatchResourceBlock`, numeri compresi, moriva in un
 * `return`.
 *
 * Una coda ferma senza motivo visibile da nessuna parte è indistinguibile da un
 * dispatcher rotto: ci ho perso mezz'ora a cercare un bug che non esisteva,
 * escludendo a mano auto_dispatch, capacità, task pesanti, id del board e
 * project store — mentre la risposta era «8,7 GB liberi, ne servono 12».
 */
/**
 * L'interruttore dell'auto-dispatch vive in `app_settings` (una riga per
 * MACCHINA) dalla migration del 2026-08-16, non piu' sulla riga `'*'` di
 * `board_settings`. Scriverlo nel posto vecchio non accende piu' niente e il
 * tick esce al primo controllo, muto.
 */
function accendiDispatch(db: Database): void {
  db.run(APP_SETTINGS_DDL);
  db.run("UPDATE app_settings SET auto_dispatch = 1 WHERE id = 1");
}

describe("il pavimento delle risorse si spiega", () => {
  it("dice il motivo UNA volta, non a ogni tick", async () => {
    const righe: string[] = [];
    let bloccato = true;
    // I GB CAMBIANO A OGNI LETTURA, ed è il motivo per cui la prima versione
    // di questo fix non deduplicava niente: confrontava il testo intero, e il
    // testo intero è sempre diverso. Provato sul server vero — tre righe in
    // trenta secondi, identiche nel senso e diverse nei decimali.
    let gb = 8.7;
    const h = harness({
      log: (m: string) => righe.push(m),
      resourceBlock: () => (bloccato ? `Memoria quasi finita: ${(gb -= 0.1).toFixed(1)} GB disponibili, sotto il pavimento di 12 GB.` : null),
    });
    accendiDispatch(h.db);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await h.dispatcher.tick(PID);
    await h.dispatcher.tick(PID);

    const blocchi = righe.filter((r) => r.includes("coda ferma"));
    expect(blocchi.length).toBe(1);
    // Il motivo c'è per intero, numeri compresi: senza, la riga non aiuta più
    // del chip che c'era già.
    expect(blocchi[0]).toContain("GB disponibili");
    expect(blocchi[0]).toContain("pavimento");
    // E nessun agente è partito: il pavimento fa il suo lavoro.
    expect(h.topicsCreated).toHaveLength(0);
  });

  it("dice anche quando riparte, o l'ultima riga resterebbe un allarme per sempre", async () => {
    const righe: string[] = [];
    let bloccato = true;
    const h = harness({
      log: (m: string) => righe.push(m),
      resourceBlock: () => (bloccato ? "Disco quasi pieno: 2 GB liberi." : null),
    });
    accendiDispatch(h.db);
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    expect(righe.filter((r) => r.includes("coda ferma"))).toHaveLength(1);

    bloccato = false;
    await h.dispatcher.tick(PID);
    expect(righe.filter((r) => r.includes("coda ripartita"))).toHaveLength(1);

    // E un secondo blocco DOPO il rientro si dice di nuovo: è un episodio
    // nuovo, non la ripetizione del vecchio.
    bloccato = true;
    await h.dispatcher.tick(PID);
    expect(righe.filter((r) => r.includes("coda ferma"))).toHaveLength(2);
  });
});

/**
 * FERMARE UNA BOARD LASCIANDO GIRARE LE ALTRE.
 *
 * Prima l'unica leva su una board che faceva danni era spegnere l'interruttore
 * GLOBALE — e con quello spento si fermano anche le board che stavano lavorando
 * bene. L'unico freno per progetto era `nightMode`, che e' condizionale e si
 * spegne da solo a un orario: non e' «ferma questa».
 *
 * I due versi sono entrambi qui di proposito. Un freno che ferma sempre non e'
 * un freno, e' il dispatch spento; e un freno che puo' ACCENDERE quando il
 * globale e' spento sarebbe un secondo interruttore che contraddice il primo.
 */
describe("dispatchPaused: il freno di una board sola", () => {
  it("in pausa: questa board non dispaccia", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchPaused: true });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(0);
    expect(h.task("t1")?.status).toBe("todo");
  });

  it("NON in pausa: dispaccia come sempre", async () => {
    // Il caso che tiene onesto l'altro: senza, «in pausa non parte» sarebbe
    // verde anche con il dispatch rotto del tutto.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchPaused: false });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(1);
  });

  it("puo' solo FERMARE: col globale spento, non-in-pausa non accende niente", async () => {
    // Il verso che rende i due interruttori compatibili invece che rivali.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchPaused: false });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBe(0);
  });

  it("una board in pausa non ferma le ALTRE", async () => {
    // E' tutto il motivo per cui questa colonna esiste.
    const h = harness();
    const ALTRA = "altra-board-xyz";
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchPaused: true });
    h.svc.updateBoardSettings(ALTRA, { dispatchPaused: false });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });
    // `seedTask` semina sempre su PID: la card dell'altra board si sposta a
    // mano, che e' anche l'unico modo di avere DUE board nello stesso caso.
    seedTask(h.db, { id: "t2", status: "todo" });
    h.db.run("UPDATE tasks SET project_id = ? WHERE id = 't2'", [ALTRA]);

    await h.dispatcher.tick(PID);
    await h.dispatcher.tick(ALTRA);
    await flush();

    // Ne parte UNO: quello della board non in pausa.
    expect(h.turns.length).toBe(1);
    expect(h.task("t1")?.status).toBe("todo");
    expect(h.task("t2")?.status).not.toBe("todo");
  });
});

/**
 * IL RITENTATIVO DICE 60 SECONDI E IL POLL NE ASPETTA 10.
 *
 * Quando un turno cade su un guasto ricuperabile, `onTurnEnd` programma il
 * ritentativo con un `setTimeout(backoff)` e lo ANNUNCIA sulla card. Ma il timer
 * non trattiene lo slot: il `finally` del chiamante libera `inFlight` subito
 * dopo, e da quel momento la card e' una riga `in_progress` con chip `working` e
 * nessun turno vivo — cioe' identica a un orfano di riavvio per il giro di
 * `reconcile`, che in produzione gira ogni 10 secondi (`DISPATCH_POLL_MS`).
 *
 * Misurato il 18/08 sul DB vivo: 504 note «La sessione stava gia' rispondendo:
 * turno non avviato: riprovo tra 60s» su 12 card. Gli istanti di quattro
 * consecutive su `d636cfbf`: 12:43:46, 12:43:59, 12:44:09, 12:44:19 — 13, 10, 10
 * secondi. E' il poll, non il backoff. Ogni giro sveglia una sessione che sta
 * davvero rispondendo, incassa un 409, scrive la nota e programma un ALTRO
 * timer.
 *
 * Il costo non e' il thread: e' una chiamata alla front-door ogni dieci secondi,
 * per card, pagata per farsi dire di no — e sale col numero di agenti.
 */
describe("un ritentativo programmato non si fa svegliare dal poll", () => {
  it("reconcile NON riprende una card che sta aspettando il backoff", async () => {
    // `retryBackoffMs` VERO, non lo zero del banco: senza un'attesa che dura,
    // il registro e' gia' vuoto quando arriva il poll e la guardia non viene
    // esercitata — il caso passerebbe verde anche disarmandola (verificato).
    const h = harness({ retryBackoffMs: 60_000 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns.length).toBe(1);

    // Il turno non parte: la sessione stava gia' rispondendo. Non e' un guasto
    // dell'agent e non brucia un tentativo — si riprova, fra `backoff`.
    h.finishTurnWith({ end: "cancelled", cause: "turn-in-flight" });
    await flush();

    // Il poll passa piu' volte DENTRO la finestra di attesa. Prima, ognuno di
    // questi giri faceva partire un turno nuovo contro la stessa sessione.
    // Il turno di partenza e basta: il ritentativo e' programmato fra 60s e non
    // e' ancora scattato. Ogni turno in piu' da qui e' opera del poll.
    expect(h.turns.length).toBe(1);
    const primaDelPoll = h.turns.length;
    for (let i = 0; i < 5; i++) { await h.dispatcher.reconcile(); await flush(); }

    expect(
      h.turns.length - primaDelPoll,
      "il poll ha svegliato la sessione: e' il difetto delle 504 note",
    ).toBe(0);
  });

  it("e la card non si riempie della stessa nota a ogni giro", async () => {
    // La meta' visibile dello stesso guasto: 504 righe identiche nel thread.
    const h = harness({ retryBackoffMs: 60_000 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurnWith({ end: "cancelled", cause: "turn-in-flight" });
    await flush();
    for (let i = 0; i < 5; i++) { await h.dispatcher.reconcile(); await flush(); }

    const note = (h.svc.get("t1")?.comments ?? [])
      .filter((c) => c.content.includes("stava già rispondendo"));
    expect(note.length, "una nota per attesa, non una per giro di poll").toBeLessThanOrEqual(1);
  });

  it("il controllo: un orfano VERO reconcile lo riprende ancora", async () => {
    // Senza questo caso, la guardia potrebbe diventare «non riprendere mai
    // niente» e passerebbe verde: un riavvio a meta' turno lascerebbe la card
    // ferma per sempre. Il riavvio azzera il registro insieme al timer, ed e'
    // esattamente cio' che distingue un fantasma da un'attesa viva.
    const h = harness({ retryBackoffMs: 60_000 });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 5 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurnWith({ end: "cancelled", cause: "turn-in-flight" });
    await flush();

    const beforeRestart = h.turns.length;
    const afterRestart = h.restart();
    await afterRestart.reconcile();
    await flush();
    expect(
      h.turns.length - beforeRestart,
      "dopo un riavvio il registro e' vuoto: la card e' orfana davvero e va ripresa",
    ).toBeGreaterThan(0);
    afterRestart.shutdown();
  });
});


/**
 * NIENTE NELLA STORIA DI GIT NON VUOL DIRE NIENTE SUL DISCO.
 *
 * La fotografia di consegna legge ramo, commit e diffstat: la STORIA. Un turno
 * ucciso prima del commit non ne lascia, quindi la card concludeva «nessun ramo
 * e nessun file toccato» e mandava chi rivede a chiudere o rilanciare una card
 * il cui lavoro era li', sul disco, intatto.
 *
 * Misurato il 18/08/2026 su due card in colonna review, entrambe con zero
 * commit e la stessa frase addosso: una aveva QUATTRO file modificati (367
 * righe, test verdi), l'altra TRE — e le ultime parole del suo agente,
 * recuperate dalla sessione, erano «Changes are staged but not committed».
 */
describe("una consegna senza commit guarda anche il worktree", () => {
  /**
   * Porta una card fino alla consegna forzata: l'agente PARLA (cosi' la card
   * arriva all'umano invece di essere fallita) ma non si sposta mai in review,
   * ed esaurisce i tentativi. E' lo stesso percorso di «HANDS an
   * exhausted-but-worked task to review».
   */
  async function finoAllaConsegnaForzata(h: ReturnType<typeof harness>) {
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.svc.addComment({ taskId: "t1", author: "agent", content: "Ecco il piano: 1) … 2) …" });
    h.finishTurn(); await flush();
    h.finishTurn(); await flush();
    h.finishTurn(); await flush();
    expect(h.task("t1")!.status, "il banco non e' arrivato alla consegna forzata").toBe("review");
    return (h.svc.get("t1")?.comments ?? []).map((c) => c.content).join("\n---\n");
  }

  it("i file non committati si NOMINANO, e la mossa cambia", async () => {
    const h = harness({
      uncommittedInWorktree: async () => ["server/services/tasks.ts", "server/mcp/topics-mcp-server.ts"],
    });
    const thread = await finoAllaConsegnaForzata(h);
    expect(thread).toContain("2 file modificati");
    expect(thread).toContain("server/services/tasks.ts");
    // La mossa non e' «non c'e' un diff da guardare»: c'e' qualcosa da salvare.
    expect(thread).toContain("non e' perduto");
  });

  it("un worktree davvero pulito resta il caso storico", async () => {
    // L'elenco VUOTO e' una misura — il worktree c'e' ed e' pulito — e deve
    // portare al testo di prima, non a «0 file modificati».
    const h = harness({ uncommittedInWorktree: async () => [] });
    const thread = await finoAllaConsegnaForzata(h);
    expect(thread).toContain("nessun ramo e nessun file toccato");
    expect(thread).not.toContain("file modificati");
  });

  it("non misurabile (`null`) non inventa niente", async () => {
    // Nessun worktree, o git muto: `null` non e' «pulito». Il testo storico e'
    // un silenzio onesto, e senza questo caso la sonda potrebbe tornare `null`
    // per sempre senza che nessuno se ne accorga.
    const h = harness({ uncommittedInWorktree: async () => null });
    const thread = await finoAllaConsegnaForzata(h);
    expect(thread).toContain("nessun ramo e nessun file toccato");
  });

  it("senza la sonda il comportamento e' quello di prima", async () => {
    const h = harness();
    const thread = await finoAllaConsegnaForzata(h);
    expect(thread).toContain("nessun ramo e nessun file toccato");
  });
});
