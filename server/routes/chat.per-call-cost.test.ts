/**
 * THE COST OF A MESSAGE IS THE SUM OF ITS CALLS, each priced on its own.
 *
 * Haiku 5.5 picks its rate card per request: over 100k tokens of prompt the
 * whole request costs five times more. The route used to price the turn from
 * its total spread evenly over the calls, so a turn of uneven calls landed on
 * one card for all of them: 60k, 80k, 120k and 140k came out at a third of the
 * bill, 40k x3 and 300k at half again more.
 *
 * Proven on the real `POST /api/chat` with a fake provider: it reports four
 * calls one by one (`onCallUsage`), then the turn total (`onDone`), as the CLI
 * and the native engine do. The cost is read off the real row and off the
 * `stream:usage` frames. Expected values by hand from the official cards
 * ($0.10/$0.50, and $0.50/$2.50 over 100k).
 * @covers USAGE-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-per-call-cost");
let ctx: AppContext;
const frames: Array<Record<string, unknown>> = [];
beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };
});
afterAll(() => cleanupTestDataDir(ROOT));

function topic(tid: string): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, provider: "claude-code" } as Topic);
  return `topic:${tid}`;
}

let drive: (h: StreamHandler) => void | Promise<void> = () => {};
const provider = {
  name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
  get connected() { return true; },
  registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
  sendChat: async (_sk: string, _m: string, h: StreamHandler) => { setTimeout(() => drive(h), 5); return { runId: "run" }; },
  reattach: async (_sk: string, h: StreamHandler) => { setTimeout(() => drive(h), 5); return "reattach-run"; },
  defaultModel: () => "claude-haiku-5-5", abort: async () => {}, start: () => {}, stop: () => {}, complete: async () => ({ content: "" }),
} as unknown as AIProvider;

async function turn(sk: string, emit: (h: StreamHandler) => void | Promise<void>): Promise<void> {
  drive = emit;
  const chat = createChatRouter(ctx, {
    resolveProvider: () => provider, resolveProviderByName: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null, getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: join(ROOT, "ws"),
  } as never);
  const url = new URL("http://topics.test/api/chat");
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk, messages: [{ role: "user", content: "go" }] }) }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  await new Response(resp.body).text();
}

/** A Haiku 5.5 call with `prompt` fresh tokens and 10k of output. */
const call = (prompt: number) => ({ inputTokens: prompt, outputTokens: 10_000, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, model: "claude-haiku-5-5" });

/** Four calls one by one, then the turn total, as a provider reports them. */
async function turnOf(tid: string, prompts: number[]): Promise<{ costCents: number | null; liveCents: unknown }> {
  const sk = topic(tid);
  frames.length = 0;
  await turn(sk, (h) => {
    for (const p of prompts) h.onCallUsage!(call(p));
    const total = prompts.reduce((a, b) => a + b, 0);
    h.onTextDelta("ok", "ok");
    h.onDone({ result: "ok", usage: { inputTokens: total, outputTokens: 10_000 * prompts.length, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 } } as never);
  });
  const row = ctx.db.query("SELECT cost_cents FROM messages WHERE session_key = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1").get(sk) as { cost_cents: number | null };
  const live = frames.filter((f) => f.type === "stream:usage").at(-1);
  return { costCents: row.cost_cents, liveCents: live?.costCents };
}

describe("a Haiku 5.5 turn of uneven calls costs the sum of its calls", () => {
  test("60k, 80k, 120k, 140k: 20 cents, not 6", async () => {
    // Cheap card: 60k*0.1 + 10k*0.5 = $0.011; 80k = $0.013.
    // Long card: 120k*0.5 + 10k*2.5 = $0.085; 140k = $0.095. Sum $0.204.
    const { costCents, liveCents } = await turnOf("uneven-a", [60_000, 80_000, 120_000, 140_000]);
    expect(costCents).toBe(20);
    expect(liveCents).toBe(20);
  });

  test("40k x3 and 300k: 20 cents, not 31", async () => {
    // 3 x (40k*0.1 + 10k*0.5) = $0.027; 300k*0.5 + 10k*2.5 = $0.175. Sum $0.202.
    const { costCents, liveCents } = await turnOf("uneven-b", [40_000, 40_000, 40_000, 300_000]);
    expect(costCents).toBe(20);
    expect(liveCents).toBe(20);
  });
});
