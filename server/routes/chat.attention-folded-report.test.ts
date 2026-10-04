/**
 * A background task's report that arrives INSIDE a turn of ours (review 2 of
 * notifications-redesign, B1). The CLI either starts the report's wake right
 * after that turn's `result` or folded the report into the turn and opens
 * none ("a report the CLI folded into a running turn opens no new one",
 * `wakeAboutToStart` in `claude-code.ts`). The turn ends `background` on the
 * queued wake; when no wake opens, the wake leaves by the clock and the chat
 * is `finished(done)` with one announce. Before, nothing re-read the map: the
 * chat stayed `background` for good, and the idle reaper turned the phantom
 * wake into a red "the process ended with 1 task in flight" with a push.
 *
 * Wired like server.ts (`observeBackgroundChanged`, `observeProcessEnded`),
 * with the real chat route and the real `ClaudeCodeProvider`.
 * @covers ATTN-02, ATTN-05, ATTN-15
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { registerProvider, removeProvider } from "../providers";
import { ClaudeCodeProvider } from "../providers/claude-code";
import { SidechainTracker } from "../providers/claude/sidechain-tracker";
import { WAKE_AFTER_RESULT_MS } from "../providers/claude/background-work";
import { sessionAttentionBackground } from "../providers/background-probes";
import { configureAttentionStore, getAttention, processEnded, resetAttentionStore } from "../attention/store";
import { chatBackgroundChanged, chatSubjectOfSession, configureAttentionWire } from "../attention/wire";
import { topicSubject } from "../../shared/attention";
import type { StreamHandler } from "../providers/types";
import type { Topic } from "../types";

const ROOT = testTmpDir("chat-attention-folded-report");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => {
  resetAttentionStore();
  removeProvider("claude-code");
  ClaudeCodeProvider.observeWokenTurns(() => false);
  ClaudeCodeProvider.observeBackgroundChanged(() => {});
  ClaudeCodeProvider.observeProcessEnded(() => {});
  configureAttentionWire({ subjectForSessionKey: () => null, cardForSession: () => null });
  cleanupTestDataDir(ROOT);
});

const SID = "sess-folded";
let n = 0;
const u = () => `u-${++n}`;
const se = (event: Record<string, unknown>) => ({ type: "stream_event", event, session_id: SID, parent_tool_use_id: null, uuid: u() });
const init = () => ({ type: "system", subtype: "init", cwd: "/tmp", session_id: SID, model: "claude-sonnet-5", uuid: u() });
function text(msgId: string, t: string) {
  return [
    se({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
    { type: "assistant", message: { id: msgId, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: t }] }, parent_tool_use_id: null, session_id: SID, uuid: u() },
    se({ type: "content_block_stop", index: 0 }),
    se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 3 } }),
    se({ type: "message_stop" }),
  ];
}
const result = (t: string) => ({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: t, session_id: SID, num_turns: 1, usage: { input_tokens: 1, output_tokens: 3 }, uuid: u() });
const listed = (tasks: Array<{ id: string; d: string }>) => ({ type: "system", subtype: "background_tasks_changed", tasks: tasks.map((t) => ({ task_id: t.id, task_type: "local_bash", description: t.d })), session_id: SID, uuid: u() });

describe("a background report folded into a turn of ours", () => {
  test("the turn ends background on the wake, then finished(done) once the wake cannot come; the reaper lights nothing", async () => {
    const ctx = await createTestAppContext();
    (ctx as unknown as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
    (ctx as unknown as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
    const pushes: Array<{ title: string; body: string }> = [];
    configureAttentionStore({ sendPush: (p) => { pushes.push(p as { title: string; body: string }); } });

    const sessionKey = "topic:folded";
    const now = new Date().toISOString();
    const topic = { id: "t-folded", name: "folded", slug: "folded", parentId: null, links: [], sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: now, updatedAt: now, archived: false, provider: "claude-code" } as Topic;
    ctx.saveSingleTopic(topic);
    const subject = topicSubject(topic.id);
    configureAttentionWire({ subjectForSessionKey: (sk) => (sk === sessionKey ? subject : null), cardForSession: () => null });
    // server.ts, the same two observers.
    ClaudeCodeProvider.observeBackgroundChanged((sk) => { const work = sessionAttentionBackground(sk); if (work) chatBackgroundChanged(sk, work.tasks); });
    ClaudeCodeProvider.observeProcessEnded((sk, cause, byPerson) => { const s = chatSubjectOfSession(sk); if (s) processEnded(s, { cause, byPerson, turnClosedByRoute: true }); });
    ClaudeCodeProvider.observeWokenTurns(() => false);

    removeProvider("claude-code");
    const provider = registerProvider({ type: "claude-code" } as never) as ClaudeCodeProvider;
    const pp: Record<string, unknown> & { streamHandler: StreamHandler | null } = {
      sessionKey, alive: true, streamHandler: null, pendingResolve: null, pendingReject: null,
      fullText: "", activeToolCalls: new Set(), subAgentEmit: new Map(), sidechain: new SidechainTracker(),
      pendingInputs: new Map(), lastEventAt: Date.now(), inactivityTimer: null, lifetimeTimer: null, heartbeatInterval: null,
      readline: { close() {} }, io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
      spawnedWith: { autonomy: null, model: null, effort: null },
    };
    const internals = provider as unknown as { processes: Map<string, unknown>; sendChat: unknown; handleStreamEvent: (p: unknown, e: unknown) => void; killProcess: (p: unknown, c: string) => void };
    internals.processes.set(sessionKey, pp);
    internals.sendChat = (_sk: string, _msg: string, handler: StreamHandler) => new Promise((resolve, reject) => {
      pp.streamHandler = handler; pp.preRegistered = null; pp.pendingResolve = resolve; pp.pendingReject = reject;
    });
    const router = createChatRouter(ctx, {
      resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
      getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {},
      updateUnreadCount: () => {}, browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: `${ROOT}/ws`,
    } as never);
    const post = async (content: string) => {
      pp.streamHandler = null;
      const url = new URL("http://topics.test/api/chat");
      const resp = await router(new Request(url.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }) }), url, "/api/chat", "POST");
      resp?.body?.cancel().catch(() => {});
      for (let i = 0; i < 100 && !pp.streamHandler; i++) await Bun.sleep(10);
      expect(pp.streamHandler).not.toBeNull();
    };
    const feed = (evs: unknown[]) => { for (const e of evs) internals.handleStreamEvent(pp, e); };

    // Turn 1 launches a background build and ends on it.
    await post("run the build in background");
    feed([init(), listed([{ id: "bbuild1", d: "Run the build" }]),
      { type: "system", subtype: "task_started", task_id: "bbuild1", tool_use_id: "toolu_b1", description: "Run the build", is_backgrounded: true, task_type: "local_bash", session_id: SID, uuid: u() },
      ...text("msg_1", "Build launched, I will tell you."), result("Build launched, I will tell you.")]);
    await Bun.sleep(150);
    expect(getAttention(subject).state).toBe("background");

    // Turn 2: the person asks something else; the build reports INSIDE it, and no init follows.
    await post("meanwhile, what is 2+2?");
    feed([init(), listed([]),
      { type: "system", subtype: "task_updated", task_id: "bbuild1", patch: { status: "completed" }, session_id: SID, uuid: u() },
      { type: "system", subtype: "task_notification", task_id: "bbuild1", tool_use_id: "toolu_b1", status: "completed", summary: "Background command \"Run the build\" completed (exit code 0)", session_id: SID, uuid: u() },
      ...text("msg_2", "4. Also, the build finished: all green."), result("4. Also, the build finished: all green.")]);
    await Bun.sleep(150);
    // Its wake may still open: the turn waits on it, nothing announced yet.
    const atEnd = getAttention(subject);
    expect(atEnd.state).toBe("background");
    expect(atEnd.background.map((t) => t.kind)).toEqual(["wake"]);
    expect(pushes).toHaveLength(0);

    // No wake opened: once it cannot come, the turn is the answer.
    await Bun.sleep(WAKE_AFTER_RESULT_MS + 200);
    const done = getAttention(subject);
    expect(sessionAttentionBackground(sessionKey)?.count).toBe(0);
    expect({ state: done.state, outcome: done.outcome, background: done.background }).toEqual({ state: "finished", outcome: "done", background: [] });
    expect(pushes).toHaveLength(1);

    // The idle reaper closes the CLI later: housekeeping, nothing was in flight.
    internals.killProcess(pp, "idle");
    await Bun.sleep(20);
    const reaped = getAttention(subject);
    expect({ state: reaped.state, outcome: reaped.outcome, epoch: reaped.epoch }).toEqual({ state: "finished", outcome: "done", epoch: done.epoch });
    expect(pushes).toHaveLength(1);
  });
});
