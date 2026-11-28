/**
 * Doors B5 and B7 of the project pause, through the real chat route:
 * `POST /api/chat` is where the turns of agents (`send_chat_message`), channels
 * and scheduled jobs come in. In a paused project every one of them is HELD (202,
 * zero turns started) and goes out on "Continua"; a person's message, which the
 * app's composer sends with none of the markers, always starts. @covers USAGE-29
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { continueProject } from "../services/project-pause";
import { openPauseWithLimit } from "../../tests/helpers/paused-project";
import { fireProjectResumed, heldCount, resetHeldForTests } from "../services/turn-gate";
import { projectIdOfFolder } from "../usage/project-folders";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-pause-gate");
let ctx: AppContext;
let chat: ReturnType<typeof createChatRouter>;
const handlers: StreamHandler[] = [];
let turnsStarted = 0;
let seq = 0;

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
    sendChat: () => { turnsStarted++; return new Promise<{ runId?: string }>(() => {}); },
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
afterAll(async () => {
  for (const h of handlers.splice(0)) h.onDone({ result: "", turnEnd: { end: "end_turn" } });
  await Bun.sleep(80);
  cleanupTestDataDir(ROOT);
});
beforeEach(() => { resetHeldForTests(); turnsStarted = 0; });

/** A chat inside its own project; `paused` opens the pause like the sweep does. */
function chatInProject(paused: boolean): { sessionKey: string; projectId: string } {
  const name = `c${++seq}`;
  const folder = `${ROOT}/proj-${name}`;
  const now = new Date().toISOString();
  const sessionKey = `topic:${name}`;
  ctx.saveSingleTopic({
    id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: now, updatedAt: now, archived: false, provider: "topics", projectPath: folder,
  } as Topic);
  const projectId = projectIdOfFolder(ctx.db as never, folder);
  if (paused) openPauseWithLimit(ctx.db as never, projectId, 999);
  return { sessionKey, projectId };
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

const userRows = (sessionKey: string) => ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "user");
const settle = () => Bun.sleep(150);

describe("a paused project holds every turn that is not a person's message", () => {
  test("an agent writing to the chat (send_chat_message, fromAgent): held, zero turns", async () => {
    const { sessionKey, projectId } = chatInProject(true);
    const resp = await post(sessionKey, "hello from an agent", { fromAgent: true });
    expect(resp.status).toBe(202);
    expect(await resp.json()).toMatchObject({ held: true, code: "project_paused", projectId });
    await settle();
    expect(turnsStarted).toBe(0);
    expect(userRows(sessionKey)).toHaveLength(0);
    expect(heldCount(projectId)).toBe(1);
  });

  test("a scheduled job that declares itself an automation: held, zero turns", async () => {
    const { sessionKey } = chatInProject(true);
    const resp = await post(sessionKey, "nightly job", { origin: "automation", originSource: "scheduled-job" });
    expect(resp.status).toBe(202);
    await settle();
    expect(turnsStarted).toBe(0);
  });

  test("a channel turn from somebody who is not the owner: held, zero turns", async () => {
    const { sessionKey } = chatInProject(true);
    const resp = await post(sessionKey, "hi from the channel", { sender: { channel: "discord", id: "u-1", name: "Guest" } });
    expect(resp.status).toBe(202);
    await settle();
    expect(turnsStarted).toBe(0);
  });

  test("the owner on a channel is a person: it starts", async () => {
    const { sessionKey } = chatInProject(true);
    const resp = await post(sessionKey, "owner on the channel", { sender: { channel: "discord", id: "owner-1", name: "Owner", owner: true } });
    expect(resp.status).toBe(200);
    expect(turnsStarted).toBe(1);
  });

  test("the app's own message, with none of the markers, starts as before", async () => {
    const { sessionKey } = chatInProject(true);
    const resp = await post(sessionKey, "typed in the composer");
    expect(resp.status).toBe(200);
    expect(turnsStarted).toBe(1);
  });

  test("a project that is not paused: an agent's message starts", async () => {
    const { sessionKey } = chatInProject(false);
    const resp = await post(sessionKey, "hello from an agent", { fromAgent: true });
    expect(resp.status).toBe(200);
    expect(turnsStarted).toBe(1);
  });
});

describe("what was held is not lost", () => {
  test("after Continua the held agent message starts its turn, once, even if it was sent twice", async () => {
    const { sessionKey, projectId } = chatInProject(true);
    await post(sessionKey, "do the thing", { fromAgent: true, clientMessageId: "k-1" });
    await post(sessionKey, "do the thing", { fromAgent: true, clientMessageId: "k-1" });
    expect(heldCount(projectId)).toBe(1);
    expect(turnsStarted).toBe(0);

    continueProject(ctx.db as never, projectId, 999);
    fireProjectResumed(projectId);
    for (let i = 0; i < 200 && turnsStarted === 0; i++) await Bun.sleep(50);
    expect(turnsStarted).toBe(1);
    expect(userRows(sessionKey).map((m) => m.content)).toEqual(["do the thing"]);
    expect(heldCount(projectId)).toBe(0);
  });
});
