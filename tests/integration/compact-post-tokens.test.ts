/**
 * A MANUAL /compact LEAVES A DIVIDER WITH BOTH NUMBERS.
 *
 * The post-compaction size is the prompt of the FIRST model call after the
 * boundary. An auto-compaction happens mid-turn, so the same turn makes that
 * call and fills it. A manual `/compact` is a turn of its own that ends right
 * at the boundary: no call follows in it, so the divider kept «~445k token
 * before» for good (10 manual markers of 10 on the prod DB, 24/09, all without
 * a post count). The next turn's first measurement is that number.
 * @covers CHAT-COMPACT-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { Topic } from "../../server/types";

const TEST_DATA = testTmpDir("compact-post-tokens");
beforeAll(() => setupTestDataDir(TEST_DATA));
registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

describe("manual /compact: the next turn fills the post-compaction size", () => {
  test("the marker gets post_tokens from the first call of the following turn", async () => {
    const sessionKey = "topic:compact-post";
    const ctx = await createTestAppContext();
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
    (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
    const topic = {
      id: "t-compact-post", name: "compact", slug: "compact", parentId: null, links: [], sessionKey,
      color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "openai",
    } as Topic;
    ctx.saveSingleTopic(topic);

    const handlers: StreamHandler[] = [];
    const provider = {
      name: "fake-stream", capabilities: new Set(["streaming"]), contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handlers.push(h); },
      unregisterStreamHandler: () => {},
      sendChat: () => new Promise<{ runId?: string }>(() => {}),
      defaultModel: () => "fake-model", abort: async () => {}, start: () => {}, stop: () => {},
      complete: async () => ({ content: "" }),
    } as unknown as AIProvider;
    const router = createChatRouter(ctx, {
      resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
      resolveProjectRef: () => null, getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {},
      watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: testTmpDir("compact-post-ws"),
    } as never);
    const send = async (content: string) => {
      const url = new URL("http://topics.test/api/chat");
      const resp = await router(new Request(url.toString(), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
      }), url, "/api/chat", "POST");
      expect(resp?.status).toBe(200);
      resp?.body?.cancel().catch(() => {});
    };
    const settle = () => new Promise((r) => setTimeout(r, 120));
    const marker = () => ctx.db.query(`SELECT trigger, pre_tokens, post_tokens FROM compaction_markers WHERE session_key = ?`).get(sessionKey) as
      { trigger: string; pre_tokens: number | null; post_tokens: number | null } | null;

    // The /compact turn: the boundary arrives, then the turn ends. No call.
    await send("/compact");
    const h1 = handlers[handlers.length - 1]!;
    h1.onCompaction?.({ trigger: "manual", preTokens: 445_222 } as never);
    h1.onDone();
    await settle();
    expect(marker()).toEqual({ trigger: "manual", pre_tokens: 445_222, post_tokens: null });

    // The next turn: its first call's prompt IS the compacted context.
    await send("continua");
    const h2 = handlers[handlers.length - 1]!;
    h2.onContextSize?.(51_490, "fake-model", 200_000);
    h2.onContextSize?.(58_000, "fake-model", 200_000);
    h2.onTextDelta("ok", "ok");
    h2.onDone();
    await settle();
    expect(marker()?.post_tokens).toBe(51_490);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
