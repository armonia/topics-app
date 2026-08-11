import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_RULE, PREVIEW_CARD_MAX_RATIO, extractPreviewRule, formatStatusEvent } from "../../shared/board";
import { toolsForProfile } from "../mcp/topics-mcp-server";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { cancelled, type TurnEndInfo } from "../providers/stop-reason";
import { beginAsk, endAsk } from "../lib/ask-user-bridge";
import { beginPermission, endPermission } from "../lib/permission-bridge";

// Self-contained schema (mirrors migrations 001 + 026 + 031, tasks-relevant
// subset). PRAGMA foreign_keys + the assigned_topic_id FK are faithful to prod
// on purpose: the "pending:<taskId>" placeholder bug only reproduced with the
// FK enforced.
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, fingerprint TEXT, due_date TEXT,
    chat_id TEXT, created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    claude_task_id TEXT, assigned_topic_id TEXT REFERENCES topics(id), archived INTEGER NOT NULL DEFAULT 0,
    assigned_agent_id TEXT, in_progress_at TEXT,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0, dispatch_state TEXT, dispatch_error TEXT,
    dispatch_deferred_until TEXT, dispatch_weight TEXT,
    parent_task_id TEXT REFERENCES tasks(id), output_url TEXT, plan_first INTEGER NOT NULL DEFAULT 0,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT, blocked_by_task_id TEXT REFERENCES tasks(id), reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
    priority_auto INTEGER NOT NULL DEFAULT 1,
    delivered_by TEXT, delivered_reason TEXT, created_by_topic_id TEXT
  )`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER
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
  o: { id?: string; status?: string; attempts?: number; assignedTopicId?: string | null; dispatchState?: string | null; createdAt?: string; parentTaskId?: string | null; text?: string } = {},
): string {
  const id = o.id ?? `t${++seq}`;
  const ts = o.createdAt ?? new Date(Date.now() + seq).toISOString();
  // FK: a seeded binding needs its topics row, like in prod.
  if (o.assignedTopicId) db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [o.assignedTopicId]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, assigned_topic_id, dispatch_state, parent_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, PID, o.text ?? ("task " + id), o.status ?? "todo", ts, ts, o.attempts ?? 0, o.assignedTopicId ?? null, o.dispatchState ?? null, o.parentTaskId ?? null],
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
  const turns: { sessionKey: string; content: string; contextMode?: "full" | "lean" }[] = [];
  let resolveTurn: ((info?: TurnEndInfo) => void) | null = null;
  let rejectTurn: ((e: unknown) => void) | null = null;

  const deps: DispatcherDeps = {
    svc,
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
      new Promise<TurnEndInfo | void>((res, rej) => { turns.push({ sessionKey, content, contextMode: opts?.contextMode }); resolveTurn = res; rejectTurn = rej; }),
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    expect(h.turns[0].content).toContain("owner esclusivo del task");
    expect(h.dispatcher.isInFlight("t1")).toBe(true);
  });

  it("una domanda a META' TURNO porta il chip a needs_input, e il rilascio lo riporta a working", async () => {
    // Il buco piu' caro trovato dal confronto board/chat: `ask_user_question`
    // aperta mentre il turno e' vivo lasciava la card su `working`. La board
    // diceva «sto lavorando» sopra una sessione ferma su una persona.
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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

  it("self-heals a DEAD binding: a todo bound to a reaped topic dispatches again", async () => {
    // A task that ran before, reached done, then was dragged back to todo — its
    // agent topic was reaped in between, so `assigned_topic_id` now dangles.
    // Without the heal it would be skipped forever by the `!assignedTopicId`
    // eligibility filter and sit in todo with no chip.
    const h = harness({ topicExists: (id) => id !== "reaped-topic" });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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

  it("leaves a task alone when the turn ends in review", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // Agent moved it to review mid-turn (allowed: agent→review, after its summary).
    h.svc.addComment({ taskId: "t1", author: "claude", content: "fatto" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
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
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
    h.finishTurn();
    await flush();
  }

  it("consegna → il worktree si snellisce, ma solo DOPO l'anteprima", async () => {
    const ordine: string[] = [];
    let sbloccaAnteprima: (() => void) | null = null;
    const h = harness({
      preparePreview: (id) => new Promise<void>((res) => {
        ordine.push(`anteprima:${id}`);
        sbloccaAnteprima = () => res();
      }),
      slimWorktree: async (id) => { ordine.push(`slim:${id}`); },
    });
    await deliver(h);
    // L'anteprima è ancora in piedi: togliere `node_modules` ora la ucciderebbe.
    expect(ordine).toEqual(["anteprima:t1"]);
    sbloccaAnteprima!();
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
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
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
    expect(h.turns[1].content).toContain("interrotto");
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
    expect(notes).toContain("limite di tempo");
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
    expect(h.turns[1].content).toContain("ULTIMO TURNO");
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
    // The concurrency cap is now a single MACHINE-WIDE budget (getGlobalCap),
    // not a per-board maxAgents — pin it to 1 explicitly (auto off) so the
    // harness's default (auto, max 3) doesn't let both tasks through.
    h.svc.setGlobalCap({ auto: false, max: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    seedTask(h.db, { id: "t2", status: "todo", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress"); // oldest claimed
    expect(h.task("t2")!.status).toBe("todo");         // cap hit → stays queued
    expect(h.turns.length).toBe(1);
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false, maxAgents: 5 });
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
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
    h.finishTurn();
    await p;
    await flush();
    expect(h.task("t1")!.status).toBe("review");
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("resume is a no-op when the task has no bound topic", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: null });
    await h.dispatcher.resume("t1", "hey");
    await flush();
    expect(h.turns.length).toBe(0);
  });

  it("reconcile requeues an orphaned (mid-dispatch) in-progress task, refunding the attempt", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 1, dispatchState: "working" });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");            // requeued
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchAttempts).toBe(0);       // restart refunds the interrupted attempt
  });

  it("reconcile ALWAYS requeues a restart orphan (never parks): a restart is not a failure", async () => {
    // Even at the cap, a server restart must not park the task — it rolls the
    // interrupted attempt back and requeues, so deploys can't bounce a healthy
    // task into backlog "per errore".
    const h = harness();
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
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
    expect(h.turns[0].content).toContain("Riprendi da dove eri");
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
    expect(comments.some((c) => c.author === "system" && c.content.includes("Ripreso in diretta"))).toBe(true);
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
    expect(h.turns[0].content).toContain("owner esclusivo del task"); // kickoff da capo
  });

  it("reconcile with the global switch OFF requeues without resuming and without a stranded chip", async () => {
    // The human turned auto-dispatch off: no agent may relaunch. The orphan
    // goes back to todo, and the requeue's `queued` chip is cleared — on a
    // board that never dispatches it would strand forever.
    const h = harness({ topicExists: () => true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 2, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("todo");
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchAttempts).toBe(1);   // interrupted attempt refunded
    expect(t.dispatchState).toBeNull();   // no stranded 'queued'
    expect(h.turns.length).toBe(0);
  });

  it("reconcile LIBERA un orfano fermo su `queued` con la board SPENTA", async () => {
    // Il fantasma misurato l'11/08: sette card in_progress col chip `queued`,
    // ferme da 40 minuti, nessun turno vivo. Nascono da un'attesa che vive in
    // memoria (il rinvio del resume quando il tetto è pieno): il riavvio si
    // porta via il timer e lascia il chip, e la card resta in_progress PER
    // SEMPRE — il recupero orfani la saltava perché guardava solo
    // {working, starting}.
    //
    // La board spenta è il caso duro: non reclama nulla, ma deve comunque
    // poter LIBERARE la card (e con lei lo slot che l'umano le vede occupare).
    const h = harness({ topicExists: () => true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "queued" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("todo");
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchAttempts).toBe(0);   // il riavvio non consuma un tentativo
    expect(t.dispatchState).toBeNull();   // niente chip arenato su una board che non dispaccia
    expect(h.turns.length).toBe(0);       // spenta: nessun agente riparte
  });

  it("reconcile LIBERA un orfano fermo su `queued` anche con la board ACCESA", async () => {
    // Stesso fantasma, board accesa. Il passaggio da `todo` c'è ma non si
    // fotografa: la STESSA reconcile, dopo il requeue, ticca la board e la
    // riclaima — ed è il punto, perché è così che lo slot torna a lavorare
    // invece di restare occupato da una card ferma.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "queued" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    // L'invariante, in entrambe le modalità: nessuna card sopravvive come
    // in_progress + `queued` senza un turno.
    expect(t.status === "in_progress" && t.dispatchState === "queued").toBe(false);
    expect(t.assignedTopicId).toBe("topic-1");                       // topic NUOVO, il fantasma era sbindato
    expect(t.dispatchAttempts).toBe(1);                              // rimborsato (1→0) e riclaimato (0→1)
    expect(h.turns.length).toBe(1);                                  // lo slot lavora davvero
    expect(h.turns[0].content).toContain("owner esclusivo del task"); // kickoff, non un turno fantasma
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

    // Riavvio: il processo nuovo non ha né il timer né il registro. ADESSO la
    // stessa card è orfana per davvero, e reconcile deve liberarla.
    const restarted = h.restart();
    await restarted.reconcile();
    await flush();

    const ghost = h.task("t2")!;
    expect(ghost.status).toBe("todo");                      // rimessa in coda
    expect(ghost.assignedTopicId).toBeNull();               // sbindata: la sessione non ha più nessuno
    expect(ghost.dispatchAttempts).toBe(0);                 // il riavvio non consuma un tentativo
    expect(h.svc.get("t2")!.comments.some((c) => c.content.includes("aspettava uno slot libero"))).toBe(true);
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
    expect(h.turns[0].content).toContain("ULTIMO TURNO"); // budget exhausted → deliver-now nudge
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
    expect(kickoff).toContain("TUTTI i tuoi step devono essere done");
    // Consegna = tab del task + file consegnati, niente concetto "Output":
    // l'agente deve sapere che una pagina viva si apre come TAB, non si dichiara
    // come url in un campo a parte.
    expect(kickoff).toContain("open_browser_pane");
    expect(kickoff).toContain("FILE CONSEGNATI");
    expect(kickoff).not.toContain("output_url");
  });

  it("buffers a resume landing while the turn is in flight and delivers it on the same tab at turn end", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // Agent delivers to review mid-turn (the turn has NOT ended yet)…
    h.svc.addComment({ taskId: "t1", author: "claude", content: "fatto" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
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
    expect(h.turns[0].content).toContain("STESSA sessione");
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
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
    const auto = h.svc.create({ projectId: PID, status: "todo", text: "senza priorità" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain("Priorità automatica");
    h.finishTurn(); await flush();
    const h2 = harness();
    h2.svc.updateBoardSettings(PID, { autoDispatch: true });
    h2.svc.create({ projectId: PID, status: "todo", text: "scelta umana", priority: 3 });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.turns[0].content).not.toContain("Priorità automatica");
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
      expect(h.svc.get("t2")!.comments.filter((c) => c.author === "system").length).toBe(2);
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
    // Estratta per STRUTTURA (dalla riga «EVIDENZA DI REVIEW» a «Cancello
    // unico»), non cercando la costante: un test che cerca la stringa che ha
    // appena interpolato non può fallire.
    const kickoffPreviewRule = extractPreviewRule(kickoff);
    expect(kickoffPreviewRule).toBe(PREVIEW_RULE);
    // E una sola volta: due blocchi nello stesso envelope sarebbero già la
    // divergenza che ricomincia.
    expect(kickoff.split(PREVIEW_RULE).length - 1).toBe(1);
    expect(kickoff).toContain("· DIAGRAMMA");
    expect(kickoff).not.toContain("UI STATICA"); // il vecchio ramo a due vie è sparito
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
    // 144/268 = il riquadro `max-h-36 object-cover` della card. Se qualcuno
    // cambia il layout e non la costante, la regola mente agli agenti.
    expect(PREVIEW_CARD_MAX_RATIO).toBeCloseTo(0.537, 3);
    expect(PREVIEW_RULE).toContain(PREVIEW_CARD_MAX_RATIO.toFixed(3));
    expect(PREVIEW_RULE).toContain("≤20s");        // il tetto del video
    expect(PREVIEW_RULE).toContain("DUE O PIÙ STATI"); // il criterio del ramo video
  });

  it("nessuna sesta copia: il testo dei rami esiste solo in shared/board.ts", () => {
    // Il marcatore è una riga della costante. Chi riscrive la regola a mano in
    // un altro file la ricopia quasi certamente da qui — e questo test lo vede.
    const MARK = "· DIAGRAMMA .svg";
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
    expect(h.svc.get("t1")!.comments.map((c) => c.content).join("\n")).toContain("Budget dei tentativi finito");
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
    seedTask(h.db, { id: "figlio", status: "todo", parentTaskId: "padre" });
    h.svc.deliverToReviewBySystem({ taskId: "padre", reason: "turno finito" });
    const p = h.task("padre")!;
    expect(p.status).toBe("todo");
    expect(p.dispatchAttempts).toBe(1);          // il tentativo torna indietro
    expect(p.dispatchState).toBe("waiting");     // e il board dice perché
    expect(p.dispatchDeferredUntil).toBeTruthy(); // niente giro a vuoto immediato
  });

  it("…ma se i figli sono SOLO parcheggiati non c'è nulla da aspettare: si ferma lui", () => {
    // Nessuno dispaccia dal backlog: rimandarlo in coda sarebbe un giro
    // perpetuo ogni 10 minuti. Parcheggiato con la ragione, è una card su cui
    // si può agire.
    const h = harness();
    seedTask(h.db, { id: "padre", status: "in_progress", assignedTopicId: "topic-padre" });
    seedTask(h.db, { id: "figlio", status: "backlog", parentTaskId: "padre" });
    h.svc.deliverToReviewBySystem({ taskId: "padre", reason: "turno finito" });
    const p = h.task("padre")!;
    expect(p.status).toBe("backlog");
    expect(p.dispatchState).toBe("blocked");
  });
});
