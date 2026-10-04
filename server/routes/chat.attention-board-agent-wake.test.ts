/**
 * The turns of a board agent's topic that the dispatcher did not send (review
 * 2 of notifications-redesign, B2). An agent's topic is born archived and its
 * card is the subject; the CLI's own wake on a background report is adopted
 * through the chat route with `{ mode: "woken" }` and no `dispatched`, as
 * `runHeadlessWoken` (server.ts) does it. That turn reset the store's
 * `dispatched`, and the topic's `archived` was never told to the store at
 * runtime: the woken turn lit the agent's topic and raised the server's
 * number (the next push carried `badge: 2`).
 *
 * Rule 1 (archived) and rule 2 (board agent) are pinned one at a time: an
 * open topic owned by a running card, and an archived topic no card owns.
 * @covers ATTN-01, ATTN-08, CHROME-COUNT-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { registerProvider, removeProvider } from "../providers";
import { ClaudeCodeProvider } from "../providers/claude-code";
import { SidechainTracker } from "../providers/claude/sidechain-tracker";
import { getDatabase } from "../db";
import { configureAttentionStore, getAttention, litSubjectCount, resetAttentionStore, turnEnded, turnStarted } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import type { StreamHandler } from "../providers/types";
import type { Topic } from "../types";

const ROOT = testTmpDir("chat-attention-board-agent-wake");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => {
  resetAttentionStore();
  removeProvider("claude-code");
  ClaudeCodeProvider.observeWokenTurns(() => false);
  cleanupTestDataDir(ROOT);
});

let n = 0;
const u = () => `u-${++n}`;

function lines(sid: string) {
  const se = (event: Record<string, unknown>) => ({ type: "stream_event", event, session_id: sid, parent_tool_use_id: null, uuid: u() });
  return {
    init: () => ({ type: "system", subtype: "init", cwd: "/tmp", session_id: sid, model: "claude-sonnet-5", uuid: u() }),
    text: (msgId: string, t: string) => [
      se({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
      { type: "assistant", message: { id: msgId, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: t }] }, parent_tool_use_id: null, session_id: sid, uuid: u() },
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 3 } }),
      se({ type: "message_stop" }),
    ],
    result: (t: string) => ({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: t, session_id: sid, num_turns: 1, usage: { input_tokens: 1, output_tokens: 3 }, uuid: u() }),
    listed: (tasks: Array<{ id: string; d: string }>) => ({ type: "system", subtype: "background_tasks_changed", tasks: tasks.map((t) => ({ task_id: t.id, task_type: "local_bash", description: t.d })), session_id: sid, uuid: u() }),
    started: (id: string, d: string) => ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `toolu_${id}`, description: d, is_backgrounded: true, task_type: "local_bash", session_id: sid, uuid: u() }),
    reported: (id: string, d: string) => ({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: `toolu_${id}`, status: "completed", summary: `Background command "${d}" completed (exit code 0)`, session_id: sid, uuid: u() }),
  };
}

interface Rig {
  subject: string;
  pushes: Array<{ badge?: number }>;
  /** A turn sent through the route, fed with these lines. */
  send: (body: Record<string, unknown>, evs: unknown[]) => Promise<void>;
  /** Lines the CLI prints with no turn of ours open: a woken turn is adopted through the route. */
  feedUnattended: (evs: unknown[]) => Promise<void>;
  saveTopic: (t: { id: string; name: string; sessionKey: string; archived?: boolean }) => void;
}

