/**
 * THE OVERFLOW: a card held by THIS Mac's memory floor for more than two
 * minutes goes to a machine where the floor does not apply.
 *
 * The contract:
 *  1. Mac under the floor + Cloud Claude online: past two minutes the card
 *     leaves with `machine_id` = Cloud within one round, and is launched there;
 *     before two minutes it stays;
 *  2. a card (or a board) marked "this Mac only" stays held, whatever the wait;
 *  3. Cloud offline (or without credit) and the PC online: the card goes to the PC;
 *  4. the board switch off: nothing moves;
 *  5. a card that already has a delivery branch starts FROM it over there: the
 *     branch is pushed first and rides `createRun` as `baseBranch`; a branch
 *     that cannot reach origin keeps the card here;
 *  6. Cloud only for a GitHub origin and a Claude model, otherwise the PC;
 *  7. the two-minute clock measures an UNBROKEN hold: a round in which another
 *     wait held the card, or a trip out of Todo, starts it again;
 *  8. a machine at its slots takes nothing more, and a round moves at most
 *     `OVERFLOW_MAX_PER_ROUND` cards.
 *
 * Harness: the node fake and the injected floor of
 * `task-dispatcher-remote-node-floor.test.ts`, with a clock the test moves.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { ResourceFloorVerdict } from "./dispatch-capacity";
import type { TurnEndInfo } from "../providers/stop-reason";
import {
  OVERFLOW_AFTER_MS, OVERFLOW_MAX_PER_ROUND, OVERFLOW_SLOTS, cloudRunsModel, overflowEligible, pickOverflowMachine,
  type OverflowChoice, type OverflowMachine,
} from "./dispatch-overflow";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const PID = "alpha-abc123";
const LOCAL = "questo-mac";
const CLOUD = "cloud-claude";
const PC = "pc-windows";
const CARD = "card-ferma";

const BLOCKED: ResourceFloorVerdict = {
  reason: "Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è 4.1 GB, sotto il pavimento di 6 GB.",
  kind: "memory",
  memoryFirstCardExempt: false,
};

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_overflow INTEGER NOT NULL DEFAULT 1, dispatch_stay_local INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  for (const id of [LOCAL, CLOUD, PC]) db.run("INSERT INTO machines (id) VALUES (?)", [id]);
  return db;
}

const ADDRESS: Record<string, string> = { [CLOUD]: "claude-cloud://", [PC]: "https://pc.local" };
const NAME: Record<string, string> = { [CLOUD]: "Cloud Claude", [PC]: "PC Windows" };

function harness(opts: {
  cloudOnline?: boolean; pcOnline?: boolean; cloudCredit?: boolean; github?: boolean;
  /** The Mac under its memory floor (default) or free. */
  floor?: boolean;
  /** What pushing a card's own branch answers (default: it reaches origin). */
  ensure?: (branch: string) => { ok: true } | { ok: false; reason: string };
} = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const created: Array<{ baseUrl: string; originTaskId: string }> = [];
  const bodies: Array<{ originTaskId: string; baseBranch?: string | null }> = [];
  const pushed: string[] = [];
  const worktrees: Array<{ baseBranch?: string } | undefined> = [];
  const turns: string[] = [];
  let now = Date.UTC(2026, 9, 30, 10, 0, 0);
  let nextRun = 0;
  const machines = (): OverflowMachine[] => [
    { id: CLOUD, name: NAME[CLOUD], kind: "cloud", online: opts.cloudOnline ?? true },
    { id: PC, name: NAME[PC], kind: "node", online: opts.pcOnline ?? true },
  ];

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${turns.length + 1}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async (_store, wopts) => { worktrees.push(wopts); return "wt-1"; },
    deleteWorktree: async () => {},
    runTurn: (sessionKey) => { turns.push(sessionKey); return new Promise<TurnEndInfo | void>(() => {}); },
    broadcast: () => {},
    // The Mac stays under its floor for the whole test: only a move gets the card out.
    resourceBlock: () => (opts.floor === false ? null : BLOCKED),
    node: {
      createRun: async ({ baseUrl, body }) => {
        created.push({ baseUrl, originTaskId: body.originTaskId });
        bodies.push({ originTaskId: body.originTaskId, baseBranch: body.baseBranch });
        nextRun += 1;
        return { runId: `run-${nextRun}` };
      },
      readRun: async () => ({
        status: "in_progress", dispatchState: "working", dispatchError: null, comments: [],
        deliveryBranch: null, deliveryCommit: null, baseSha: null, stat: null,
      }),
      fetchBundle: async () => ({ empty: true as const }),
      cancelRun: async () => {},
      baseUrlOf: (id) => ADDRESS[id] ?? null,
      tokenOf: () => "tok",
      nameOf: (id) => NAME[id] ?? null,
      localMachineId: () => LOCAL,
      originUrlOf: async () => "git@github.com:acme/alpha.git",
      plantBranch: async () => ({ planted: true, commit: "c0ffeec0ffee", reason: null }),
      ensureBranchOnOrigin: async ({ branch }) => { pushed.push(branch); return opts.ensure?.(branch) ?? { ok: true }; },
    },
    overflowMachines: machines,
    githubOriginOf: async () => opts.github ?? true,
    cloudCredit: () => opts.cloudCredit ?? true,
    now: () => now,
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1 });
  svc.setGlobalCap({ auto: false, max: 9 });

  const seed = (id: string, extra: { machineId?: string | null; stayLocal?: boolean; deliveryBranch?: string; model?: string; costCents?: number; baseBranch?: string } = {}) => {
    const ts = new Date(now).toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts, machine_id, stay_local,
                          delivery_branch, model, agent_cost_cents, base_branch)
       VALUES (?, ?, 'una card in coda', 'sotto il pavimento', 'todo', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [id, PID, ts, ts, extra.machineId ?? null, extra.stayLocal ? 1 : 0, extra.deliveryBranch ?? null, extra.model ?? null, extra.costCents ?? 0, extra.baseBranch ?? null],
    );
  };
  const flush = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  const tick = async () => { await dispatcher.tick(PID); await flush(); };
  const advance = (ms: number) => { now += ms; };
  return { db, svc, created, bodies, pushed, worktrees, turns, seed, tick, advance, task: (id: string) => svc.get(id)!.task };
}

