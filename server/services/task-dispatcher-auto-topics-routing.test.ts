/**
 * AICTRL-01, "ON with provider Automatic": Topics picks by its own rules, so the
 * automatic picker may only choose what the Topics engine routes. It used to
 * pick Codex (the board default here), and the topic gate then parked the card
 * with "Topics routing cannot dispatch to codex".
 *
 * @covers AICTRL-01
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import { automaticDispatchHooks } from "./task-auto-model";
import { resolveDispatchTopicIdentity, type DispatchTopicIdentity } from "./dispatch-topic-identity";
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

function harness(fleet = FLEET) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const topics: DispatchTopicIdentity[] = [];
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    // The hooks server.ts spreads, with a classifier that always votes Codex.
    ...automaticDispatchHooks({
      snapshot: () => fleet,
      codexModels: () => CODEX_MODELS,
      getProvider: () => ({ connected: true, complete: async () => ({ content: '{"provider":"codex","model":"gpt-5.5","effort":"medium","weight":"light"}' }) }) as unknown as AIProvider,
    }),
    // Same gate as server.ts createTopic: this is what threw and parked the card.
    createTopic: (o) => {
      topics.push(resolveDispatchTopicIdentity(o, fleet));
      const id = `topic-${topics.length}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async () => "wt-1",
    deleteWorktree: async () => {},
    runTurn: () => new Promise<TurnEndInfo | void>(() => {}),
    broadcast: () => {},
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
  };
  return { db, svc, dispatcher: createTaskDispatcher(deps), topics };
}

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

async function dispatchAutomaticWithRoutingOn(fanOut?: number, fleet = FLEET) {
  const h = harness(fleet);
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

describe("Automatic with Topics routing ON never picks what the switch cannot route", () => {
  for (const [label, fanOut] of [["single launch", undefined], ["fan-out", 2]] as const) {
    it(`${label}: the card starts on the Topics engine instead of parking`, async () => {
      const h = await dispatchAutomaticWithRoutingOn(fanOut);
      const task = h.svc.get("t1")!.task;
      expect(task.dispatchError ?? "").not.toContain("Topics routing cannot dispatch");
      expect(task.dispatchState).not.toBe("blocked");
      expect(h.topics.length).toBeGreaterThan(0);
      for (const topic of h.topics) {
        expect(topic.executor).toBe("topics");
        expect(topic.model?.startsWith("claude-")).toBe(true);
        // The native engine is the router, never a target: pinned on it, the
        // card was stored as the legacy `topics:<model>` value.
        expect(topic.provider).not.toBe("topics");
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
        const h = await dispatchAutomaticWithRoutingOn(fanOut, fleet);
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
    const h = await dispatchAutomaticWithRoutingOn(undefined, fleet);
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

describe("Automatic with Topics routing ON and no routable candidate", () => {
  it("the Topics engine down: the card parks with the switch's reason, not the effort one", async () => {
    const engineDown = { ...FLEET, providers: [entry("topics", [], "error"), ...FLEET.providers.slice(1)] } as unknown as ProvidersSnapshot;
    const h = await dispatchAutomaticWithRoutingOn(undefined, engineDown);
    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("blocked");
    // Exactly the engine's reason: the Codex-pin message also says "Turn the switch off".
    expect(task.dispatchError).toBe("The Topics routing engine is unavailable. Turn the switch off or reconnect it before starting the task.");
    expect(h.topics).toHaveLength(0);
  });

  it("the Topics engine still in discovery: the card waits in the queue instead of parking", async () => {
    const engineLoading = { ...FLEET, providers: [entry("topics", [], "loading"), ...FLEET.providers.slice(1)] } as unknown as ProvidersSnapshot;
    const h = await dispatchAutomaticWithRoutingOn(undefined, engineLoading);
    const task = h.svc.get("t1")!.task;
    expect(task).toMatchObject({ status: "todo", dispatchState: "queued", dispatchAttempts: 0 });
    expect(task.dispatchError).toBe("Waiting for topics provider discovery.");
    expect(h.topics).toHaveLength(0);
  });

  // Codex is free, so "some runtime is available" was true, but with ON
  // every candidate runs on Claude: the card waits for the plan like an
  // explicit Claude task, it is not parked for good.
  for (const kind of ["hold", "threshold"] as const) {
    it(`Claude ${kind === "hold" ? "on hold" : "past the five-hour threshold"} with Codex ready: the card waits in the queue`, async () => {
      const untilMs = Date.now() + 3_600_000;
      if (kind === "hold") setProviderHold({ untilMs, window: "five_hour", reason: "Claude quota exhausted" });
      else recordPlanUsage({ fiveHour: { utilization: 95, resetsAtMs: untilMs }, sevenDay: null });
      const h = await dispatchAutomaticWithRoutingOn();
      const task = h.svc.get("t1")!.task;
      expect(task).toMatchObject({ status: "todo", dispatchState: "queued", dispatchAttempts: 0 });
      expect(task.dispatchError).toContain("Claude");
      expect(h.topics).toHaveLength(0);
      clearProviderHold(); clearPlanUsage();
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.topics.map((t) => t.executor)).toEqual(["topics"]);
    });
  }
});
