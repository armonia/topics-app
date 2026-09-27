/**
 * A HELD RESUME IS QUIET: it writes its chip when the hold changes, not at every retry.
 *
 * Measured on 15/09/2026: with the memory floor holding, each queued resume
 * retried every 5-6.75 s and every retry rewrote `dispatch_error` with the
 * reading of that instant, touched `updated_at` and broadcast `task:updated`.
 * Seven held cards made about 70 frames a minute to every client.
 *
 * The real service, dispatcher and floor composer (`dispatchResourceVerdict`, the
 * native runtime's floor of 6 GB, with its hysteresis): only the memory and disk
 * readings are injected. The retries are driven by hand at the cadence the timer
 * keeps, with the system clock moved between them, so two minutes take
 * milliseconds.
 *  1. Seven cards held for two minutes by readings that cross 6.0 GB, where the
 *     composer swings between "under the floor" and "climbing back": at most two
 *     frames and two row writes per card, and the card still reads the kind.
 *  2. A change of kind (floor, then the 24h spend, then the floor again) or of
 *     resource (memory, then disk) is written at the very next retry; the swing
 *     between the sentences of one memory episode waits for the minute refresh.
 *  3. Quiet only while the row still says what we wrote: when another writer
 *     rewrites the chip between two retries, the next retry puts the hold back.
 *  4. The warm-up does not own the dedup key of the real floor, so the reason
 *     that matters reaches the thread (KANBAN-91).
 * @covers KANBAN-75
 * @covers KANBAN-91
 */
import { describe, it, expect, setSystemTime, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type Task, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";
import { dispatchResourceBlock, dispatchResourceVerdict } from "./dispatch-capacity";
import type { HeldMemory } from "./mem-signal";
import { clearProviderHold, resetProviderHoldStore, setProviderHold } from "../lib/provider-hold";
import { taskDetailBump } from "../../client/src/lib/board";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5, dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    max_agents_auto INTEGER, dispatch_fanout INTEGER, dispatch_paused INTEGER NOT NULL DEFAULT 0,
    max_agents_mode TEXT, max_load_ratio REAL, max_mem_ratio REAL, machine_budget_share REAL
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT, UNIQUE (task_id, idx)
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment', message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run(APP_SETTINGS_DDL);
  db.run("UPDATE app_settings SET auto_dispatch = 1 WHERE id = 1");
  return db;
}

const PID = "alpha-abc123";

/**
 * The readings the rows showed that morning (5.7, 5.9, 6.0, 5.8), plus the swing
 * of a tenth around 6.0 the production DB also shows: under 6 the composer
 * writes "under the floor", from 6.0 up, while holding, "climbing back".
 */
const READINGS = [5.7, 5.9, 6.0, 5.8, 6.1, 5.9];

const dispatchers: { shutdown(): void }[] = [];
afterEach(() => {
  setSystemTime();
  for (const d of dispatchers.splice(0)) d.shutdown();
});

/** A full 2-minute window whose lowest reading is `gb`; `null` = not measurable. */
const windowAt = (gb: number | null) => (): HeldMemory =>
  gb == null ? { measurable: false, latestGB: null, heldGB: null, coveredMs: 0 } : { measurable: true, latestGB: gb, heldGB: gb, coveredMs: 120_000 };

function harness() {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const frames: string[] = [];
  const lastFrames = new Map<string, Task>();
  /** Every chip write that reached the row, whoever made it. */
  const writes: string[] = [];
  const setDispatchState = svc.setDispatchState.bind(svc);
  svc.setDispatchState = (input) => { writes.push(input.taskId); return setDispatchState(input); };
  /** The injected probes; `null` memory = no reading, the composer holds nothing.
   *  `warming` is the state of the first 120 s of a process: readings arriving,
   *  no full window yet. */
  const floor = { memGB: null as number | null, diskGB: 100, warming: false };
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: () => ({ topicId: "topic-new", sessionKey: "topic:new" }),
    createWorktree: async (storeId) => `wt-${storeId}`,
    topicExists: () => true,
    runTurn: () => new Promise<TurnEndInfo | void>(() => { /* stays in flight */ }),
    broadcast: (m: OutboundMessage) => {
      const msg = m as { type: string; task?: { id: string } };
      if (msg.type === "task:updated" && msg.task) {
        frames.push(msg.task.id);
        lastFrames.set(msg.task.id, msg.task as Task);
      }
    },
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    // A full window at the injected reading, with a turn of ours on the machine
    // (the held cards' own), so the floor's line is floor + price and the
    // readings swing between its two sentences.
    resourceBlock: (hold) => dispatchResourceVerdict(
      "/",
      () => floor.diskGB,
      floor.warming ? () => ({ measurable: true, latestGB: 20, heldGB: null, coveredMs: 11_000 }) : windowAt(floor.memGB),
      false,
      { ...hold, spendingHere: true, ourWorkRunning: true },
    ),
  };
  const dispatcher = createTaskDispatcher(deps);
  dispatchers.push(dispatcher);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  svc.setGlobalCap({ auto: false, max: 4 });
  return {
    db, svc, dispatcher, frames, floor,
    /** A RESTART: same database, a brand new dispatcher whose in-memory maps
     *  (`waitingForSlot`, `heldWritten`, the held-block map) are empty. */
    restart: () => {
      dispatcher.shutdown();
      const next = createTaskDispatcher(deps);
      dispatchers.push(next);
      return next;
    },
    task: (id: string) => svc.get(id)!.task,
    framesOf: (id: string) => frames.filter((f) => f === id).length,
    lastFrame: (id: string) => lastFrames.get(id),
    writesOf: (id: string) => writes.filter((w) => w === id).length,
    serviceNotes: (id: string) => svc.get(id)!.comments.filter((c) => c.kind === "service").map((c) => c.content),
  };
}

