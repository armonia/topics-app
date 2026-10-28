/**
 * THE MEMORY FLOOR HOLDS THIS MACHINE, NOT THE NODE.
 *
 * The floor answers "can THIS Mac take one more agent". A card whose
 * `machine_id` names a paired node is launched over there (`remoteLaunch`, then
 * `createRun`): no worktree, no topic, no process and no gigabyte on this side.
 * Holding it behind the Mac's floor parks work that costs the Mac nothing, for
 * as long as the Mac stays short of memory (hours, on a loaded board).
 *
 * The contract, in three clauses:
 *  1. while the floor blocks the local queue, a remote card is still launched
 *     on its node, and a local card queued beside it stays blocked (control);
 *  2. a remote card takes no local exempt slot: the "one card by derogation"
 *     the floor grants a machine with none of our work on it is still there
 *     for a local card after the remote one has started;
 *  3. admitting it reads no local memory figure: once it is in flight, the
 *     floor's census (`reservedCards`, `reservedGB`, `spendingHere`,
 *     `ourWorkRunning`) still sees an empty machine.
 *
 * Harness: the node fake and the dispatcher wiring of
 * `task-dispatcher-remote-node.test.ts`, the injected floor verdict of
 * `task-dispatcher-pressure.test.ts`. No network, no sleeps.
 *
 * @covers KANBAN-76
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { MemoryFloorHold, ResourceFloorVerdict } from "./dispatch-capacity";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const PID = "alpha-abc123";
const NODE = "node-1";
const LOCAL = "questa-macchina";
const REMOTE_CARD = "card-sul-nodo";
const LOCAL_CARD = "card-locale";
const LOCAL_CARD_2 = "card-locale-2";
const REMOTE_CARD_2 = "card-sul-nodo-2";

const FLOOR_TEXT = "Memoria quasi finita: 5.5 GB disponibili, sotto il pavimento di 6 GB. Riprendo appena si libera memoria: niente è andato perso.";

const BLOCKED: ResourceFloorVerdict = { reason: FLOOR_TEXT, kind: "memory", memoryFirstCardExempt: false };
const EXEMPT: ResourceFloorVerdict = { reason: null, kind: null, memoryFirstCardExempt: true };

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
    max_agents_auto INTEGER, dispatch_fanout INTEGER
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
  db.run("INSERT INTO machines (id) VALUES (?)", [NODE]);
  db.run("INSERT INTO machines (id) VALUES (?)", [LOCAL]);
  return db;
}

/**
 * `floor` is the verdict while no local work is in flight. Once a LOCAL turn is
 * alive the floor is what the real one says: blocked (the derogation is for a
 * machine with none of our work on it, one card, once).
 */
