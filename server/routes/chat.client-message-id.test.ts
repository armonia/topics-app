/**
 * THE SEND'S KEY IS ON THE ROW, SO THE SAME MESSAGE IS STORED ONCE ACROSS A
 * RESTART, AND THE HISTORY CARRIES IT.  @covers CHAT-QUEUE-07
 *
 * The route remembered the key (`clientMessageId`) only in memory: a message
 * stored, its echo lost with the socket, the server reloaded on a save, and
 * the outbound queue's resend under the same key was stored a second time.
 * The key is now written on the person's row (migration 20261003202540) and
 * the route asks the table when its memory has nothing; the table's unique
 * index is the backstop for two requests that both passed that question.
 *
 * Real route, real database (`createTestAppContext`), a provider that never
 * answers: each POST writes the person's row and opens its turn, and the test
 * closes the turn by hand.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { createHistoryRouter } from "./history";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-client-message-id");
let ctx: AppContext;
let handlers: StreamHandler[] = [];
let chat: ReturnType<typeof createChatRouter>;
/** The route over the context as it is now: it reads `ctx.appendLocalMessage` once, when built. */
let buildChat: () => ReturnType<typeof createChatRouter>;

beforeAll(async () => {
  setupTestDataDir(`${ROOT}/data`);
  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  const provider = {
    name: "topics",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handlers.push(h); },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  buildChat = () => createChatRouter(ctx, {
    resolveProvider: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
    getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {},
    watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: `${ROOT}/ws`,
  } as never);
  chat = buildChat();
});
afterEach(() => { setSystemTime(); });
afterAll(() => cleanupTestDataDir(ROOT));

function topic(name: string): string {
  const now = new Date().toISOString();
  const sessionKey = `topic:${name}`;
  ctx.saveSingleTopic({
    id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: now, updatedAt: now, archived: false, provider: "topics",
  } as Topic);
  return sessionKey;
}

async function post(sessionKey: string, content: string, key: string): Promise<Response> {
  const url = new URL("http://topics.test/api/chat");
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }], clientMessageId: key }),
  });
  const resp = (await chat(req, url, url.pathname, "POST"))!;
  if (resp.status === 200) resp.body?.cancel().catch(() => {});
  return resp;
}

/** Closes every turn the route opened, as the provider would at the end of its answer. */
async function endTurns(): Promise<void> {
  for (const h of handlers.splice(0)) {
    h.onTextDelta("Done.", "Done.");
    h.onDone({ result: "Done.", turnEnd: { end: "end_turn" } });
  }
  await Bun.sleep(80);
}

const userRows = (sessionKey: string, content: string) =>
  ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "user" && m.content === content);

/** The process forgets every key it held: the 30 minutes of the in-memory map go by, as a restart would clear it. */
const forgetInMemoryKeys = () => setSystemTime(new Date(Date.now() + 31 * 60_000));

describe("a resend under a key the table already holds", () => {
  test("restart-dup: stored, echo lost, the memory of the key gone: the resend is duplicate_message and the row stays one", async () => {
    const sk = topic("restart-dup");
    const key = `k-${crypto.randomUUID()}`;
    const first = await post(sk, "deploy the branch", key);
    expect(first.status).toBe(200);
    await endTurns();
    const [stored] = userRows(sk, "deploy the branch");

    forgetInMemoryKeys();
    const again = await post(sk, "deploy the branch", key);
    await endTurns();

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "duplicate_message", messageId: stored!.id });
    expect(userRows(sk, "deploy the branch")).toHaveLength(1);
  });

  test("the same words under another key are another message, stored", async () => {
    const sk = topic("same-words-new-key");
    expect((await post(sk, "ok", `k-${crypto.randomUUID()}`)).status).toBe(200);
    await endTurns();
    forgetInMemoryKeys();
    expect((await post(sk, "ok", `k-${crypto.randomUUID()}`)).status).toBe(200);
    await endTurns();
    expect(userRows(sk, "ok")).toHaveLength(2);
  });

  test("the key is the session's: the same key in another chat is not a duplicate", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const a = topic("key-scope-a");
    const b = topic("key-scope-b");
    expect((await post(a, "hello", key)).status).toBe(200);
    await endTurns();
    expect((await post(b, "hello", key)).status).toBe(200);
    await endTurns();
    expect(userRows(b, "hello")).toHaveLength(1);
  });
});

describe("two requests with the same key", () => {
  test("concurrent-same-key: two POSTs racing write one row, the other answers duplicate_message", async () => {
    const sk = topic("concurrent-same-key");
    const key = `k-${crypto.randomUUID()}`;
    const answers = await Promise.all([post(sk, "run the tests", key), post(sk, "run the tests", key)]);
    await endTurns();
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = answers.find((r) => r.status === 409)!;
    expect((await refused.json()).code).toBe("duplicate_message");
    expect(userRows(sk, "run the tests")).toHaveLength(1);
  });

  test("the other request stores the key after this one asked: the unique index refuses it, and the answer is duplicate_message, not a 500", async () => {
    const sk = topic("race-past-the-lookup");
    const key = `k-${crypto.randomUUID()}`;
    const append = ctx.appendLocalMessage;
    let rival: string | null = null;
    // A second writer that stores the same key between this request's lookup
    // and its own write: what two server processes on one database, or any
    // await slipped between the two, would do.
    ctx.appendLocalMessage = (...args: Parameters<typeof append>) => {
      if (!rival && args[1] === "user") {
        rival = crypto.randomUUID();
        ctx.db.prepare(
          `INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, client_message_id)
           VALUES (?, ?, 'user', ?, ?, 0, ?)`,
        ).run(rival, sk, args[2], new Date().toISOString(), key);
      }
      return append(...args);
    };
    chat = buildChat();
    try {
      const resp = await post(sk, "ship it", key);
      expect(resp.status).toBe(409);
      expect(await resp.json()).toMatchObject({ code: "duplicate_message", messageId: rival });
    } finally {
      ctx.appendLocalMessage = append;
      chat = buildChat();
      await endTurns();
    }
    expect(userRows(sk, "ship it").map((m) => m.id)).toEqual([rival!]);
  });
});

describe("the history carries the key", () => {
  test("the person's row comes back with the key it was sent with; a row nobody keyed carries none", async () => {
    const sk = topic("history-key");
    const key = `k-${crypto.randomUUID()}`;
    expect((await post(sk, "what changed?", key)).status).toBe(200);
    await endTurns();
    ctx.appendLocalMessage(sk, "user", "an answer the relay wrote");

    const history = createHistoryRouter(ctx, {
      matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
      providerForSessionKey: () => { throw new Error("no provider: the rows are local"); },
    });
    const path = `/api/history/${encodeURIComponent(sk)}`;
    const url = new URL(`http://topics.test${path}`);
    const resp = (await history(new Request(url, { method: "POST", body: JSON.stringify({ limit: 40 }), headers: { "content-type": "application/json" } }), url, path, "POST"))!;
    const { messages } = (await resp.json()) as { messages: Array<{ role: string; content: string; clientMessageId?: string }> };
    const mine = messages.find((m) => m.content === "what changed?");
    const relayed = messages.find((m) => m.content === "an answer the relay wrote");
    expect(mine?.clientMessageId).toBe(key);
    expect(relayed && "clientMessageId" in relayed).toBe(false);
  });
});