function heldCard(db: Database, id: string): void {
  const ts = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, 'held resume', 'in_progress', ?, ?, ?, 1, 2)`,
    [id, PID, `topic-${id}`, ts, ts],
  );
}

function todo(h: ReturnType<typeof harness>, id: string): void {
  const ts = new Date().toISOString();
  h.db.run("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority) VALUES (?, ?, 'x', 'todo', ?, ?, 0, 2)", [id, PID, ts, ts]);
}

/** The 24h spend cap reached (`on`) or off, on the real service's two reads. */
function daySpend(h: ReturnType<typeof harness>, on: boolean): void {
  const spend = h.svc as unknown as { getSpendCaps: () => object; agentSpend: () => object };
  spend.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: on ? 1_000 : 0 });
  spend.agentSpend = () => ({ cents24h: 1_200, centsTotal: 1_200, unpricedCostTokens24h: 0, unpricedCostTokensTotal: 0 });
}

describe("a held resume writes its chip when the hold changes, not at every retry", () => {
  it("seven cards held by a moving memory reading for two minutes: at most two frames and two writes per card", async () => {
    const h = harness();
    let read = 0;
    const ids = Array.from({ length: 7 }, (_, i) => `held-${i}`);
    for (const id of ids) heldCard(h.db, id);

    const t0 = Date.now();
    const updatedAt = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
    // Twenty retries, 6 s apart (the timer's 5 s plus its stagger): 0 .. 114 s.
    for (let retry = 0; retry < 20; retry++) {
      setSystemTime(new Date(t0 + retry * 6_000));
      for (const id of ids) {
        h.floor.memGB = READINGS[read++ % READINGS.length]!;
        await h.dispatcher.resume(id, retry === 0 ? "continua" : "");
        updatedAt.get(id)!.add(h.task(id).updatedAt);
      }
    }

    // The swing is really there: the composer wrote both sentences on these readings.
    const sentences = new Set<string>();
    for (const gb of READINGS) {
      sentences.add(dispatchResourceBlock("/", () => 100, windowAt(gb), false, { cardGB: 4, reservedGB: 0, reservedCards: 0, spendingHere: true, ourWorkRunning: true })!.split(":")[0]!);
    }
    expect([...sentences].sort()).toEqual(["Memoria in risalita", "Memoria quasi finita"]);
    for (const id of ids) {
      // Two, not one: the first hold, and the refresh of its numbers a minute later.
      expect(h.framesOf(id)).toBe(2);
      expect(updatedAt.get(id)!.size).toBeLessThanOrEqual(2);
      // Quiet, not blind: still queued, and the card still reads the floor.
      expect(h.task(id).dispatchState).toBe("queued");
      expect(h.task(id).dispatchError).toStartWith("Memoria ");
      expect(h.task(id).queueReason).toMatchObject({ kind: "resource_floor" });
    }
    // Nothing started while the floor held.
    expect(h.task(ids[0]!).status).toBe("in_progress");
  });

  it("a change of kind or of words is written at the next retry, and the card reads the new kind", async () => {
    const h = harness();
    h.floor.memGB = 5.7;
    heldCard(h.db, "switch");
    const t0 = Date.now();
    let at = 0;
    const retry = async (stepMs = 6_000) => {
      setSystemTime(new Date(t0 + (at += stepMs)));
      await h.dispatcher.resume("switch", "");
    };

    await h.dispatcher.resume("switch", "continua");
    expect(h.framesOf("switch")).toBe(1);
    expect(h.task("switch").dispatchError).toStartWith("Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è 5.7 GB");
    h.floor.memGB = 5.9;
    await retry();
    expect(h.framesOf("switch")).toBe(1);

    // Climbing back is another sentence of the SAME episode: no frame now...
    h.floor.memGB = 6.4;
    await retry();
    expect(h.framesOf("switch")).toBe(1);
    // ...and the minute refresh brings the sentence of now.
    await retry(60_000);
    expect(h.framesOf("switch")).toBe(2);
    expect(h.task("switch").dispatchError).toStartWith("Memoria in risalita: la lettura più bassa degli ultimi 2 minuti è 6.4 GB");
    expect(h.task("switch").queueReason).toMatchObject({ kind: "resource_floor" });

    // Another resource inside the same kind: the disk fills, written at once.
    h.floor.diskGB = 5;
    await retry();
    expect(h.framesOf("switch")).toBe(3);
    expect(h.task("switch").dispatchError).toStartWith("Disco quasi pieno: 5.0 GB");
    expect(h.task("switch").queueReason).toMatchObject({ kind: "resource_floor" });
    h.floor.diskGB = 100;

    // The floor clears and the 24h spend holds it: another kind, written at once.
    h.floor.memGB = null;
    const spend = h.svc as unknown as { getSpendCaps: () => object; agentSpend: () => object };
    spend.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 1_000 });
    spend.agentSpend = () => ({ cents24h: 1_200, centsTotal: 1_200, unpricedCostTokens24h: 0, unpricedCostTokensTotal: 0 });
    await retry();
    expect(h.framesOf("switch")).toBe(4);
    expect(h.task("switch").dispatchError).toStartWith("Tetto di spesa giornaliero raggiunto");
    expect(h.task("switch").queueReason).toMatchObject({ kind: "spend_cap" });

    // And back to the floor: written at once again, with the reading of now.
    spend.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 0 });
    h.floor.memGB = 5.2;
    await retry();
    expect(h.framesOf("switch")).toBe(5);
    expect(h.task("switch").dispatchError).toContain("ultimi 2 minuti è 5.2 GB");
    expect(h.task("switch").queueReason).toMatchObject({ kind: "resource_floor" });
  });

  /**
   * AN HOUR OF IT, with a person writing to the card every five minutes. The
   * comment route calls `resume` with the words, so each comment is one more
   * pass through the hold, between two retries. Card 0fcb7b87 asked for this
   * count on the case it came from (89919742, a held resume in In progress).
   */
  it("an hour held with a comment every five minutes: one write on a steady floor, one a minute on a moving one", async () => {
    const hour = async (readings: number[]) => {
      const h = harness();
      heldCard(h.db, "talked");
      const t0 = Date.now();
      const stamps = new Set<string>();
      // 600 retries 6 s apart; a comment 3 s after every 50th, so its stamp is its own.
      for (let retry = 0; retry < 600; retry++) {
        setSystemTime(new Date(t0 + retry * 6_000));
        h.floor.memGB = readings[retry % readings.length]!;
        await h.dispatcher.resume("talked", "");
        stamps.add(h.task("talked").updatedAt);
        if (retry > 0 && retry % 50 === 0) {
          setSystemTime(new Date(t0 + retry * 6_000 + 3_000));
          const c = h.svc.addComment({ taskId: "talked", author: "user", content: `any news at minute ${retry / 10}?` });
          await h.dispatcher.resume("talked", c.content, { commentIds: [c.id] });
          stamps.add(h.task("talked").updatedAt);
        }
      }
      expect(h.task("talked").status).toBe("in_progress");
      expect(h.task("talked").queueReason).toMatchObject({ kind: "resource_floor" });
      return { writes: h.writesOf("talked"), frames: h.framesOf("talked"), stamps: stamps.size };
    };
    // The first retry writes; after it only the eleven comments move the row.
    expect(await hour([4.8])).toEqual({ writes: 1, frames: 1, stamps: 12 });
    // Moving figures: the minute refresh (60 writes), plus the same eleven comments.
    expect(await hour([4.2, 3.9, 3.5])).toEqual({ writes: 60, frames: 60, stamps: 71 });
  });

  it("another writer rewrites the chip between two retries: the next retry puts the hold back", async () => {
    const h = harness();
    h.floor.memGB = 5.7;
    heldCard(h.db, "rewritten");
    const t0 = Date.now();
    await h.dispatcher.resume("rewritten", "continua");
    expect(h.task("rewritten").dispatchState).toBe("queued");
    expect(h.framesOf("rewritten")).toBe(1);

    // Same hold, same resource, well inside the minute: only the row tells the
    // retry that its last write is gone.
    h.svc.setDispatchState({ taskId: "rewritten", state: null });
    setSystemTime(new Date(t0 + 6_000));
    h.floor.memGB = 5.8;
    await h.dispatcher.resume("rewritten", "");
    expect(h.task("rewritten").dispatchState).toBe("queued");
    expect(h.task("rewritten").dispatchError).toStartWith("Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è 5.8 GB");
    expect(h.task("rewritten").queueReason).toMatchObject({ kind: "resource_floor" });
  });

  /**
   * KANBAN-91: THE WARM-UP DOES NOT OWN THE KEY OF THE REAL FLOOR.
   *
   * "Memoria: la sto misurando da 11 s su 120" and "Memoria quasi finita: …"
   * share their first word, which was the whole dedup key for a machine-floor
   * wait. The warm-up is a 120 s state guaranteed at every boot, so it always
   * wrote first and the real reason NEVER reached the thread: 80 comments out of
   * 80 after 15/09/2026 17:49 carried the warm-up and zero carried the floor,
   * while `dispatch_error` beside them was refreshed every 60 s with the right
   * text - chip and conversation saying two different things.
   */
  it("the warm-up writes no line in the thread, and the floor's reason arrives when the window fills", async () => {
    const h = harness();
    h.floor.warming = true;
    heldCard(h.db, "boot");
    const t0 = Date.now();

    await h.dispatcher.resume("boot", "continua");
    // The chip says it - that channel is not the one that was broken.
    expect(h.task("boot").dispatchError).toContain("la sto misurando");
    // The thread does not: it lasts 120 s, the chip already says it, and a
    // permanent line about an empty window is the wrong half of the story.
    expect(h.serviceNotes("boot")).toEqual([]);

    // The window fills and the floor bites: another wait, so the card gets it.
    h.floor.warming = false;
    h.floor.memGB = 4.8;
    setSystemTime(new Date(t0 + 6_000));
    await h.dispatcher.resume("boot", "");
    const notes = h.serviceNotes("boot");
    expect(notes.length).toBe(1);
    expect(notes[0]).toStartWith("Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è 4.8 GB");
    // AND THE CHIP MOVES WITH IT, which is the half the dedup key decides and
    // the only half a mutation can reach: the warm-up writes no thread line at
    // all, so with the old key - the reason's first word, shared by "Memoria:
    // la sto misurando" and "Memoria quasi finita" - the note above still got
    // through and nothing here failed. What stayed wrong was the row: the wait
    // was believed unchanged, so the chip kept saying "I am measuring it" for up
    // to HELD_RESUME_REFRESH_MS (60 s) after the floor had already bitten.
    expect(h.task("boot").dispatchError).toStartWith("Memoria quasi finita");

    // And it stays one: the same wait is not re-said at every retry.
    setSystemTime(new Date(t0 + 12_000));
    h.floor.memGB = 4.9;
    await h.dispatcher.resume("boot", "");
    expect(h.serviceNotes("boot").length).toBe(1);

    // Another resource IS another wait, and the card gets it (KANBAN-91). It
    // takes the place of the memory line instead of stacking under it: the
    // note is the card's wait NOW, one slot per card (see RESUME_WAIT_OPENINGS).
    setSystemTime(new Date(t0 + 18_000));
    h.floor.memGB = null;
    h.floor.diskGB = 2;
    await h.dispatcher.resume("boot", "");
    expect(h.serviceNotes("boot").length).toBe(1);
    expect(h.serviceNotes("boot")[0]).toStartWith("Disco quasi pieno");
  });
});

/**
 * A HELD CARD ACROSS RESTARTS: its notes are a STATE, one slot per card.
 *
 * Measured on 24/09/2026 on card 89919742 (in progress, queued behind a Codex
 * wall of days): 15 identical boot notes and 17 identical wall notes, one pair
 * per boot, boots 35+ minutes apart. The in-memory registers are born empty at
 * every process and the `addComment` dedupe window is 10 s, so nothing stopped
 * them. Same shape on the memory floor: 33 notes on 13 cards, up to 6 on one,
 * different only in their figures. And the chip was rewritten every minute with
 * the very sentence the row already carried: `updated_at` moved and every client
 * got a frame for nothing.
 */
describe("a held card across restarts", () => {
  afterEach(() => { clearProviderHold(); clearProviderHold("codex"); });

  const bootNotes = (h: ReturnType<typeof harness>, id: string) =>
    h.serviceNotes(id).filter((c) => c.startsWith("Server ripartito mentre la card aspettava uno slot"));

  it("three boots 35 minutes apart leave one boot note, not three", async () => {
    const h = harness();
    h.floor.memGB = 4.8;
    heldCard(h.db, "booted");
    h.db.run("UPDATE tasks SET dispatch_state = 'queued' WHERE id = 'booted'");
    const t0 = Date.now();
    let d = h.dispatcher;
    for (let boot = 0; boot < 3; boot++) {
      setSystemTime(new Date(t0 + boot * 35 * 60_000));
      if (boot > 0) d = h.restart();
      await d.reconcile({ reason: "boot" });
    }
    expect(bootNotes(h, "booted")).toHaveLength(1);
  });

  it("the memory floor across boots, with other figures each time: one note, the current one", async () => {
    const h = harness();
    heldCard(h.db, "floor");
    const t0 = Date.now();
    let d = h.dispatcher;
    for (const [boot, gb] of [4.8, 5.1, 4.2].entries()) {
      setSystemTime(new Date(t0 + boot * 35 * 60_000));
      h.floor.memGB = gb;
      if (boot > 0) d = h.restart();
      await d.resume("floor", "");
    }
    const floorNotes = h.serviceNotes("floor").filter((c) => c.startsWith("Memoria"));
    expect(floorNotes).toHaveLength(1);
    expect(floorNotes[0]).toContain("4.2 GB");
  });

  it("a provider wall of days across boots: one note on the card, not one per boot", async () => {
    resetProviderHoldStore();
    const h = harness();
    heldCard(h.db, "walled");
    const t0 = Date.now();
    setProviderHold({ untilMs: t0 + 6 * 24 * 3_600_000, window: "usage_limit", reason: "Claude quota exhausted" });
    let d = h.dispatcher;
    for (let boot = 0; boot < 3; boot++) {
      setSystemTime(new Date(t0 + boot * 35 * 60_000));
      if (boot > 0) d = h.restart();
      await d.resume("walled", "");
    }
    expect(h.task("walled").dispatchError).toContain("piano esaurito");
    expect(h.serviceNotes("walled").filter((c) => c.startsWith("Claude: "))).toHaveLength(1);
  });

  it("the pile already in the thread shrinks to one, and only the machine's own copies go", async () => {
    const h = harness();
    heldCard(h.db, "pile");
    for (const gb of ["4.1", "4.3", "4.5"]) {
      h.svc.addComment({ taskId: "pile", author: "system", kind: "service", content: `Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è ${gb} GB, vecchia.` });
    }
    // allow-italian: a person and an agent writing the same opening in the thread
    h.svc.addComment({ taskId: "pile", author: "user", content: "Memoria quasi finita: lo so, ho chiuso Chrome." });
    h.svc.addComment({ taskId: "pile", author: "agent-1", content: "Memoria quasi finita: aspetto." });
    h.floor.memGB = 4.8;
    await h.dispatcher.resume("pile", "");
    const all = h.svc.get("pile")!.comments.map((c) => `${c.author}|${c.content}`);
    expect(all.filter((c) => c.startsWith("system|Memoria"))).toHaveLength(1);
    expect(all.filter((c) => c.startsWith("system|Memoria"))[0]).toContain("4.8 GB");
    expect(all.some((c) => c.startsWith("user|Memoria quasi finita: lo so"))).toBe(true);
    expect(all.some((c) => c.startsWith("agent-1|Memoria quasi finita: aspetto"))).toBe(true);
  });

  it("the same sentence already on the row: no write and no frame, even after the minute and after a restart", async () => {
    const h = harness();
    h.floor.memGB = 4.8;
    heldCard(h.db, "still");
    const t0 = Date.now();
    await h.dispatcher.resume("still", "");
    expect(h.framesOf("still")).toBe(1);
    const stamp = h.task("still").updatedAt;

    setSystemTime(new Date(t0 + 65_000));
    await h.dispatcher.resume("still", "");
    expect(h.framesOf("still")).toBe(1);
    expect(h.task("still").updatedAt).toBe(stamp);

    // A restart empties the kind map: the row is not rewritten, but the card
    // must still read the machine block that holds it, and clients that read
    // it in the gap get it through ONE frame (see the next test).
    setSystemTime(new Date(t0 + 35 * 60_000));
    const d = h.restart();
    await d.resume("still", "");
    expect(h.framesOf("still")).toBe(2);
    expect(h.task("still").updatedAt).toBe(stamp);
    expect(h.task("still").queueReason).toMatchObject({ kind: "resource_floor" });
  });

  /**
   * The client read the card between the boot and the first held resume
   * (useBoardFeed refetches on every socket 'open'), when the kind map was still
   * empty: its copy says queueReason null. The row is right and is not
   * rewritten, but without a frame that copy stays wrong until the words
   * change. One frame per card per boot, the first time the map learns it.
   * Found by the verifier of this branch (repro R2).
   */
  it("after a restart, the first quiet resume sends ONE frame so a client that read the empty map learns the reason", async () => {
    const h = harness();
    h.floor.memGB = 4.8;
    heldCard(h.db, "relearn");
    const t0 = Date.now();
    await h.dispatcher.resume("relearn", "");
    expect(h.framesOf("relearn")).toBe(1);
    setSystemTime(new Date(t0 + 35 * 60_000));
    const d = h.restart();
    await d.resume("relearn", "");
    expect(h.framesOf("relearn")).toBe(2);
    await d.resume("relearn", "");
    setSystemTime(new Date(t0 + 37 * 60_000));
    await d.resume("relearn", "");
    expect(h.framesOf("relearn")).toBe(2);
  });

  /**
   * The relearned frame is the only frame that carries no write, and it is owed
   * once per card per boot. What the rest of the boot does to the row goes
   * through the write path (another kind of hold, another writer clearing the
   * chip) or finds the map already knowing the sentence: never a second frame
   * of its own.
   */
  it("inside one boot, a kind that changes and a chip cleared by another writer add writes, not relearned frames", async () => {
    const h = harness();
    h.floor.memGB = 4.8;
    heldCard(h.db, "oneboot");
    const t0 = Date.now();
    await h.dispatcher.resume("oneboot", "");
    const sentence = h.task("oneboot").dispatchError;
    let at = 35 * 60_000;
    setSystemTime(new Date(t0 + at));
    const d = h.restart();
    const frames0 = h.framesOf("oneboot");
    const writes0 = h.writesOf("oneboot");
    const retry = async () => {
      setSystemTime(new Date(t0 + (at += 6_000)));
      await d.resume("oneboot", "");
    };

    await retry();
    // The kind changes twice: the floor clears and the 24h spend holds, then
    // the floor comes back with the very sentence the row carried at the boot.
    h.floor.memGB = null;
    daySpend(h, true);
    await retry();
    expect(h.task("oneboot").queueReason).toMatchObject({ kind: "spend_cap" });
    daySpend(h, false);
    h.floor.memGB = 4.8;
    await retry();
    expect(h.task("oneboot").dispatchError).toBe(sentence);
    // Another writer clears the chip; the next retry puts the same sentence back.
    h.db.run("UPDATE tasks SET dispatch_state = NULL, dispatch_error = NULL WHERE id = 'oneboot'");
    await retry();
    expect(h.task("oneboot").dispatchError).toBe(sentence);
    // And quiet from there, past the minute refresh.
    for (let i = 0; i < 20; i++) await retry();

    const writes = h.writesOf("oneboot") - writes0;
    expect(writes).toBe(3);
    expect(h.framesOf("oneboot") - frames0 - writes).toBe(1);
    expect(h.task("oneboot").queueReason).toMatchObject({ kind: "resource_floor" });
  });

  /**
   * A NEW episode with the same words comes back to the bottom. `once` kept the
   * old row wherever it was, so a wait that ended and started again after a
   * person had written stayed ABOVE that person's comment, and the thread read
   * as if the machine had spoken first. The slot is still one row: the old one
   * goes, the new one lands at the end. Found by the verifier (repro R3b).
   */
  it("a new episode with the same words after a human comment lands below it, and the slot keeps one row", async () => {
    const h = harness();
    h.floor.memGB = 4.8;
    heldCard(h.db, "again");
    const t0 = Date.now();
    await h.dispatcher.resume("again", "");
    // The episode ends: the card left the queue (it ran, it came back), and a
    // person writes. Done on the row, since the turn itself is not the subject.
    h.db.run("UPDATE tasks SET dispatch_state = 'working', dispatch_error = NULL WHERE id = 'again'");
    setSystemTime(new Date(t0 + 3 * 3_600_000));
    h.svc.addComment({ taskId: "again", author: "user", content: "rifai il test" }); // allow-italian: a person's message
    // A new episode, same reading, same words: after a restart, like prod.
    h.db.run("UPDATE tasks SET status = 'in_progress', dispatch_state = NULL, dispatch_error = NULL WHERE id = 'again'");
    h.floor.memGB = 4.8;
    await h.restart().resume("again", "");
    const thread = h.svc.get("again")!.comments.filter((c) => c.kind !== "status").map((c) => `${c.author}|${c.content.slice(0, 24)}`);
    expect(thread.filter((c) => c.startsWith("system|Memoria"))).toHaveLength(1);
    expect(thread[thread.length - 1]).toStartWith("system|Memoria");
  });
});

/**
 * THE TICK'S NOTE ON A TODO CARD IS THE SAME STATE as the resume's, in the same
 * words, so it is the same slot. Written apart, it piled up on its own (268 rows
 * on 58 cards in prod, up to 29 on one) and the resume's slot then erased it as
 * if it were its own copy. Found by the verifier (repro R1).
 */
describe("the tick's wait note on a todo card", () => {
  it("episodes of the floor with other figures leave one note on the card, the current one", async () => {
    const h = harness();
    todo(h, "queue1");
    const t0 = Date.now();
    let d = h.dispatcher;
    for (const [i, gb] of [4.8, 5.1, 4.2].entries()) {
      setSystemTime(new Date(t0 + i * 35 * 60_000));
      h.floor.memGB = gb;
      if (i > 0) d = h.restart();
      await d.tick(PID);
    }
    const notes = h.serviceNotes("queue1").filter((c) => c.startsWith("Memoria"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("4.2 GB");
  });

  /**
   * The tick only writes on a Todo card, and a Todo card has no live resume
   * wait: `resume` drops it as soon as the card is out of In progress. So the
   * resume note the tick's note replaces is always the one of a wait that has
   * ended, and the retry still in flight when the card moved does not bring
   * it back.
   */
  it("a held resume dragged back to Todo keeps one wait note, the tick's, and the late retry leaves it there", async () => {
    const h = harness();
    h.floor.memGB = 4.8;
    heldCard(h.db, "back");
    const t0 = Date.now();
    await h.dispatcher.resume("back", "");
    const memory = () => h.serviceNotes("back").filter((c) => c.startsWith("Memoria"));
    expect(memory()).toHaveLength(1);

    // A person drags it back to Todo, which unbinds its topic.
    h.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL WHERE id = 'back'");
    setSystemTime(new Date(t0 + 60_000));
    h.floor.memGB = 5.1;
    await h.dispatcher.tick(PID);
    expect(memory()).toHaveLength(1);
    expect(memory()[0]).toContain("5.1 GB");

    // The resume's retry timer was still armed: it fires, finds a Todo card, and drops its wait.
    await h.dispatcher.resume("back", "");
    expect(memory()).toHaveLength(1);
    expect(memory()[0]).toContain("5.1 GB");
  });
});

/**
 * A TODO CARD HELD BY THE MACHINE IS QUIET TOO.
 *
 * The tick polls every 10 s (`server.ts`), and its floor branch wrote the bare
 * `queued` chip on every held Todo card at every poll: `setDispatchState` moves
 * `updated_at` and the card went out as a `task:updated` frame. 360 writes and
 * 360 frames an hour per card, for a chip that already said `queued`, the same
 * burst the held resume had until 15/09. The chip is written when the row does
 * not carry it; the card is re-sent without a write when the block holding the
 * queue changes, with the held resume's one-minute refresh for moving figures,
 * and once more when a tick sees the block lift. A tick that returns before it
 * publishes (a paused board) sees nothing: the published block's own limit,
 * written in `dispatch-block-signal.ts`.
 */
describe("a todo card held by the machine for an hour", () => {
  it("a steady floor and a comment every five minutes: one write, one frame, updated_at moved only by the comments", async () => {
    const h = harness();
    h.floor.memGB = 4.8;
    todo(h, "hour");
    const t0 = Date.now();
    const stamps = new Set<string>();
    for (let poll = 0; poll < 360; poll++) {
      setSystemTime(new Date(t0 + poll * 10_000));
      if (poll > 0 && poll % 30 === 0) h.svc.addComment({ taskId: "hour", author: "user", content: `still waiting at minute ${poll / 6}?` });
      await h.dispatcher.tick(PID);
      stamps.add(h.task("hour").updatedAt);
    }
    expect(h.writesOf("hour")).toBe(1);
    expect(h.framesOf("hour")).toBe(1);
    // The first poll (chip and note in the same instant) and the eleven comments.
    expect(stamps.size).toBe(12);
    expect(h.task("hour").dispatchState).toBe("queued");
    expect(h.task("hour").status).toBe("todo");
    expect(h.task("hour").queueReason).toMatchObject({ kind: "resource_floor" });
    expect(h.serviceNotes("hour").filter((c) => c.startsWith("Memoria"))).toHaveLength(1);
  });

  it("a moving reading under the floor re-sends the card at most once a minute, and never writes it again", async () => {
    const h = harness();
    todo(h, "moving");
    const t0 = Date.now();
    const readings = [4.8, 4.9, 5.1, 4.7];
    for (let poll = 0; poll < 360; poll++) {
      setSystemTime(new Date(t0 + poll * 10_000));
      h.floor.memGB = readings[poll % readings.length]!;
      await h.dispatcher.tick(PID);
    }
    expect(h.writesOf("moving")).toBe(1);
    expect(h.framesOf("moving")).toBeGreaterThan(1);
    expect(h.framesOf("moving")).toBeLessThanOrEqual(60);
    expect(h.lastFrame("moving")!.queueReason).toMatchObject({ kind: "resource_floor" });
  });

  it("another block reaches the card at the next poll without a write, and the lift reaches it once, from any board", async () => {
    const OTHER = "beta-def456";
    const h = harness();
    h.svc.updateBoardSettings(OTHER, { autoDispatch: true, dispatchUseWorktree: false });
    h.floor.memGB = 4.8;
    todo(h, "kinds");
    const t0 = Date.now();
    let at = 0;
    const poll = async (board = PID) => {
      setSystemTime(new Date(t0 + (at += 10_000)));
      await h.dispatcher.tick(board);
    };

    await poll();
    await poll();
    expect(h.framesOf("kinds")).toBe(1);

    // The floor clears and the 24h spend holds the queue: another block, sent at once.
    h.floor.memGB = null;
    daySpend(h, true);
    await poll();
    expect(h.framesOf("kinds")).toBe(2);
    expect(h.lastFrame("kinds")!.queueReason).toMatchObject({ kind: "spend_cap" });
    await poll();
    expect(h.framesOf("kinds")).toBe(2);

    // The spend clears too. The first tick to see it is another board's, whose
    // queue is empty: the held card on this board still learns it, once.
    daySpend(h, false);
    await poll(OTHER);
    expect(h.framesOf("kinds")).toBe(3);
    expect(h.lastFrame("kinds")!.queueReason).toMatchObject({ kind: "slot" });
    await poll(OTHER);
    expect(h.framesOf("kinds")).toBe(3);
    expect(h.writesOf("kinds")).toBe(1);
  });

  /**
   * THE OPEN DRAWER FOLLOWS THE BLOCK. Those frames carry no write, so the
   * card's `updated_at` stays where the first poll left it, and the drawer
   * re-read its card only when that moved: opened under the floor, it kept the
   * floor after the spend cap took over, and the figures of the minute it was
   * opened, while the card beside it had moved on. Found by the verifier.
   */
  it("a drawer opened on the held card re-reads it when the figures change, the block changes and the block lifts", async () => {
    const OTHER = "beta-def456";
    const h = harness();
    h.svc.updateBoardSettings(OTHER, { autoDispatch: true, dispatchUseWorktree: false });
    h.floor.memGB = 4.8;
    todo(h, "drawer");
    const t0 = Date.now();
    let at = 0;
    const poll = async (stepMs = 10_000, board = PID) => {
      setSystemTime(new Date(t0 + (at += stepMs)));
      await h.dispatcher.tick(board);
    };
    const drawerSignal = () => taskDetailBump(h.lastFrame("drawer")!);

    await poll();
    await poll();
    const opened = drawerSignal();

    // Other figures under the same floor, sent with the minute refresh.
    h.floor.memGB = 4.2;
    await poll(60_000);
    expect(JSON.stringify(h.lastFrame("drawer")!.queueReason)).toContain("4.2");
    const figures = drawerSignal();
    expect(figures).not.toBe(opened);

    // The spend cap takes over from the floor.
    h.floor.memGB = null;
    daySpend(h, true);
    await poll();
    expect(h.lastFrame("drawer")!.queueReason).toMatchObject({ kind: "spend_cap" });
    const spend = drawerSignal();
    expect(spend).not.toBe(figures);

    // And it lifts, seen by another board's tick.
    daySpend(h, false);
    await poll(10_000, OTHER);
    expect(h.lastFrame("drawer")!.queueReason).toMatchObject({ kind: "slot" });
    expect(drawerSignal()).not.toBe(spend);
    expect(h.writesOf("drawer")).toBe(1);
  });

  it("the ramp does not rewrite a queued chip at every start", async () => {
    const h = harness();
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
    // The topic the harness's launches bind, so a start stays started.
    h.db.run("INSERT INTO topics (id) VALUES ('topic-new')");
    const t0 = Date.now();
    for (const [i, id] of ["ramp-1", "ramp-2", "ramp-3"].entries()) {
      setSystemTime(new Date(t0 + i));
      todo(h, id);
    }
    // One start per poll: each start puts the chip on the cards behind it.
    setSystemTime(new Date(t0 + 10_000));
    await h.dispatcher.tick(PID);
    setSystemTime(new Date(t0 + 20_000));
    await h.dispatcher.tick(PID);
    expect(h.task("ramp-1").status).toBe("in_progress");
    expect(h.task("ramp-2").status).toBe("in_progress");
    expect(h.task("ramp-3").dispatchState).toBe("queued");
    expect(h.writesOf("ramp-3")).toBe(1);
    expect(h.framesOf("ramp-3")).toBe(1);
  });

  // The floor re-read after a start (`midPassFloor`) holds the rest of that
  // pass, and each start under a low floor goes through it again: the path of
  // the memory derogation, where one card passes and the floor closes behind it.
  it("the floor read again after a start does not rewrite a queued chip at every start", async () => {
    const h = harness();
    h.db.run("INSERT INTO topics (id) VALUES ('topic-new')");
    const claim = h.svc.claim.bind(h.svc);
    // The card that starts takes the memory the next read sees.
    h.svc.claim = (input) => { const won = claim(input); if (won) h.floor.memGB = 4.8; return won; };
    const t0 = Date.now();
    for (const [i, id] of ["mid-1", "mid-2", "mid-3"].entries()) {
      setSystemTime(new Date(t0 + i));
      todo(h, id);
    }
    for (const poll of [1, 2]) {
      h.floor.memGB = 20;
      setSystemTime(new Date(t0 + poll * 10_000));
      await h.dispatcher.tick(PID);
    }
    expect(h.task("mid-1").status).toBe("in_progress");
    expect(h.task("mid-2").status).toBe("in_progress");
    expect(h.task("mid-3").dispatchState).toBe("queued");
    expect(h.writesOf("mid-3")).toBe(1);
    expect(h.framesOf("mid-3")).toBe(1);
  });
});

/**
 * A QUEUED CHIP ON A CARD THAT LEFT IN PROGRESS.
 *
 * Card a551b940 on 23/09/2026: the agent took it to review inside a turn whose
 * end nobody observed, so `onTurnEnd` never ran and the chip stayed `queued`
 * with the floor sentence of 18:04. The card said "in coda" from the Review
 * column, and neither `resume` nor any boot pass looked at it again.
 */
describe("a queued chip left on a review card", () => {
  const strand = (h: ReturnType<typeof harness>, id: string) => {
    heldCard(h.db, id);
    h.svc.addComment({ taskId: id, author: "agent-1", content: "Fatto: consegnato su main." });
    h.db.run("UPDATE tasks SET status = 'review', dispatch_state = 'queued', dispatch_error = 'Memoria quasi finita: vecchia.' WHERE id = ?", [id]);
  };

  it("the boot pass settles it to the review chip and drops the stale reason", async () => {
    const h = harness();
    strand(h, "stranded");
    await h.restart().reconcile({ reason: "boot" });
    expect(h.task("stranded").status).toBe("review");
    expect(h.task("stranded").dispatchState).toBe("delivered");
    expect(h.task("stranded").dispatchError ?? null).toBeNull();
  });

  it("a resume that finds it out of In progress settles it too", async () => {
    const h = harness();
    strand(h, "resumed");
    await h.dispatcher.resume("resumed", "");
    expect(h.task("resumed").dispatchState).toBe("delivered");
    expect(h.task("resumed").dispatchError ?? null).toBeNull();
  });
});