function harness(floor: ResourceFloorVerdict) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const created: unknown[] = [];
  const worktrees: string[] = [];
  const turns: string[] = [];
  const readings: MemoryFloorHold[] = [];
  const now = Date.UTC(2026, 8, 6, 10, 0, 0);
  let nextRun = 0;

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${turns.length + worktrees.length + 1}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async () => { worktrees.push(`wt-${worktrees.length + 1}`); return `wt-${worktrees.length}`; },
    deleteWorktree: async () => {},
    // Never settles: a local turn that was started stays in flight, so the
    // second local card meets the floor with our work already on the machine.
    runTurn: (sessionKey) => { turns.push(sessionKey); return new Promise<TurnEndInfo | void>(() => {}); },
    broadcast: () => {},
    resourceBlock: (hold) => {
      readings.push({ ...hold });
      return hold.ourWorkRunning ? BLOCKED : floor;
    },
    node: {
      createRun: async ({ body }) => { created.push(body); nextRun += 1; return { runId: `run-${nextRun}` }; },
      readRun: async () => ({
        status: "in_progress", dispatchState: "working", dispatchError: null, comments: [],
        deliveryBranch: null, deliveryCommit: null, baseSha: null, stat: null,
      }),
      fetchBundle: async () => ({ empty: true as const }),
      cancelRun: async () => {},
      baseUrlOf: () => "https://node.local",
      tokenOf: () => "tok-node-1",
      delegatedTokenOf: () => "tok-confined",
      nameOf: () => "Portatile",
      localMachineId: () => LOCAL,
      originUrlOf: async () => "git@github.com:acme/alpha.git",
      plantBranch: async () => ({ planted: true, commit: "c0ffeec0ffee", reason: null }),
    },
    now: () => now,
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1 });
  svc.setGlobalCap({ auto: false, max: 9 });

  /** Oldest first, so the queue order is the order of the calls. */
  let seq = 0;
  const seed = (id: string, machineId: string) => {
    const ts = new Date(now + seq++ * 1000).toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts, machine_id)
       VALUES (?, ?, 'una card in coda', 'sotto il pavimento', 'todo', ?, ?, 0, ?)`,
      [id, PID, ts, ts, machineId],
    );
  };
  return { svc, dispatcher, created, worktrees, turns, readings, seed, task: (id: string) => svc.get(id)!.task };
}

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
async function dispatch(h: ReturnType<typeof harness>) {
  await h.dispatcher.tick(PID);
  await flush();
}

describe("il pavimento di memoria del Mac non trattiene le card dei nodi", () => {
  it("con il pavimento che blocca, la card del nodo parte sul nodo e quella locale resta ferma", async () => {
    const h = harness(BLOCKED);
    h.seed(REMOTE_CARD, NODE);
    h.seed(LOCAL_CARD, LOCAL);

    await dispatch(h);

    // The remote card runs over there ...
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ originTaskId: REMOTE_CARD });
    expect(h.task(REMOTE_CARD).status).toBe("in_progress");
    expect(h.task(REMOTE_CARD).dispatchState).toBe("working");
    // ... and the local card, the control, is held by the same floor.
    expect(h.task(LOCAL_CARD).status).toBe("todo");
    expect(h.worktrees).toEqual([]);
    expect(h.turns).toEqual([]);
  });

  it("a metà giro una seconda card del nodo non aspetta il pavimento locale", async () => {
    const h = harness(BLOCKED);
    h.seed(REMOTE_CARD, NODE);
    h.seed(REMOTE_CARD_2, NODE);

    await dispatch(h);

    expect(h.created).toHaveLength(2);
    expect(h.created.map((body) => (body as { originTaskId: string }).originTaskId))
      .toEqual([REMOTE_CARD, REMOTE_CARD_2]);
    expect(h.task(REMOTE_CARD).status).toBe("in_progress");
    expect(h.task(REMOTE_CARD_2).status).toBe("in_progress");
    expect(h.worktrees).toEqual([]);
    expect(h.turns).toEqual([]);
  });

  it("la card del nodo non prende lo slot di deroga: la prima card locale passa ancora", async () => {
    const h = harness(EXEMPT);
    h.seed(REMOTE_CARD, NODE);
    h.seed(LOCAL_CARD, LOCAL);
    h.seed(LOCAL_CARD_2, LOCAL);

    await dispatch(h);

    expect(h.created).toHaveLength(1);
    expect(h.task(REMOTE_CARD).dispatchState).toBe("working");
    // One local card by derogation, exactly as if the remote one did not exist ...
    expect(h.turns).toHaveLength(1);
    expect(h.task(LOCAL_CARD).status).toBe("in_progress");
    // ... and the second one is back under the full floor.
    expect(h.task(LOCAL_CARD_2).status).toBe("todo");
  });

  it("ammetterla non legge nessuna cifra locale: per il pavimento la macchina resta vuota", async () => {
    const h = harness(BLOCKED);
    h.seed(REMOTE_CARD, NODE);

    await dispatch(h);
    await dispatch(h);

    // The card is in flight on the node ...
    expect(h.created).toHaveLength(1);
    expect(h.dispatcher.busyIds()).toContain(REMOTE_CARD);
    // ... and no reading of the floor charges it to this machine.
    expect(h.readings.length).toBeGreaterThan(0);
    for (const r of h.readings) {
      expect(r).toMatchObject({ reservedCards: 0, reservedGB: 0, spendingHere: false, ourWorkRunning: false });
    }
  });
});
