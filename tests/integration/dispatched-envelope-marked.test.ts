/**
 * A DISPATCHER ENVELOPE IS NOT SOMETHING THE PERSON SAID.
 *
 * A board turn starts by POSTing a generated text to `/api/chat` as a `user`
 * message: the kickoff ("You are the exclusive owner of task ..."), the resume,
 * the nudge after an interrupted turn. `user` is the only role a provider
 * answers, so on the wire the row has to look like that.
 *
 * `dispatched: true` already travelled with the request, but it stopped at the
 * push trigger and never reached the `messages` table, which has no column to
 * tell a word somebody typed from an injection. On the live DB: 411 `user` rows
 * opening with "You are the exclusive owner of task" and 1,033 with "previous
 * turn on this task was interrupted", every one of them with a NULL author and
 * drawn as an editable bubble on the right.
 *
 * The starting red of this file is the row without its mark. It drives the REAL
 * route with a fake provider, the same bench as `goal-continuation.test.ts`,
 * because what was missing is a CONNECTION and not a function.
 *
 * @covers CHAT-GOALLOOP-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { ContentBlock, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("dispatched-envelope");
beforeAll(() => setupTestDataDir(TEST_DATA));

registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

const KICKOFF = "You are the exclusive owner of task 4a554ee3 on this Kanban board.";

async function bench(name: string) {
  const sessionKey = `topic:${name}`;
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = () => {};

  const topic: Topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);

  const handlers: StreamHandler[] = [];
  const provider = {
    name: "fake-stream",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handlers.push(h); },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "ok" }),
  } as unknown as AIProvider;

  const router = createChatRouter(ctx, {
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
    WORKSPACE_DIR: testTmpDir(`${name}-ws`),
  } as never);

  /** One turn through the real route. `dispatched` is the whole question. */
  async function send(content: string, dispatched: boolean) {
    const url = new URL("http://topics.test/api/chat");
    const resp = await router(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...(dispatched ? { dispatched: true } : {}) }),
      }),
      url, "/api/chat", "POST",
    );
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    // The turn stays in flight, so the next send would take the 409 door: close
    // it the way the model would.
    const h = handlers[handlers.length - 1];
    h?.onTextDelta("ok", "ok");
    h?.onDone();
    await new Promise((r) => setTimeout(r, 60));
  }

  const rows = () => ctx.db
    .query("SELECT role, content, blocks FROM messages WHERE session_key = ? ORDER BY sort_order ASC")
    .all(sessionKey) as Array<{ role: string; content: string; blocks: string | null }>;

  return { send, rows };
}

function blocksOf(row: { blocks: string | null }): ContentBlock[] {
  try { return JSON.parse(row.blocks ?? "null") ?? []; } catch { return []; }
}

describe("the dispatcher envelope carries its mark", () => {
  test("a dispatched turn saves the row marked, a human one does not", async () => {
    const b = await bench("dispatched-mark");

    await b.send(KICKOFF, true);
    await b.send("e adesso rifallo con i test", false);   // allow-italian: what a person actually types

    const users = b.rows().filter((r) => r.role === "user");
    expect(users.length).toBe(2);

    // The envelope: marked, and the text kept whole (the rendering folds it,
    // nothing rewrites what was already sent to the model).
    expect(blocksOf(users[0]!)).toEqual([{ kind: "dispatched-envelope" }]);
    expect(users[0]!.content).toBe(KICKOFF);

    // The person's own words: no mark. This is the half that makes the mark
    // mean something - a flag on every row would say nothing at all.
    expect(blocksOf(users[1]!)).toEqual([]);
  });
});
