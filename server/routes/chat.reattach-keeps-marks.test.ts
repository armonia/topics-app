/**
 * A ROW TAKEN BACK BY A REATTACH KEEPS THE MARKS IT OPENS WITH, AND THE RESUME
 * READS THEM THE SAME AFTER A RESTART AS BEFORE.
 * @covers RESUME-01, CHAT-BUBBLE-02
 *
 * A reattach leg starts from an empty timeline, neither a wake nor a resend,
 * and its replay never writes a `woken` or a route `ripreso`. Before the merge
 * put them back, a restart during a wake or during a probe dropped them:
 *   - a wake cut by an outage on the reattached leg was promised "Riprende da
 *     solo" and the sweep resent the person's previous message, one the turn
 *     before the wake had already answered (a second paid turn);
 *   - a free probe into an API still down lost its leading `ripreso`, so the
 *     sweep spent a resume attempt on it and the chat lost its redone-answer
 *     banner while offering Retry under a notice that says it resumes.
 * Both go through the real route (`mode: "reattach"`, the boot's request), the
 * boot's partial sweep, the end of the leg and the real resume sweep.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { endReattachLeg } from "../lib/closed-outside";
import { resumeVerdict, riprendiTurniInterrotti } from "../lib/ripresa-boot";
import { noteResendCopy, recordResend } from "../lib/resend-count";
import { outageNoticeResumes } from "../lib/cancelled-notice";
import { clearProviderHold, resetProviderHoldStore } from "../lib/provider-hold";
import { isRedoneAnswer, turnIsOnlyError } from "../../client/src/components/Chat/turnError";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, ContentBlock, Topic, ToolCall } from "../types";

const ROOT = testTmpDir("chat-reattach-keeps-marks");
let ctx: AppContext;
beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
});
afterAll(() => {
  clearProviderHold();
  resetProviderHoldStore();
  cleanupTestDataDir(ROOT);
});

function topic(tid: string): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, provider: "claude-code" } as Topic);
  return `topic:${tid}`;
}

/** A boot with the chat's child still alive in the broker: its open row is kept for the reattach. */
const bootWithChildAlive = (sk: string) =>
  runBootPartialSweep(ctx.db as unknown as PartialSweepDb, { listConfirmed: true, liveSessions: new Set([sk]) });

/** What the broker hands the leg: the replay of the turn in flight, then how it ended. */
let replay: (h: StreamHandler) => void = () => {};
const brokerProvider = {
  name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
  get connected() { return true; },
  registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
  reattach: async (_sk: string, h: StreamHandler) => { setTimeout(() => replay(h), 5); return "reattach-run"; },
  sendChat: () => { throw new Error("a reattach leg sends nothing"); },
  defaultModel: () => "claude-opus-5", abort: async () => {}, start: () => {}, stop: () => {}, complete: async () => ({ content: "" }),
} as unknown as AIProvider;

