/** @covers MP-DISPATCH-01, MP-TASK-01, USAGE-21, RESUME-04, KANBAN-88 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskAttemptStore } from "./task-attempts";
import { createTaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { clearPlanUsage, clearProviderHold, recordPlanUsage, setProviderHold, resetProviderHoldStore } from "../lib/provider-hold";
import { taskProviderForModel } from "../../shared/task-coding-models";
import type { ProvidersSnapshot } from "../../shared/types";
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
    dispatch_mcp TEXT, dispatch_model TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    agent_cost_cap_cents INTEGER NOT NULL DEFAULT 0,
    agent_cost_cap_cents_24h INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running',
    commit_sha TEXT, files_changed INTEGER, insertions INTEGER, deletions INTEGER,
    summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

const PID = "hold-board";
const CLAUDE = "claude-opus-5";
const codingModel = "gpt-5.4";
const cleanups: Array<() => void> = [];
beforeEach(() => { resetProviderHoldStore(); clearProviderHold(); clearProviderHold("codex"); clearPlanUsage(); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  clearProviderHold(); clearProviderHold("codex"); clearPlanUsage();
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function limit(kind: "hold" | "threshold") {
  const untilMs = Date.now() + 3_600_000;
  if (kind === "hold") setProviderHold({ untilMs, window: "five_hour", reason: "Claude quota exhausted" });
  else recordPlanUsage({ fiveHour: { utilization: 95, resetsAtMs: untilMs }, sevenDay: null });
}
function codexLimit() {
  setProviderHold({ untilMs: Date.now() + 3_600_000, window: "usage_limit", reason: "Codex plan usage limit reached", provider: "codex" });
}
/**
 * `shared` is what a RESTART looks like from here: the same database and the
 * same service clock, a brand new dispatcher whose in-memory sets are empty.
 * Without it every "boot" would also be a fresh thread, which is precisely the
 * state that hides a note rewritten once per process.
 */
function harness(defaultProvider = "topics", overrides: Partial<DispatcherDeps> = {}, shared?: { db: Database; now: () => string }) {
  const db = shared?.db ?? freshDb();
  const svc = createTaskService(db, shared ? { now: shared.now } : {});
  const attempts = createTaskAttemptStore(db);
  const snapshot: ProvidersSnapshot = {
    defaultProvider, generatedAt: new Date().toISOString(),
    providers: ["topics", "claude-code", "codex"].map(name => ({
      name, models: [name === "codex" ? codingModel : CLAUDE], status: "ready", isDefault: name === defaultProvider,
      requirements: [], fetchedAt: new Date().toISOString(),
    })),
  };
  const sessions = new Map<string, { model: string; provider: string }>();
  const starts: Array<{ model?: string; provider: string }> = [];
  const turns: Array<{ key: string; content: string }> = [];
  const ends: Array<(info: TurnEndInfo) => void> = [];
  const deps: DispatcherDeps = {
    svc, attempts, resolveProject: () => ({ path: "/tmp/hold-project", projectStoreId: "store" }),
    resolveTaskProvider: model => taskProviderForModel(model, snapshot),
    topicModelSelection: id => sessions.get(id) ?? null,
    createTopic: opts => {
      const provider = taskProviderForModel(opts.model, snapshot);
      starts.push({ model: opts.model, provider });
      const id = `topic-${starts.length}`;
      db.run("INSERT INTO topics (id) VALUES (?)", [id]);
      sessions.set(id, { model: opts.model ?? (provider === "codex" ? codingModel : CLAUDE), provider });
      return { topicId: id, sessionKey: `topic:${id.slice(0, 8)}` };
    },
    archiveTopic: () => {}, broadcast: () => {}, log: () => {}, graceMs: 0, retryBackoffMs: 5,
    runTurn: (key, content) => new Promise<TurnEndInfo>(resolve => { turns.push({ key, content }); ends.push(resolve); }),
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  cleanups.push(() => { dispatcher.shutdown(); if (!shared) db.close(); });
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  svc.setGlobalCap({ auto: false, max: 5 });
  function task(id: string, model?: string, provider?: string) {
    const topic = provider ? `bound-${id}` : null;
    if (topic) {
      db.run("INSERT INTO topics (id) VALUES (?)", [topic]);
      sessions.set(topic, { model: model ?? CLAUDE, provider: provider! });
    }
    const now = new Date().toISOString();
    db.run(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, model, assigned_topic_id, dispatch_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, PID, id, topic ? "in_progress" : "todo", now, now, model ?? null, topic, topic ? "working" : null]);
    return id;
  }
  return { db, svc, attempts, dispatcher, snapshot, starts, turns, ends, sessions, task };
}

