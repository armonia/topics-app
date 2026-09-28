/**
 * A LATER TURN UNDER A MESSAGE ALREADY ANSWERED IS NOT RESENT, WHATEVER A
 * RELOAD TOOK OFF ITS ROW.
 * @covers RESUME-01, MONITOR-03
 *
 * The resend is the person's last message. A wake (a turn the CLI opened on
 * its own: a Monitor firing, a background task reporting) sits after the turn
 * that answered it, so resending it runs the answered message again: a second
 * paid turn with every effect again. The wake's row says it is one with its
 * `woken` mark, but the route keeps that mark in memory until the first tool or
 * the tenth chunk of text: a wake into an API that only retries has none on
 * disk when a save reloads the server, and the reattach that takes the row
 * back never writes it. The thread says it anyway: the row comes after a turn
 * that ended.
 *
 * Every row here is written by the real route (a message answered through
 * `sendChat`, a wake through `mode: "woken"`, the leg through `mode:
 * "reattach"`), the reload is the old process's streams and flushers gone,
 * then the boot's partial sweep and the end of the leg, or the stale sweeper's
 * finalize, and the real resume sweep. No block is written by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { _resetTurnBodyFlushers } from "../lib/turn-body-flush";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { endReattachLeg, finalizeStaleRow } from "../lib/closed-outside";
import { INTERRUPTED_MARKER } from "../lib/stale-stream-sweep";
import { riprendiTurniInterrotti } from "../lib/ripresa-boot";
import { outageNoticeResumes } from "../lib/cancelled-notice";
import { clearProviderHold, resetProviderHoldStore } from "../lib/provider-hold";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, ContentBlock, Topic } from "../types";

const ROOT = testTmpDir("chat-wake-after-answer");
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

const MESSAGE = "Lancia il build e avvisami";

function topic(tid: string): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, provider: "claude-code" } as Topic);
  return `topic:${tid}`;
}

/**
 * One provider for every route. `send` drives a turn the person asked for,
 * `wake` is what a turn the CLI opened on its own emits, `replay` is what the
 * broker hands a reattach leg. The handler of the last turn opened stays in
 * `opened`: the old process's route, which a reload leaves without a word.
 */
let opened: StreamHandler | undefined;
let send: (h: StreamHandler) => void = () => {};
let replay: (h: StreamHandler) => void = () => {};
const provider = {
  name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
  get connected() { return true; },
  registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
  adoptWokenTurn: (_sk: string, h: StreamHandler) => { opened = h; return true; },
  sendChat: (_sk: string, _content: unknown, h: StreamHandler) => {
    opened = h;
    return new Promise((resolve) => setTimeout(() => { send(h); resolve({ runId: "run" }); }, 5));
  },
  reattach: async (_sk: string, h: StreamHandler) => { setTimeout(() => replay(h), 5); return "reattach-run"; },
  defaultModel: () => "claude-opus-5", abort: async () => {}, start: () => {}, stop: () => {}, complete: async () => ({ content: "" }),
} as unknown as AIProvider;

async function post(body: Record<string, unknown>): Promise<Response> {
  const chat = createChatRouter(ctx, {
    resolveProvider: () => provider, resolveProviderByName: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null, getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: join(ROOT, "ws"),
  } as never);
  const url = new URL("http://topics.test/api/chat");
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "claude-code", ...body }) }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  return resp;
}

async function drain(resp: Response): Promise<void> {
  const reader = resp.body!.getReader();
  while (!(await reader.read()).done) { /* the turn's frames */ }
}

/** The person writes, and a whole turn answers: the row the wake comes after. */
async function answered(sk: string, question: string, answer: string): Promise<void> {
  send = (h) => { h.onTextDelta(answer, answer); h.onDone({ result: answer } as never); };
  await drain(await post({ sessionKey: sk, messages: [{ role: "user", content: question }] }));
}

/** The route opens a turn and the CLI gets as far as `live`; returns its row and the old route's teardown. */
async function open(sk: string, body: Record<string, unknown>, live: (h: StreamHandler) => void) {
  opened = undefined;
  send = () => {};
  const resp = await post({ sessionKey: sk, ...body });
  await new Promise((r) => setTimeout(r, 20));
  const rowId = ctx.loadLocalMessages(sk).filter((m) => m.role === "assistant").at(-1)!.id;
  const route = opened!;
  live(route);
  return {
    rowId,
    teardown: async () => {
      route.onAborted?.({ turnEnd: { end: "cancelled", cause: "server-shutdown" } } as never);
      await resp.body?.cancel().catch(() => {});
    },
  };
}

/** A save under server/ reloads the server: the old process's streams and flushers are gone, the child lives on. */
function reload(sk: string): void {
  _resetTurnBodyFlushers();
  ctx.activeStreams.delete(sk);
  runBootPartialSweep(ctx.db as unknown as PartialSweepDb, { listConfirmed: true, liveSessions: new Set([sk]) });
}

/** A reattach leg through the real route, read to its end, then ended as server.ts ends it (broker idle). */
async function reattachLeg(sk: string, emit: (h: StreamHandler) => void): Promise<void> {
  replay = emit;
  await drain(await post({ sessionKey: sk, messages: [], mode: "reattach", dispatched: true }));
  await endReattachLeg(ctx, sk, { brokerTurnState: async () => "idle" } as never);
}

