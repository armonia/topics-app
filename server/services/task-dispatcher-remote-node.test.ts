/**
 * THE REMOTE LANE: a card that runs on another machine.
 *
 * Two requirements meet in this file, and both are written against a defect
 * that costs real work:
 *
 *  · KANBAN-76 — a card whose `machine_id` names a paired node runs THERE.
 *    Not "preferably there": the local lane must never open a worktree, a
 *    topic or a turn for it, not even when the node is silent. A fallback to
 *    this machine is the one behaviour a human who picked a machine by hand
 *    did not ask for. And the slot it holds here does not spend the local cap:
 *    a remote run costs no process and no CPU on this side.
 *
 *  · KANBAN-77 — liveness is CONSECUTIVE FAILED POLLS, K = 30, never elapsed
 *    time. A closed laptop produces no polls at all, so twenty minutes of
 *    silence must bury exactly ZERO runs: a clock rule would bury every remote
 *    card the moment the lid opens. And a buried run is not a DEAD run - it may
 *    still be working over there - so the next run for the same card cancels it
 *    first, and a report carrying a buried run id is dropped. Without those two
 *    the card collects two deliveries and two branches.
 *
 * No network and no sleeps: the node is a fake, the clock is a variable, and
 * every poll is one `reconcile` call driven by hand.
 *
 * @covers KANBAN-76
 * @covers KANBAN-77
 * @covers GUEST-13
 * @covers GUEST-15
 * @covers GUEST-17
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleHooks, type LifecycleHookPayload, type LifecycleHookRunner } from "./lifecycle-hooks";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { NODE_BRANCH_GRACE_POLLS, NODE_DEAD_POLLS, NODE_RETIRE_TRIES } from "./task-dispatcher-remote-node";
import { createNodeBranchPlanter } from "./node-branch-plant";
import type { NodeRunBinding, NodeRunReport } from "./node-client";
import type { DelegatedRunPolicy } from "../lib/delegated-agent-start";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

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
    max_agents_auto INTEGER, dispatch_fanout INTEGER, language TEXT
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: l'ancora di KANBAN-72, qui è l'id del commento SUL NODO.
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run("INSERT INTO machines (id) VALUES ('node-1')");
  return db;
}

const PID = "alpha-abc123";
const TASK = "card-remota";
const MACHINE = "node-1";
const BASE_URL = "https://node.local";
const TOKEN = "tok-node-1";

/** A node report carrying only the fields the case under test looks at. */
function report(over: Partial<NodeRunReport> = {}): NodeRunReport {
  return {
    status: "in_progress",
    dispatchState: "working",
    dispatchError: null,
    comments: [],
    deliveryBranch: null,
    deliveryCommit: null,
    baseSha: null,
    stat: null,
    ...over,
  };
}

interface NodeFakeOptions {
  /** `false` = never paired: neither address nor token. */
  paired?: boolean;
  createRun?: () => Promise<{ runId: string }>;
  readRun?: (runId: string) => Promise<NodeRunReport>;
  cancelRun?: (runId: string) => Promise<void>;
  bundle?: Uint8Array | null;
  planted?: { planted: boolean; commit: string | null; reason: string | null };
  /** The `node-run` hook runner; absent = the lane's own default. */
  hooks?: LifecycleHookRunner;
  projectPathOf?: (projectId: string) => string | null;
}

function nodeFake(o: NodeFakeOptions = {}) {
  const calls: string[] = [];
  const created: { body: unknown; token: string; delegation?: NodeRunBinding }[] = [];
  const plantedWith: { branch: string; baseSha: string | null; bundleBytes: number | null }[] = [];
  let nextRun = 0;
  const node: NonNullable<DispatcherDeps["node"]> = {
    createRun: async ({ body, token, delegation }) => {
      calls.push("create");
      created.push({ body, token, delegation });
      if (o.createRun) return o.createRun();
      nextRun += 1;
      return { runId: `run-${nextRun}` };
    },
    readRun: async ({ runId }) => {
      calls.push(`read:${runId}`);
      return o.readRun ? o.readRun(runId) : report();
    },
    fetchBundle: async () => {
      calls.push("bundle");
      return o.bundle && o.bundle.length > 0 ? { empty: false as const, bytes: o.bundle } : { empty: true as const };
    },
    cancelRun: async ({ runId }) => {
      calls.push(`cancel:${runId}`);
      if (o.cancelRun) await o.cancelRun(runId);
    },
    baseUrlOf: () => (o.paired === false ? null : BASE_URL),
    tokenOf: () => (o.paired === false ? null : TOKEN),
    delegatedTokenOf: () => (o.paired === false ? null : "tok-confined"),
    nameOf: () => "Portatile",
    localMachineId: () => "questa-macchina",
    originUrlOf: async () => "git@github.com:acme/alpha.git",
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.projectPathOf ? { projectPathOf: o.projectPathOf } : {}),
    plantBranch: async ({ branch, baseSha, bundle }) => {
      plantedWith.push({ branch, baseSha, bundleBytes: bundle ? bundle.length : null });
      return o.planted ?? { planted: true, commit: "c0ffeec0ffee", reason: null };
    },
  };
  return { node, calls, created, plantedWith };
}

function delegatedPolicy(overrides: Partial<DelegatedRunPolicy> = {}): DelegatedRunPolicy {
  return {
    id: "capability-confined",
    subjectType: "person",
    subjectId: "person-confined",
    projectId: PID,
    machineId: MACHINE,
    machineName: "Portatile",
    repositoryKey: "github.com/acme/alpha",
    model: "gpt-5",
    effort: "medium",
    maxDurationMinutes: 7,
    maxAttempts: 1,
    fanout: 1,
    grantedByPersonId: "person-owner",
    grantedAt: Date.UTC(2026, 8, 6, 9, 0, 0),
    expiresAt: null,
    revokedAt: null,
    taskId: TASK,
    initiatorPersonId: "person-confined",
    initiatorDeviceId: "device-confined",
    ...overrides,
    deadlineAt: overrides.deadlineAt ?? null,
  };
}

