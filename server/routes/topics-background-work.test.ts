/**
 * A CHAT'S BACKGROUND WORK, through the real routes: a config change against
 * it, and the Stop of it.
 *
 * Applying an autonomy, model or effort change respawns the CLI, and the
 * respawn kills the agent, the Bash or the Monitor a closed turn left running.
 * The verification of 25/09 found the permission change killing it anyway, and
 * mutating that wiring left 83 tests green: nothing drove the route with a
 * child that had work in the background. Here the real PATCH and the real
 * `/api/command` reach the real registered ClaudeCodeProvider, whose child
 * carries the recorded session's background work:
 *
 *   - no change kills it, a raise of the autonomy least of all;
 *   - a change the running CLI cannot take is said in the chat, one row;
 *   - once the work is over the same change respawns the child;
 *   - with no turn open, the Stop stops the work (it answered `no_active_stream`
 *     and left it running), and the status route offers that Stop.
 *
 * @covers MONITOR-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "./topics";
import { registerProvider, removeProvider } from "../providers";
import { ClaudeCodeProvider } from "../providers/claude-code";
import { takeTurnEnd } from "../providers/turn-end-registry";
import { internalAbortRequest } from "../lib/abort-cause";
import { noticeOwedChanges, postBackgroundNotice } from "../lib/background-notice";
import { SidechainTracker } from "../providers/claude/sidechain-tracker";
import { recordedBackgroundSession } from "../providers/claude/background-work.fixture";
import type { AppContext, Topic } from "../types";
import type { ChatGoalLoop } from "../services/goal-continuation";
import { decodeCol } from "../../shared/message-blob";
import { riprendiTurniInterrotti } from "../lib/ripresa-boot";
import { resetTurnEndRegistry } from "../providers/turn-end-registry";
import { userRowMarks } from "../lib/user-row-marks";

const ROOT = testTmpDir("topics-background-config");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const events = recordedBackgroundSession();
const firstResult = events.findIndex((e) => e.type === "result");

async function harness(name: string, autonomyLevel: Topic["autonomyLevel"]) {
  const ctx: AppContext = await createTestAppContext();
  const sessionKey = `topic:${name}`;
  const topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false,
    provider: "claude-code", autonomyLevel,
  } as Topic;
  ctx.saveSingleTopic(topic);
  const provider = registerProvider({ type: "claude-code" } as never) as ClaudeCodeProvider;
  const killed = { n: 0, sigint: 0 };
  // The child of a turn that closed with an agent, a Bash and a Monitor still running.
  const pp: any = {
    sessionKey, alive: true, streamHandler: null, pendingResolve: null, pendingReject: null,
    fullText: "", activeToolCalls: new Set(), subAgentEmit: new Map(), sidechain: new SidechainTracker(),
    pendingInputs: new Map(), lastEventAt: Date.now(), inactivityTimer: null, lifetimeTimer: null, heartbeatInterval: null,
    readline: { close() {} },
    io: { writeStdin: () => {}, signal: (s: string) => { if (s === "SIGINT") killed.sigint++; }, kill: () => { killed.n++; } },
    // As `spawnPersistentProcess` records it: the topic's choices at spawn.
    spawnedWith: { autonomy: autonomyLevel, model: null, effort: null },
  };
  (provider as any).processes.set(sessionKey, pp);
  for (const e of events.slice(0, firstResult + 1)) (provider as any).handleStreamEvent(pp, e);
  pp.wokenBuffer = null; pp.declinedTurn = false;
  expect(provider.backgroundState(sessionKey)).toBe("running");

  let goalLoop: ChatGoalLoop | null = null;
  const router = createTopicsRouter(ctx, undefined, undefined, { exposeGoalLoop: (l) => { goalLoop = l; } });
  const call = async (path: string, method: string, body: unknown) => {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url.toString(), { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return (await router(req, url, url.pathname, method)) as Response;
  };
  // Decoded, not LIKE'd: a notice naming three tasks is over the blob threshold.
  const notices = () => (ctx.db.prepare(`SELECT blocks FROM messages WHERE session_key = ? ORDER BY sort_order`).all(sessionKey) as Array<{ blocks: unknown }>)
    .map((r) => JSON.parse(decodeCol(r.blocks as never) ?? "null")?.[0]).filter((b) => b?.kind === "background-notice");
  return {
    provider, pp, killed, notices, sessionKey, goalLoop: goalLoop!, ctx, router, topicId: topic.id,
    patch: (body: Record<string, unknown>) => call(`/api/topics/${topic.id}`, "PATCH", body),
    command: (command: string, args: Record<string, unknown>) => call("/api/command", "POST", { command, sessionKey, args }),
    stop: () => call("/api/chat/abort", "POST", { sessionKey }),
    status: async () => ((await (await call("/api/topics/streaming", "GET", undefined)).json()) as { sessions: Array<{ sessionKey: string; state: string }> }).sessions,
    /** The CLI's last snapshot is empty and the report's wake has run: the work is over. */
    workOver: () => { (provider as any).handleStreamEvent(pp, { type: "system", subtype: "background_tasks_changed", tasks: [] }); pp.background.wakeQueuedAt = null; },
  };
}