/** Held once, then past the two minutes: the round the move must happen in. */
async function holdPastThreshold(h: ReturnType<typeof harness>) {
  await h.tick();
  h.advance(OVERFLOW_AFTER_MS + 1_000);
  await h.tick();
}

describe("overflow: una card ferma per la memoria del Mac va dove il pavimento non vale", () => {
  it("Mac sotto il pavimento e Cloud online: dopo 2 minuti la card esce con machine_id Cloud e parte lì", async () => {
    const h = harness();
    h.seed(CARD);

    await h.tick();
    // Under two minutes: held here, nothing moved.
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    h.advance(OVERFLOW_AFTER_MS - 10_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);

    h.advance(20_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
    expect(h.task(CARD).overflowedAt).toBeString();
    expect(h.created).toEqual([{ baseUrl: "claude-cloud://", originTaskId: CARD }]);
    expect(h.task(CARD).status).toBe("in_progress");
    expect(h.turns).toEqual([]);
    const note = h.svc.get(CARD)!.comments.map((c) => c.content).find((c) => c.startsWith("Spostata su"));
    expect(note).toStartWith("Spostata su Cloud Claude: Mac pieno.");
  });

  it("anche la card con la macchina predefinita = questo Mac si sposta", async () => {
    const h = harness();
    h.seed(CARD, { machineId: LOCAL });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("una card marcata «solo Mac» resta ferma", async () => {
    const h = harness();
    h.seed(CARD, { stayLocal: true });
    await holdPastThreshold(h);
    h.advance(10 * 60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.created).toEqual([]);
  });

  it("una card nata «solo Mac» (marcata alla creazione) resta ferma", async () => {
    const h = harness();
    const born = h.svc.create({ projectId: PID, text: "riavvia OpenClaw", status: "todo", stayLocal: true });
    expect(born.stayLocal).toBe(true);
    await holdPastThreshold(h);
    expect(h.task(born.id).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("una board marcata «solo Mac» tiene ferme le sue card", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchStayLocal: true });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("con l'interruttore della board spento non si sposta niente", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchOverflow: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("Cloud offline e PC online: la card va sul PC", async () => {
    const h = harness({ cloudOnline: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
    expect(h.created).toEqual([{ baseUrl: "https://pc.local", originTaskId: CARD }]);
  });

  it("Cloud senza credito e PC online: la card va sul PC", async () => {
    const h = harness({ cloudCredit: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("nessuna macchina online: la card resta in coda sul Mac", async () => {
    const h = harness({ cloudOnline: false, pcOnline: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
  });

  it("una card assegnata a mano a un'altra macchina non è toccata dall'overflow", async () => {
    const h = harness({ pcOnline: false });
    h.seed(CARD, { machineId: PC });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });
});

describe("overflow: il ramo della card, l'origin, il modello", () => {
  it("sul nodo PC la card specchio con un ramo base fa nascere il worktree da lì, non da main", async () => {
    const h = harness({ floor: false });
    h.seed("specchio", { baseBranch: "topics/endless-calf" });
    h.seed("altra");
    await h.tick();
    expect(h.worktrees).toContainEqual({ baseBranch: "topics/endless-calf" });
    expect(h.worktrees).toContainEqual(undefined);
  });

  it("una card con un ramo di consegna va su Cloud partendo DA quel ramo, pushato prima", async () => {
    const h = harness();
    h.seed(CARD, { deliveryBranch: "topics/endless-calf" });
    await holdPastThreshold(h);
    // The push answers asynchronously: the move comes in the next round.
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
    expect(h.pushed).toContain("topics/endless-calf");
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: "topics/endless-calf" }]);
  });

  it("una card senza ramo parte dal default: nessun baseBranch, nessun push", async () => {
    const h = harness();
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: undefined }]);
    expect(h.pushed).toEqual([]);
  });

  it("un ramo che non arriva su origin tiene la card sul Mac", async () => {
    const h = harness({ ensure: () => ({ ok: false, reason: "push rifiutato: non-fast-forward" }) });
    h.seed(CARD, { deliveryBranch: "topics/endless-calf" });
    await holdPastThreshold(h);
    for (let i = 0; i < 3; i++) { h.advance(70_000); await h.tick(); }
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.created).toEqual([]);
  });

  it("anche una card mandata a mano sul PC parte dal suo ramo; se non si può pushare, si ferma con il motivo", async () => {
    const h = harness();
    h.seed("a-mano", { machineId: PC, deliveryBranch: "topics/endless-calf" });
    await h.tick();
    expect(h.bodies).toEqual([{ originTaskId: "a-mano", baseBranch: "topics/endless-calf" }]);

    const k = harness({ ensure: () => ({ ok: false, reason: "push rifiutato" }) });
    k.seed("a-mano", { machineId: PC, deliveryBranch: "topics/endless-calf" });
    await k.tick();
    expect(k.created).toEqual([]);
    expect(k.task("a-mano").status).not.toBe("in_progress");
    expect(k.svc.get("a-mano")!.comments.map((c) => c.content).join("\n")).toContain("topics/endless-calf");
  });

  it("origin non su GitHub: il Cloud rifiuterebbe, la card va sul PC", async () => {
    const h = harness({ github: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("modello non Claude (Codex): niente Cloud, la card va sul PC", async () => {
    const h = harness();
    h.seed(CARD, { model: "codex:gpt-5.5" });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("modello non Claude e PC offline: resta sul Mac", async () => {
    const h = harness({ pcOnline: false });
    h.seed(CARD, { model: "codex:gpt-5.5" });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
  });
});

describe("overflow: l'orologio dei 2 minuti misura una attesa ininterrotta", () => {
  it("un giro fermato da un'altra attesa (tetto di spesa) riparte da zero", async () => {
    const h = harness();
    h.seed(CARD, { costCents: 500 });
    await h.tick(); // held by memory: the clock starts
    h.advance(90_000);
    h.svc.getSpendCaps = () => ({ perTaskCents: 100, perDayCents: 0 });
    await h.tick(); // held by the spend cap, not by memory: the clock stops
    h.svc.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 0 });
    h.advance(60_000); // 150 s since the first hold, 60 s since this one
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("una card che esce da Todo e ci torna riparte da zero", async () => {
    const h = harness();
    h.seed(CARD);
    await h.tick();
    h.advance(90_000);
    h.db.run("UPDATE tasks SET status = 'backlog' WHERE id = ?", [CARD]);
    await h.tick();
    h.db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [CARD]);
    h.advance(60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });
});

describe("overflow: lo spazio sulle altre macchine", () => {
  it("un giro sposta al massimo OVERFLOW_MAX_PER_ROUND card", async () => {
    const h = harness();
    const ids = ["c-1", "c-2", "c-3"];
    for (const id of ids) h.seed(id);
    await holdPastThreshold(h);
    expect(ids.filter((id) => h.task(id).machineId === CLOUD)).toHaveLength(OVERFLOW_MAX_PER_ROUND);
    await h.tick();
    expect(ids.filter((id) => h.task(id).machineId === CLOUD)).toHaveLength(3);
  });

  it("il PC pieno ai suoi posti non prende la terza card", async () => {
    const h = harness({ cloudOnline: false });
    const ids = ["c-1", "c-2", "c-3"];
    for (const id of ids) h.seed(id);
    await holdPastThreshold(h);
    await h.tick();
    h.advance(60_000);
    await h.tick();
    expect(ids.filter((id) => h.task(id).machineId === PC)).toHaveLength(OVERFLOW_SLOTS.node);
    expect(ids.filter((id) => h.task(id).machineId === null)).toHaveLength(3 - OVERFLOW_SLOTS.node);
  });
});

describe("overflow: le due regole pure", () => {
  const m = (id: string, kind: "cloud" | "node", online: boolean): OverflowMachine => ({ id, name: id, kind, online });

  const ok: OverflowChoice = { cloudCredit: true, githubOrigin: true, model: null, load: () => 0 };
  const both = [m("pc", "node", true), m("cloud", "cloud", true)];

  it("Cloud con credito prima, poi il primo nodo online", () => {
    expect(pickOverflowMachine(both, ok)?.id).toBe("cloud");
    expect(pickOverflowMachine(both, { ...ok, cloudCredit: false })?.id).toBe("pc");
    expect(pickOverflowMachine([m("pc", "node", false), m("cloud", "cloud", false)], ok)).toBeNull();
  });

  it("Cloud solo con origin GitHub e modello Claude: altrimenti il PC", () => {
    expect(pickOverflowMachine(both, { ...ok, githubOrigin: false })?.id).toBe("pc");
    expect(pickOverflowMachine(both, { ...ok, model: "codex:gpt-5.5" })?.id).toBe("pc");
    expect(pickOverflowMachine(both, { ...ok, model: "claude-code:sonnet" })?.id).toBe("cloud");
    expect(pickOverflowMachine([m("cloud", "cloud", true)], { ...ok, model: "codex" })).toBeNull();
  });

  it("una macchina ai suoi posti non prende altro", () => {
    expect(pickOverflowMachine(both, { ...ok, load: (id) => (id === "cloud" ? OVERFLOW_SLOTS.cloud : 0) })?.id).toBe("pc");
    expect(pickOverflowMachine(both, { ...ok, load: (id) => (id === "cloud" ? OVERFLOW_SLOTS.cloud : OVERFLOW_SLOTS.node) })).toBeNull();
    expect(pickOverflowMachine([{ ...m("pc", "node", true), slots: 5 }], { ...ok, load: () => 4 })?.id).toBe("pc");
  });

  it("i modelli che il cloud esegue", () => {
    for (const yes of [null, "", "opus", "claude-code:sonnet", "claude-opus-5-5", "claude-code"]) expect(cloudRunsModel(yes)).toBe(true);
    for (const no of ["codex", "codex:gpt-5.5", "gpt-5.5", "openai:o5", "gemini-3"]) expect(cloudRunsModel(no)).toBe(false);
  });

  it("solo le card che girerebbero qui, senza marcatura, con l'interruttore acceso", () => {
    expect(overflowEligible({ machineId: null }, {}, LOCAL)).toBe(true);
    expect(overflowEligible({ machineId: LOCAL }, {}, LOCAL)).toBe(true);
    expect(overflowEligible({ machineId: PC }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null, stayLocal: true }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null }, { dispatchStayLocal: true }, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null }, { dispatchOverflow: false }, LOCAL)).toBe(false);
  });
});
