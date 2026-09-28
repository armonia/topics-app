/**
 * AN OUTAGE'S CUT IS RESENT ONLY WHERE IT IS THE DIRECT ANSWER TO THE PERSON'S
 * MESSAGE, AND ONLY AS MANY TIMES AS THE CHAIN ALLOWS.
 * @covers RESUME-01, MONITOR-03
 *
 * The resend is the person's last message. An API that stopped answering and
 * an ai-bridge daemon that died made rows resumable that never were, and any
 * of them that is not that message's own answer runs an answered message a
 * second time when resent: a wake the CLI opened after the answer, a turn
 * under a regenerated reply, a wake after a /compact. The rule
 * (`outageCutNotResent`) resends an outage's cut only when the cut row answers
 * the person's message and is the chat's last word as the sweep picks it; the
 * notice promises "Riprende da solo" only where both hold when the cut is
 * written. Every other shape asks the person, including one the rule cannot
 * tell from a wake: a sub-agent's report under the live answer. A report or a
 * wake that lands under the cut after the notice promised is accepted as not
 * resent: the person retries.
 *
 * Every row is written by the real route (a message through `sendChat`, a
 * wake through `mode: "woken"`, a reattach leg through `mode: "reattach"`, a
 * regeneration through the edit route, a report through the sub-agent
 * watcher's `deliverExit`), and every verdict is the real resume sweep's. A
 * resend of the chain goes back through the real chat route, so each link
 * opens with the banner the route writes. No block is written by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { createEditRouter } from "./edit";
import { createSubagentWatcher } from "../lib/subagent-watch";
import { _resetTurnBodyFlushers } from "../lib/turn-body-flush";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { endReattachLeg, finalizeStaleRow } from "../lib/closed-outside";
import { INTERRUPTED_MARKER } from "../lib/stale-stream-sweep";
import { MAX_RESUME_ATTEMPTS, riprendiTurniInterrotti } from "../lib/ripresa-boot";
import { outageNoticeResumes } from "../lib/cancelled-notice";
import { clearProviderHold, resetProviderHoldStore } from "../lib/provider-hold";
import { noteApiHealth } from "../providers/claude/api-outage";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, ContentBlock, Topic } from "../types";

const ROOT = testTmpDir("chat-outage-direct-answer");
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
const CAUSES = ["api-unavailable", "broker-died"] as const;
type Outage = (typeof CAUSES)[number];

function topic(tid: string): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, provider: "claude-code" } as Topic);
  return `topic:${tid}`;
}

/**
 * One provider for every route. `send` drives a turn the route sent, `replay`
 * is what the broker hands a reattach leg. The handler of the last turn opened
 * stays in `opened`: the old process's route, which a reload leaves mute.
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
  defaultModel: () => "claude-opus-5", abort: async () => {}, start: () => {}, stop: () => {},
  complete: async () => ({ content: "Build lanciato di nuovo: ti avviso quando finisce." }),
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

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retry = (attempt: number) => ({ attempt, maxAttempts: 10, delayMs: 30_000, reason: "overloaded" });
const lastAnswerRow = (sk: string) => ctx.loadLocalMessages(sk).filter((m) => m.role === "assistant").at(-1)!.id;

/** The person writes, and a whole turn answers. */
async function answered(sk: string, question: string, answer: string): Promise<void> {
  send = (h) => { h.onTextDelta(answer, answer); h.onDone({ result: answer } as never); };
  await drain(await post({ sessionKey: sk, messages: [{ role: "user", content: question }] }));
}