async function rig(name: string, opts: { archived: boolean; ownedByRunningCard: boolean }): Promise<Rig> {
  resetAttentionStore();
  const ctx = await createTestAppContext();
  (ctx as unknown as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as unknown as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  const pushes: Array<{ badge?: number }> = [];
  configureAttentionStore({ sendPush: (p) => { pushes.push(p as { badge?: number }); } });
  const sessionKey = `topic:${name}`;
  const saveTopic = (t: { id: string; name: string; sessionKey: string; archived?: boolean }): Topic => {
    const now = new Date().toISOString();
    const full = { ...t, slug: t.id, parentId: null, links: [], color: "#5865f2", icon: "MessageSquare",
      createdAt: now, updatedAt: now, archived: t.archived ?? false, provider: "claude-code" } as Topic;
    ctx.saveSingleTopic(full);
    return full;
  };
  const topic = saveTopic({ id: `t-${name}`, name, sessionKey, archived: opts.archived });
  if (opts.ownedByRunningCard) {
    getDatabase().run(
      "INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at) VALUES (?, 'p1', 'card', 'in_progress', ?, datetime('now'), datetime('now'))",
      [`task-${name}`, topic.id],
    );
  }

  removeProvider("claude-code");
  const provider = registerProvider({ type: "claude-code" } as never) as ClaudeCodeProvider;
  const pp: Record<string, unknown> & { streamHandler: StreamHandler | null } = {
    sessionKey, alive: true, streamHandler: null, pendingResolve: null, pendingReject: null,
    fullText: "", activeToolCalls: new Set(), subAgentEmit: new Map(), sidechain: new SidechainTracker(),
    pendingInputs: new Map(), lastEventAt: Date.now(), inactivityTimer: null, lifetimeTimer: null, heartbeatInterval: null,
    readline: { close() {} }, io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    spawnedWith: { autonomy: null, model: null, effort: null },
  };
  const internals = provider as unknown as { processes: Map<string, unknown>; sendChat: unknown; handleStreamEvent: (p: unknown, e: unknown) => void };
  internals.processes.set(sessionKey, pp);
  internals.sendChat = (_sk: string, _msg: string, handler: StreamHandler) => new Promise((resolve, reject) => {
    pp.streamHandler = handler; pp.preRegistered = null; pp.pendingResolve = resolve; pp.pendingReject = reject;
  });
  const router = createChatRouter(ctx, {
    resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
    getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {},
    updateUnreadCount: () => {}, browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: `${ROOT}/ws-${name}`,
  } as never);
  const post = async (body: Record<string, unknown>) => {
    const url = new URL("http://topics.test/api/chat");
    const resp = await router(new Request(url.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey, ...body }) }), url, "/api/chat", "POST");
    resp?.body?.cancel().catch(() => {});
  };
  const inflight: Promise<unknown>[] = [];
  // server.ts `runHeadlessWoken`: the same body, no `dispatched`.
  ClaudeCodeProvider.observeWokenTurns((sk) => {
    if (sk !== sessionKey) return false;
    inflight.push(post({ messages: [], mode: "woken", provider: "claude-code" }));
    return true;
  });
  const settle = async () => {
    for (let i = 0; i < 20; i++) { await Promise.all(inflight.splice(0)); await Bun.sleep(15); if (!inflight.length) return; }
  };
  return {
    subject: topicSubject(topic.id),
    pushes,
    saveTopic: (t) => { saveTopic(t); },
    send: async (body, evs) => {
      pp.streamHandler = null;
      await post(body);
      for (let i = 0; i < 100 && !pp.streamHandler; i++) await Bun.sleep(10);
      expect(pp.streamHandler).not.toBeNull();
      for (const e of evs) internals.handleStreamEvent(pp, e);
      await Bun.sleep(150);
    },
    feedUnattended: async (evs) => {
      for (const e of evs) { internals.handleStreamEvent(pp, e); await settle(); }
      await Bun.sleep(150);
      await settle();
    },
  };
}

/** The dispatcher's turn launches a background Bash; its report wakes the CLI, which answers on its own. */
async function dispatchedThenWoken(r: Rig, sid: string): Promise<void> {
  const l = lines(sid);
  await r.send({ messages: [{ role: "user", content: "do the card" }], dispatched: true },
    [l.init(), l.listed([{ id: "bt1", d: "run tests" }]), l.started("bt1", "run tests"), ...l.text(`${sid}-1`, "Tests launched."), l.result("Tests launched.")]);
  await r.feedUnattended([l.listed([]), l.reported("bt1", "run tests"), l.init(), ...l.text(`${sid}-2`, "Tests are green."), l.result("Tests are green.")]);
}

describe("a board agent's topic stays idle through the turns the dispatcher did not send", () => {
  test("its CLI's woken turn: the archived topic of a running card stays idle, and the next push counts 1", async () => {
    const r = await rig("agent", { archived: true, ownedByRunningCard: true });
    await dispatchedThenWoken(r, "sess-agent");
    const s = getAttention(r.subject);
    expect({ state: s.state, lit: s.lit }).toEqual({ state: "idle", lit: false });
    expect(litSubjectCount()).toBe(0);
    expect(r.pushes).toHaveLength(0);
    // An open chat finishes now: its push carries the server's count.
    r.saveTopic({ id: "t-open", name: "open chat", sessionKey: "topic:open" });
    turnStarted(topicSubject("t-open"));
    turnEnded(topicSubject("t-open"), { turnId: "m-open", outcome: "done" });
    expect(r.pushes.map((p) => p.badge)).toEqual([1]);
  });

  test("rule 2 alone: an OPEN topic owned by a running card stays idle on its woken turn", async () => {
    const r = await rig("owned-open", { archived: false, ownedByRunningCard: true });
    await dispatchedThenWoken(r, "sess-owned-open");
    expect(getAttention(r.subject).state).toBe("idle");
    expect(r.pushes).toHaveLength(0);
  });

  test("rule 1 alone: an archived topic no card owns stays idle on a turn the person sent", async () => {
    const r = await rig("archived-chat", { archived: true, ownedByRunningCard: false });
    const l = lines("sess-archived-chat");
    await r.send({ messages: [{ role: "user", content: "one more thing" }] }, [l.init(), ...l.text("ac-1", "Done."), l.result("Done.")]);
    expect(getAttention(r.subject).state).toBe("idle");
    expect(r.pushes).toHaveLength(0);
  });
});
