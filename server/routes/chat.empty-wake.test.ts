/**
 * A woken turn that says nothing (a Monitor tick the model answers with
 * silence) is discarded, and leaves no trace on the counters either
 * (ATTN-05, T17, defect D7).
 *
 * Today the row is discarded, no `message:new` goes out, and
 * `finalizeTurnActivity` still bumps the unread counter: the badge grows with
 * no message behind it.
 * @covers ATTN-05
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { configureAttentionStore, getAttention, setBackgroundTasks, resetAttentionStore } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { Topic } from "../types";

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

const ROOT = testTmpDir("chat-empty-wake-attn");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

describe("an empty woken turn", () => {
  test("is discarded, leaves the unread as it was, and makes no epoch", async () => {
    const ctx = await createTestAppContext();
    const frames: Array<Record<string, unknown>> = [];
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
    (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };
    const pushes: unknown[] = [];
    configureAttentionStore({ sendPush: (p) => { pushes.push(p); } });
    let captured: StreamHandler | undefined;
    const provider = {
      name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
      unregisterStreamHandler: () => {}, sendChat: () => new Promise<{ runId?: string }>(() => {}),
      defaultModel: () => "fake-model", abort: async () => {}, start: () => {}, stop: () => {}, complete: async () => ({ content: "" }),
      backgroundState: () => "running", hasBackgroundWork: () => true,
      adoptWokenTurn: (_sk: string, h: StreamHandler) => { captured = h; return true; },
    } as unknown as AIProvider;
    let unreadBumps = 0;
    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
      getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {},
      updateUnreadCount: () => { unreadBumps++; }, browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: `${ROOT}/ws`,
    } as never);
    const sk = "topic:empty-wake";
    ctx.saveSingleTopic({ id: "t-empty-wake", name: "wake", slug: "wake", parentId: null, links: [], sessionKey: sk, color: "#5865f2",
      icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, provider: "claude-code" } as Topic);
    // The chat waits on a Monitor: background, nothing lit.
    const subject = topicSubject("t-empty-wake");
    setBackgroundTasks(subject, { bmon01: { kind: "monitor", label: "tail -f build.log", startedAt: new Date().toISOString() } });
    const before = getAttention(subject);
    expect(before.state).toBe("background");

    const url = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(new Request(url.toString(), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: sk, messages: [], mode: "woken" }) }), url, "/api/chat", "POST");
    resp?.body?.cancel().catch(() => {});
    captured!.onDone({ result: "", turnEnd: { end: "end_turn" } });
    await Bun.sleep(80);

    const end = frames.find((f) => f.type === "stream:end");
    expect(end?.discardedMessageId).toBeTruthy();
    expect(unreadBumps).toBe(0);
    const after = getAttention(subject);
    expect(after.epoch).toBe(before.epoch);
    expect(after.lit).toBe(false);
    expect(pushes).toHaveLength(0);
  });
});