/** The route opens a turn and the CLI gets as far as `live`; returns its row, its handler and the old route's teardown. */
async function open(sk: string, body: Record<string, unknown>, live: (h: StreamHandler) => void) {
  opened = undefined;
  send = () => {};
  const resp = await post({ sessionKey: sk, ...body });
  await tick(20);
  const rowId = lastAnswerRow(sk);
  const route = opened!;
  live(route);
  return {
    rowId, route, resp,
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

/** How each outage ends a turn: the CLI giving up on the API, the daemon gone under the child. */
const outageEnd = (cause: Outage) => (h: StreamHandler) => {
  if (cause === "api-unavailable") h.onDone({ result: "", turnEnd: { end: "error", cause, detail: "API Error: Request timed out" } } as never);
  else h.onAborted!({ turnEnd: { end: "error", cause } } as never);
};

const lastError = (blocks: ContentBlock[] | undefined) => (blocks ?? []).filter((b) => b.kind === "error").at(-1) as { text: string; cause?: string } | undefined;
/** Whether the row's outage notice promises the resume (what the push reads too). */
const promises = (rowId: string) => outageNoticeResumes(`⚠️ ${lastError(ctx.getMessageById(rowId)!.blocks)!.text}`);

/** The resends a sweep's route got for `sk`. With `through`, each goes on through the real chat route, and its turn stays live in `opened`. */
const live: Response[] = [];
async function resumeSweep(sk: string, opts: { through?: boolean } = {}): Promise<unknown[]> {
  // The hold only: the store also keeps when the API last answered, which a
  // resend into an API still down reads to spend no attempt.
  clearProviderHold();
  const resent: unknown[] = [];
  await riprendiTurniInterrotti({
    db: ctx.db, getTopicBySessionKey: (k: string) => ctx.getTopicBySessionKey(k),
    isStreaming: () => false, providerBusy: () => false, lastTurnEnd: () => undefined, bootedAtMs: Date.now(),
  } as never, async (req: Request) => {
    const body = await req.json() as { sessionKey?: string; ripresa?: unknown };
    if (body.sessionKey === sk) {
      resent.push(body.ripresa);
      if (opts.through) { live.push(await post(body)); await tick(20); }
    }
    return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  return resent;
}

/** The resent turn meets the API (its first words lift the outage), then works on. */
const resentTurn = (extra: (h: StreamHandler) => void = () => {}) => (h: StreamHandler) => {
  noteApiHealth("partial", {});
  h.onTextDelta("Riprendo il build", "Riprendo il build");
  extra(h);
};

/** The live resent turn is cut by `cause` on its own leg, and its response is read to the end. */
async function cutResent(cause: Outage): Promise<void> {
  outageEnd(cause)(opened!);
  await drain(live.shift()!);
}

/** A sub-agent's report, through the real watcher: written whole under the thread's last row when it lands. */
const watcher = createSubagentWatcher({
  gatewayUrl: "", gatewayToken: "", getTopicById: (id) => ctx.getTopicById(id),
  getTopicBySessionKey: (k) => ctx.getTopicBySessionKey(k), saveSingleTopic: (t) => ctx.saveSingleTopic(t),
  appendLocalMessage: (sk, role, content) => ctx.appendLocalMessage(sk, role, content),
  broadcastToAll: () => {}, bumpUnread: () => {}, resolveProvider: () => provider,
});
afterAll(() => watcher.stop());
let reports = 0;
function reportLands(sk: string): void {
  reports += 1;
  watcher.deliverExit({ parentSessionKey: sk, childId: `child-${reports}`, name: "lane-a", result: "Lane A: 12 test verdi.", exitCode: 0 });
}
const spawnsSubAgent = (h: StreamHandler) => {
  h.onToolStart(`spawn-${reports}`, "mcp__topics__spawn_agent", { name: "lane-a" });
  h.onToolResult(`spawn-${reports}`, "spawned");
};

describe("the message's own answer cut by an outage", () => {
  for (const cause of CAUSES) {
    test(`${cause}: resent once per sweep, each link counted, and the chain stops at MAX_RESUME_ATTEMPTS`, async () => {
      const sk = topic(`chain-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onRetry!(retry(1)));
      outageEnd(cause)(answer.route);
      await drain(answer.resp);
      expect(promises(answer.rowId)).toBe(true);

      send = resentTurn();
      const links: unknown[][] = [];
      for (let link = 1; link <= MAX_RESUME_ATTEMPTS; link++) {
        links.push(await resumeSweep(sk, { through: true }));
        const resentRow = lastAnswerRow(sk);
        await cutResent(cause);
        // Each resend is the direct answer to the message it resent, and says so.
        expect(promises(resentRow), `link ${link}`).toBe(true);
      }
      expect(links).toEqual([[1], [2], [3], [4]]);
      // The cap: said once in the chat, and nothing more is resent.
      expect(await resumeSweep(sk, { through: true })).toEqual([]);
      expect(ctx.loadLocalMessages(sk).at(-1)!.content).toStartWith("⚠️ Ripresa automatica sospesa");
      expect(await resumeSweep(sk, { through: true })).toEqual([]);
    });

    test(`${cause}: reloaded before a word and cut on the reattach leg, resent once`, async () => {
      const sk = topic(`reattach-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onRetry!(retry(1)));
      reload(sk);
      await reattachLeg(sk, outageEnd(cause));
      expect(lastError(ctx.getMessageById(answer.rowId)!.blocks)!.cause).toBe(cause);
      expect(promises(answer.rowId)).toBe(true);
      expect(await resumeSweep(sk)).toEqual([1]);
      await answer.teardown();
    });
  }
});

describe("a wake after an answer, reloaded before its mark reached the row and cut by an outage", () => {
  /**
   * The route keeps the wake's `woken` mark in memory until its first tool or
   * tenth chunk: a wake into an API that only retries has none on disk when a
   * save reloads the server, and the reattach never writes it. The row hangs
   * from the answer, not from the message, and that is what the rule reads.
   */
  for (const cause of CAUSES) {
    test(`${cause}: the notice promises nothing, and the answered message is not resent`, async () => {
      const sk = topic(`wake-${cause}`);
      await answered(sk, MESSAGE, "Build lanciato, ti avviso.");
      const wake = await open(sk, { messages: [], mode: "woken", wokenLabel: "build finito" }, (h) => { h.onRetry!(retry(1)); h.onRetry!(retry(2)); });
      reload(sk);
      await reattachLeg(sk, outageEnd(cause));
      expect(lastError(ctx.getMessageById(wake.rowId)!.blocks)!.cause).toBe(cause);
      expect(promises(wake.rowId)).toBe(false);
      expect(await resumeSweep(sk)).toEqual([]);
      await wake.teardown();
    });
  }
});

describe("a wake after a regenerated answer, cut by an outage", () => {
  for (const cause of CAUSES) {
    test(`${cause}: the regenerated reply hangs from the message, the wake from the reply: not resent`, async () => {
      const sk = topic(`regen-${cause}`);
      await answered(sk, MESSAGE, "Build lanciato, ti avviso.");
      const first = ctx.loadLocalMessages(sk).filter((m) => m.role === "assistant").at(-1)!;
      const edit = createEditRouter(ctx, { resolveProvider: () => provider, updateUnreadCount: () => {} } as never);
      const url = new URL(`http://topics.test/api/messages/${first.id}/regenerate`);
      const regenerated = await edit(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), url, url.pathname, "POST");
      expect(regenerated?.status).toBe(200);
      await drain(regenerated!);
      const reply = ctx.loadLocalMessages(sk).filter((m) => m.role === "assistant").at(-1)!;
      expect(reply.id).not.toBe(first.id);
      const wake = await open(sk, { messages: [], mode: "woken", wokenLabel: "build finito" }, (h) => h.onRetry!(retry(1)));
      reload(sk);
      await reattachLeg(sk, outageEnd(cause));
      expect(ctx.getMessageById(wake.rowId)!.parentId).toBe(reply.id);
      expect(promises(wake.rowId)).toBe(false);
      expect(await resumeSweep(sk)).toEqual([]);
      await wake.teardown();
    });
  }
});

describe("a wake after a /compact, reloaded before its mark reached the row and cut by an outage", () => {
  /**
   * A /compact's own row is dropped once the compaction ends (nothing to show),
   * so the wake hangs from the "/compact" message itself. Its `manual` marker,
   * anchored on that message, says the message was carried out: resent, the
   * CLI would compact a second time.
   */
  for (const cause of CAUSES) {
    test(`${cause}: the notice promises nothing, and /compact is not resent`, async () => {
      const sk = topic(`compact-wake-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      send = (h) => { h.onCompaction!({ trigger: "manual", preTokens: 120_000 } as never); h.onDone({ result: "" } as never); };
      await drain(await post({ sessionKey: sk, messages: [{ role: "user", content: "/compact" }] }));
      const compact = ctx.loadLocalMessages(sk).at(-1)!;
      expect(`${compact.role}:${compact.content}`).toBe("user:/compact");
      const wake = await open(sk, { messages: [], mode: "woken", wokenLabel: "build finito" }, (h) => h.onRetry!(retry(1)));
      reload(sk);
      await reattachLeg(sk, outageEnd(cause));
      expect(ctx.getMessageById(wake.rowId)!.parentId).toBe(compact.id);
      expect(lastError(ctx.getMessageById(wake.rowId)!.blocks)!.cause).toBe(cause);
      expect(promises(wake.rowId)).toBe(false);
      expect(await resumeSweep(sk)).toEqual([]);
      await wake.teardown();
    });
  }
});

describe("a wake the CLI opens under the direct answer after its promised cut (accepted)", () => {
  /**
   * The answer launched a build in the background, then the API went down: the
   * CLI gave up on the turn and stayed alive, so the promise was written. When
   * the build ends the CLI opens a wake under the cut answer, and the wake is
   * the chat's last word from then on: the sweep judges it and never resends
   * the message, whether the wake answers or is cut in turn. Accepted: the
   * person retries. What must hold is that nothing is resent. No `broker-died`
   * here: the child and its background work die with the daemon.
   */
  for (const wakeEnds of ["answers", "is cut"] as const) {
    test(`api-unavailable, then a wake that ${wakeEnds}: nothing resent`, async () => {
      const sk = topic(`wake-after-cut-${wakeEnds.replace(" ", "-")}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => {
        h.onToolStart("bg1", "Bash", { command: "bun run build", run_in_background: true });
        h.onToolResult("bg1", "Command running in background with ID: bg1");
        h.onRetry!(retry(1));
      });
      outageEnd("api-unavailable")(answer.route);
      await drain(answer.resp);
      expect(promises(answer.rowId)).toBe(true);
      const wake = await open(sk, { messages: [], mode: "woken", wokenLabel: "build finito" }, (h) => {
        if (wakeEnds === "answers") { h.onTextDelta("Build finito, tutto verde.", "Build finito, tutto verde."); h.onDone({ result: "Build finito, tutto verde." } as never); }
        else outageEnd("api-unavailable")(h);
      });
      await drain(wake.resp);
      expect(ctx.getMessageById(wake.rowId)!.parentId).toBe(answer.rowId);
      for (let sweep = 0; sweep < 2; sweep++) expect(await resumeSweep(sk)).toEqual([]);
    });
  }
});

describe("a sub-agent's report under the message's own answer", () => {
  /**
   * The report is written whole under the thread's last row, the live answer,
   * and it is the chat's last word from then on: the sweep judges the report,
   * which answers nobody, and leaves the chat alone. Accepted: the person
   * retries. What must hold is that no notice promises what the sweep will
   * not do, and that nothing is resent more than once.
   */
  for (const cause of CAUSES) {
    test(`${cause} on the route's own leg: the notice promises nothing, and no sweep resends`, async () => {
      const sk = topic(`report-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, spawnsSubAgent);
      await tick(10);
      reportLands(sk);
      expect(ctx.loadLocalMessages(sk).at(-1)!.parentId).toBe(answer.rowId);
      outageEnd(cause)(answer.route);
      await drain(answer.resp);
      expect(lastError(ctx.getMessageById(answer.rowId)!.blocks)!.cause).toBe(cause);
      expect(promises(answer.rowId)).toBe(false);
      for (let sweep = 0; sweep < 3; sweep++) expect(await resumeSweep(sk)).toEqual([]);
    });

    test(`${cause} on the reattach leg after a reload: the notice promises nothing, and no sweep resends`, async () => {
      const sk = topic(`report-leg-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, spawnsSubAgent);
      await tick(10);
      reportLands(sk);
      reload(sk);
      await reattachLeg(sk, outageEnd(cause));
      expect(promises(answer.rowId)).toBe(false);
      expect(await resumeSweep(sk)).toEqual([]);
      await answer.teardown();
    });

    test(`${cause}: a resend whose own answer gets a report is not resent again`, async () => {
      const sk = topic(`report-chain-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onRetry!(retry(1)));
      outageEnd(cause)(answer.route);
      await drain(answer.resp);
      // The resend works on a sub-agent, whose report lands before the next cut.
      send = resentTurn(spawnsSubAgent);
      const resends = [await resumeSweep(sk, { through: true })];
      const resentRow = lastAnswerRow(sk);
      reportLands(sk);
      await cutResent(cause);
      expect(promises(resentRow)).toBe(false);
      for (let sweep = 0; sweep < 3; sweep++) resends.push(await resumeSweep(sk, { through: true }));
      expect(resends.flat()).toEqual([1]);
    });

    test(`${cause}: a report that lands after the notice promised leaves the chat to the person (accepted)`, async () => {
      const sk = topic(`report-after-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, spawnsSubAgent);
      outageEnd(cause)(answer.route);
      await drain(answer.resp);
      expect(promises(answer.rowId)).toBe(true);
      reportLands(sk);
      expect(await resumeSweep(sk)).toEqual([]);
    });
  }
});

describe("the late-answer lane writes the same promise", () => {
  /**
   * The stale sweeper gave up on the answer, and the CLI was alive after all:
   * its late end reaches the closed row through the lane. The lane's notice
   * reads the thread as the route's does.
   */
  for (const report of [false, true]) {
    test(report ? "with a report under the answer: no promise, nothing resent" : "on the direct answer: the promise, and the resend", async () => {
      const sk = topic(`late-${report ? "report" : "direct"}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, spawnsSubAgent);
      finalizeStaleRow(ctx.db, { messageId: answer.rowId, marker: INTERRUPTED_MARKER, interruption: { text: INTERRUPTED_MARKER, cause: "watchdog", at: new Date().toISOString() } });
      ctx.activeStreams.get(sk)?.abortController?.abort();
      await tick(10);
      if (report) reportLands(sk);
      answer.route.onTextDelta("Request timed out", "Request timed out");
      outageEnd("api-unavailable")(answer.route);
      await tick(20);
      await answer.resp.body?.cancel().catch(() => {});
      ctx.activeStreams.delete(sk);
      expect(lastError(ctx.getMessageById(answer.rowId)!.blocks)!.cause).toBe("api-unavailable");
      expect(promises(answer.rowId)).toBe(!report);
      expect(await resumeSweep(sk)).toEqual(report ? [] : [1]);
    });
  }
});