for (const kind of ["hold", "threshold"] as const) describe(kind, () => {
  test("general Auto reaches the picker during a Claude hold and can choose Codex", async () => {
    let picks = 0;
    const h = harness("topics", {
      automaticModelAvailable: () => true,
      pickAutoModel: async () => { picks++; return { model: codingModel, effort: "low", weight: "light" }; },
    });
    h.task("automatic"); h.task("explicit-claude", CLAUDE);
    limit(kind);
    await h.dispatcher.tick(PID); await flush();
    expect(picks).toBe(1);
    expect(h.starts).toEqual([{ model: codingModel, provider: "codex" }]);
    expect(h.svc.get("explicit-claude")?.task.dispatchAttempts).toBe(0);
    expect(h.svc.get("explicit-claude")?.task.status).toBe("todo");
  });
  test("a held Claude head does not block GPT and consumes no attempt", async () => {
    const h = harness();
    h.task("a-claude", CLAUDE); h.task("b-gpt", codingModel);
    h.db.run("UPDATE tasks SET priority = 4 WHERE id = 'a-claude'");
    limit(kind);
    await h.dispatcher.tick(PID); await flush();
    expect(h.starts).toEqual([{ model: codingModel, provider: "codex" }]);
    expect(h.turns).toHaveLength(1);
    expect(h.svc.get("a-claude")!.task).toMatchObject({ status: "todo", assignedTopicId: null, dispatchAttempts: 0, dispatchState: "queued" });
    expect(h.svc.get("a-claude")!.task.dispatchError).toContain("Claude");
    clearProviderHold(); clearPlanUsage();
    await h.dispatcher.tick(PID); await flush();
    expect(h.starts.map(s => s.provider)).toEqual(["codex", "topics"]);
  });
  test("task choice wins over the board, and board over the coding default", async () => {
    const h = harness("codex");
    h.svc.updateBoardSettings(PID, { dispatchModel: CLAUDE });
    h.task("override-gpt", codingModel); h.task("board-claude");
    limit(kind);
    await h.dispatcher.tick(PID); await flush();
    expect(h.starts).toEqual([{ model: codingModel, provider: "codex" }]);
    h.svc.updateBoardSettings(PID, { dispatchModel: codingModel });
    h.task("override-claude", CLAUDE);
    await h.dispatcher.tick(PID); await flush();
    expect(h.starts.map(s => s.provider)).toEqual(["codex", "codex"]);
    expect(h.svc.get("override-claude")!.task.dispatchAttempts).toBe(0);
  });
  test("auto uses the current coding default without calling a Claude classifier", async () => {
    let picks = 0;
    const h = harness("codex", { pickAutoModel: async () => { picks++; return { model: "codex" }; } });
    h.task("auto-codex"); limit(kind);
    await h.dispatcher.tick(PID); await flush();
    expect(h.starts).toEqual([{ model: "codex", provider: "codex" }]);
    expect(picks).toBe(1);
    h.snapshot.defaultProvider = "claude-code";
    h.task("auto-claude");
    await h.dispatcher.tick(PID); await flush();
    expect(picks).toBe(1);
    expect(h.svc.get("auto-claude")!.task.dispatchAttempts).toBe(0);
  });
});

