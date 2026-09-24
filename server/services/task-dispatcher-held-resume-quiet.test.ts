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
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";
import { dispatchResourceBlock, dispatchResourceVerdict } from "./dispatch-capacity";
import type { HeldMemory } from "./mem-signal";
import { clearProviderHold, resetProviderHoldStore, setProviderHold } from "../lib/provider-hold";

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
      if (msg.type === "task:updated" && msg.task) frames.push(msg.task.id);
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

    // Another resource IS another wait: the disk speaks in its own line.
    setSystemTime(new Date(t0 + 18_000));
    h.floor.memGB = null;
    h.floor.diskGB = 2;
    await h.dispatcher.resume("boot", "");
    expect(h.serviceNotes("boot").length).toBe(2);
    expect(h.serviceNotes("boot")[1]).toStartWith("Disco quasi pieno");
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
    // must still read the machine block that holds it.
    setSystemTime(new Date(t0 + 35 * 60_000));
    const d = h.restart();
    await d.resume("still", "");
    expect(h.framesOf("still")).toBe(1);
    expect(h.task("still").updatedAt).toBe(stamp);
    expect(h.task("still").queueReason).toMatchObject({ kind: "resource_floor" });
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