function harness(nodeOverrides: NodeFakeOptions = {}, depOverrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const fake = nodeFake(nodeOverrides);
  const worktrees: string[] = [];
  const topics: string[] = [];
  const turns: string[] = [];
  let now = Date.UTC(2026, 8, 6, 10, 0, 0);

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${topics.length + 1}`;
      topics.push(id);
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async () => { worktrees.push(`wt-${worktrees.length + 1}`); return `wt-${worktrees.length}`; },
    deleteWorktree: async () => {},
    runTurn: (sessionKey) => { turns.push(sessionKey); return Promise.resolve<TurnEndInfo | void>(undefined); },
    recordDelegatedPhase: () => {
      const policy = depOverrides.delegatedPolicyForTask?.(TASK);
      return policy?.deadlineAt ?? now + (policy?.maxDurationMinutes ?? 7) * 60_000;
    },
    broadcast: () => {},
    node: fake.node,
    now: () => now,
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    ...depOverrides,
  };
  const dispatcher = createTaskDispatcher(deps);

  // `auto` said out loud: the global preference of whoever runs the suite must not reach the body.
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1, language: "auto" });
  svc.setGlobalCap({ auto: false, max: 9 });

  return {
    db, svc, dispatcher, worktrees, topics, turns,
    calls: fake.calls, created: fake.created, plantedWith: fake.plantedWith,
    advance: (ms: number) => { now += ms; },
    nowMs: () => now,
    task: () => svc.get(TASK)!.task,
    comments: () => svc.get(TASK)!.comments,
    /** A todo that names the node: the only difference from any other card. */
    seed: () => {
      const ts = new Date(now).toISOString();
      db.run(
        `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts, machine_id)
         VALUES (?, ?, 'porta a casa la corsia remota', 'con il ramo', 'todo', ?, ?, 0, ?)`,
        [TASK, PID, ts, ts, MACHINE],
      );
    },
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** One poll round: `reconcile` is what asks the node, once per slot. */
async function poll(h: ReturnType<typeof harness>, rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    await h.dispatcher.reconcile({ reason: "poll" });
    await flush();
  }
}

async function dispatch(h: ReturnType<typeof harness>) {
  await h.dispatcher.tick(PID);
  await flush();
}

describe("la card parte sul nodo, non qui", () => {
  it("nessun worktree, nessun discorso, nessun turno: solo la corsa sul nodo", async () => {
    const h = harness();
    h.seed();

    await dispatch(h);

    expect(h.worktrees).toEqual([]);
    expect(h.topics).toEqual([]);
    expect(h.turns).toEqual([]);
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);
    // The node resolves the repository from its git remote, and the card says where it came from.
    expect(h.created[0].body).toMatchObject({ originTaskId: TASK, originUrl: "git@github.com:acme/alpha.git" });
    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchState).toBe("working");
  });

  it("la card che nomina QUESTA macchina gira QUI, come sempre", async () => {
    // `machine_id` is the choice of A machine, and picking this one is the
    // default said out loud: without this case the remote lane would wait
    // forever for a node that is us, on a row whose `baseUrl` is null by
    // construction.
    const h = harness();
    h.db.run("INSERT INTO machines (id) VALUES ('questa-macchina')");
    h.seed();
    h.db.run("UPDATE tasks SET machine_id = 'questa-macchina' WHERE id = ?", [TASK]);

    await dispatch(h);

    expect(h.calls).toEqual([]);
    expect(h.worktrees).toHaveLength(1);
    expect(h.turns).toHaveLength(1);
  });

  it("una card remota in lavorazione NON spende il tetto locale", async () => {
    const h = harness();
    h.seed();

    await dispatch(h);

    expect(h.task().dispatchState).toBe("working");
    // The `running` of GET /api/system/dispatch-capacity reads this number.
    expect(h.dispatcher.busyCount()).toBe(0);
    // The card still counts as in flight: this process holds a handle on it.
    expect(h.dispatcher.busyIds()).toContain(TASK);
  });

  it("nodo muto al dispatch: resta in coda con node_unreachable, e nessun turno qui", async () => {
    const h = harness({ createRun: () => Promise.reject(Object.assign(new Error("boom"), { reason: "unreachable" })) });
    h.seed();

    await dispatch(h);

    const t = h.task();
    expect(t.status).toBe("todo");
    expect(t.dispatchError).toBe("node_unreachable");
    expect(t.dispatchDeferredUntil).not.toBeNull();
    expect(Date.parse(t.dispatchDeferredUntil!)).toBeGreaterThan(Date.now());
    // The attempt the claim spent is refunded: a node that is off is not a failure of the card.
    expect(t.dispatchAttempts).toBe(0);
    expect(h.turns).toEqual([]);
    expect(h.worktrees).toEqual([]);
    expect(h.topics).toEqual([]);
  });

  it("nodo mai accoppiato: stessa risposta, senza nemmeno provare", async () => {
    const h = harness({ paired: false });
    h.seed();

    await dispatch(h);

    expect(h.calls).toEqual([]);
    expect(h.task().status).toBe("todo");
    expect(h.task().dispatchError).toBe("node_unreachable");
  });

  it("la card rimandata indietro porta al nodo il feedback della review e la consegna precedente", async () => {
    // ff293eda, 26/10: the reviewer twice asked the PC for one line in the README; the node was
    // only ever given the title and the description, rewrote the file from scratch every round
    // and never wrote the line. A local card reads its thread through `get_task`; a node cannot.
    const h = harness();
    h.seed();
    h.svc.addComment({ taskId: TASK, author: "agent", kind: "delivery", content: "README riscritto, 38 righe" });
    h.svc.addComment({ taskId: TASK, author: "attilio", content: "Manca il prerequisito git config user.name/user.email" });
    h.svc.addComment({ taskId: TASK, author: "system", kind: "service", content: "Task in coda per una nuova sessione." });
    h.svc.addComment({ taskId: TASK, author: "system", content: "Consegnato dal nodo «Portatile»: il ramo è stato piantato" });

    await dispatch(h);

    const sent = (h.created[0].body as { description: string }).description;
    expect(sent.startsWith("con il ramo")).toBe(true);
    expect(sent).toContain("Manca il prerequisito git config user.name/user.email");
    expect(sent).toContain("README riscritto, 38 righe");
    // The dispatcher's own bookkeeping is not the reviewer's voice.
    expect(sent).not.toContain("Task in coda per una nuova sessione");
    expect(sent).not.toContain("Consegnato dal nodo");
  });

  it("a un dispositivo ospite confinato la discussione del proprietario NON viaggia", async () => {
    const h = harness({}, { delegatedPolicyForTask: () => delegatedPolicy() });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = 'capability-confined' WHERE id = ?", [TASK]);
    h.svc.addComment({ taskId: TASK, author: "attilio", content: "nota privata del proprietario" });

    await dispatch(h);

    expect(h.created).toHaveLength(1);
    expect((h.created[0].body as { description: string }).description).toBe("con il ramo");
  });

  it("con la board in italiano il nodo riceve la direttiva di lingua, per commenti e consegna", async () => {
    // 26/10, 22:30-22:34: four Cloud Claude cards, language set to Italian, one delivered in English.
    // The cloud's prompt is the title plus this description: nothing else of ours reaches it.
    const h = harness();
    h.svc.updateBoardSettings(PID, { language: "it" });
    h.seed();

    await dispatch(h);

    const sent = (h.created[0].body as { description: string }).description;
    expect(sent.startsWith("con il ramo")).toBe(true);
    expect(sent).toContain("Rispondi sempre in italiano");
    expect(sent).toContain("every comment you write on the card and your closing summary");
    expect(sent).toContain("code comments are always English");
  });

  it("la lingua arriva anche dopo il thread, e anche a un dispositivo ospite", async () => {
    const h = harness({}, { delegatedPolicyForTask: () => delegatedPolicy() });
    h.svc.updateBoardSettings(PID, { language: "en" });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = 'capability-confined' WHERE id = ?", [TASK]);

    await dispatch(h);

    const sent = (h.created[0].body as { description: string }).description;
    expect(sent.startsWith("con il ramo\n\n--- LANGUAGE ---")).toBe(true);
    expect(sent).toContain("Always answer in English");
  });

  it("una card senza discussione parte con la sua descrizione, identica", async () => {
    const h = harness();
    h.seed();

    await dispatch(h);

    expect((h.created[0].body as { description: string }).description).toBe("con il ramo");
  });
});

describe("l'hook node-run gira prima che la card parta sul nodo", () => {
  /** A runner that records every call and answers with a fixed outcome. */
  function hookFake(outcome: Awaited<ReturnType<LifecycleHookRunner["run"]>>, order?: string[]) {
    const seen: { event: string; payload: LifecycleHookPayload }[] = [];
    const runner: LifecycleHookRunner = {
      run: async (event, payload) => {
        order?.push("hook");
        seen.push({ event, payload });
        return outcome;
      },
    };
    return { runner, seen };
  }

  it("via libera: la corsa parte con lo stesso corpo di sempre e l'hook riceve il carico completo", async () => {
    const order: string[] = [];
    const hook = hookFake({ ok: true }, order);
    const h = harness({ hooks: hook.runner, projectPathOf: () => "/Users/me/alpha" });
    h.seed();

    await dispatch(h);

    expect(hook.seen).toHaveLength(1);
    expect(hook.seen[0].event).toBe("node-run");
    expect(hook.seen[0].payload).toEqual({
      hook_event_name: "node-run",
      session_id: TASK,
      cwd: "/Users/me/alpha",
      task_id: TASK,
      project_id: PID,
      machine_id: MACHINE,
      machine_name: "Portatile",
      node_base_url: BASE_URL,
      origin_url: "git@github.com:acme/alpha.git",
    });
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(h.created[0].body).toEqual({
      originTaskId: TASK,
      originUrl: "git@github.com:acme/alpha.git",
      text: "porta a casa la corsia remota",
      description: "con il ramo",
      model: null,
      effort: "medium",
    });
    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchState).toBe("working");
  });

  it("veto: nessuna corsa creata, la card torna in coda come un nodo muto e dice perché", async () => {
    const hook = hookFake({ ok: false, reason: "il PC non si sveglia (wol senza risposta)" });
    const h = harness({ hooks: hook.runner });
    h.seed();

    await dispatch(h);

    expect(h.calls).toEqual([]);
    const t = h.task();
    expect(t.status).toBe("todo");
    expect(t.dispatchError).toBe("node_unreachable");
    expect(t.dispatchDeferredUntil).not.toBeNull();
    expect(Date.parse(t.dispatchDeferredUntil!)).toBeGreaterThan(Date.now());
    expect(t.dispatchAttempts).toBe(0);
    expect(h.turns).toEqual([]);
    expect(h.worktrees).toEqual([]);
    const note = h.comments().map((c) => c.content).join("\n");
    expect(note).toContain("il nodo «Portatile» non è pronto: il PC non si sveglia (wol senza risposta)");
    // The slot is free again: the retry is not blocked by a ghost run.
    expect(h.dispatcher.busyIds()).not.toContain(TASK);
  });

  it("l'hook gira prima di ogni chiamata al nodo, anche la cancellazione della corsa vecchia", async () => {
    // A PC that sleeps cannot answer the cancel either: the hook that wakes it
    // has to come first, then the cancel of the buried run, then the new run.
    const trace: string[] = [];
    let runs = 0;
    let buried = false;
    const hook = hookFake({ ok: true }, trace);
    const h = harness({
      hooks: hook.runner,
      createRun: async () => { trace.push("create"); runs += 1; return { runId: `run-${runs}` }; },
      cancelRun: async (runId) => { trace.push(`cancel:${runId}`); },
      readRun: (runId) =>
        runId === "run-1" && !buried
          ? Promise.reject(Object.assign(new Error("giu"), { reason: "unreachable" }))
          : Promise.resolve(report()),
    });
    h.seed();
    await dispatch(h);
    await poll(h, NODE_DEAD_POLLS);
    buried = true;

    expect(trace).toEqual(["hook", "create", "hook", "cancel:run-1", "create"]);
  });

  it("hooks.json con uno script che esce non zero: il motivo sullo stderr arriva sulla card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "node-run-hook-"));
    try {
      const file = join(dir, "hooks.json");
      writeFileSync(file, JSON.stringify({
        hooks: [{ event: "node-run", cmd: "cat >/dev/null; echo 'bundle non inviato' >&2; exit 3", timeoutMs: 5000 }],
      }));
      const h = harness({ hooks: createLifecycleHooks({ file, log: () => {} }) });
      h.seed();

      await dispatch(h);
      // The real command runs in a child process: give it a moment to answer.
      for (let i = 0; i < 100 && h.task().status !== "todo"; i++) await new Promise((r) => setTimeout(r, 20));
      await flush();

      expect(h.calls).toEqual([]);
      expect(h.task().status).toBe("todo");
      expect(h.comments().map((c) => c.content).join("\n")).toContain("bundle non inviato");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nessun hooks.json: la card parte esattamente come prima", async () => {
    const dir = mkdtempSync(join(tmpdir(), "node-run-nohooks-"));
    const previous = process.env.TOPICS_HOME;
    process.env.TOPICS_HOME = dir;
    try {
      // No `hooks` injected: the lane falls back to the shared runner, which reads the (absent) file.
      const h = harness();
      h.seed();

      await dispatch(h);

      expect(h.calls.filter((c) => c === "create")).toHaveLength(1);
      expect(h.task().status).toBe("in_progress");
      expect(h.task().dispatchState).toBe("working");
    } finally {
      if (previous === undefined) delete process.env.TOPICS_HOME; else process.env.TOPICS_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("delegated remote dispatch stays inside its immutable envelope", () => {
  it("applies the stricter effort and duration with one attempt and no fanout", async () => {
    const policy = delegatedPolicy();
    const h = harness({}, { delegatedPolicyForTask: () => policy });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = ? WHERE id = ?", [policy.id, TASK]);
    h.svc.updateBoardSettings(PID, {
      dispatchEffort: "high",
      dispatchTimeoutMin: 30,
      dispatchFanOut: 4,
    });

    await dispatch(h);

    expect(h.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(h.created[0].token).toBe("tok-confined");
    expect(h.created[0].body).toMatchObject({
      model: "gpt-5",
      effort: "medium",
    });
    expect(h.created[0].delegation).toEqual({
      capabilityId: policy.id,
      subjectPersonId: policy.initiatorPersonId,
      subjectDeviceId: policy.initiatorDeviceId,
    });
    expect(h.task().dispatchAttempts).toBe(1);
  });

  it("fails closed before node creation when the live capability disappears", async () => {
    const h = harness({}, { delegatedPolicyForTask: () => null, isDelegatedTask: () => true });
    h.seed();

    await dispatch(h);

    expect(h.calls).toEqual([]);
    expect(h.task().status).toBe("todo");
    expect(h.task().dispatchAttempts).toBe(0);
    expect(h.task().dispatchError).toBe("delegated_capability_invalid");
  });

  it("does not create a remote run when verified begin throws or updates zero rows", async () => {
    for (const recordDelegatedPhase of [
      () => { throw new Error("disk full"); },
      () => false,
    ]) {
      const policy = delegatedPolicy();
      const h = harness({}, { delegatedPolicyForTask: () => policy, recordDelegatedPhase });
      h.seed();
      h.db.run("UPDATE tasks SET delegated_start_capability_id = ? WHERE id = ?", [policy.id, TASK]);

      await dispatch(h);

      expect(h.calls).toEqual([]);
      expect(h.task().status).toBe("backlog");
      expect(h.task().dispatchState).toBe("blocked");
    }
  });

  it("cancels only the just-created remote run when its audit binding fails", async () => {
    const policy = delegatedPolicy();
    let writes = 0;
    const h = harness({}, {
      delegatedPolicyForTask: () => policy,
      recordDelegatedPhase: () => (++writes === 1 ? Date.UTC(2026, 8, 6, 10, 7, 0) : false),
    });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = ? WHERE id = ?", [policy.id, TASK]);

    await dispatch(h);

    expect(h.calls).toEqual(["create", "cancel:run-1"]);
    expect(h.task().status).toBe("backlog");
    expect(h.task().dispatchState).toBe("blocked");
  });

  it("keeps the exact run bound when post-bind cancellation is offline, then retries it", async () => {
    const policy = delegatedPolicy();
    let writes = 0;
    let cancellations = 0;
    const h = harness({
      cancelRun: async () => {
        cancellations += 1;
        if (cancellations === 1) throw new Error("offline");
      },
    }, {
      delegatedPolicyForTask: () => policy,
      recordDelegatedPhase: () => (++writes === 1 ? Date.UTC(2026, 8, 6, 10, 7, 0) : false),
    });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = ? WHERE id = ?", [policy.id, TASK]);

    await dispatch(h);

    expect(h.calls).toEqual(["create", "cancel:run-1"]);
    expect(h.dispatcher.busyIds()).toContain(TASK);
    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchError).toBe("delegated_cancel_unconfirmed");

    await poll(h);

    expect(h.calls).toEqual(["create", "cancel:run-1", "cancel:run-1"]);
    expect(h.dispatcher.busyIds()).not.toContain(TASK);
    expect(h.task().status).toBe("backlog");
    expect(h.task().dispatchState).toBe("blocked");
  });

  it("revocation cancels only the active run bound to that capability", async () => {
    const policy = delegatedPolicy();
    const h = harness({}, { delegatedPolicyForTask: () => policy });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = ? WHERE id = ?", [policy.id, TASK]);
    await dispatch(h);

    const canceled = await h.dispatcher.revokeDelegatedCapability(policy.id);

    expect(canceled).toBe(1);
    expect(h.calls.filter((call) => call.startsWith("cancel:"))).toEqual(["cancel:run-1"]);
    expect(h.task().dispatchState).toBe("blocked");
    expect(h.task().dispatchError).toContain("revoked");
  });

  it("does not claim a remote run stopped when cancellation is unreachable", async () => {
    const policy = delegatedPolicy();
    const h = harness({ cancelRun: async () => { throw new Error("offline"); } }, {
      delegatedPolicyForTask: () => policy,
    });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = ? WHERE id = ?", [policy.id, TASK]);
    await dispatch(h);

    const canceled = await h.dispatcher.revokeDelegatedCapability(policy.id);

    expect(canceled).toBe(0);
    expect(h.dispatcher.busyIds()).toContain(TASK);
    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchError).toBe("delegated_cancel_unconfirmed");
  });
});

describe("delegated local dispatch revalidates at the turn seam", () => {
  it("parks before runTurn when begin persistence throws or updates zero rows", async () => {
    for (const recordDelegatedPhase of [
      () => { throw new Error("write failed"); },
      () => false,
    ]) {
      let turnCalls = 0;
      const policy = delegatedPolicy({ machineId: "questa-macchina" });
      const h = harness({}, {
        delegatedPolicyForTask: () => policy,
        recordDelegatedPhase,
        abortTurn: async () => {},
        runTurn: async () => { turnCalls += 1; },
      });
      h.db.run("INSERT INTO machines (id) VALUES ('questa-macchina')");
      h.seed();
      h.db.run(
        "UPDATE tasks SET machine_id = 'questa-macchina', delegated_start_capability_id = ? WHERE id = ?",
        [policy.id, TASK],
      );

      await dispatch(h);

      expect(turnCalls).toBe(0);
      expect(h.task().status).toBe("backlog");
      // A boot/reconcile after the failed persistence cannot recreate a fresh
      // duration or start the card from its stale delegated marker.
      await h.dispatcher.reconcile({ reason: "boot" });
      await flush();
      expect(turnCalls).toBe(0);
    }
  });

  it("resume with no persisted deadline runs no turn", async () => {
    let turnCalls = 0;
    const policy = delegatedPolicy({ machineId: "questa-macchina", deadlineAt: null });
    const h = harness({}, {
      delegatedPolicyForTask: () => policy,
      recordDelegatedPhase: () => false,
      abortTurn: async () => {},
      runTurn: async () => { turnCalls += 1; },
    });
    h.db.run("INSERT INTO machines (id) VALUES ('questa-macchina')");
    h.seed();
    h.db.run("INSERT INTO topics (id) VALUES ('resume-topic')");
    h.db.run(`UPDATE tasks SET status = 'in_progress', assigned_topic_id = 'resume-topic',
      machine_id = 'questa-macchina', delegated_start_capability_id = ? WHERE id = ?`, [policy.id, TASK]);

    await h.dispatcher.resume(TASK, "continue");

    expect(turnCalls).toBe(0);
    expect(h.task().status).toBe("backlog");
  });

  it("an absolute deadline that expires before runTurn denies the turn", async () => {
    let turnCalls = 0;
    const policy = delegatedPolicy({
      machineId: "questa-macchina",
      deadlineAt: Date.UTC(2026, 8, 6, 10, 0, 0) - 1,
    });
    const h = harness({}, {
      delegatedPolicyForTask: () => policy,
      abortTurn: async () => {},
      runTurn: async () => { turnCalls += 1; },
    });
    h.db.run("INSERT INTO machines (id) VALUES ('questa-macchina')");
    h.seed();
    h.db.run(
      "UPDATE tasks SET machine_id = 'questa-macchina', delegated_start_capability_id = ? WHERE id = ?",
      [policy.id, TASK],
    );

    await dispatch(h);

    expect(turnCalls).toBe(0);
  });
});

describe("un nodo è alive finché i suoi POLL rispondono", () => {
  it("venti minuti senza NESSUN poll non seppelliscono niente", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);

    // The machine sleeps: the clock runs and nobody asks the node anything.
    h.advance(20 * 60_000);

    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchState).toBe("working");
    expect(h.comments().some((c) => c.content.includes("non risponde più"))).toBe(false);

    // And on waking the first round answers: the run is alive as it was.
    await poll(h);
    expect(h.task().status).toBe("in_progress");
  });

  it(`${NODE_DEAD_POLLS} rounds falliti seppelliscono UNA volta, con una nota sola`, async () => {
    const h = harness({ readRun: () => Promise.reject(Object.assign(new Error("giù"), { reason: "unreachable" })) });
    h.seed();
    await dispatch(h);
    expect(h.task().dispatchAttempts).toBe(1);

    // One round short of the cap: still nothing.
    await poll(h, NODE_DEAD_POLLS - 1);
    expect(h.task().status).toBe("in_progress");

    // Dispatch goes off BEFORE the last round: the burial lives in step 0 of
    // `reconcile` and happens regardless, but the card does not leave again for
    // the node straight away, so what gets measured is the burial and not the
    // round after it.
    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    await poll(h);

    const t = h.task();
    expect(t.status).toBe("todo");
    expect(t.dispatchAttempts).toBe(0); // refunded, like the orphans of KANBAN-10
    const note = h.comments().filter((c) => c.content.includes("non risponde più"));
    expect(note).toHaveLength(1);

    // And ten more rounds add no second note: the run is buried already.
    await poll(h, 10);
    expect(h.comments().filter((c) => c.content.includes("non risponde più"))).toHaveLength(1);
  });

  it("un giro riuscito al ventinovesimo azzera il conto", async () => {
    let alive = false;
    const h = harness({
      readRun: () => (alive ? Promise.resolve(report()) : Promise.reject(new Error("giù"))),
    });
    h.seed();
    await dispatch(h);

    await poll(h, NODE_DEAD_POLLS - 1);
    expect(h.task().status).toBe("in_progress");

    // The node answers once: the count starts over from zero.
    alive = true;
    await poll(h);
    alive = false;
    // Twenty-nine more failures are no longer enough: without the reset this
    // round would be the thirtieth and the run would already be buried.
    await poll(h, NODE_DEAD_POLLS - 1);

    expect(h.task().status).toBe("in_progress");
    expect(h.comments().some((c) => c.content.includes("non risponde più"))).toBe(false);
  });

  it("la corsa vecchia si cancella PRIMA di crearne una nuova, e il suo rapporto non torna più", async () => {
    // Run 1 stops answering and is buried. From that moment on "buried" makes
    // it answer again, and with a DELIVERY: if anybody still asked it, the card
    // would collect a second branch. The proof that the report is dropped is
    // that this branch never arrives.
    let buried = false;
    const h = harness({
      readRun: (runId) => {
        if (runId !== "run-1") return Promise.resolve(report());
        return buried
          ? Promise.resolve(report({ status: "review", deliveryBranch: "ramo-della-corsa-buried", baseSha: "aaaaaaa1" }))
          : Promise.reject(Object.assign(new Error("giù"), { reason: "unreachable" }));
      },
    });
    h.seed();
    await dispatch(h);

    await poll(h, NODE_DEAD_POLLS);
    buried = true;

    // The burial put the card back in the queue and the `tick` of the same
    // round dispatched it again: first the old run is cancelled, then the new
    // one is created.
    const order = h.calls.filter((c) => c === "create" || c.startsWith("cancel:"));
    expect(order).toEqual(["create", "cancel:run-1", "create"]);
    expect(h.task().status).toBe("in_progress");

    // From here on nobody asks `run-1` anything: the late report of a buried
    // run has no door to come in through.
    const callsBefore = h.calls.length;
    await poll(h, 3);
    expect(h.calls.slice(callsBefore).filter((c) => c === "read:run-1")).toEqual([]);
    expect(h.task().deliveryBranch).toBeNull();
  });
});

describe("lo specchio: stato, commenti e il ramo che torna", () => {
  it("un commento specchiato due volte si scrive UNA volta", async () => {
    let comments: NodeRunReport["comments"] = [
      { id: "nc-origine", author: "system", content: "Card specchiata da github.com/acme/alpha", kind: "service", createdAt: "2026-09-06T10:00:00.000Z" },
    ];
    const h = harness({ readRun: () => Promise.resolve(report({ comments })) });
    h.seed();
    await dispatch(h);

    // First round seeds and nothing else. The node's origin note is our own
    // dispatch coming back, and mirroring it would be noise.
    await poll(h);
    expect(h.comments().some((c) => c.content.includes("Card specchiata"))).toBe(false);

    comments = [
      ...comments,
      { id: "nc-1", author: "agent", content: "Ho finito il primo pezzo.", kind: "service", createdAt: "2026-09-06T10:01:00.000Z" },
    ];
    await poll(h);
    await poll(h); // the same comment, again

    const mirrored = h.comments().filter((c) => c.content === "Ho finito il primo pezzo.");
    expect(mirrored).toHaveLength(1);
    // Dedup goes through the ANCHOR (KANBAN-72), never through the text.
    expect(mirrored[0].messageId).toBe("nc-1");
  });

  it("la card del nodo in review pianta il ramo e registra la consegna", async () => {
    const bundle = new Uint8Array([1, 2, 3, 4]);
    const h = harness({
      bundle,
      readRun: () =>
        Promise.resolve(report({
          status: "review",
          dispatchState: "delivered",
          deliveryBranch: "topics/corsa-remota",
          deliveryCommit: "deadbeefdeadbeef",
          baseSha: "abcdef0123456789",
          stat: { filesChanged: 3, insertions: 40, deletions: 2 },
        })),
    });
    h.seed();
    await dispatch(h);

    await poll(h);

    const t = h.task();
    expect(t.status).toBe("review");
    expect(t.deliveryBranch).toBe("topics/corsa-remota");
    expect(t.deliveryCommit).toBe("c0ffeec0ffee"); // the commit REALLY planted here
    expect(t.deliveryFilesChanged).toBe(3);
    // The branch arrived as a bundle over the already authenticated channel.
    expect(h.plantedWith).toEqual([{ branch: "topics/corsa-remota", baseSha: "abcdef0123456789", bundleBytes: 4 }]);
    // ONE note only, and it names the node.
    const note = h.comments().filter((c) => c.content.includes("Portatile"));
    expect(note.length).toBeGreaterThanOrEqual(1);
    expect(h.comments().some((c) => c.content.includes("piantato in questo checkout"))).toBe(true);
    // The slot is released: the run is over.
    expect(h.dispatcher.busyIds()).not.toContain(TASK);
  });

  it("il ramo che non si pianta arriva comunque in review, col motivo scritto", async () => {
    const h = harness({
      bundle: new Uint8Array([9, 9]),
      planted: { planted: false, commit: null, reason: "il commit di base 1234abcd non è in questo checkout" },
      readRun: () =>
        Promise.resolve(report({ status: "review", deliveryBranch: "topics/corsa-remota", baseSha: "1234abcd" })),
    });
    h.seed();
    await dispatch(h);

    await poll(h);

    expect(h.task().status).toBe("review");
    expect(h.task().deliveryBranch).toBeNull();
    expect(h.comments().some((c) => c.content.includes("il commit di base 1234abcd non è in questo checkout"))).toBe(true);
  });
});

describe("review senza ramo: il nodo scrive lo stato e poi il ramo", () => {
  // 26/10, a real run on the PC: the node's system delivery writes "review" and
  // the branch half a second later. A poll that fell in between read "review, no
  // branch" and the card landed here empty, with the commit left on the node.
  it("il ramo che arriva al giro dopo si pianta", async () => {
    let round = 0;
    const h = harness({
      bundle: new Uint8Array([1, 2]),
      readRun: () => {
        round++;
        return Promise.resolve(round === 1
          ? report({ status: "review" })
          : report({ status: "review", deliveryBranch: "topics/lilac-henge", deliveryCommit: "937a26e", baseSha: "502414bd" }));
      },
    });
    h.seed();
    await dispatch(h);

    await poll(h);
    expect(h.task().status).toBe("in_progress");
    expect(h.plantedWith).toEqual([]);

    await poll(h);
    expect(h.task().status).toBe("review");
    expect(h.task().deliveryBranch).toBe("topics/lilac-henge");
    expect(h.plantedWith).toEqual([{ branch: "topics/lilac-henge", baseSha: "502414bd", bundleBytes: 2 }]);
  });

  it("senza ramo per davvero arriva in review dopo la tolleranza, col motivo", async () => {
    const h = harness({ readRun: () => Promise.resolve(report({ status: "review" })) });
    h.seed();
    await dispatch(h);

    for (let i = 1; i < NODE_BRANCH_GRACE_POLLS; i++) {
      await poll(h);
      expect(h.task().status).toBe("in_progress");
    }
    await poll(h);
    expect(h.task().status).toBe("review");
    expect(h.comments().some((c) => c.content.includes("il nodo non ha consegnato nessun ramo"))).toBe(true);
    expect(h.dispatcher.busyIds()).not.toContain(TASK);
  });

  it("un motivo dichiarato (il cloud) non aspetta", async () => {
    const h = harness({
      readRun: () => Promise.resolve(report({ status: "review", reason: "la sessione cloud è finita con un errore" })),
    });
    h.seed();
    await dispatch(h);

    await poll(h);
    expect(h.task().status).toBe("review");
    expect(h.comments().some((c) => c.content.includes("la sessione cloud è finita con un errore"))).toBe(true);
  });
});

describe("il bundle presuppone il commit di base", () => {
  it("base assente anche dopo UN fetch di origin: niente bundle a storia intera, un motivo da leggere", async () => {
    const ranGit: string[][] = [];
    const planter = createNodeBranchPlanter({
      repoPathOf: () => "/tmp/alpha",
      runGit: async (_cwd, args) => {
        ranGit.push(args);
        // `cat-file -e` says no, before and after the fetch: the base is not on origin either.
        if (args[0] === "cat-file") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      writeBundle: async () => ({ file: "/tmp/x.bundle", cleanup: async () => {} }),
    });

    const out = await planter.plantBranch({
      projectId: PID,
      branch: "topics/corsa-remota",
      baseSha: "abcdef0123456789",
      bundle: new Uint8Array([1, 2, 3]),
    });

    expect(out.planted).toBe(false);
    expect(out.reason).toContain("abcdef01");
    expect(out.reason).toContain("fetch di origin");
    // The rule (cd9f7cfed8): ONE bounded fetch of origin when this clone is behind,
    // the check asked again, and never a whole-history bundle nor a second fetch.
    expect(ranGit.map((a) => a[0])).toEqual(["cat-file", "fetch", "cat-file"]);
    expect(ranGit[1]).toEqual(["fetch", "--no-tags", "origin"]);
  });
});

describe("la copia vecchia che il nodo restituisce dopo un riavvio", () => {
  // ff293eda, 26/10: after the production restart the Mac no longer remembered the previous run
  // (`lastNodeRun` lives in memory), so it could not cancel it; the node answers `createRun` with the
  // live mirror of the card as it is, already in review, and the card landed the OLD delivery again.
  const old = { id: "c-old", author: "agent", kind: "delivery", content: "consegna vecchia", createdAt: "2026-10-26T10:00:00.000Z" };
  const fresh = { id: "c-new", author: "agent", kind: "delivery", content: "consegna nuova", createdAt: "2026-10-26T11:00:00.000Z" };

  it("già in review al primo giro, con una consegna che la card ha già: cancella la copia e riparte da capo", async () => {
    const h = harness({
      readRun: async (runId) => runId === "run-1"
        ? report({ status: "review", dispatchState: "delivered", deliveryBranch: "topics/vecchio", deliveryCommit: "aaa", baseSha: "bbb", comments: [old] })
        : report({ status: "review", dispatchState: "delivered", deliveryBranch: "topics/nuovo", deliveryCommit: "ccc", baseSha: "bbb", comments: [fresh] }),
      bundle: new Uint8Array([1]),
    });
    h.seed();
    h.svc.addComment({ taskId: TASK, author: "system", kind: "delivery", content: "consegna vecchia", messageId: "c-old" });

    await dispatch(h);
    await poll(h);

    // The old delivery is not landed again: the copy is cancelled once and the card goes out again in
    // the same round, onto a NEW run (like after a burial).
    expect(h.plantedWith).toEqual([]);
    expect(h.calls.filter((c) => c === "create" || c.startsWith("cancel:"))).toEqual(["create", "cancel:run-1", "create"]);
    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchAttempts).toBe(1); // refunded, then spent again by the new run
    expect(h.comments().filter((c) => c.content.includes("copia della consegna precedente"))).toHaveLength(1);

    // And the new run is the one that lands.
    await poll(h);
    expect(h.plantedWith.map((p) => p.branch)).toEqual(["topics/nuovo"]);
    expect(h.task().status).toBe("review");
  });

  it("già in review al primo giro ma con una consegna che la card non ha mai visto: è una corsa veloce, atterra", async () => {
    const h = harness({
      readRun: async () => report({ status: "review", dispatchState: "delivered", deliveryBranch: "topics/veloce", deliveryCommit: "ddd", baseSha: "bbb", comments: [fresh] }),
      bundle: new Uint8Array([1]),
    });
    h.seed();

    await dispatch(h);
    await poll(h);

    expect(h.calls.some((c) => c.startsWith("cancel"))).toBe(false);
    expect(h.plantedWith.map((p) => p.branch)).toEqual(["topics/veloce"]);
    expect(h.task().status).toBe("review");
  });

  it("una corsa vera in attesa del ramo (la sua consegna è già specchiata) non è scambiata per una copia vecchia", async () => {
    // The first answer only SEEDS the comments it carries; a delivery that appears from the second
    // answer on is written on the card with its anchor. The round that still waits for the branch
    // then sees it anchored, and must not take its own run for the old mirror: only the FIRST answer
    // of a run can be that.
    let round = 0;
    const h = harness({
      readRun: async () => {
        round += 1;
        if (round === 1) return report();
        const withBranch = round >= 3;
        return report({
          status: "review", dispatchState: "delivered", comments: [fresh],
          deliveryBranch: withBranch ? "topics/in-ritardo" : null, deliveryCommit: withBranch ? "eee" : null, baseSha: "bbb",
        });
      },
      bundle: new Uint8Array([1]),
    });
    h.seed();

    await dispatch(h);
    await poll(h, 4);

    expect(h.calls.some((c) => c.startsWith("cancel"))).toBe(false);
    expect(h.plantedWith.map((p) => p.branch)).toEqual(["topics/in-ritardo"]);
  });

  it("la copia vecchia che non si riesce a cancellare non fa atterrare la vecchia consegna, e si riprova", async () => {
    let cancelWorks = false;
    const h = harness({
      readRun: async () => report({ status: "review", dispatchState: "delivered", deliveryBranch: "topics/vecchio", deliveryCommit: "aaa", baseSha: "bbb", comments: [old] }),
      cancelRun: async () => { if (!cancelWorks) throw new Error("giù"); },
      bundle: new Uint8Array([1]),
    });
    h.seed();
    h.svc.addComment({ taskId: TASK, author: "system", kind: "delivery", content: "consegna vecchia", messageId: "c-old" });

    await dispatch(h);
    await poll(h, 3);
    expect(h.plantedWith).toEqual([]);
    expect(h.task().status).toBe("in_progress");
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);

    cancelWorks = true;
    await poll(h);
    expect(h.plantedWith).toEqual([]);
    expect(h.calls.filter((c) => c === "create")).toHaveLength(2);
  });

  it("un nodo che risponde ma non cancella mai la copia vecchia: dopo qualche giro la card si parcheggia con la spiegazione", async () => {
    let cancels = 0;
    const h = harness({
      readRun: async () => report({ status: "review", dispatchState: "delivered", deliveryBranch: "topics/vecchio", deliveryCommit: "aaa", baseSha: "bbb", comments: [old] }),
      cancelRun: async () => { cancels += 1; throw new Error("403"); },
      bundle: new Uint8Array([1]),
    });
    h.seed();
    h.svc.addComment({ taskId: TASK, author: "system", kind: "delivery", content: "consegna vecchia", messageId: "c-old" });

    await dispatch(h);
    await poll(h, NODE_RETIRE_TRIES - 1);
    expect(h.task().dispatchState).toBe("working"); // still trying

    await poll(h);
    expect(h.task().dispatchState).toBe("blocked");
    expect(h.task().dispatchError ?? "").toContain("non la cancella");
    expect(h.plantedWith).toEqual([]);

    // Parked means parked: the slot is gone, so nothing asks the node or tries the cancel again.
    expect(cancels).toBe(NODE_RETIRE_TRIES);
    await poll(h, 3);
    expect(cancels).toBe(NODE_RETIRE_TRIES);
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);
  });
});