/** What the resume sweep did to `sk`: the resends it posted, and the rows it wrote or traced. */
async function resumeSweep(sk: string): Promise<{ resent: unknown[]; rowsBefore: number; rowsAfter: number; traced: boolean }> {
  clearProviderHold();
  resetProviderHoldStore();
  const rowsBefore = ctx.loadLocalMessages(sk).length;
  const resent: unknown[] = [];
  await riprendiTurniInterrotti({
    db: ctx.db, getTopicBySessionKey: (k: string) => ctx.getTopicBySessionKey(k),
    isStreaming: () => false, providerBusy: () => false, lastTurnEnd: () => undefined, bootedAtMs: Date.now(),
  } as never, async (req: Request) => {
    const body = await req.json() as { sessionKey?: string; ripresa?: unknown };
    if (body.sessionKey === sk) resent.push(body.ripresa);
    return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const rows = ctx.loadLocalMessages(sk);
  const traced = rows.some((m) => (m.blocks ?? []).some((b, i, all) => b.kind === "ripreso" && all.slice(0, i).some((x) => x.kind === "error")));
  return { resent, rowsBefore, rowsAfter: rows.length, traced };
}

/** The verdict `no`, as the sweep acts on it: nothing resent, nothing traced, no notice written. */
async function expectLeftAlone(sk: string, why: string): Promise<void> {
  const swept = await resumeSweep(sk);
  expect(swept.resent, why).toEqual([]);
  expect(swept.traced, why).toBe(false);
  expect(swept.rowsAfter, why).toBe(swept.rowsBefore);
}

const retry = (attempt: number) => ({ attempt, maxAttempts: 10, delayMs: 30_000, reason: "overloaded" });
const lastError = (blocks: ContentBlock[] | undefined) => (blocks ?? []).filter((b) => b.kind === "error").at(-1) as { text: string; cause?: string } | undefined;
const outageEnd = (cause: "api-unavailable" | "broker-died") => (h: StreamHandler) => {
  if (cause === "api-unavailable") h.onDone({ result: "", turnEnd: { end: "error", cause, detail: "API Error: Request timed out" } } as never);
  else h.onAborted!({ turnEnd: { end: "error", cause } } as never);
};

describe("a wake reloaded before its mark reached the row, then cut by an outage", () => {
  for (const cause of ["api-unavailable", "broker-died"] as const) {
    test(`${cause}: the notice asks the person, and the sweep leaves the answered message alone`, async () => {
      const sk = topic(`wake-${cause}`);
      await answered(sk, MESSAGE, "Build lanciato, ti avviso.");
      // The Monitor wakes the agent into an API that only retries; a save reloads the server.
      const wake = await open(sk, { messages: [], mode: "woken", wokenLabel: "build finito" }, (h) => { h.onRetry!(retry(1)); h.onRetry!(retry(2)); });
      reload(sk);
      // The broker replays the wake: still nothing but the outage that ends it.
      await reattachLeg(sk, outageEnd(cause));
      const row = ctx.getMessageById(wake.rowId)!;
      const notice = lastError(row.blocks)!;
      expect(notice.cause).toBe(cause);
      expect(outageNoticeResumes(`⚠️ ${notice.text}`)).toBe(false);
      await expectLeftAlone(sk, cause);
      await wake.teardown();
    });
  }
});

describe("a wake closed by the stale sweeper", () => {
  /**
   * The row as the sweeper's own finalize leaves it (`finalizeStaleRow`, with
   * the arguments `sweepStaleStreams` passes): closed from outside, and the
   * `watchdog` verdict on its timeline when it has one. The SSE abort that
   * follows makes a live route write its blocks again over that verdict, an
   * older defect of its own; the rule has to hold on the verdict itself.
   */
  for (const work of [false, true]) {
    test(`${work ? "after a tool" : "with no work"}: the sweep leaves the answered message alone`, async () => {
      const sk = topic(`wake-stale-${work ? "tool" : "idle"}`);
      await answered(sk, MESSAGE, "Build lanciato, ti avviso.");
      const wake = await open(sk, { messages: [], mode: "woken", wokenLabel: "build finito" }, (h) => {
        h.onRetry!(retry(1));
        if (work) { h.onToolStart("t1", "Bash", { command: "cat build.log" }); h.onToolResult("t1", "ok"); }
      });
      finalizeStaleRow(ctx.db, { messageId: wake.rowId, marker: INTERRUPTED_MARKER, interruption: { text: INTERRUPTED_MARKER, cause: "watchdog", at: new Date().toISOString() } });
      expect(ctx.getMessageById(wake.rowId)!.endReason).toBe("closed-outside");
      await expectLeftAlone(sk, work ? "wake with a tool" : "idle wake");
      await wake.teardown();
    });
  }
});

describe("the message's own answer cut by an outage is still resent, once", () => {
  for (const cause of ["api-unavailable", "broker-died"] as const) {
    test(`${cause}: after an earlier exchange, a reload and the leg's cut, the sweep resends the message as attempt 1`, async () => {
      const sk = topic(`answer-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      // The person's message: its turn only retries into the dark API when the server reloads.
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onRetry!(retry(1)));
      reload(sk);
      await reattachLeg(sk, outageEnd(cause));
      const notice = lastError(ctx.getMessageById(answer.rowId)!.blocks)!;
      expect(notice.cause).toBe(cause);
      expect(outageNoticeResumes(`⚠️ ${notice.text}`)).toBe(true);
      expect((await resumeSweep(sk)).resent).toEqual([1]);
      await answer.teardown();
    });
  }
});
