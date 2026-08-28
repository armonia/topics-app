/**
 * SPEND IN DOLLARS, AND THE TWO CAPS THAT ARE BORN OFF.
 *
 * Three things are measured here, and the first is the most important because it
 * depends on no setting:
 *
 *  1. THE COUNTER. A dispatched agent used to write only tokens; now every
 *     booking prices the component delta at the price list of THAT session's
 *     model and writes the cents with the same monotone floor as the tokens, plus
 *     a dated row in the ledger (`agent_spend`) which is what makes the rolling
 *     24h window writable. Calling it twice does not count twice: it is an
 *     absolute, not a delta.
 *
 *  2. THE CAPS, OFF. On a fresh install they are zero, zero means unlimited, and
 *     the dispatcher behaves exactly as it behaved before: no brake, no note, no
 *     warning.
 *
 *  3. THE BRAKE, once a cap is set. It refuses the NEXT turn (it does not cut a
 *     turn in half) and says so once per episode, with how much and which cap.
 *     Fail OPEN: if reading the cap falls over, the turn is dispatched.
 * @covers KANBAN-07
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { readSpendCaps } from "./dispatch-capacity";
import type { SessionUsage } from "./transcript-usage";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  // The two cap columns are here with their default: the default is what this
  // file has to be able to measure, not a value written by the harness.
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    agent_cost_cap_cents INTEGER NOT NULL DEFAULT 0,
    agent_cost_cap_cents_24h INTEGER NOT NULL DEFAULT 0
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

function seedTask(db: Database, id: string, opts: { model?: string; costCents?: number } = {}): string {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority, model, agent_cost_cents)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, 2, ?, ?)`,
    [id, PID, "task " + id, ts, ts, opts.model ?? null, opts.costCents ?? 0],
  );
  return id;
}

/** One transcript reading, components separated the way the CLI carries them. */
function usage(u: Partial<SessionUsage>): SessionUsage {
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  const cacheWriteTokens = u.cacheWriteTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: u.cacheWrite1hTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    billableTokens: u.billableTokens ?? inputTokens + outputTokens + cacheWriteTokens,
  };
}

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: { sessionKey: string; content: string }[] = [];

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = turns.length + 1;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`t-${n}`]);
      return { topicId: `t-${n}`, sessionKey: `topic:sk${n}` };
    },
    archiveTopic: () => {},
    getLastAgentText: () => "riassunto",
    runTurn: (sessionKey, content) => {
      turns.push({ sessionKey, content });
      return Promise.resolve<TurnEndInfo | void>(undefined);
    },
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, turns,
    task: (id: string) => svc.get(id)?.task,
    comments: (id: string) => (svc.get(id)?.comments ?? []).map((c) => c.content),
    righeSpesa: (id: string) =>
      (svc.get(id)?.comments ?? []).filter((c) => c.content.includes("Tetto di spesa per card")).length,
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function board(h: ReturnType<typeof harness>): void {
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  h.svc.setGlobalCap({ auto: false, max: 4 });
}

describe("il contatore in centesimi", () => {
  it("prezza il delta dei componenti e scrive UNA riga nel libro", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    seedTask(db, "c1");

    // 3.00 USD: the caller brings the absolute, and this case measures the floor
    // and the ledger, not the arithmetic of the price list (that lives in
    // pricing.test.ts).
    svc.raiseAgentUsage({ taskId: "c1", tokens: 320_000, cacheReadTokens: 2_000_000, costCents: 300, unpricedCostTokens: 0 });
    expect(svc.get("c1")!.task.agentCostCents).toBe(300);
    expect(svc.agentSpend().cents24h).toBe(300);

    // The same absolute again: it is not a delta, so it does not count twice.
    svc.raiseAgentUsage({ taskId: "c1", tokens: 320_000, cacheReadTokens: 2_000_000, costCents: 300 });
    expect(svc.get("c1")!.task.agentCostCents).toBe(300);
    expect(svc.agentSpend().cents24h).toBe(300);

    // It grows: what enters the ledger is the DELTA, not the total.
    svc.raiseAgentUsage({ taskId: "c1", tokens: 400_000, cacheReadTokens: 2_000_000, costCents: 450 });
    expect(svc.get("c1")!.task.agentCostCents).toBe(450);
    expect(svc.agentSpend().cents24h).toBe(450);

    // A reading that regresses does not subtract.
    svc.raiseAgentUsage({ taskId: "c1", tokens: 400_000, cacheReadTokens: 2_000_000, costCents: 10 });
    expect(svc.get("c1")!.task.agentCostCents).toBe(450);
  });

  it("un modello senza listino non vale zero: la quota resta contata a parte", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    seedTask(db, "c2");

    svc.raiseAgentUsage({ taskId: "c2", tokens: 100_000, cacheReadTokens: 0, costCents: 0, unpricedCostTokens: 100_000 });
    const spesa = svc.agentSpend();
    expect(svc.get("c2")!.task.agentCostCents).toBe(0);
    expect(spesa.cents24h).toBe(0);
    // The number is there and it can be SHOWN: that is the difference between
    // "free" and "I cannot price it".
    expect(spesa.unpricedCostTokens24h).toBe(100_000);

    // It does not add to itself at every booking: it is an absolute, like the cents.
    svc.raiseAgentUsage({ taskId: "c2", tokens: 100_000, cacheReadTokens: 0, costCents: 0, unpricedCostTokens: 100_000 });
    expect(svc.agentSpend().unpricedCostTokens24h).toBe(100_000);
  });

  it("il turno di un agente finisce in dollari sulla card, col listino del suo modello", async () => {
    // 200k fresh input, 20k output, 100k of 5-minute cache write and 2M of
    // re-read on claude-opus-5 (5 USD / 25 USD per M):
    //   input    200_000 x 5           = 1_000_000
    //   write    100_000 x 5 x 1.25    =   625_000
    //   read   2_000_000 x 5 x 0.1     = 1_000_000
    //   output    20_000 x 25          =   500_000
    //   total  3_125_000 / 1e6         = 3.125 USD, i.e. 313 cents
    const letto = usage({ inputTokens: 200_000, outputTokens: 20_000, cacheWriteTokens: 100_000, cacheReadTokens: 2_000_000 });
    // The first reading is the ANCHOR (turn start, nothing consumed yet); the
    // later ones carry the turn. The bill is always a delta against the anchor.
    let letture = 0;
    const h = harness({ getSessionUsage: () => (letture++ === 0 ? usage({}) : letto) });
    board(h);
    seedTask(h.db, "d1", { model: "claude-opus-5" });

    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task("d1")!;
    expect(t.agentTokens).toBe(320_000);
    expect(t.agentCostCents).toBe(313);
    expect(h.svc.agentSpend().cents24h).toBe(313);
  });
});