describe("Codex hold (AGPT-01 extended)", () => {
  test("general Auto reaches the picker during a Codex hold and can choose Claude", async () => {
    let picks = 0;
    const h = harness("codex", {
      automaticModelAvailable: () => true,
      pickAutoModel: async () => { picks++; return { model: CLAUDE, provider: "topics" }; },
    });
    h.task("automatic"); h.task("explicit-codex", codingModel);
    codexLimit();
    await h.dispatcher.tick(PID); await flush();
    expect(picks).toBe(1);
    expect(h.starts).toEqual([{ model: CLAUDE, provider: "topics" }]);
    expect(h.svc.get("explicit-codex")?.task.dispatchAttempts).toBe(0);
    expect(h.svc.get("explicit-codex")?.task.status).toBe("todo");
  });

  test("a held Codex wall does not block Claude and consumes no attempt", async () => {
    const h = harness();
    h.task("a-gpt", codingModel); h.task("b-claude", CLAUDE);
    h.db.run("UPDATE tasks SET priority = 4 WHERE id = 'a-gpt'");
    codexLimit();
    await h.dispatcher.tick(PID); await flush();
    expect(h.starts).toEqual([{ model: CLAUDE, provider: "topics" }]);
    expect(h.turns).toHaveLength(1);
    expect(h.svc.get("a-gpt")!.task).toMatchObject({ status: "todo", assignedTopicId: null, dispatchAttempts: 0, dispatchState: "queued" });
    expect(h.svc.get("a-gpt")!.task.dispatchError).toContain("Codex");
    clearProviderHold("codex");
    await h.dispatcher.tick(PID); await flush();
    expect(h.starts.map(s => s.provider)).toEqual(["topics", "codex"]);
  });
});

/**
 * A WALL OF DAYS IS A QUESTION, NOT A WAIT.
 *
 * Measured on 2026-09-17: `provider-hold.json` held a Codex wall written on
 * 13/09 at 17:39 and ending on 19/09 at 14:45, the log repeated "resumes at
 * 14:45" 43 times over three days, and the board's `dispatch_model` sends every
 * card through that provider. Six days are not a window rotating, and the only
 * thing that moves those cards is a person.
 */
describe("a hold longer than a day", () => {
  const sixDays = () => setProviderHold({
    untilMs: Date.now() + 6 * 24 * 3_600_000, window: "usage_limit",
    reason: "Codex plan usage limit reached", provider: "codex",
  });

  test("says the date, calls it a spent plan, and writes it on the card once", async () => {
    const h = harness();
    h.task("held-for-days", codingModel);
    sixDays();
    await h.dispatcher.tick(PID); await flush();

    const chip = h.svc.get("held-for-days")!.task.dispatchError ?? "";
    // The date, because an hour alone reads as "later this afternoon".
    expect(chip).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
    expect(chip).toContain("piano esaurito");
    const said = () => (h.svc.get("held-for-days")!.comments ?? []).map(c => c.content).filter(c => c.includes("piano esaurito"));
    expect(said()).toHaveLength(1);
    // One per EPISODE: a 10 s poll must not write the same paragraph again.
    await h.dispatcher.tick(PID); await flush();
    expect(said()).toHaveLength(1);
    expect(h.starts).toHaveLength(0);
  });

  /**
   * ONE PARAGRAPH PER CARD, ACROSS RESTARTS - the set in the closure cannot do it.
   *
   * `planHeldNoted` is born empty at every process, and the only other defence
   * is the 10-second dedupe window of `addComment`. On this machine a boot is
   * ~35 minutes from the last one (44 restarts in 25,7 h), and a wall of days
   * outlives all of them: 7 cards in the queue behind a 6-day Codex wall is
   * ~300 identical paragraphs a day in the threads, the same pile KANBAN-83 and
   * the 314 «Memoria quasi finita» comments exist to end. And the sentence is
   * not even identical: it counts the days left, so it is REWORDED once a day.
   */
  test("five boots over three days leave one paragraph on the card, not five", async () => {
    const db = freshDb();
    cleanups.push(() => db.close());
    const clock = { ms: Date.parse("2026-09-17T09:00:00.000Z") };
    const shared = { db, now: () => new Date(clock.ms).toISOString() };
    const wall = clock.ms + 6 * 24 * 3_600_000;
    setProviderHold({ untilMs: wall, window: "usage_limit", reason: "Codex plan usage limit reached", provider: "codex" });

    const first = harness("topics", { now: () => clock.ms }, shared);
    first.task("held-across-boots", codingModel);
    const said = () => (first.svc.get("held-across-boots")!.comments ?? [])
      .filter(c => c.content.includes("piano esaurito"));
    const boot = () => {
      const h = harness("topics", { now: () => clock.ms }, shared);
      return h.dispatcher.tick(PID).then(flush);
    };

    await first.dispatcher.tick(PID); await flush();
    expect(said()).toHaveLength(1);
    const firstRow = said()[0]!.id;

    // Two boots 35 minutes apart - the watcher's own cadence on this machine -
    // with the sentence unchanged. Not merely one comment: the SAME one. A
    // delete-and-rewrite would touch `updated_at` every 35 minutes, which is
    // the column KANBAN-84 already found lying about how idle a card is.
    clock.ms += 35 * 60_000; await boot();
    clock.ms += 35 * 60_000; await boot();
    expect(said()).toHaveLength(1);
    expect(said()[0]!.id).toBe(firstRow);

    // Two more a day apart: now the sentence itself CHANGES (six days left
    // becomes five, then four), so the identical-text guard cannot catch it and
    // the slot has to.
    clock.ms += 24 * 3_600_000; await boot();
    clock.ms += 24 * 3_600_000; await boot();
    expect(said()).toHaveLength(1);
    // The one left is the CURRENT one: a card that kept the first paragraph
    // would still promise six days.
    expect(said()[0]!.content).toContain("fra 4 giorni");
  });

  test("a wall of hours stays a wait: the hour alone, and nothing in the thread", async () => {
    const h = harness();
    h.task("held-for-hours", codingModel);
    codexLimit();
    await h.dispatcher.tick(PID); await flush();
    const chip = h.svc.get("held-for-hours")!.task.dispatchError ?? "";
    expect(chip).toContain("Ripresa dopo il reset");
    expect(chip).not.toContain("piano esaurito");
    expect((h.svc.get("held-for-hours")!.comments ?? []).filter(c => c.content.includes("piano esaurito"))).toHaveLength(0);
  });
});

