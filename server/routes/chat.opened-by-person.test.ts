/**
 * @covers CHAT-COMPACT-06
 *
 * WHO OPENED THE TURN TRAVELS WITH IT TO THE PROVIDER.
 *
 * The native engine compacts an agent's chat at its ceiling only on a turn a
 * person opened (`openedByPerson`): their message is then the newest, inside
 * the tail compaction never cuts. A resume ("carry on", the note after a
 * restart) points back at a request that may sit outside it, and the ceiling's
 * low target dropped it (review of PR #1779, reproduced). This drives the real
 * chat route with a provider that only records what `sendChat` was handed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-opened-by-person");
const PROJECT = join(ROOT, "project");

type Sent = { message: string; options: { openedByPerson?: boolean } };
const sent: Sent[] = [];
let ctx: AppContext;
let chat: ReturnType<typeof createChatRouter>;

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  mkdirSync(PROJECT, { recursive: true });
  ctx = await createTestAppContext();
  // The provider answers every turn at once, so the next POST finds the chat idle.
  const provider = {
    name: "native", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
    get connected() { return true; },
    registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
    sendChat: async (_sk: string, message: string, handler: StreamHandler, options: Sent["options"] = {}) => {
      sent.push({ message, options });
      queueMicrotask(() => handler.onDone({ result: "ok", turnEnd: { end: "end_turn" } } as never));
      return { runId: `run-${sent.length}` };
    },
    defaultModel: () => "claude-opus-5", abort: async () => {}, start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  chat = createChatRouter(ctx, {
    resolveProvider: () => provider, resolveProviderByName: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
    getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {},
    watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: join(ROOT, "ws"),
  } as never);
});
afterAll(() => cleanupTestDataDir(ROOT));

function topic(tid: string): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({
    id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "", icon: "chat",
    createdAt: now, updatedAt: now, archived: false, provider: "native", projectPath: PROJECT,
  } as Topic);
  return `topic:${tid}`;
}

/** One turn through the real route, read to its end; returns what the provider was handed. */
async function turn(sessionKey: string, content: string, extra: Record<string, unknown> = {}): Promise<Sent> {
  const before = sent.length;
  const url = new URL("http://topics.test/api/chat");
  const body = JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...extra });
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  const reader = resp.body!.getReader();
  while (!(await reader.read()).done) { /* the turn's frames */ }
  expect(sent.length).toBe(before + 1);
  return sent[before]!;
}

describe("the provider knows whether a person opened the turn", () => {
  test("a message a person typed", async () => {
    expect((await turn(topic("obp-person"), "come va il deploy?")).options.openedByPerson).toBe(true);
  });

  test("the resume after a cut turn, and the goal loop's nudge, are not a person's", async () => {
    const sk = topic("obp-machine");
    await turn(sk, "controlla i log");
    expect((await turn(sk, "Carry on from where you were.", { ripresa: 1 })).options.openedByPerson).toBeUndefined();
    expect((await turn(sk, "Keep going toward the goal.", { goalNudge: 1 })).options.openedByPerson).toBeUndefined();
  });
});
