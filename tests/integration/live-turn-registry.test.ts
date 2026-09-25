/**
 * A LIVE TURN IN A SILENT TOOL STAYS A LIVE TURN, for every reader of the registry.
 * @covers CHAT-REL-05
 *
 * On 2026-09-25 (topic:3019832f, a read-only poller on production) a turn with
 * its row still partial and its child alive dropped out of
 * `GET /api/topics/streaming` at 09:28:42 and again from 09:36:20 to 09:36:28,
 * and came back only after a "[StaleStream] ... extending" line. The cause was a
 * clock inside `isStreaming`: three minutes without a provider event and it
 * answered "not streaming", while the entry stayed in the map. A tool that
 * prints nothing (a long Bash, a wait on a Monitor) is exactly that silence.
 * Every reader of `isStreaming` saw a dead turn: the poll every client
 * reconciles against (two misses and the Stop is gone, the queue drains), and
 * the 409 gate of POST /api/chat, which then let a second turn in.
 *
 * The real pieces, no copy of their logic: `createAppContext` (startStream,
 * isStreaming), the topics router's registry route, the chat router's gate, and
 * `sweepStaleStreams`, the tick the 30 s interval in server.ts runs.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "./helpers";
import { createTopicsRouter } from "../../server/routes/topics";
import { createChatRouter } from "../../server/routes/chat";
import { sweepStaleStreams, type SilenceMark, type SweepOutcome } from "../../server/lib/stale-stream-sweep";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("live-turn-registry");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const SILENT_TOOL_MS = 181_000;

function saveTopic(ctx: AppContext, id: string): string {
  const sessionKey = `topic:${id}`;
  ctx.saveSingleTopic({
    id, name: id, slug: id, parentId: null, links: [], sessionKey,
    color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archived: false,
  } as unknown as Topic);
  return sessionKey;
}

async function registry(ctx: AppContext): Promise<string[]> {
  const router = createTopicsRouter(ctx);
  const url = new URL("http://t.test/api/topics/streaming");
  const res = await router(new Request(url), url, url.pathname, "GET");
  const body = (await res!.json()) as { sessions: Array<{ sessionKey: string }> };
  return body.sessions.map((s) => s.sessionKey);
}

/**
 * POST /api/chat through the real gate and the real `isStreaming`. What lies
 * past the gate is not this test's business, and on a checkout without the fix
 * it must not start a provider: the first write past the gate throws instead.
 */
async function postChat(ctx: AppContext, sessionKey: string): Promise<number | "past the gate"> {
  const chatCtx = {
    ...ctx,
    getTopicBySessionKey: () => undefined,
    appendLocalMessage: () => { throw new Error("PAST_THE_GATE"); },
  } as unknown as AppContext;
  const router = createChatRouter(chatCtx, { browserNavigatedTopics: new Set<string>() } as never);
  const url = new URL("http://t.test/api/chat");
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "a second turn" }] }),
  });
  try {
    return (await router(req, url, url.pathname, "POST"))!.status;
  } catch {
    return "past the gate";
  }
}

function sweep(ctx: AppContext, state: { rescued: Set<string>; silence: Map<string, SilenceMark> }, childAlive: boolean) {
  const broadcasts: Array<Record<string, unknown>> = [];
  const outcomes: Map<string, SweepOutcome> = sweepStaleStreams({
    now: () => Date.now(), timeoutMs: 3 * 60_000, askTtlMs: 10 * 60_000,
    activeStreams: ctx.activeStreams as never, rescued: state.rescued, silence: state.silence,
    getMessageById: (id) => ctx.getMessageById(id) as never,
    humanHoldAgeMs: () => null,
    childAlive: () => childAlive,
    resyncStream: () => {}, cancelAsk: () => {},
    updateStreamActivity: (sk) => ctx.updateStreamActivity(sk),
    getTopicId: (sk) => ctx.getTopicBySessionKey(sk)?.id,
    abortProvider: () => {}, endStream: (sk) => ctx.endStream(sk) as never,
    broadcast: (m) => broadcasts.push(m),
    finalizeMessage: ({ messageId }) => { ctx.db.run("UPDATE messages SET partial = 0 WHERE id = ?", [messageId]); },
    recordTurnEnd: () => {},
    warn: () => {}, info: () => {},
  });
  return { outcomes, broadcasts };
}

/** The last provider event was this long ago: a tool started and has printed nothing since. */
function silentFor(ctx: AppContext, sessionKey: string, ms: number): void {
  ctx.activeStreams.get(sessionKey)!.lastActivity = new Date(Date.now() - ms).toISOString();
}

describe("a live turn silent in a tool for more than three minutes", () => {
  test("the registry lists it and the chat gate answers 409, with no sweep having run", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "silent-tool");
    const row = ctx.createPartialMessage(sessionKey, "assistant");
    ctx.startStream(sessionKey, row.id, new AbortController(), true);

    silentFor(ctx, sessionKey, SILENT_TOOL_MS);

    expect(await registry(ctx)).toEqual([sessionKey]);
    expect(ctx.isStreaming(sessionKey)?.messageId).toBe(row.id);
    expect(await postChat(ctx, sessionKey)).toBe(409);
  });

  test("the sweep that finds its child alive tells every client the turn is alive, each time it rescues or extends", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "silent-rescued");
    const topicId = ctx.getTopicBySessionKey(sessionKey)!.id;
    const row = ctx.createPartialMessage(sessionKey, "assistant");
    ctx.startStream(sessionKey, row.id, new AbortController(), true);
    const state = { rescued: new Set<string>(), silence: new Map<string, SilenceMark>() };
    const alive = { type: "stream:alive", sessionKey, topicId, messageId: row.id };

    silentFor(ctx, sessionKey, SILENT_TOOL_MS);
    const first = sweep(ctx, state, true);
    expect(first.outcomes.get(sessionKey)).toBe("rescued");
    expect(first.broadcasts).toEqual([alive]);

    silentFor(ctx, sessionKey, SILENT_TOOL_MS);
    const second = sweep(ctx, state, true);
    expect(second.outcomes.get(sessionKey)).toBe("extended");
    expect(second.broadcasts).toEqual([alive]);
    expect(await registry(ctx)).toEqual([sessionKey]);
  });

  test("its death is the sweep's to declare: a dead child is closed, and only then the gate opens", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "silent-dead");
    const row = ctx.createPartialMessage(sessionKey, "assistant");
    ctx.startStream(sessionKey, row.id, new AbortController(), true);
    const state = { rescued: new Set<string>(), silence: new Map<string, SilenceMark>() };

    silentFor(ctx, sessionKey, SILENT_TOOL_MS);
    expect(await postChat(ctx, sessionKey)).toBe(409);

    const { outcomes, broadcasts } = sweep(ctx, state, false);
    expect(outcomes.get(sessionKey)).toBe("finalized");
    expect(broadcasts.some((m) => m.type === "stream:alive")).toBe(false);
    expect(await registry(ctx)).toEqual([]);
    expect(await postChat(ctx, sessionKey)).toBe("past the gate");
  });
});
