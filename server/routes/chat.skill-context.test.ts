/**
 * A SKILL INVOCATION LEAVES THE ROUTE BARE, WITH ITS CONTEXT BESIDE IT.
 * @covers SKILL-03
 *
 * The adapter decides the shape (`payload.slashContext`) and the provider writes
 * it; this file proves the wiring in between, through the real `POST /api/chat`
 * and a provider that only records what `sendChat` was handed:
 *  - first turn: the message is the bare `/skill args`, the topic context
 *    travels in `options.slashContext` (needs the route to know the skill, by
 *    the topic's cwd, and to forward the field);
 *  - steady state: the preamble was deduplicated, so the message is bare with
 *    no context, and the full context waits in `resetFallbackSlashContext` for
 *    a session reset (the fresh CLI session never saw it);
 *  - a name that is not on disk (`/tmp …`, a pasted path) keeps the old shape.
 * Without this wiring the first turn's context is dropped silently and the
 * slots are still marked sent, so no later turn resends it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-skill-context");
const PROJECT = join(ROOT, "project");
const PROMPT = "SKILL-ROUTE-PROMPT-MARK";

type Sent = { message: string; options: { slashContext?: string; resetFallbackSlashContext?: string; resetFallbackContent?: string } };
const sent: Sent[] = [];
let ctx: AppContext;
let chat: ReturnType<typeof createChatRouter>;

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  mkdirSync(join(PROJECT, ".claude", "skills", "rfprobe"), { recursive: true });
  writeFileSync(join(PROJECT, ".claude", "skills", "rfprobe", "SKILL.md"), "---\nname: rfprobe\n---\n\nProbe $ARGUMENTS.");
  ctx = await createTestAppContext();
  // The provider answers every turn at once, so the next POST finds the chat idle.
  const provider = {
    name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
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
    createdAt: now, updatedAt: now, archived: false, provider: "claude-code", projectPath: PROJECT, systemPrompt: PROMPT,
  } as Topic);
  return `topic:${tid}`;
}

/** One turn through the real route, read to its end; returns what the provider was handed. */
async function turn(sessionKey: string, content: string): Promise<Sent> {
  const before = sent.length;
  const url = new URL("http://topics.test/api/chat");
  const body = JSON.stringify({ sessionKey, messages: [{ role: "user", content }] });
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  const reader = resp.body!.getReader();
  while (!(await reader.read()).done) { /* the turn's frames */ }
  expect(sent.length).toBe(before + 1);
  return sent[before]!;
}

describe("what the route hands the provider for a skill invocation", () => {
  test("first turn: the bare command, the topic context in slashContext", async () => {
    const sk = topic("skill-first");
    const first = await turn(sk, "/rfprobe alpha beta");
    expect(first.message).toBe("/rfprobe alpha beta");
    expect(first.options.slashContext).toContain("<context>");
    expect(first.options.slashContext).toContain(PROMPT);
  });

  test("steady state: bare and without context, the full context kept for a session reset", async () => {
    const sk = topic("skill-steady");
    await turn(sk, "ciao, prima di tutto");
    const steady = await turn(sk, "/rfprobe delta");
    expect(steady.message).toBe("/rfprobe delta");
    expect(steady.options.slashContext ?? "").not.toContain(PROMPT);
    expect(steady.options.resetFallbackSlashContext).toContain(PROMPT);
    // The fallback is the same bare command: the context goes beside it, never in front.
    expect(steady.options.resetFallbackContent ?? steady.message).toBe("/rfprobe delta");
  });

  test("a name that is not a skill on disk keeps the context in front of the text", async () => {
    const sk = topic("skill-path");
    const path = await turn(sk, "/tmp da vedere");
    expect(path.options.slashContext).toBeUndefined();
    expect(path.message.startsWith("<context>")).toBe(true);
    expect(path.message).toContain(PROMPT);
    expect(path.message.endsWith("/tmp da vedere")).toBe(true);
  });
});