/** A reattach leg through the real route, read to its end, then ended as server.ts ends it (broker idle). */
async function reattachLeg(sk: string, emit: (h: StreamHandler) => void): Promise<void> {
  replay = emit;
  const chat = createChatRouter(ctx, {
    resolveProvider: () => brokerProvider, resolveProviderByName: () => brokerProvider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null, getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: join(ROOT, "ws"),
  } as never);
  const url = new URL("http://topics.test/api/chat");
  const body = JSON.stringify({ sessionKey: sk, messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  const reader = resp.body!.getReader();
  while (!(await reader.read()).done) { /* the leg's frames */ }
  await endReattachLeg(ctx, sk, { brokerTurnState: async () => "idle" } as never);
}

/** The resume sweep as the boot runs it, with no hold in force; returns the `ripresa` of each resend of `sk`. */
async function sweep(sk: string): Promise<unknown[]> {
  clearProviderHold();
  resetProviderHoldStore();
  const resent: unknown[] = [];
  await riprendiTurniInterrotti({
    db: ctx.db, getTopicBySessionKey: (k: string) => ctx.getTopicBySessionKey(k),
    isStreaming: () => false, providerBusy: () => false, lastTurnEnd: () => undefined, bootedAtMs: Date.now(),
  } as never, async (req: Request) => {
    const body = await req.json() as { sessionKey?: string; ripresa?: unknown };
    if (body.sessionKey === sk) resent.push(body.ripresa);
    return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  return resent;
}

const blocksOf = (id: string): ContentBlock[] => ctx.getMessageById(id)?.blocks ?? [];
const verdictOf = (id: string) => {
  const row = ctx.getMessageById(id)!;
  return resumeVerdict({ sessionKey: row.id, ruolo: "assistant", blocks: row.blocks ?? [], timestampMs: Date.parse(row.timestamp), attempts: 0 }, Date.now());
};
const lastError = (blocks: ContentBlock[]) => blocks.filter((b) => b.kind === "error").at(-1) as { text: string; cause?: string } | undefined;

describe("a wake reattached after a restart and then cut by an outage is not resumed", () => {
  for (const cause of ["api-unavailable", "broker-died"] as const) {
    test(`${cause}: the row keeps its woken mark, the notice asks the person, and the sweep resends nothing`, async () => {
      const sk = topic(`reattach-wake-${cause}`);
      ctx.appendLocalMessage(sk, "user", "Lancia il build e avvisami");
      const first = ctx.createPartialMessage(sk, "assistant");
      ctx.updateLastMessage(sk, { content: "Build lanciato, ti avviso.", partial: undefined, streamedAt: undefined, latencyMs: 500, endReason: "done" }, { rowId: first.id });
      // The Monitor wakes the agent; its row is written, then a save reloads the server.
      const wake = ctx.reuseHeadstoneOrCreate(sk);
      const bash: ToolCall = { id: "t1", name: "Bash", args: {}, status: "success" };
      ctx.updateLastMessage(sk, { content: "", blocks: [{ kind: "woken", label: "build finito" }, { kind: "tool", toolCall: bash }], toolCalls: [bash] }, { rowId: wake.id });
      bootWithChildAlive(sk);
      // The replay starts from the wake's own start: every tool again, then the outage.
      await reattachLeg(sk, (h) => {
        h.onToolStart("t1", "Bash", {});
        h.onToolResult("t1", "ok");
        h.onTextDelta("Il build è passato, ", "Il build è passato, ");
        if (cause === "api-unavailable") h.onDone({ result: "", turnEnd: { end: "error", cause, detail: "Request timed out" } } as never);
        else h.onAborted!({ turnEnd: { end: "error", cause } } as never);
      });
      const blocks = blocksOf(wake.id);
      expect(blocks[0]).toEqual({ kind: "woken", label: "build finito" });
      const notice = lastError(blocks)!;
      expect(notice.cause).toBe(cause);
      expect(outageNoticeResumes(`⚠️ ${notice.text}`)).toBe(false);
      expect(verdictOf(wake.id)).toBe("no");
      expect(await sweep(sk)).toEqual([]);
    });
  }
});

describe("a free probe reattached after a restart stays free", () => {
  test("cut again by the API still down, it keeps its leading banner: the sweep resends it without spending an attempt, and the chat shows the redone answer", async () => {
    const sk = topic("reattach-probe");
    const cut = (at: string) => ({ kind: "error", text: "Turno interrotto: l'API di Claude non rispondeva più.", cause: "api-unavailable", at }) as ContentBlock;
    const message = ctx.appendLocalMessage(sk, "user", "Misura la catena");
    // The first cut, traced by the sweep that resent it (attempt 1, counted),
    // and the copy of the message the resend wrote, linked to its count.
    const cutRow = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { content: "", blocks: [cut(new Date(Date.now() - 60_000).toISOString()), { kind: "ripreso", attempt: 1 }], partial: undefined, streamedAt: undefined, latencyMs: 10, endReason: "done" }, { rowId: cutRow.id });
    recordResend(ctx.db, sk, { messageId: message.id, attempts: 1, freeProbes: 0 });
    noteResendCopy(ctx.db, sk, message.id, ctx.appendLocalMessage(sk, "user", "Misura la catena").id);
    // The resend is the probe: the route's banner is on its row, its CLI retries into the blackout.
    const probe = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { blocks: [{ kind: "ripreso", attempt: 1 }] }, { rowId: probe.id });
    bootWithChildAlive(sk);
    // Nothing to replay but retries, then the CLI gives up on the API.
    await reattachLeg(sk, (h) => h.onDone({ result: "", turnEnd: { end: "error", cause: "api-unavailable", detail: "API Error: Request timed out" } } as never));
    const blocks = blocksOf(probe.id);
    expect(blocks.map((b) => b.kind)).toEqual(["ripreso", "error"]);
    expect(isRedoneAnswer(blocks)).toBe(true);
    // Retry is not offered under a notice that says the chat resumes by itself.
    expect(turnIsOnlyError({ ...ctx.getMessageById(probe.id)!, blocks })).toBe(false);
    expect(await sweep(sk)).toEqual([1]);
  });
});