describe("i tetti nascono spenti", () => {
  it("installazione nuova: zero e zero, e zero vuol dire illimitato", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    expect(readSpendCaps(db)).toEqual({ perTaskCents: 0, perDayCents: 0 });
    expect(svc.getSpendCaps()).toEqual({ perTaskCents: 0, perDayCents: 0 });
    expect(svc.agentSpend()).toEqual({
      cents24h: 0, centsTotal: 0, unpricedCostTokens24h: 0, unpricedCostTokensTotal: 0,
    });
  });

  it("a tetti spenti una card cara parte come prima, e nel thread non c'e' niente", async () => {
    const h = harness();
    board(h);
    // 99.70 USD is the most expensive card ever measured: with no cap that is no
    // reason to stop anything.
    seedTask(h.db, "e1", { costCents: 9_970 });

    await h.dispatcher.tick(PID);
    await flush();

    // The turn STARTED (in this harness `runTurn` closes at once, so the card is
    // already past `in_progress`): what matters is that no brake held it, and that
    // the thread names no cap.
    expect(h.turns.length).toBeGreaterThanOrEqual(1);
    expect(h.righeSpesa("e1")).toBe(0);
  });

  it("i tetti li scrive una persona, e zero li cancella", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    expect(svc.setSpendCaps({ perTaskCents: 2_500, perDayCents: 50_000 }))
      .toEqual({ perTaskCents: 2_500, perDayCents: 50_000 });
    expect(svc.setSpendCaps({ perTaskCents: 0 }))
      .toEqual({ perTaskCents: 0, perDayCents: 50_000 });
    // A negative is not a very tight cap: it is off.
    expect(svc.setSpendCaps({ perDayCents: -1 }).perDayCents).toBe(0);
  });
});

describe("il freno, a tetto impostato", () => {
  it("la card oltre il tetto non fa partire il turno successivo, e lo dice una volta", async () => {
    const h = harness();
    board(h);
    h.svc.setSpendCaps({ perTaskCents: 2_500 });
    seedTask(h.db, "f1", { costCents: 2_740 });

    for (let i = 0; i < 3; i++) { await h.dispatcher.tick(PID); await flush(); }

    expect(h.task("f1")!.status).toBe("todo");
    expect(h.task("f1")!.dispatchState).toBe("queued");
    // One line per episode, with the two numbers that make it checkable.
    expect(h.righeSpesa("f1")).toBe(1);
    const nota = h.comments("f1").join("\n");
    expect(nota).toContain("27.40 USD");
    expect(nota).toContain("25.00 USD");
  });

  it("sotto il tetto non cambia niente: la card parte", async () => {
    const h = harness();
    board(h);
    h.svc.setSpendCaps({ perTaskCents: 2_500 });
    seedTask(h.db, "f2", { costCents: 2_400 });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBeGreaterThanOrEqual(1);
    expect(h.righeSpesa("f2")).toBe(0);
  });

  it("il tetto per MACCHINA su 24h ferma anche le card che stanno sotto al proprio", async () => {
    const h = harness();
    board(h);
    // The worst measured day was made of many cards each below its own cap: that
    // is the failure the per-card cap never sees go by.
    h.svc.setSpendCaps({ perDayCents: 50_000 });
    seedTask(h.db, "g1", { costCents: 100 });
    h.svc.raiseAgentUsage({ taskId: "g1", tokens: 10, cacheReadTokens: 0, costCents: 60_000 });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("g1")!.status).toBe("todo");
    expect(h.task("g1")!.dispatchState).toBe("queued");
  });

  it("fail OPEN: se la lettura del tetto cade, il turno parte", async () => {
    const h = harness();
    board(h);
    seedTask(h.db, "h1", { costCents: 99_999 });
    // The single door: if `getSpendCaps` blows up, the brake must let it through.
    // Erring towards the block stops good work over a measurement error.
    (h.svc as unknown as { getSpendCaps: () => never }).getSpendCaps = () => {
      throw new Error("colonna assente");
    };

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBeGreaterThanOrEqual(1);
  });
});
