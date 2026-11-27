/**
 * @covers CHAT-COMPACT-06
 *
 * A TURN THAT ONLY CONTINUES WORK SAYS SO TO THE PROVIDER.
 *
 * The native engine leaves an agent's compaction ceiling out of a continuation
 * (`continuation`): a resume ("carry on", the note after a restart), a goal
 * or hook nudge, or a wake (a command's end, sub-agent results) points back at a request that may sit outside the tail
 * compaction never cuts, and the ceiling's low target dropped it (review of PR
 * #1779, reproduced). Every other turn gets the ceiling, and that includes the
 * one jarvis-channels sends for a person's Discord message, which arrives as
 * `dispatched` (its `chat_body`): reading `!sentByPerson` instead turned the
 * ceiling off for its only users (second review of PR #1779). This drives the
 * real chat route with a provider that only records what `sendChat` was handed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-continuation-turn");
const PROJECT = join(ROOT, "project");

type Sent = { message: string; options: { continuation?: boolean } };
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
async function turn(sessionKey: string, content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Sent> {
  const before = sent.length;
  const url = new URL("http://topics.test/api/chat");
  const body = JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...extra });
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  const reader = resp.body!.getReader();
  while (!(await reader.read()).done) { /* the turn's frames */ }
  expect(sent.length).toBe(before + 1);
  return sent[before]!;
}

describe("the provider knows whether the turn only continues work", () => {
  test("a message typed in the composer is no continuation", async () => {
    expect((await turn(topic("ct-composer"), "come va il deploy?")).options.continuation).toBeUndefined();
  });

  test("a person's Discord message as jarvis-channels sends it (dispatched, with its sender) is no continuation", async () => {
    const body = { dispatched: true, clientMessageId: "discord:1", sender: { channel: "discord", id: "42", name: "Attilio", owner: true } };
    expect((await turn(topic("ct-discord"), "Jarvis, che task ho oggi?", body, { "x-idempotency-key": "discord:1" })).options.continuation).toBeUndefined();
  });

  test("the resume after a cut turn, and the goal loop's and a hook's nudges, are", async () => {
    const sk = topic("ct-machine");
    await turn(sk, "controlla i log");
    expect((await turn(sk, "Carry on from where you were.", { ripresa: 1 })).options.continuation).toBe(true);
    expect((await turn(sk, "Keep going toward the goal.", { goalNudge: 1 })).options.continuation).toBe(true);
    expect((await turn(sk, "The turn-end hook asks for more.", { hookNudge: 1 })).options.continuation).toBe(true);
  });

  // A wake points back at the request that launched the work just as a resume
  // does ("Command `build` finished", "Carry on with the task."): on the
  // ceiling's target the request was dropped (third review of PR #1779).
  test("a wake (a command's end, sub-agent results, a card's outcome) is a continuation too", async () => {
    const sk = topic("ct-wake");
    await turn(sk, "lancia la build e avvisami");
    expect((await turn(sk, "Command `build` finished: exit 0.", { processExit: true })).options.continuation).toBe(true);
    expect((await turn(sk, "Sub-agent results. Carry on with the task.", { subagentResults: true })).options.continuation).toBe(true);
    expect((await turn(sk, "The card you sent to work is done.", { cardOutcome: true })).options.continuation).toBe(true);
  });
});
