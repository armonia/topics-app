/**
 * AICTRL-01 + MSEL-06, "ON with provider Automatic". The switch used to narrow
 * the automatic ballot to what the Topics engine routes; before that, a Codex
 * pick parked the card with "Topics routing cannot dispatch to codex". With
 * MSEL-06 the ballot keeps the GPT models, the pick decides the target, and
 * `topicsRoute` decides the route afterwards: a Claude pick the engine serves
 * runs there, a Codex pick runs direct, and nothing parks for the switch.
 *
 * @covers AICTRL-01, MSEL-06
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import { automaticDispatchHooks } from "./task-auto-model";
import { dispatchTopicBinding, resolveDispatchTopicIdentity, type DispatchTopicIdentity } from "./dispatch-topic-identity";
import type { AIProvider } from "../providers/types";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { ProvidersSnapshot } from "../../shared/types";
import { taskModelSelection } from "../../shared/task-coding-models";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { clearPlanUsage, clearProviderHold, recordPlanUsage, resetProviderHoldStore, setProviderHold } from "../lib/provider-hold";

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
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium', dispatch_model TEXT,
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_paused INTEGER NOT NULL DEFAULT 0,
    dispatch_topics_routing INTEGER CHECK (dispatch_topics_routing IN (0, 1))
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
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

const PID = "alpha-abc123";
const entry = (name: string, models: string[], status = "ready") => ({ name, label: name, status, models, requirements: [] });
// Codex is the default and ready: exactly the fleet where Automatic used to land on it.
const FLEET = {
  defaultProvider: "codex",
  providers: [
    entry("topics", ["claude-sonnet-5", "claude-opus-5"]),
    entry("claude-code", ["claude-sonnet-5", "claude-opus-5"]),
    entry("codex", ["gpt-5.5"]),
  ],
} as unknown as ProvidersSnapshot;
const CODEX_MODELS = [{ slug: "gpt-5.5", description: "Reliable workhorse", defaultEffort: "medium", efforts: ["low", "medium", "high"] }];

const CODEX_VOTE = '{"provider":"codex","model":"gpt-5.5","effort":"medium","weight":"light"}';
const ENGINE_VOTE = '{"provider":"topics","model":"claude-sonnet-5","effort":"medium","weight":"light"}';
const CLAUDE_CODE_VOTE = '{"provider":"claude-code","model":"claude-sonnet-5","effort":"medium","weight":"light"}';

function harness(fleet = FLEET, vote = CODEX_VOTE) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const topics: DispatchTopicIdentity[] = [];
  const turnEnds: Array<(end: TurnEndInfo) => void> = [];
  const frames: Array<Record<string, unknown>> = [];
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    // The hooks server.ts spreads, with a classifier that always casts `vote`.
    ...automaticDispatchHooks({
      snapshot: () => fleet,
      codexModels: () => CODEX_MODELS,
      getProvider: () => ({ connected: true, complete: async () => ({ content: vote }) }) as unknown as AIProvider,
    }),
    // Same gate as server.ts createTopic: this is what threw and parked the card.
    createTopic: (o) => {
      topics.push(resolveDispatchTopicIdentity(o, fleet));
      const id = `topic-${topics.length}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    // Same read-back as server.ts: what a hold or a reused session is judged against.
    topicModelSelection: (id) => {
      const topic = topics[Number(id.slice("topic-".length)) - 1];
      return topic ? dispatchTopicBinding(topic, fleet.defaultProvider, fleet) : null;
    },
    createWorktree: async () => "wt-1",
    deleteWorktree: async () => {},
    runTurn: () => new Promise<TurnEndInfo | void>((resolve) => { turnEnds.push(resolve); }),
    broadcast: (frame) => { frames.push(frame as Record<string, unknown>); },
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
  };
  return { db, svc, dispatcher: createTaskDispatcher(deps), topics, turnEnds, frames };
}

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

async function dispatchAutomaticWithRoutingOn(fanOut?: number, fleet = FLEET, vote = CODEX_VOTE) {
  const h = harness(fleet, vote);
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchTopicsRouting: true, ...(fanOut ? { dispatchFanOut: fanOut } : {}) });
  h.svc.setGlobalCap({ auto: false, max: 5 });
  const ts = new Date().toISOString();
  h.db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, model, topics_routing)
     VALUES ('t1', ?, 'task', 'todo', ?, ?, 0, NULL, NULL)`,
    [PID, ts, ts],
  );
  await h.dispatcher.tick(PID);
  await flush();
  return h;
}

describe("Automatic with Topics routing ON keeps GPT on the ballot", () => {
  for (const [label, fanOut] of [["single launch", undefined], ["fan-out", 2]] as const) {
    it(`${label}: a Codex pick starts direct on Codex instead of parking`, async () => {
      const h = await dispatchAutomaticWithRoutingOn(fanOut);
      const task = h.svc.get("t1")!.task;
      expect(task.dispatchError ?? "").not.toContain("Topics routing cannot dispatch");
      expect(task.dispatchState).not.toBe("blocked");
      expect(h.topics.length).toBeGreaterThan(0);
      for (const topic of h.topics) {
        expect(topic).toMatchObject({ executor: "codex", provider: "codex", model: "gpt-5.5", topicsRouting: true });
      }
    });

    it(`${label}: a Claude Code pick runs through the engine, pinned to its target`, async () => {
      const h = await dispatchAutomaticWithRoutingOn(fanOut, FLEET, CLAUDE_CODE_VOTE);
      const task = h.svc.get("t1")!.task;
      expect(task.dispatchState).not.toBe("blocked");
      for (const topic of h.topics) {
        expect(topic).toMatchObject({ executor: "topics", provider: "claude-code", model: "claude-sonnet-5" });
      }
      expect(task.model?.startsWith("topics:")).toBe(false);
      // What the card was stored with still means something with the switch
      // OFF: a direct run on its target, not the native engine again.
      const stored = taskModelSelection(task.model);
      expect(resolveDispatchTopicIdentity({ ...stored, topicsRouting: false }, FLEET).executor).not.toBe("topics");
    });
  }
});

// The provider holds are module state: every test starts and ends without one.
beforeEach(() => { resetProviderHoldStore(); clearProviderHold(); clearProviderHold("codex"); clearPlanUsage(); });
afterEach(() => { clearProviderHold(); clearProviderHold("codex"); clearPlanUsage(); });

const fleetOf = (...providers: ReturnType<typeof entry>[]) => ({ defaultProvider: "codex", providers }) as unknown as ProvidersSnapshot;
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-opus-5"];

// The engine is ready and the menu shows the switch as routable, but no Claude
// Code target is: the CLI is missing, or it did not answer discovery.
describe("Automatic with Topics routing ON and the engine up without a Claude Code target", () => {
  const fleets = {
    "Claude Code unavailable": fleetOf(entry("topics", CLAUDE_MODELS), entry("claude-code", [], "unavailable"), entry("codex", ["gpt-5.5"])),
    "the engine alone": fleetOf(entry("topics", CLAUDE_MODELS)),
  };
  for (const [label, fleet] of Object.entries(fleets)) {
    for (const [launch, fanOut] of [["single launch", undefined], ["fan-out", 2]] as const) {
      it(`${label}, ${launch}: the card runs on the engine, pinned to no runtime`, async () => {
        const h = await dispatchAutomaticWithRoutingOn(fanOut, fleet, ENGINE_VOTE);
        const task = h.svc.get("t1")!.task;
        expect(task).toMatchObject({ status: "in_progress", dispatchState: "working" });
        expect(h.topics.length).toBeGreaterThan(0);
        for (const topic of h.topics) {
          expect(topic).toMatchObject({ executor: "topics", topicsRouting: true });
          expect(topic.provider).toBeUndefined();
        }
        // Stored without the legacy `topics:` pin, so OFF later is a real OFF.
        expect(task.model?.startsWith("topics:")).toBe(false);
      });
    }
  }

  it("Claude Code still in discovery: the card waits for it, then starts pinned to it", async () => {
    const fleet = fleetOf(entry("topics", CLAUDE_MODELS), entry("claude-code", [], "loading"), entry("codex", ["gpt-5.5"]));
    const h = await dispatchAutomaticWithRoutingOn(undefined, fleet, CLAUDE_CODE_VOTE);
    const task = h.svc.get("t1")!.task;
    expect(task).toMatchObject({ status: "todo", dispatchState: "queued", dispatchAttempts: 0 });
    expect(task.dispatchError).toBe("Waiting for claude-code provider discovery.");
    expect(h.topics).toHaveLength(0);
    Object.assign(fleet.providers[1]!, { status: "ready", models: CLAUDE_MODELS });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topics).toHaveLength(1);
    expect(h.topics[0]).toMatchObject({ provider: "claude-code", executor: "topics" });
  });
});

describe("Automatic with Topics routing ON and the engine not usable", () => {
  it("the Topics engine down: nothing parks, a Claude Code pick runs direct on Claude Code", async () => {
    const engineDown = { ...FLEET, providers: [entry("topics", [], "error"), ...FLEET.providers.slice(1)] } as unknown as ProvidersSnapshot;
    const h = await dispatchAutomaticWithRoutingOn(undefined, engineDown, CLAUDE_CODE_VOTE);
    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).not.toBe("blocked");
    expect(h.topics.map((t) => t.executor)).toEqual(["claude-code"]);
  });

  it("the Topics engine still in discovery: a Claude pick waits in the queue, never parks", async () => {
    const engineLoading = { ...FLEET, providers: [entry("topics", [], "loading"), ...FLEET.providers.slice(1)] } as unknown as ProvidersSnapshot;
    const h = await dispatchAutomaticWithRoutingOn(undefined, engineLoading, CLAUDE_CODE_VOTE);
    const task = h.svc.get("t1")!.task;
    expect(task).toMatchObject({ status: "todo", dispatchState: "queued", dispatchAttempts: 0 });
    expect(task.dispatchError).toBe("Waiting for topics provider discovery.");
    expect(h.topics).toHaveLength(0);
  });

  it("the Topics engine still in discovery: a Codex pick does not wait for it", async () => {
    const engineLoading = { ...FLEET, providers: [entry("topics", [], "loading"), ...FLEET.providers.slice(1)] } as unknown as ProvidersSnapshot;
    const h = await dispatchAutomaticWithRoutingOn(undefined, engineLoading);
    expect(h.topics.map((t) => t.executor)).toEqual(["codex"]);
  });

  // Codex is free and on the ballot: with the GPT models back among the
  // candidates a Claude hold no longer holds an Automatic card.
  for (const kind of ["hold", "threshold"] as const) {
    it(`Claude ${kind === "hold" ? "on hold" : "past the five-hour threshold"} with Codex ready: the card starts on Codex`, async () => {
      const untilMs = Date.now() + 3_600_000;
      if (kind === "hold") setProviderHold({ untilMs, window: "five_hour", reason: "Claude quota exhausted" });
      else recordPlanUsage({ fiveHour: { utilization: 95, resetsAtMs: untilMs }, sevenDay: null });
      const h = await dispatchAutomaticWithRoutingOn();
      const task = h.svc.get("t1")!.task;
      expect(task.dispatchState).not.toBe("blocked");
      expect(h.topics.map((t) => t.executor)).toEqual(["codex"]);
    });
  }
});


// The engine runs a card that no runtime is pinned to (no Claude Code target was
// ready). Its topic then carries no provider, and reading the registry default
// in its place named Codex here: Claude's wall stopped applying to a card the
// Claude engine was running.
describe("A card on the engine with no pinned runtime stays behind Claude's wall", () => {
  const engineOnly = () => fleetOf(entry("topics", CLAUDE_MODELS), entry("claude-code", [], "unavailable"), entry("codex", ["gpt-5.5"]));

  it("a provider error during a Claude hold retries at the hold's end, not at once", async () => {
    const h = await dispatchAutomaticWithRoutingOn(undefined, engineOnly(), ENGINE_VOTE);
    expect(h.topics).toHaveLength(1);
    expect(h.topics[0]!.provider).toBeUndefined();
    expect(h.turnEnds).toHaveLength(1);
    const untilMs = Date.now() + 3_600_000;
    setProviderHold({ untilMs, window: "five_hour", reason: "Claude quota exhausted" });
    h.turnEnds[0]!({ end: "error", cause: "provider-error" });
    await flush();
    const retry = h.frames.map((f) => f.retry as { at: number } | undefined).find(Boolean);
    expect(retry!.at).toBeGreaterThanOrEqual(untilMs - 1_000);
    expect(h.turnEnds).toHaveLength(1);
  });

  it("a dependent reusing that session waits for the hold instead of starting on it", async () => {
    const h = await dispatchAutomaticWithRoutingOn(undefined, engineOnly(), ENGINE_VOTE);
    expect(h.topics[0]!.provider).toBeUndefined();
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = 't1'");
    const ts = new Date().toISOString();
    h.db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, model, topics_routing, blocked_by_task_id, reuse_blocker_context)
       VALUES ('t2', ?, 'dependent', 'todo', ?, ?, 0, NULL, NULL, 't1', 1)`,
      [PID, ts, ts],
    );
    setProviderHold({ untilMs: Date.now() + 3_600_000, window: "five_hour", reason: "Claude quota exhausted" });
    await h.dispatcher.tick(PID);
    await flush();
    const dependent = h.svc.get("t2")!.task;
    expect(dependent).toMatchObject({ status: "todo", dispatchState: "queued", dispatchAttempts: 0 });
    expect(dependent.dispatchError).toContain("Claude");
    expect(h.turnEnds).toHaveLength(1);
  });
});

// A dependent that reuses its blocker's session continues that topic as it
// runs: the topic's own switch decides who executes the turn. So the dependent
// continues it only with the same switch (S1: ON goes through the engine; S3:
// OFF runs directly), whether it names a provider, a bare model or Automatic.
// Otherwise its switch would be a silent no-op, and the card parks naming the
// switch, not the model, which matches. With the switch OFF on both sides an
// explicit provider also names who runs the turn: the engine itself or a
// provider directly. The fleet is production's: the engine is the default
// runtime (DEFAULT_AGENT_RUNTIME), so with the switch OFF a plain model runs
// there directly too.
describe("A dependent continues its blocker's session only with the switch the session runs with", () => {
  const productionFleet = () => ({
    defaultProvider: "topics",
    providers: [entry("claude-code", CLAUDE_MODELS), entry("codex", ["gpt-5.5"]), entry("topics", CLAUDE_MODELS)],
  }) as unknown as ProvidersSnapshot;
  const SESSION_SWITCH_ON = "This task has Topics routing off, but the previous session runs with the switch on, through the Topics engine. Turn the switch on or turn off session reuse before starting the task.";
  const SESSION_SWITCH_OFF = "This task has Topics routing on, but the previous session runs with the switch off. Turn the switch off or turn off session reuse before starting the task.";
  const SESSION_ON_ENGINE = "This task has Topics routing off and asks for a direct run, but the previous session runs on the Topics engine. Turn off session reuse before starting the task.";
  const SESSION_DIRECT = "This task names the Topics engine as its runtime, but the previous session runs directly on its provider. Turn off session reuse before starting the task.";
  const CLAUDE_CODE = "claude-code:claude-sonnet-5";

  type Routing = 0 | 1 | null;
  async function reuseBlockerSession(board: boolean | null, blocker: [string, Routing], dependent: [string | null, Routing]) {
    const h = harness(productionFleet());
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, ...(board === null ? {} : { dispatchTopicsRouting: board }) });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    const ts = new Date().toISOString();
    h.db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, model, topics_routing)
       VALUES ('t1', ?, 'blocker', 'todo', ?, ?, 0, ?, ?)`,
      [PID, ts, ts, blocker[0], blocker[1]],
    );
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topics).toHaveLength(1);
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = 't1'");
    h.db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, model, topics_routing, blocked_by_task_id, reuse_blocker_context)
       VALUES ('t2', ?, 'dependent', 'todo', ?, ?, 0, ?, ?, 't1', 1)`,
      [PID, ts, ts, dependent[0], dependent[1]],
    );
    await h.dispatcher.tick(PID);
    await flush();
    return { h, session: h.topics[0]!, dependent: h.svc.get("t2")!.task };
  }

  // The sessions a blocker leaves, by the switch it ran with.
  const onEngine = { executor: "topics", model: "claude-sonnet-5" };
  type Session = Partial<DispatchTopicIdentity> & { provider: string | undefined };
  const sessions: Record<string, { board: boolean | null; blocker: [string, Routing]; session: Session }> = {
    "a plain model with the board ON, pinned to no runtime": {
      board: true, blocker: ["claude-sonnet-5", null], session: { ...onEngine, topicsRouting: true, provider: undefined } },
    "a legacy topics: value, ON by its prefix": {
      board: null, blocker: ["topics:claude-sonnet-5", null], session: { ...onEngine, topicsRouting: true, provider: "topics" } },
    "the board OFF and only the blocker ON": {
      board: false, blocker: ["claude-sonnet-5", 1], session: { ...onEngine, topicsRouting: true, provider: undefined } },
    "Claude Code pinned with the switch ON": {
      board: true, blocker: [CLAUDE_CODE, null], session: { ...onEngine, topicsRouting: true, provider: "claude-code" } },
    "a plain model with the switch OFF, run by the engine directly": {
      board: false, blocker: ["claude-sonnet-5", 0], session: { ...onEngine, topicsRouting: false, provider: "topics" } },
    "a plain model switched OFF on a board ON, run by the engine directly": {
      board: true, blocker: ["claude-sonnet-5", 0], session: { ...onEngine, topicsRouting: false, provider: "topics" } },
    "Claude Code with the switch OFF, run directly": {
      board: false, blocker: [CLAUDE_CODE, 0], session: { executor: "claude-code", model: "claude-sonnet-5", topicsRouting: false, provider: "claude-code" } },
  };
  const cases: Array<{ session: keyof typeof sessions; dependent: [string | null, Routing]; name: string; reason: string | null }> = [
    // The dependent's switch differs from the session's: the card parks naming the switch.
    { session: "a plain model with the board ON, pinned to no runtime", dependent: [CLAUDE_CODE, 0], name: "Claude Code switched OFF", reason: SESSION_SWITCH_ON },
    { session: "a legacy topics: value, ON by its prefix", dependent: [CLAUDE_CODE, 0], name: "Claude Code switched OFF", reason: SESSION_SWITCH_ON },
    { session: "the board OFF and only the blocker ON", dependent: [CLAUDE_CODE, null], name: "Claude Code inheriting OFF", reason: SESSION_SWITCH_ON },
    { session: "Claude Code pinned with the switch ON", dependent: [CLAUDE_CODE, 0], name: "Claude Code switched OFF", reason: SESSION_SWITCH_ON },
    { session: "Claude Code pinned with the switch ON", dependent: [null, 0], name: "Automatic switched OFF", reason: SESSION_SWITCH_ON },
    { session: "Claude Code pinned with the switch ON", dependent: ["claude-sonnet-5", 0], name: "the same bare model switched OFF", reason: SESSION_SWITCH_ON },
    { session: "Claude Code with the switch OFF, run directly", dependent: [CLAUDE_CODE, 1], name: "Claude Code switched ON", reason: SESSION_SWITCH_OFF },
    { session: "Claude Code with the switch OFF, run directly", dependent: [null, 1], name: "Automatic switched ON", reason: SESSION_SWITCH_OFF },
    { session: "a plain model with the switch OFF, run by the engine directly", dependent: [CLAUDE_CODE, 1], name: "Claude Code switched ON", reason: SESSION_SWITCH_OFF },
    { session: "a plain model switched OFF on a board ON, run by the engine directly", dependent: [CLAUDE_CODE, null], name: "Claude Code inheriting ON", reason: SESSION_SWITCH_OFF },
    // The switch OFF on both sides, and the dependent names another runtime than the session's.
    { session: "a plain model with the switch OFF, run by the engine directly", dependent: [CLAUDE_CODE, 0], name: "Claude Code switched OFF", reason: SESSION_ON_ENGINE },
    { session: "Claude Code with the switch OFF, run directly", dependent: ["topics:claude-sonnet-5", 0], name: "a legacy topics: value switched OFF", reason: SESSION_DIRECT },
    // The same switch and the same runtime: the dependent continues the session.
    { session: "a plain model with the board ON, pinned to no runtime", dependent: [CLAUDE_CODE, null], name: "Claude Code ON", reason: null },
    { session: "Claude Code pinned with the switch ON", dependent: [CLAUDE_CODE, null], name: "Claude Code ON", reason: null },
    { session: "Claude Code pinned with the switch ON", dependent: [null, null], name: "Automatic ON", reason: null },
    { session: "Claude Code with the switch OFF, run directly", dependent: [CLAUDE_CODE, null], name: "Claude Code OFF", reason: null },
    { session: "Claude Code with the switch OFF, run directly", dependent: [null, null], name: "Automatic OFF", reason: null },
    { session: "a plain model with the switch OFF, run by the engine directly", dependent: ["claude-sonnet-5", null], name: "the same bare model OFF", reason: null },
  ];

  for (const c of cases) {
    it(`${c.session}; the dependent is ${c.name}: ${c.reason ? "it parks with the reason" : "it starts on the blocker's session"}`, async () => {
      const { board, blocker, session: expected } = sessions[c.session]!;
      const { h, session, dependent } = await reuseBlockerSession(board, blocker, c.dependent);
      const { provider, ...route } = expected;
      expect(session).toMatchObject(route);
      expect(session.provider).toBe(provider);
      if (c.reason) {
        expect(dependent).toMatchObject({ status: "backlog", dispatchState: "blocked", dispatchError: c.reason });
        expect(h.turnEnds).toHaveLength(1);
      } else {
        expect(dependent.dispatchError ?? null).toBeNull();
        expect(dependent).toMatchObject({ status: "in_progress", dispatchState: "working", assignedTopicId: "topic-1" });
        expect(h.turnEnds).toHaveLength(2);
      }
      expect(h.topics).toHaveLength(1);
    });
  }
});
