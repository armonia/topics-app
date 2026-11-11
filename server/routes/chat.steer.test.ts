/**
 * `POST /api/chat` WITH `steer: true` HANDS THE MESSAGE TO THE RUNNING TURN.
 *
 * Real route, real database (`createTestAppContext`), a provider that never
 * answers: the first POST opens a turn, and the test plays the native turn's
 * part with `openSteerTarget` (what `driveTurn` does). A second POST with
 * `steer: true` must not answer `stream_in_flight` but 202; the person's row
 * is written when the turn takes the message, under the sender's key. A
 * message the turn never takes goes as a turn of its own once the first one
 * ends, so nothing is lost.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";
import { openSteerTarget, resetTurnSteer } from "../lib/turn-steer";

const ROOT = testTmpDir("chat-steer");
let ctx: AppContext;
const handlers: StreamHandler[] = [];
let sent = 0;
let chat: ReturnType<typeof createChatRouter>;

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
    sendChat: () => { sent++; return new Promise<{ runId?: string }>(() => {}); },
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  chat = createChatRouter(ctx, {
    resolveProvider: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
    getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {},
    watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: `${ROOT}/ws`,
  } as never);
});
beforeEach(() => { resetTurnSteer(); sent = 0; });
afterAll(() => { resetTurnSteer(); cleanupTestDataDir(ROOT); });

function topic(name: string): string {
  const now = new Date().toISOString();
  const sessionKey = `topic:${name}`;
  ctx.saveSingleTopic({
    id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: now, updatedAt: now, archived: false, provider: "topics",
  } as Topic);
  return sessionKey;
}

async function post(sessionKey: string, content: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const url = new URL("http://topics.test/api/chat");
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...extra }),
  });
  const resp = (await chat(req, url, url.pathname, "POST"))!;
  if (resp.status === 200) resp.body?.cancel().catch(() => {});
  return resp;
}

async function steerStatus(sessionKey: string, id: string): Promise<Response> {
  const url = new URL(`http://topics.test/api/chat/steer?sessionKey=${encodeURIComponent(sessionKey)}&id=${encodeURIComponent(id)}`);
  return (await chat(new Request(url), url, url.pathname, "GET"))!;
}

async function endTurns(): Promise<void> {
  for (const h of handlers.splice(0)) {
    h.onTextDelta("Done.", "Done.");
    h.onDone({ result: "Done.", turnEnd: { end: "end_turn" } });
  }
  await Bun.sleep(80);
}

const userRows = (sessionKey: string, content: string) =>
  ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "user" && m.content === content);

describe("steer into a running native turn", () => {
  test("202 instead of stream_in_flight; the row is written when the turn takes it, under the sender's key", async () => {
    const sk = topic("steer-taken");
    expect((await post(sk, "migra il server")).status).toBe(200);
    const target = openSteerTarget(sk);

    const resp = await post(sk, "usa la porta 2222", { steer: true, clientMessageId: "k-steer-1", dispatched: true });
    expect(resp.status).toBe(202);
    const { steered, steerId } = await resp.json() as { steered: boolean; steerId: string };
    expect(steered).toBe(true);
    // Not read by the model yet: no row.
    expect(userRows(sk, "usa la porta 2222")).toHaveLength(0);
    expect(await (await steerStatus(sk, steerId)).json()).toEqual({ state: "pending" });

    expect(target.take()).toEqual(["usa la porta 2222"]);
    await Bun.sleep(10);
    const rows = userRows(sk, "usa la porta 2222");
    expect(rows).toHaveLength(1);
    expect(await (await steerStatus(sk, steerId)).json()).toEqual({ state: "taken", messageId: rows[0]!.id });

    // The sender resending under the same key gets its row back, not a copy.
    const again = await post(sk, "usa la porta 2222", { clientMessageId: "k-steer-1", dispatched: true });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "duplicate_message", messageId: rows[0]!.id });

    target.close();
    await endTurns();
    expect(sent).toBe(1);
  });

  test("a turn that takes no messages answers the usual stream_in_flight", async () => {
    const sk = topic("steer-closed");
    expect((await post(sk, "primo")).status).toBe(200);
    const resp = await post(sk, "secondo", { steer: true });
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("stream_in_flight");
    await endTurns();
  });

  test("a message the turn never took goes as a turn of its own once the session is free", async () => {
    const sk = topic("steer-returned");
    expect((await post(sk, "prepara il deploy")).status).toBe(200);
    const target = openSteerTarget(sk);
    const resp = await post(sk, "e avvisa Giuseppe", { steer: true, clientMessageId: "k-steer-2" });
    expect(resp.status).toBe(202);
    const { steerId } = await resp.json() as { steerId: string };

    // The turn ends at a round that asked for no tool: nothing taken.
    target.close();
    await Bun.sleep(10);
    expect(sent).toBe(1);
    await endTurns();
    for (let i = 0; i < 40 && sent < 2; i++) await Bun.sleep(25);

    expect(sent).toBe(2);
    expect(userRows(sk, "e avvisa Giuseppe")).toHaveLength(1);
    expect((await (await steerStatus(sk, steerId)).json() as { state: string }).state).toBe("returned");
    await endTurns();
  });

  test("an unknown steer id is a 404, not a guess", async () => {
    const resp = await steerStatus("topic:nobody", "steer-nope");
    expect(resp.status).toBe(404);
  });
});
