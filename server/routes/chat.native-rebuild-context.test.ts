/**
 * A native session rebuilt from the database gets its context block again.
 * @covers CTX-DEDUP-02
 *
 * The native runtime keeps the conversation in memory and evicts a session
 * idle for 15 minutes; the next turn rebuilds the history from the stored
 * rows, which hold the person's words and not the inline `<context>` the
 * route prepended. The dedup scope did not move (a native chat never renews
 * its CLI session id), so the route kept the block out as "already sent":
 * from then on the model worked without the project README, the global
 * rules, the skills and the memory index.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { Topic } from "../types";

const ROOT = testTmpDir("chat-native-rebuild-context");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const MARKER = "SYSTEM-PROMPT-MARKER-7f3a";

async function harness() {
  const ctx = await createTestAppContext();
  const sent: string[] = [];
  let epoch = 1;
  let handler: StreamHandler | undefined;
  const provider = {
    name: "fake-native",
    capabilities: new Set(["streaming"]),
    contextStrategy: "inline-system",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handler = h; },
    unregisterStreamHandler: () => {},
    contextEpoch: () => epoch,
    sendChat: async (_sk: string, message: string) => {
      sent.push(message);
      const h = handler;
      setTimeout(() => { h?.onTextDelta("ok", "ok"); h?.onDone({ result: "ok" } as never); }, 5);
      return { runId: `run-${sent.length}` };
    },
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;

  const chat = createChatRouter(ctx, {
    resolveProvider: () => provider,
    detectLocalhostAutoNav: () => {},
    bindTopicToProject: () => {},
    resolveProjectRef: () => null,
    getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [],
    autoBindProject: () => {},
    watchSessionForSubagents: () => {},
    updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(),
    WORKSPACE_DIR: testTmpDir("chat-native-rebuild-context-ws"),
  } as never);

  const sessionKey = "topic:native-rebuild";
  const now = new Date().toISOString();
  ctx.saveSingleTopic({
    id: "native-rebuild", name: "rebuild", slug: "rebuild", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare", createdAt: now, updatedAt: now,
    archived: false, provider: "fake-native", systemPrompt: MARKER,
  } as Topic);

  const turn = async (text: string): Promise<string> => {
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: text }] }),
    });
    const resp = await chat(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    const reader = resp!.body!.getReader();
    while (!(await reader.read()).done) { /* drain the turn's frames */ }
    return sent.at(-1)!;
  };

  return { turn, rebuild: () => { epoch += 1; } };
}

describe("the inline context after a native session rebuild", () => {
  test("is resent on the first turn after the rebuild, and deduplicated again after it", async () => {
    const h = await harness();

    // Control: the dedup works while the session lives, or the last check
    // below would pass on a route that resends everything every turn.
    expect(await h.turn("first")).toContain(MARKER);
    expect(await h.turn("second")).not.toContain(MARKER);

    // The provider evicted the session and will rebuild it from the rows.
    h.rebuild();
    expect(await h.turn("third")).toContain(MARKER);
    expect(await h.turn("fourth")).not.toContain(MARKER);
  });
});
