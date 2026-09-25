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
import { SidechainTracker } from "../providers/claude/sidechain-tracker";
import { recordedBackgroundSession } from "../providers/claude/background-work.fixture";
import type { AppContext, Topic } from "../types";
import type { ChatGoalLoop } from "../services/goal-continuation";

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
  const notices = () => (ctx.db.prepare(
    `SELECT content, blocks FROM messages WHERE session_key = ? AND blocks LIKE '%background-notice%' ORDER BY sort_order`,
  ).all(sessionKey) as Array<{ content: string; blocks: string }>).map((r) => JSON.parse(r.blocks)[0]);
  return {
    provider, pp, killed, notices, sessionKey, goalLoop: goalLoop!,
    patch: (body: Record<string, unknown>) => call(`/api/topics/${topic.id}`, "PATCH", body),
    command: (command: string, args: Record<string, unknown>) => call("/api/command", "POST", { command, sessionKey, args }),
    stop: () => call("/api/chat/abort", "POST", { sessionKey }),
    status: async () => ((await (await call("/api/topics/streaming", "GET", undefined)).json()) as { sessions: Array<{ sessionKey: string; state: string }> }).sessions,
    /** The CLI's last snapshot is empty and the report's wake has run: the work is over. */
    workOver: () => { (provider as any).handleStreamEvent(pp, { type: "system", subtype: "background_tasks_changed", tasks: [] }); pp.background.wakeQueuedAt = null; },
  };
}

describe("a config change against a chat's background work", () => {
  test("lowering the autonomy waits for the work and says so in the chat; once the work is over it respawns", async () => {
    const h = await harness("bg-config-lower", "yolo");
    try {
      expect((await h.patch({ autonomyLevel: "ask" })).status).toBe(200);
      expect(h.killed.n).toBe(0);
      expect(h.notices()).toEqual([{ kind: "background-notice", event: "deferred", change: "autonomy" }]);
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
      expect(h.notices()).toEqual([{ kind: "background-notice", event: "deferred", change: "autonomy" }]);
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