test("resume follows the bound provider and retains human updates while Claude waits", async () => {
  const h = harness("codex");
  h.task("claude", CLAUDE, "topics"); h.task("gpt", codingModel, "codex");
  limit("hold");
  void h.dispatcher.resume("claude", "Keep the first update");
  void h.dispatcher.resume("claude", "And the second update");
  void h.dispatcher.resume("gpt", "Continue GPT"); await flush();
  expect(h.turns).toHaveLength(1);
  expect(h.turns[0].content).toContain("Continue GPT");
  expect(h.svc.get("claude")!.task).toMatchObject({ dispatchState: "queued", assignedTopicId: "bound-claude" });
  clearProviderHold();
  void h.dispatcher.resume("claude", "After reset"); await flush();
  expect(h.turns).toHaveLength(2);
  expect(h.turns[1].content).toContain("After reset");
  h.ends[1]({ end: "end_turn" });
  await flush(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(h.turns).toHaveLength(3);
  expect(h.turns[2].content).toContain("Keep the first update");
  expect(h.turns[2].content).toContain("And the second update");
  expect(h.starts).toHaveLength(0);
});

test("the approaching limit keeps the existing-session resume policy", async () => {
  const h = harness(); h.task("existing", CLAUDE, "topics"); limit("threshold");
  void h.dispatcher.resume("existing", "Finish this turn"); await flush();
  expect(h.turns).toHaveLength(1);
});

test("a reused Claude session stays held despite a Codex default", async () => {
  const h = harness("codex");
  h.task("blocker", CLAUDE, "topics");
  h.db.run("UPDATE tasks SET status = 'done' WHERE id = 'blocker'");
  h.task("dependent");
  h.db.run("UPDATE tasks SET blocked_by_task_id = 'blocker', reuse_blocker_context = 1 WHERE id = 'dependent'");
  limit("hold"); await h.dispatcher.tick(PID); await flush();
  expect(h.turns).toHaveLength(0); expect(h.starts).toHaveLength(0);
  expect(h.svc.get("dependent")!.task.dispatchAttempts).toBe(0);
});


test("a hold arriving during model selection requeues before creating a topic or worktree", async () => {
  let worktrees = 0;
  const h = harness("topics", {
    pickAutoModel: async () => { limit("hold"); return { model: CLAUDE }; },
    createWorktree: async () => { worktrees++; return "unused"; },
  });
  h.svc.updateBoardSettings(PID, { dispatchUseWorktree: true });
  h.task("late-hold");
  await h.dispatcher.tick(PID); await flush();
  expect(worktrees).toBe(0); expect(h.starts).toHaveLength(0); expect(h.turns).toHaveLength(0);
  expect(h.svc.get("late-hold")!.task).toMatchObject({ status: "todo", dispatchAttempts: 0, dispatchState: "queued" });
});

test("Codex retries its own transient error without inheriting the Claude reset", async () => {
  const h = harness("codex"); h.task("retry", codingModel);
  await h.dispatcher.tick(PID); await flush();
  expect(h.turns).toHaveLength(1);
  limit("hold");
  h.ends[0]({ end: "error", cause: "provider-error" });
  await flush(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.turns).toHaveLength(2);
  expect(h.turns[1].key).toBe(h.turns[0].key);
});


for (const fanOut of [1, 2]) test(`a hold during worktree creation cancels ${fanOut} unstarted turn(s)`, async () => {
  const pending: Array<(id: string) => void> = [];
  const deleted: string[] = [];
  const h = harness("topics", {
    createWorktree: () => new Promise<string>(resolve => { pending.push(resolve); }),
    deleteWorktree: async id => { deleted.push(id); },
    worktreeHasWork: async id => id.endsWith("1"),
  });
  h.svc.updateBoardSettings(PID, { dispatchUseWorktree: true, dispatchFanOut: fanOut });
  h.task("barrier", CLAUDE);
  await h.dispatcher.tick(PID); await flush();
  expect(pending).toHaveLength(fanOut);
  limit("hold");
  pending.forEach((resolve, i) => resolve(`worktree-${i}`));
  await flush();
  expect(h.starts).toHaveLength(0); expect(h.turns).toHaveLength(0);
  expect(deleted).toEqual(["worktree-0"]);
  expect(h.svc.get("barrier")!.task).toMatchObject({ status: "todo", dispatchAttempts: 0, dispatchState: "queued", assignedTopicId: null });
  expect(h.attempts.list("barrier").filter(a => a.state === "running")).toHaveLength(0);
});

for (const fanOut of [1, 2]) test(`Codex still starts ${fanOut} turn(s) when Claude hold arrives during worktree creation`, async () => {
  const pending: Array<(id: string) => void> = [];
  const h = harness("codex", {
    createWorktree: () => new Promise<string>(resolve => { pending.push(resolve); }),
  });
  h.svc.updateBoardSettings(PID, { dispatchUseWorktree: true, dispatchFanOut: fanOut });
  h.task("codex-barrier", codingModel);
  await h.dispatcher.tick(PID); await flush();
  expect(pending).toHaveLength(fanOut);
  limit("hold");
  pending.forEach((resolve, i) => resolve(`codex-worktree-${i}`));
  await flush();
  expect(h.starts).toHaveLength(fanOut); expect(h.turns).toHaveLength(fanOut);
  expect(h.starts.every(start => start.provider === "codex")).toBe(true);
});

test("a fan-out sibling already running keeps its delivery when a later sibling is held", async () => {
  const pending: Array<(id: string) => void> = [];
  const deleted: string[] = [];
  const h = harness("topics", {
    createWorktree: () => new Promise<string>(resolve => { pending.push(resolve); }),
    deleteWorktree: async id => { deleted.push(id); },
    attemptStats: async () => ({ commit: "abc123", filesChanged: 1, insertions: 1, deletions: 0 }),
    getLastAgentText: () => ({ text: "The first sibling delivered", id: "delivery" }),
  });
  h.svc.updateBoardSettings(PID, { dispatchUseWorktree: true, dispatchFanOut: 2 });
  h.task("partial", CLAUDE);
  await h.dispatcher.tick(PID); await flush();
  pending[0]("working-tree"); await flush();
  expect(h.turns).toHaveLength(1);
  limit("hold"); pending[1]("unstarted-tree"); await flush();
  expect(h.turns).toHaveLength(1); expect(deleted).toEqual(["unstarted-tree"]);
  h.ends[0]({ end: "end_turn" }); await flush();
  expect(h.svc.get("partial")!.task.status).toBe("review");
  expect(h.attempts.list("partial").find(attempt => attempt.idx === 1)?.commit).toBe("abc123");
  expect(deleted).not.toContain("working-tree");
});