/** The pose of a turn silent for `minutes`: its stream entry is there, its last activity old. */
function silent(h: { ctx: AppContext; sessionKey: string }, minutes: number) {
  if (minutes) h.ctx.activeStreams.get(h.sessionKey)!.lastActivity = new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("a config change against a chat's background work", () => {
  test("lowering the autonomy waits for the work and says so in the chat; once the work is over it respawns", async () => {
    const h = await harness("bg-config-lower", "yolo");
    try {
      expect((await h.patch({ autonomyLevel: "ask" })).status).toBe(200);
      expect(h.killed.n).toBe(0);
      expect(h.notices()).toEqual([expect.objectContaining({ kind: "background-notice", event: "deferred", change: "autonomy", text: expect.stringContaining("autonomy change") })]);
      // The work ends: the next change the child cannot take is applied at once.
      h.workOver();
      expect((await h.patch({ autonomyLevel: "auto-apply" })).status).toBe(200);
      expect(h.killed.n).toBe(1);
      expect(h.notices().length).toBe(1);
    } finally {
      removeProvider("claude-code");
    }
  });

  test("raising the autonomy never kills: out of `ask` it is owed and said, above it it applies live", async () => {
    const h = await harness("bg-config-raise", "ask");
    try {
      await h.patch({ autonomyLevel: "auto-apply" });
      expect(h.killed.n).toBe(0);
      expect(h.notices()).toEqual([expect.objectContaining({ kind: "background-notice", event: "deferred", change: "autonomy", text: expect.stringContaining("autonomy change") })]);
      // auto-apply to yolo: the permission bridge frees the session live.
      await h.patch({ autonomyLevel: "yolo" });
      expect(h.killed.n).toBe(0);
      expect(h.notices().length).toBe(1);
    } finally {
      removeProvider("claude-code");
    }
  });

  test("a model or effort change waits too, in the chat and in the command's answer", async () => {
    const h = await harness("bg-config-model", "yolo");
    try {
      await h.patch({ model: "claude-sonnet-5" });
      expect(h.killed.n).toBe(0);
      const answer = await (await h.command("effort", { level: "high" })).json() as { pending?: string };
      expect(h.killed.n).toBe(0);
      expect(answer.pending).toBe("background-work");
      expect(h.notices().map((n) => n.change)).toEqual(["model", "effort"]);
      // The command's own path for the model, not only the PATCH.
      const viaCommand = await (await h.command("model", { model: "claude-opus-5-5" })).json() as { pending?: string };
      expect(viaCommand.pending).toBe("background-work");
      expect(h.killed.n).toBe(0);
      expect(h.notices().map((n) => n.change)).toEqual(["model", "effort", "model"]);
    } finally {
      removeProvider("claude-code");
    }
  });
});

describe("the Stop of a chat whose turn is closed and whose work still runs", () => {
  test("the status offers it, the Stop stops the work, and nothing is recorded as a turn", async () => {
    const h = await harness("bg-stop", "yolo");
    // The goal waiting for that work must stop waiting, or its check-in revives it.
    const forgotten: string[] = [];
    const stopWaiting = h.goalLoop.stopWaiting;
    h.goalLoop.stopWaiting = (sk) => { forgotten.push(sk); stopWaiting(sk); };
    try {
      expect(await h.status()).toContainEqual(expect.objectContaining({ sessionKey: h.sessionKey, state: "background" }));
      const resp = await h.stop();
      expect(await resp.json()).toEqual({ ok: true, reason: "background_stopped", cleared: false });
      expect(h.killed.sigint).toBe(1);
      expect(forgotten).toEqual([h.sessionKey]);
      // No turn was stopped: a headless driver must not read a cancelled turn here.
      expect(takeTurnEnd(h.sessionKey)).toBeUndefined();
      // The child is on its way out with its work: no Stop left to offer, no second SIGINT.
      expect((await h.status()).some((s) => s.sessionKey === h.sessionKey)).toBe(false);
      expect(await (await h.stop()).json()).toEqual({ ok: false, reason: "no_active_stream", cleared: false });
      expect(h.killed.sigint).toBe(1);
    } finally {
      removeProvider("claude-code");
    }
  });

  test("after a switch to another provider the Stop still reaches the child that has the work", async () => {
    const h = await harness("bg-stop-switched", "yolo");
    registerProvider({ type: "openai", apiKey: "" } as never);
    try {
      expect((await h.patch({ provider: "openai" })).status).toBe(200);
      expect(await (await h.stop()).json()).toEqual({ ok: true, reason: "background_stopped", cleared: false });
      expect(h.killed.sigint).toBe(1);
    } finally {
      try { removeProvider("openai"); } catch { /* already gone */ }
      removeProvider("claude-code");
    }
  });

  test("a machine stop with no turn open leaves live work alone, unless the card is superseded", async () => {
    const h = await harness("bg-stop-machine", "yolo");
    try {
      const machine = async (cause: "stall" | "wall-clock" | "superseded") => {
        const req = internalAbortRequest(h.sessionKey, cause);
        return (await (await h.router(req, new URL(req.url), "/api/chat/abort", "POST"))!.json());
      };
      // The stall judge thought while the turn ended: the work is not its business.
      expect(await machine("stall")).toEqual({ ok: false, reason: "no_active_stream", cleared: false });
      expect(await machine("wall-clock")).toEqual({ ok: false, reason: "no_active_stream", cleared: false });
      expect(h.killed.sigint).toBe(0);
      expect(await machine("superseded")).toEqual({ ok: true, reason: "background_stopped", cleared: false });
      expect(h.killed.sigint).toBe(1);
      expect(h.pp.abortReason).toBe("superseded");
    } finally {
      removeProvider("claude-code");
    }
  });

  test("a stall recycle of an empty turn: the turn is discarded and the notice follows it, not under it", async () => {
    const h = await harness("bg-stall-empty", "yolo");
    ClaudeCodeProvider.observeBackgroundClosed((sk, tasks, why) => {
      postBackgroundNotice(h.ctx, { sessionKey: sk, topicId: h.topicId }, { kind: "background-notice", event: "closed", tasks, why });
    });
    try {
      h.pp.background.lastSignalAt = Date.now() - 2 * 60 * 60_000 - 1_000;
      h.ctx.appendLocalMessage(h.sessionKey, "user", "continua il task");
      const placeholder = h.ctx.createPartialMessage(h.sessionKey, "assistant");
      h.ctx.startStream(h.sessionKey, placeholder.id, new AbortController());
      h.pp.streamHandler = { onDelta() {}, onDone() {}, onError() {}, onAborted() {} };
      const req = internalAbortRequest(h.sessionKey, "stall");
      await h.router(req, new URL(req.url), "/api/chat/abort", "POST");
      for (let i = 0; i < 40 && h.notices().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      const rows = h.ctx.db.prepare(`SELECT id, parent_id FROM messages WHERE session_key = ? ORDER BY sort_order`).all(h.sessionKey) as Array<{ id: string; parent_id: string | null }>;
      expect(rows.some((r) => r.id === placeholder.id)).toBe(false);
      expect(h.notices()).toEqual([expect.objectContaining({ event: "closed", why: "silent", text: expect.stringContaining("closed after two hours") })]);
    } finally {
      ClaudeCodeProvider.observeBackgroundClosed(() => {});
      removeProvider("claude-code");
    }
  });

  // Fresh, and in the pose a silent turn really has when the stall judge or a
  // clock stops it: no activity for over 3 minutes, its stream entry still there.
  for (const [cause, why, silentMin] of [["stall", "silent", 0], ["stall", "silent", 3.5], ["wall-clock", "deadline", 3.5]] as const) {
    test(`a card's empty turn stopped by ${cause}${silentMin ? `, silent for ${silentMin} min,` : ""} with work listed leaves ONE service row: the stop and the work it closed`, async () => {
      const h = await harness(`bg-card-${cause}-${silentMin}`, "yolo");
      // Wired as server.ts wires it.
      ClaudeCodeProvider.observeBackgroundClosed((sk, tasks, closedWhy) => {
        postBackgroundNotice(h.ctx, { sessionKey: sk, topicId: h.topicId }, { kind: "background-notice", event: "closed", tasks, why: closedWhy });
      });
      try {
        h.ctx.db.run(
          "INSERT INTO tasks (id, project_id, text, status, archived, assigned_topic_id, created_at, updated_at) VALUES (?, 'p-bg', 'card', 'in_progress', 0, ?, ?, ?)",
          [`card-${cause}-${silentMin}`, h.topicId, new Date().toISOString(), new Date().toISOString()],
        );
        h.pp.background.lastSignalAt = Date.now() - 2 * 60 * 60_000 - 1_000;
        const envelope = h.ctx.appendLocalMessage(h.sessionKey, "user", "Envelope della card: fai il merge", undefined, userRowMarks({ dispatched: true }));
        const placeholder = h.ctx.createPartialMessage(h.sessionKey, "assistant");
        h.ctx.startStream(h.sessionKey, placeholder.id, new AbortController());
        silent(h, silentMin);
        h.pp.streamHandler = { onDelta() {}, onDone() {}, onError() {}, onAborted() {} };
        const req = internalAbortRequest(h.sessionKey, cause);
        await h.router(req, new URL(req.url), "/api/chat/abort", "POST");
        expect(h.killed.sigint).toBe(1);
        // Past the notice's own wait (500 ms a step): no second row comes after it.
        await new Promise((r) => setTimeout(r, 1_500));
        const rows = (h.ctx.db.prepare(`SELECT id, role, content, blocks FROM messages WHERE session_key = ? ORDER BY sort_order`).all(h.sessionKey) as Array<{ id: string; role: string; content: string; blocks: unknown }>)
          .map((r) => ({ ...r, blocks: JSON.parse(decodeCol(r.blocks as never) ?? "null") }));
        expect(rows.map((r) => r.id)).toEqual([envelope.id, expect.any(String)]);
        expect(rows[1]).toEqual(expect.objectContaining({ role: "assistant", content: "" }));
        expect(rows[1].blocks).toEqual([
          expect.objectContaining({ kind: "machine-stop", cause }),
          expect.objectContaining({ kind: "background-notice", event: "closed", why, tasks: expect.arrayContaining(["tick counter loop"]) }),
        ]);
      } finally {
        ClaudeCodeProvider.observeBackgroundClosed(() => {});
        removeProvider("claude-code");
      }
    });
  }

  test("with the work over there is nothing to stop, as before", async () => {
    const h = await harness("bg-stop-over", "yolo");
    try {
      h.workOver();
      expect(await (await h.stop()).json()).toEqual({ ok: false, reason: "no_active_stream", cleared: false });
      expect(h.killed.sigint).toBe(0);
    } finally {
      removeProvider("claude-code");
    }
  });
});

/** The launch of a background agent, as the recorded CLI printed it: its snapshot and its start. */
const agentSnap = events.find((e: any) => e.subtype === "background_tasks_changed" && e.tasks?.length === 1) as any;
const agentStarted = events.find((e: any) => e.subtype === "task_started" && e.task_id === agentSnap.tasks[0].task_id) as any;

describe("second review of 25/09: every deferred change and every close is said, with its own reason", () => {
  for (const [label, body, change] of [
    ["R1: lowering the autonomy while a turn runs", { autonomyLevel: "ask" }, "autonomy"],
    ["R6: a model change while a turn runs", { model: "claude-sonnet-5" }, "model"],
  ] as const) {
    test(`${label}, when that turn then starts background work, is said in the chat and kills nothing`, async () => {
      const h = await harness(`bg-owed-${change}`, "yolo");
      // Wired as server.ts wires it.
      ClaudeCodeProvider.observeConfigOwed((sk, changes) => {
        noticeOwedChanges(h.ctx, { id: h.topicId, sessionKey: sk }, "deferred-background", Object.fromEntries(changes.map((c) => [c, true])));
      });
      try {
        h.workOver();
        h.pp.background.tasks.clear();
        h.pp.streamHandler = { onDelta() {}, onDone() {}, onError() {}, onAborted() {} };
        expect((await h.patch(body)).status).toBe(200);
        // Only a turn so far: nothing to say yet.
        expect(h.notices()).toEqual([]);
        // The same turn launches a background agent.
        (h.provider as any).handleStreamEvent(h.pp, agentSnap);
        (h.provider as any).handleStreamEvent(h.pp, agentStarted);
        expect(h.notices()).toEqual([expect.objectContaining({ event: "deferred", change, text: expect.stringContaining("Stop ends that work now") })]);
        h.pp.streamHandler = null; h.pp.wokenBuffer = null; h.pp.declinedTurn = false;
        expect((h.provider as any).getOrCreateProcess(h.sessionKey)).toBe(h.pp);
        expect(h.killed.n).toBe(0);
        // Said once, not at every later snapshot.
        (h.provider as any).handleStreamEvent(h.pp, agentSnap);
        expect(h.notices().length).toBe(1);
      } finally { ClaudeCodeProvider.observeConfigOwed(() => {}); removeProvider("claude-code"); }
    });
  }

  test("V6: a change taken back while the work runs is owed by nobody: the running child already has it", async () => {
    const h = await harness("bg-owed-back", "yolo");
    ClaudeCodeProvider.observeConfigOwed((sk, changes) => {
      noticeOwedChanges(h.ctx, { id: h.topicId, sessionKey: sk }, "deferred-background", Object.fromEntries(changes.map((c) => [c, true])));
    });
    try {
      h.workOver();
      h.pp.background.tasks.clear();
      h.pp.streamHandler = { onDelta() {}, onDone() {}, onError() {}, onAborted() {} };
      // Lowered mid-turn, and the turn starts background work: said once.
      await h.patch({ autonomyLevel: "ask" });
      (h.provider as any).handleStreamEvent(h.pp, agentSnap);
      (h.provider as any).handleStreamEvent(h.pp, agentStarted);
      expect(h.notices().map((n) => n.change)).toEqual(["autonomy"]);
      // Back to yolo while the work runs: the child spawned yolo, nothing waits.
      const back = await (await h.command("model", { model: "claude-opus-5-5" })).json() as { pending?: string };
      expect(back.pending).toBe("background-work");
      await h.patch({ autonomyLevel: "yolo" });
      expect(h.notices().map((n) => n.change)).toEqual(["autonomy", "model"]);
      // Mid-turn and back again before any work: the autonomy stays owed to
      // nobody, the effort the child really lacks stays owed.
      h.pp.owedChanges = new Set();
      h.workOver(); h.pp.background.tasks.clear();
      await h.patch({ autonomyLevel: "ask", effort: "high" });
      expect([...h.pp.owedChanges].sort()).toEqual(["autonomy", "effort"]);
      await h.patch({ autonomyLevel: "yolo" });
      expect([...h.pp.owedChanges]).toEqual(["effort"]);
      expect(h.killed.n).toBe(0);
    } finally { ClaudeCodeProvider.observeConfigOwed(() => {}); removeProvider("claude-code"); }
  });

  test("R2: a delegation's deadline on a working turn says so, not «a stuck turn»", async () => {
    const h = await harness("bg-deadline", "yolo");
    ClaudeCodeProvider.observeBackgroundClosed((sk, tasks, why) => {
      postBackgroundNotice(h.ctx, { sessionKey: sk, topicId: h.topicId }, { kind: "background-notice", event: "closed", tasks, why });
    });
    try {
      h.ctx.appendLocalMessage(h.sessionKey, "user", "fai la card");
      const placeholder = h.ctx.createPartialMessage(h.sessionKey, "assistant");
      h.ctx.startStream(h.sessionKey, placeholder.id, new AbortController());
      h.pp.streamHandler = { onDelta() {}, onDone() {}, onError() {}, onAborted() {} };
      const req = internalAbortRequest(h.sessionKey, "wall-clock");
      await h.router(req, new URL(req.url), "/api/chat/abort", "POST");
      for (let i = 0; i < 40 && h.notices().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(h.killed.sigint).toBe(1);
      expect(h.notices()).toEqual([expect.objectContaining({ event: "closed", why: "deadline", text: expect.stringContaining("maximum duration") })]);
    } finally { ClaudeCodeProvider.observeBackgroundClosed(() => {}); removeProvider("claude-code"); }
  });

  test("R5: a superseded card with no turn open stops its live work and leaves the row that says so", async () => {
    const h = await harness("bg-superseded-row", "yolo");
    ClaudeCodeProvider.observeBackgroundClosed((sk, tasks, why) => {
      postBackgroundNotice(h.ctx, { sessionKey: sk, topicId: h.topicId }, { kind: "background-notice", event: "closed", tasks, why });
    });
    try {
      const req = internalAbortRequest(h.sessionKey, "superseded");
      expect(await (await h.router(req, new URL(req.url), "/api/chat/abort", "POST"))!.json()).toEqual({ ok: true, reason: "background_stopped", cleared: false });
      expect(h.killed.sigint).toBe(1);
      expect(h.notices()).toEqual([expect.objectContaining({ event: "closed", why: "superseded", tasks: expect.arrayContaining(["tick counter loop"]) })]);
    } finally { ClaudeCodeProvider.observeBackgroundClosed(() => {}); removeProvider("claude-code"); }
  });

  for (const silentMin of [0, 3.5]) test(`the stall judge recycling a person's message with work listed${silentMin ? `, silent for ${silentMin} min` : ""}: the resume sweep still resends it, as on main`, async () => {
    resetTurnEndRegistry();
    const h = await harness(`bg-person-recycle-${silentMin}`, "yolo");
    ClaudeCodeProvider.observeBackgroundClosed((sk, tasks, why) => {
      postBackgroundNotice(h.ctx, { sessionKey: sk, topicId: h.topicId }, { kind: "background-notice", event: "closed", tasks, why });
    });
    try {
      h.pp.background.lastSignalAt = Date.now() - 2 * 60 * 60_000 - 1_000;
      const user = h.ctx.appendLocalMessage(h.sessionKey, "user", "continua il task");
      const placeholder = h.ctx.createPartialMessage(h.sessionKey, "assistant");
      h.ctx.startStream(h.sessionKey, placeholder.id, new AbortController());
      silent(h, silentMin);
      h.pp.streamHandler = { onDelta() {}, onDone() {}, onError() {}, onAborted() {} };
      const req = internalAbortRequest(h.sessionKey, "stall");
      await h.router(req, new URL(req.url), "/api/chat/abort", "POST");
      for (let i = 0; i < 40 && h.notices().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(h.notices().length).toBe(1);
      // The empty turn went, and the notice follows the person's message, not a placeholder.
      expect(h.ctx.getMessageById(placeholder.id)).toBeFalsy();
      // The person's message is older than the sweep's grace.
      h.ctx.db.run("UPDATE messages SET timestamp = ? WHERE id = ?", [new Date(Date.now() - 5 * 60_000).toISOString(), user.id]);
      const resent: Array<{ sessionKey?: string }> = [];
      const log = console.log, warn = console.warn;
      console.log = () => {}; console.warn = () => {};
      try {
        await riprendiTurniInterrotti({ db: h.ctx.db as never, getTopicBySessionKey: (sk) => h.ctx.getTopicBySessionKey(sk), isStreaming: (sk) => h.ctx.isStreaming(sk) },
          async (r) => { resent.push(await r.json()); return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 }); });
      } finally { console.log = log; console.warn = warn; }
      expect(resent.filter((c) => c.sessionKey === h.sessionKey).length).toBe(1);
    } finally { ClaudeCodeProvider.observeBackgroundClosed(() => {}); removeProvider("claude-code"); }
  });
});
