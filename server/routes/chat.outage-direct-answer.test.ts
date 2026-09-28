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
 * resent: the person retries. A row the machine wrote in the person's role (a
 * command's wake, a goal's continuation) is not the person's message either,
 * and a resend of one keeps its mark. A command's wake cut by an outage is
 * sent again by the wake module itself once the outage is over, on the
 * sweep's count, and it waits behind a resend the notice promised.
 *
 * Every row is written by the real route (a message through `sendChat`, a
 * wake through `mode: "woken"`, a reattach leg through `mode: "reattach"`, a
 * regeneration through the edit route, a report through the sub-agent
 * watcher's `deliverExit`, a command's end through `deliverProcessExit`), and
 * every verdict is the real resume sweep's. A resend of the chain goes back
 * through the real chat route, so each link opens with the banner the route
 * writes. No block is written by hand.
 *
 * The chain's resends are a count per message (`resend_counts`, card
 * 069f823e), not a reading of the thread: the service rows that land under a
 * resent answer (a sub-agent's report, a background notice) do not reset it, a
 * new message the person writes starts its own, and so does whatever is cut
 * after the chain was answered. A command's wake sent again after an outage
 * counts on the same number as the sweep's resends of it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { createEditRouter } from "./edit";
import { createSubagentWatcher } from "../lib/subagent-watch";
import { _resetTurnBodyFlushers } from "../lib/turn-body-flush";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { endReattachLeg, finalizeStaleRow } from "../lib/closed-outside";
import { INTERRUPTED_MARKER } from "../lib/stale-stream-sweep";
import { FINESTRA_RIPRESA_MS, MAX_FREE_PROBES, MAX_RESUME_ATTEMPTS, riprendiTurniInterrotti } from "../lib/ripresa-boot";
import { attemptsOnRow } from "../lib/resend-count";
import { postBackgroundNotice } from "../lib/background-notice";
import { outageNoticeResumes } from "../lib/cancelled-notice";
import { clearProviderHold, holdForApiDown, liftApiDownHold, resetProviderHoldStore, setProviderHold } from "../lib/provider-hold";
import { noteApiHealth } from "../providers/claude/api-outage";
import { cancelled } from "../providers/stop-reason";
import { TopicsRoutingIncompatibleError } from "../providers/resolve-topic-provider";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, ContentBlock, Topic } from "../types";
import { deliverProcessExit } from "../lib/process-exit-wake";
import { isPersonPrompt } from "../../shared/prompt-number";

const ROOT = testTmpDir("chat-outage-direct-answer");
let ctx: AppContext;
beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
});
afterAll(async () => {
  // A turn a test left open (a hard kill, the mute route of a reload) still
  // owes a deferred write of its body, up to 15 s later: run in one process
  // with the next file, it landed on this file's closed database and turned
  // that file's tests red. Closed here, as a shutdown closes it.
  for (const h of turnsOpened) {
    try { h.onAborted?.({ turnEnd: { end: "cancelled", cause: "server-shutdown" } } as never); } catch { /* already over */ }
  }
  await tick(20);
  for (const resp of live.splice(0)) await resp.body?.cancel().catch(() => {});
  clearProviderHold();
  resetProviderHoldStore();
  cleanupTestDataDir(ROOT);
});

const MESSAGE = "Lancia il build e avvisami";
const CAUSES = ["api-unavailable", "broker-died"] as const;
type Outage = (typeof CAUSES)[number];

/** `pinned: false`: the chat on the machine's default (the picker's PATCH), which the route resolves after writing the message. */
function topic(tid: string, pinned = true): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, provider: pinned ? "claude-code" : null } as Topic);
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
/** Every turn a route opened, over or not: the file closes them before its database. */
const turnsOpened = new Set<StreamHandler>();
const provider = {
  name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
  get connected() { return true; },
  registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
  adoptWokenTurn: (_sk: string, h: StreamHandler) => { opened = h; turnsOpened.add(h); return true; },
  sendChat: (_sk: string, _content: unknown, h: StreamHandler) => {
    opened = h;
    turnsOpened.add(h);
    return new Promise((resolve) => setTimeout(() => { send(h); resolve({ runId: "run" }); }, 5));
  },
  reattach: async (_sk: string, h: StreamHandler) => { turnsOpened.add(h); setTimeout(() => replay(h), 5); return "reattach-run"; },
  defaultModel: () => "claude-opus-5", abort: async () => {}, start: () => {}, stop: () => {},
  complete: async () => ({ content: "Build lanciato di nuovo: ti avviso quando finisce." }),
} as unknown as AIProvider;

/** The chat route, as every caller gets it (the person's window, the sweep, the wake module), with `deps` over the test's own. */
function chatRoute(deps: Record<string, unknown> = {}) {
  return createChatRouter(ctx, {
    resolveProvider: () => provider, resolveProviderByName: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null, getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: join(ROOT, "ws"),
    ...deps,
  } as never);
}

/** The real chat route, with `deps` over the test's own. */
async function route(body: Record<string, unknown>, deps: Record<string, unknown> = {}): Promise<Response> {
  const url = new URL("http://topics.test/api/chat");
  return (await chatRoute(deps)(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, url.pathname, "POST"))!;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  const resp = await route({ provider: "claude-code", ...body });
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

/** A save under server/ reloads the server: the old process's streams and flushers are gone, the child lives on (or, on a hard kill, dies with it). */
function reload(sk: string, child: "alive" | "dead" = "alive"): void {
  _resetTurnBodyFlushers();
  ctx.activeStreams.delete(sk);
  runBootPartialSweep(ctx.db as unknown as PartialSweepDb, { listConfirmed: true, liveSessions: new Set(child === "alive" ? [sk] : []) });
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
// A turn a test leaves open (a hard kill, a failed assertion) is not the next test's to drain.
afterEach(async () => {
  for (const resp of live.splice(0)) await resp.body?.cancel().catch(() => {});
});
/**
 * With `refused`, each goes on through the real chat route, which writes its
 * copy of the message and then refuses the turn: a topic with no provider
 * pinned whose routing cannot reach it (AICTRL-01, the 409 after the message).
 */
async function resumeSweep(sk: string, opts: { through?: boolean; refused?: boolean } = {}): Promise<unknown[]> {
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
      if (opts.refused) expect((await route(body, { resolveProvider: refuseTurn })).status).toBe(409);
    }
    return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  return resent;
}
const refuseTurn = () => { throw new TopicsRoutingIncompatibleError("claude-code", "routing on, provider not reachable through it"); };

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

/** Each turn the route sends runs the next of `list`, and the last one runs every turn after it. */
function turns(...list: Array<(h: StreamHandler) => void>): (h: StreamHandler) => void {
  let next = 0;
  return (h) => list[Math.min(next++, list.length - 1)]!(h);
}
const answers = (text: string) => (h: StreamHandler) => { h.onTextDelta(text, text); h.onDone({ result: text } as never); };

/**
 * A command started with `run_command` ends: the wake module writes its row
 * through the real route, as soon as it lets itself. Returns its process and
 * the delivery's outcome, still pending while the wake waits. With
 * `processId`, the wake of a command that already ended, asked again as the
 * boot asks for every wake still owed.
 */
let wakes = 0;
function commandEnds(sk: string, processId = `p-${++wakes}`) {
  const outcome = deliverProcessExit({
    db: ctx.db,
    getTopicById: (id) => { const t = ctx.getTopicById(id); return t ? { sessionKey: t.sessionKey, archived: !!t.archived, provider: t.provider } : null; },
    ownedByRunningTask: () => false, isBusy: (k) => ctx.activeStreams.has(k), route: chatRoute(), pollMs: 10, endGraceMs: 200,
  }, { processId, topicId: sk.slice("topic:".length), label: "bun run build", exitCode: 1, durationMs: 90_000, lines: ["error: 3 tests failed"] });
  return { processId, outcome };
}

/** A command's wake whose turn is `turn`, delivered once. Returns the wake's row and the row of its answer. */
async function commandWake(sk: string, turn: (h: StreamHandler) => void): Promise<{ wakeRow: string; rowId: string }> {
  send = turn;
  expect(await commandEnds(sk).outcome).toBe("sent");
  return { wakeRow: ctx.loadLocalMessages(sk).filter((m) => m.role === "user").at(-1)!.id, rowId: lastAnswerRow(sk) };
}

/** Every row of a process's wake in the chat, oldest first: the first one and each copy sent again. */
const wakeRows = (sk: string, processId: string) => ctx.loadLocalMessages(sk).filter((m) =>
  m.role === "user" && (m.blocks ?? []).some((b) => b.kind === "process-exit" && (b as { processId?: unknown }).processId === processId));
const answerTo = (sk: string, rowId: string) => ctx.loadLocalMessages(sk).find((m) => m.role === "assistant" && m.parentId === rowId)!;

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

describe("a row the machine wrote is not the person's message", () => {
  /**
   * A `user` row nobody typed (`MACHINE_ROW_KINDS`): a command's wake, a
   * goal's continuation, the board's envelope. Its answer cut by an outage is
   * a wake's cut: the notice promises nothing, so the failure push goes out
   * (`push-triggers.ts` reads the same promise), and no sweep resends it.
   * Resent, the wake went back as a row with no mark: the machine's words in
   * the person's bubble, with an edit button.
   */
  for (const cause of CAUSES) {
    test(`${cause}: a run_command wake's turn: no promise and no resend of the sweep's; the wake goes again once the outage is over`, async () => {
      const sk = topic(`pexit-${cause}`);
      await answered(sk, "Lancia il build con run_command e avvisami", "Lanciato, ti sveglia lui.");
      // No hold when it goes: the agent waits on the command and nothing else
      // runs. Its CLI retries (an API that is down holds Claude, as
      // `noteApiHealth` does), then the outage cuts the turn.
      send = turns((h) => { h.onRetry!(retry(1)); if (cause === "api-unavailable") holdForApiDown(); outageEnd(cause)(h); }, answers("Build rosso: 3 test."));
      const wake = commandEnds(sk);
      if (cause === "api-unavailable") {
        await tick(150);
        // Cut, and waiting behind the hold its own retries opened.
        expect(wakeRows(sk, wake.processId)).toHaveLength(1);
        // A child elsewhere gets an answer.
        liftApiDownHold();
      }
      expect(await wake.outcome).toBe("sent");
      const [first, copy] = wakeRows(sk, wake.processId);
      const cut = answerTo(sk, first!.id);
      expect(lastError(cut.blocks)!.cause).toBe(cause);
      expect(promises(cut.id)).toBe(false);
      // The copy is the machine's row, answered.
      expect(copy!.content).toBe(first!.content);
      expect(isPersonPrompt(copy!)).toBe(false);
      expect(answerTo(sk, copy!.id).content).toContain("Build rosso");
      for (let sweep = 0; sweep < 2; sweep++) expect(await resumeSweep(sk)).toEqual([]);
    });
  }

  test("api-unavailable: a goal continuation's turn: no promise, nothing resent", async () => {
    const sk = topic("goal-nudge-cut");
    await answered(sk, "Finisci il refactor", "Fatto a metà.");
    const nudge = await open(sk, { messages: [{ role: "user", content: "Objective still open: finish the refactor." }], goalNudge: 1 }, (h) => h.onRetry!(retry(1)));
    outageEnd("api-unavailable")(nudge.route);
    await drain(nudge.resp);
    expect(promises(nudge.rowId)).toBe(false);
    expect(await resumeSweep(sk)).toEqual([]);
  });

  /**
   * The person's answer launched the command and was cut with the promise;
   * the command ended during the outage. Landed under the cut first, the wake
   * became the chat's last word and the promised resend never went: before
   * the verdict read machine rows, the sweep resent the wake's text in the
   * message's place; after, it resent nothing. The wake waits behind the
   * promise, and a lifted hold alone does not let it jump ahead (the sweep is
   * nudged 20 s after the lift, the wake looked every 500 ms).
   */
  for (const cause of CAUSES) {
    test(`${cause}: a run_command wake waits behind the person's promised resend, and goes after its turn`, async () => {
      const sk = topic(`pexit-under-${cause}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => {
        h.onToolStart("rc1", "mcp__topics__run_command", { command: "bun run build" });
        h.onToolResult("rc1", "started");
        h.onRetry!(retry(1));
        if (cause === "api-unavailable") holdForApiDown();
      });
      outageEnd(cause)(answer.route);
      await drain(answer.resp);
      expect(promises(answer.rowId)).toBe(true);
      send = turns(answers("Riprendo il build."), answers("Build finito, exit 1."));
      const wake = commandEnds(sk);
      await tick(80);
      if (cause === "api-unavailable") {
        liftApiDownHold();
        await tick(80);
      }
      expect(wakeRows(sk, wake.processId)).toHaveLength(0);
      // The sweep keeps the promise, and the wake goes once the resent turn is over.
      expect(await resumeSweep(sk, { through: true })).toEqual([1]);
      await drain(live.shift()!);
      expect(await wake.outcome).toBe("sent");
      const tail = ctx.loadLocalMessages(sk).slice(-4).map((m) => `${m.role}:${m.content.split(":")[0]}`);
      expect(tail).toEqual([`user:${MESSAGE}`, "assistant:Riprendo il build.", "user:Command `bun run build` finished", "assistant:Build finito, exit 1."]);
      expect(await resumeSweep(sk)).toEqual([]);
    });
  }

  /**
   * The wake waits behind a resend only the sweep makes, so only while the
   * sweep would make it: a cut past its window, or on the chat of a card that
   * landed or that the dispatcher resumes, is never resent, and a wake behind
   * it waited for good.
   */
  const NEVER_RESENT = {
    "a day old": (_sk: string, rowId: string) => ctx.db.run("UPDATE messages SET timestamp = ? WHERE id = ?", [new Date(Date.now() - FINESTRA_RIPRESA_MS - 60_000).toISOString(), rowId]),
    "on a card that landed": (sk: string) => cardOn(sk, "done"),
    "on a card in progress": (sk: string) => cardOn(sk, "in_progress"),
  };
  for (const [shape, apply] of Object.entries(NEVER_RESENT)) {
    test(`broker-died: the person's answer cut ${shape}: the sweep resends nothing, and the wake goes`, async () => {
      const sk = topic(`pexit-never-${shape.replaceAll(" ", "-")}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onRetry!(retry(1)));
      outageEnd("broker-died")(answer.route);
      await drain(answer.resp);
      apply(sk, answer.rowId);
      send = answers("Build finito, exit 1.");
      const wake = commandEnds(sk);
      expect(await Promise.race([wake.outcome, tick(1500).then(() => "still waiting")])).toBe("sent");
      expect(wakeRows(sk, wake.processId)).toHaveLength(1);
      expect(await resumeSweep(sk)).toEqual([]);
    });
  }
});

/** A board card on the topic of `sk`, in `status`. */
function cardOn(sk: string, status: "in_progress" | "review" | "done"): void {
  const now = new Date().toISOString();
  ctx.db.run(
    "INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id) VALUES (?, 'board', 'the card', ?, ?, ?, ?)",
    [`card-${sk}`, status, now, now, sk.slice("topic:".length)],
  );
}

describe("a card's envelope answered and cut by an outage", () => {
  /**
   * The board's envelope is a row the machine wrote, so its answer is not the
   * direct answer the sweep resends. A card in progress resumes it anyway:
   * the dispatcher resumes each turn of the card that ended in error, and the
   * sweep leaves those to it. Its notice says so; a card waiting in review
   * resumes nothing, and its notice asks the person.
   */
  for (const cause of CAUSES) {
    for (const status of ["in_progress", "review"] as const) {
      test(`${cause}, card ${status}: ${status === "in_progress" ? "the notice says it resumes by itself" : "the notice asks the person"}, and the sweep resends nothing`, async () => {
        const sk = topic(`card-${status}-${cause}`);
        cardOn(sk, status);
        const turn = await open(sk, { messages: [{ role: "user", content: "Card: fix the build." }], dispatched: true }, (h) => h.onRetry!(retry(1)));
        outageEnd(cause)(turn.route);
        await drain(turn.resp);
        expect(promises(turn.rowId)).toBe(status === "in_progress");
        expect(await resumeSweep(sk)).toEqual([]);
      });
    }
  }
});

describe("a run_command wake whose turn meets the outage goes again", () => {
  /**
   * The api-down hold ends by time, and what it lets through is the probe
   * that says whether the API is back. A wake that goes out as that probe and
   * meets the API still down is cut; its CLI's retries open the hold again,
   * and the wake waits behind it for the next round.
   */
  test("a hold that ends with the API still down: the wake goes as the probe, is cut, and goes again once the API answers", async () => {
    const sk = topic("pexit-probe");
    await answered(sk, "Lancia il build con run_command e avvisami", "Lanciato, ti sveglia lui.");
    setProviderHold({ untilMs: Date.now() + 150, window: "api-down", reason: "l'API di Claude non risponde" });
    send = turns((h) => { h.onRetry!(retry(1)); holdForApiDown(); outageEnd("api-unavailable")(h); }, answers("Build rosso: 3 test."));
    const wake = commandEnds(sk);
    await tick(80);
    expect(wakeRows(sk, wake.processId)).toHaveLength(0);
    await tick(250);
    const [probe] = wakeRows(sk, wake.processId);
    expect(lastError(answerTo(sk, probe!.id).blocks)!.cause).toBe("api-unavailable");
    liftApiDownHold();
    expect(await wake.outcome).toBe("sent");
    const rows = wakeRows(sk, wake.processId);
    expect(rows).toHaveLength(2);
    const answer = answerTo(sk, rows[1]!.id);
    expect(answer.content).toContain("Build rosso");
    // Said as a resend, and counted on the chain like one.
    expect(attemptsOnRow(answer.blocks)).toBe(1);
    for (let sweep = 0; sweep < 2; sweep++) expect(await resumeSweep(sk)).toEqual([]);
  });

  /**
   * The cut's notice tells the person to write, and they did while the wake
   * waited behind the hold: its cut is no longer the chat's last word, the
   * sweep's own condition, and a copy would run a stale turn under their
   * answer.
   */
  test("the person writes while the wake waits behind the hold: the wake is done, no copy goes", async () => {
    const sk = topic("pexit-moved-on");
    await answered(sk, "Lancia il build con run_command e avvisami", "Lanciato, ti sveglia lui.");
    send = (h) => { h.onRetry!(retry(1)); holdForApiDown(); outageEnd("api-unavailable")(h); };
    const wake = commandEnds(sk);
    await tick(150);
    expect(wakeRows(sk, wake.processId)).toHaveLength(1);
    await answered(sk, "Lascia stare il build, guarda i log", "Guardo i log.");
    liftApiDownHold();
    expect(await wake.outcome).toBe("delivered");
    expect(wakeRows(sk, wake.processId)).toHaveLength(1);
    expect(ctx.loadLocalMessages(sk).at(-1)!.content).toBe("Guardo i log.");
    // Asked again, as the boot asks for every wake still owed: nothing more.
    expect(await commandEnds(sk, wake.processId).outcome).toBe("delivered");
    expect(await resumeSweep(sk)).toEqual([]);
  });

  test("cut every time, it goes again MAX_RESUME_ATTEMPTS times and then leaves the chat to the person", async () => {
    const sk = topic("pexit-cap");
    await answered(sk, "Lancia il build con run_command e avvisami", "Lanciato, ti sveglia lui.");
    send = (h) => { h.onRetry!(retry(1)); outageEnd("broker-died")(h); };
    const wake = commandEnds(sk);
    expect(await wake.outcome).toBe("capped");
    const rows = wakeRows(sk, wake.processId);
    expect(rows.map((r) => attemptsOnRow(answerTo(sk, r.id).blocks))).toEqual(Array.from({ length: MAX_RESUME_ATTEMPTS + 1 }, (_, attempt) => attempt));
    expect(promises(answerTo(sk, rows.at(-1)!.id).id)).toBe(false);
    expect(await resumeSweep(sk)).toEqual([]);
  });

  /**
   * The wake's copies and the sweep's resends of the same wake are one chain
   * on one count (`resend_counts`), keyed by the wake's first row: a restart's
   * cut between two outages does not start the budget over, in either
   * direction.
   */
  test("cut by the outage, its copy by a restart, the sweep's resend by the outage again: one count from the first cut to the cap", async () => {
    const sk = topic("pexit-one-count");
    await answered(sk, "Lancia il build con run_command e avvisami", "Lanciato, ti sveglia lui.");
    const daemonDies = (h: StreamHandler) => { h.onRetry!(retry(1)); outageEnd("broker-died")(h); };
    send = turns(daemonDies, (h) => h.onAborted!({ turnEnd: { end: "cancelled", cause: "server-shutdown" } } as never), daemonDies);
    const wake = commandEnds(sk);
    // A restart's cut is the sweep's: the wake is done with it.
    expect(await wake.outcome).toBe("sent");
    expect(await resumeSweep(sk, { through: true })).toEqual([2]);
    await drain(live.shift()!);
    // The sweep leaves the outage's cut of its copy alone; the boot asks for the wake again.
    expect(await resumeSweep(sk)).toEqual([]);
    expect(await commandEnds(sk, wake.processId).outcome).toBe("capped");
    const rows = wakeRows(sk, wake.processId);
    // The number each went out with, on the banner its answer opens with (the
    // restart's cut also carries the sweep's trace, 2, after the cut).
    const banner = (rowId: string) => attemptsOnRow(answerTo(sk, rowId).blocks?.filter((b) => b.kind === "ripreso").slice(0, 1));
    expect(rows.map((r) => banner(r.id))).toEqual(Array.from({ length: MAX_RESUME_ATTEMPTS + 1 }, (_, attempt) => attempt));
    expect(ctx.db.query("SELECT message_id, attempts, free_probes, last_copy_id FROM resend_counts WHERE session_key = ?").all(sk))
      .toEqual([{ message_id: rows[0]!.id, attempts: MAX_RESUME_ATTEMPTS, free_probes: 0, last_copy_id: rows.at(-1)!.id }]);
    expect(await resumeSweep(sk)).toEqual([]);
  });

  /**
   * The probe api-down-forever+bgnotice on the wake: every copy meets the API
   * still down, and a background notice lands under each cut, so each copy
   * hangs from a notice. Its free probes read off the thread stopped at the
   * notice and started over at every copy, with no cap; counted, they stop at
   * MAX_FREE_PROBES and the copies go on to the cap.
   */
  test("the API down for good, a background notice under every cut: MAX_FREE_PROBES free copies, then the count up to the cap", async () => {
    const sk = topic("pexit-down-notices");
    await answered(sk, "Lancia il build con run_command e avvisami", "Lanciato, ti sveglia lui.");
    send = (h) => { h.onRetry!(retry(1)); outageEnd("api-unavailable")(h); };
    const append = ctx.appendLocalMessage;
    ctx.appendLocalMessage = ((...args: Parameters<typeof append>) => {
      if (args[0] === sk && args[1] === "user") lands(sk, "background-notice");
      return append(...args);
    }) as typeof append;
    const wake = commandEnds(sk);
    try { expect(await wake.outcome).toBe("capped"); } finally { ctx.appendLocalMessage = append; }
    const rows = wakeRows(sk, wake.processId);
    expect(rows.every((r) => ctx.getMessageById(r.parentId!)!.blocks?.[0]?.kind === "background-notice")).toBe(true);
    expect(rows.map((r) => attemptsOnRow(answerTo(sk, r.id).blocks))).toEqual([0, ...Array(1 + MAX_FREE_PROBES).fill(1), ...COUNTED.slice(1)]);
    expect(ctx.db.query("SELECT attempts, free_probes FROM resend_counts WHERE session_key = ?").all(sk))
      .toEqual([{ attempts: MAX_RESUME_ATTEMPTS, free_probes: MAX_FREE_PROBES }]);
  });
});

describe("a resend of a row the machine wrote keeps its mark", () => {
  /**
   * A cut of ours (a restart) keeps its rule: the sweep resends the chat's
   * last user row, as the Retry button does. When that row is the machine's
   * words, the copy the route writes says so, as a copy of the board's
   * envelope already did (`repeatedRowMarks`, lib/user-row-marks.ts).
   */
  test("a run_command wake's turn cut by a restart: the copy carries the wake's process-exit mark", async () => {
    const sk = topic("pexit-restart");
    await answered(sk, "Lancia il build con run_command e avvisami", "Lanciato, ti sveglia lui.");
    const wake = await commandWake(sk, (h) => h.onAborted!({ turnEnd: { end: "cancelled", cause: "server-shutdown" } } as never));
    send = (h) => { h.onTextDelta("Build rosso: 3 test.", "Build rosso: 3 test."); h.onDone({ result: "Build rosso: 3 test." } as never); };
    expect(await resumeSweep(sk, { through: true })).toEqual([1]);
    await drain(live.shift()!);
    const original = ctx.getMessageById(wake.wakeRow)!;
    const copy = ctx.loadLocalMessages(sk).filter((m) => m.role === "user").at(-1)!;
    expect(copy.id).not.toBe(original.id);
    expect(copy.content).toBe(original.content);
    expect(copy.blocks).toEqual(original.blocks);
    expect(isPersonPrompt(copy)).toBe(false);
  });
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

const capNotice = (sk: string) => ctx.loadLocalMessages(sk).at(-1)!.content;
const COUNTED = Array.from({ length: MAX_RESUME_ATTEMPTS }, (_, i) => i + 1);
const BETWEEN = ["nothing", "report", "background-notice"] as const;
/** A service row under the chat's last row: a sub-agent's report, or a background notice. */
function lands(sk: string, row: (typeof BETWEEN)[number]): void {
  if (row === "report") reportLands(sk);
  if (row === "background-notice") postBackgroundNotice(ctx as never, { sessionKey: sk, topicId: sk.slice(6) }, { kind: "background-notice", event: "deferred", change: "model" } as never);
}

/** The message cut by the daemon dying, resent `k` times through the real route, each resend cut the same way but the last, which ends as `last` says. */
async function resentTimes(sk: string, k: number, last: "cut" | "answered"): Promise<void> {
  await answered(sk, "Ciao", "Ciao, dimmi.");
  const first = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onTextDelta("Lavoro", "Lavoro"));
  outageEnd("broker-died")(first.route);
  await drain(first.resp);
  send = resentTurn();
  const resends: unknown[] = [];
  for (let link = 1; link <= k; link++) {
    resends.push(...await resumeSweep(sk, { through: true }));
    if (link < k || last === "cut") await cutResent("broker-died");
  }
  expect(resends).toEqual(COUNTED.slice(0, k));
  if (last === "answered") { opened!.onDone({ result: "Build fatto." } as never); await drain(live.shift()!); }
}

describe("a service row under every resent answer does not reset the count", () => {
  /**
   * Probe v5-cap (28/09): a turn that launches a sub-agent, and a restart that
   * kills it with its child at every link. The report lands under the live
   * answer, the boot's notice under the report, and the walk up the thread
   * stopped at the report: the same message was resent seven times in seven
   * restarts, each from attempt 1.
   */
  for (const between of ["nothing", "report"] as const) {
    test(`${between} under each answer, killed with its child each time: ${MAX_RESUME_ATTEMPTS} resends, then the cap is said`, async () => {
      const sk = topic(`killed-${between}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, spawnsSubAgent);
      send = spawnsSubAgent;
      const resends: unknown[] = [];
      for (let link = 1; link <= MAX_RESUME_ATTEMPTS + 3; link++) {
        if (between === "report") reportLands(sk);
        reload(sk, "dead");
        const resent = await resumeSweep(sk, { through: true });
        if (resent.length === 0) break;
        resends.push(...resent);
      }
      expect(resends).toEqual(COUNTED);
      expect(capNotice(sk)).toStartWith("⚠️ Ripresa automatica sospesa");
    });
  }

  /**
   * Probe api-down-forever+bgnotice (28/09): the API never comes back, and a
   * background notice lands under every cut. A resend into an API still down
   * spends no attempt up to MAX_FREE_PROBES; the next resend hangs from the
   * notice, the walk stopped there, and every link read as the first probe:
   * twenty resends in twenty sweeps and no cap. With the notices the count is
   * the one without them.
   */
  for (const [cause, notice] of [["api-unavailable", false], ["api-unavailable", true], ["broker-died", true]] as const) {
    test(`${cause}${notice ? " with a background notice under every cut" : ""}: resent as the count allows, then the cap is said`, async () => {
      const sk = topic(`down-${cause}-${notice}`);
      await answered(sk, "Ciao", "Ciao, dimmi.");
      const answer = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onRetry!(retry(1)));
      outageEnd(cause)(answer.route);
      await drain(answer.resp);
      if (notice) lands(sk, "background-notice");
      // The resent turn never meets the API: it retries until the CLI gives up again.
      send = (h) => h.onRetry!(retry(1));
      const resends: unknown[] = [];
      for (let link = 1; link <= 20; link++) {
        const resent = await resumeSweep(sk, { through: true });
        if (resent.length === 0) break;
        resends.push(...resent);
        await cutResent(cause);
        if (notice) lands(sk, "background-notice");
      }
      const free = cause === "api-unavailable" ? MAX_FREE_PROBES : 0;
      expect(resends).toEqual([...Array(free).fill(1), ...COUNTED]);
      expect(capNotice(sk)).toStartWith("⚠️ Ripresa automatica sospesa");
    });
  }
});

describe("a new message under the fourth resend's cut starts its own count", () => {
  /**
   * The person writes before the sweep caps the chain: their message is new,
   * whatever sits between it and the old chain's last cut. Read off the thread,
   * it inherited the old chain's attempts and was capped at once (verifier
   * probes of 28/09 on the rounds that read past service rows).
   */
  for (const between of BETWEEN) {
    test(`${between} between: its cut is resent from 1 up to the cap`, async () => {
      const sk = topic(`new-message-${between}`);
      await resentTimes(sk, MAX_RESUME_ATTEMPTS, "cut");
      lands(sk, between);
      const next = await open(sk, { messages: [{ role: "user", content: "Lascia stare, fai un'altra cosa" }] }, (h) => h.onTextDelta("Inizio", "Inizio"));
      outageEnd("broker-died")(next.route);
      await drain(next.resp);
      send = resentTurn();
      const resends: unknown[] = [];
      for (let link = 1; link <= MAX_RESUME_ATTEMPTS + 1; link++) {
        const resent = await resumeSweep(sk, { through: true });
        if (resent.length === 0) break;
        resends.push(...resent);
        await cutResent("broker-died");
      }
      expect(resends).toEqual(COUNTED);
      expect(capNotice(sk)).toStartWith("⚠️ Ripresa automatica sospesa");
    });

    test(`${between} between: nobody answered it, and it is resent as the first of its count`, async () => {
      const sk = topic(`new-tail-${between}`);
      await resentTimes(sk, MAX_RESUME_ATTEMPTS, "cut");
      lands(sk, between);
      // The server died before the new message's answer row was born.
      const tail = ctx.appendLocalMessage(sk, "user", "Lascia stare, fai un'altra cosa");
      ctx.db.run("UPDATE messages SET timestamp = ? WHERE id = ?", [new Date(Date.now() - 5 * 60_000).toISOString(), tail.id]);
      expect(await resumeSweep(sk)).toEqual([1]);
    });
  }
});

describe("a wake cut after the chain was answered starts its own count", () => {
  /**
   * The last resend answered in full, and the CLI opens a wake once its
   * background work ends. Cut, the wake is resent as main resends it, from 1:
   * the chain it hangs under is over. Main inherited the answered chain's
   * attempts when nothing sat between (a third resend, or the cap at once),
   * and the rounds that read past service rows did it in every shape.
   */
  for (const k of [2, MAX_RESUME_ATTEMPTS]) {
    for (const between of BETWEEN) {
      test(`answered on resend ${k}, ${between} under the answer, then a wake cut by the watchdog: resent from 1`, async () => {
        const sk = topic(`wake-after-${k}-${between}`);
        await resentTimes(sk, k, "answered");
        lands(sk, between);
        const wake = await open(sk, { messages: [], mode: "woken" }, (h) => {
          h.onTextDelta("Leggo l'output del task", "Leggo l'output del task");
          h.onAborted!({ turnEnd: cancelled("watchdog") } as never);
        });
        await drain(wake.resp);
        expect(await resumeSweep(sk)).toEqual([1]);
      });
    }
  }

  /** The same wake killed with its child before its mark or its words reached the row: the boot's notice hangs from a row with nothing on it. */
  for (const between of ["nothing", "background-notice"] as const) {
    for (const words of [false, true]) {
      test(`answered on resend ${MAX_RESUME_ATTEMPTS}, ${between} under it, a wake${words ? " with words" : ""} hard-killed before its row had them: resent from 1`, async () => {
        const sk = topic(`wake-killed-${between}-${words}`);
        await resentTimes(sk, MAX_RESUME_ATTEMPTS, "answered");
        lands(sk, between);
        const wake = await open(sk, { messages: [], mode: "woken" }, (h) => { if (words) h.onTextDelta("Leggo", "Leggo"); });
        reload(sk, "dead");
        expect(await resumeSweep(sk)).toEqual([1]);
        await wake.resp.body?.cancel().catch(() => {});
      });
    }
  }
});

/**
 * A sub-agent's report that lands while the route is between the resend's
 * copy of the message and the answer row it opens (the checkpoint it awaits):
 * the report hangs from the copy, and the answer row from the report.
 */
async function withReportInTheGap<T>(sk: string, run: () => Promise<T>): Promise<T> {
  const append = ctx.appendLocalMessage;
  ctx.appendLocalMessage = ((...args: Parameters<typeof append>) => {
    const row = append(...args);
    if (args[0] === sk && args[1] === "user") reportLands(sk);
    return row;
  }) as typeof append;
  try { return await run(); } finally { ctx.appendLocalMessage = append; }
}

describe("a service row under the chain's last copy does not answer it", () => {
  /**
   * Verifier probes of 28/09 on the count: a sub-agent's report, a background
   * notice and the machine's line under a stopped turn are written whole
   * (`done`) under the thread's last row. Where that row is the resend's copy
   * of the message, because the route has not opened the answer row yet or
   * never will, the chain read as answered and started over at every link:
   * ten resends of ten, where main capped at four.
   */
  test(`a report between each resend's copy and its answer row, each resend killed with its child: ${MAX_RESUME_ATTEMPTS} resends, then the cap is said`, async () => {
    const sk = topic("report-in-the-gap");
    await answered(sk, "Ciao", "Ciao, dimmi.");
    await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, spawnsSubAgent);
    send = spawnsSubAgent;
    const resends: unknown[] = [];
    for (let link = 1; link <= MAX_RESUME_ATTEMPTS + 3; link++) {
      reload(sk, "dead");
      const resent = await withReportInTheGap(sk, () => resumeSweep(sk, { through: true }));
      if (resent.length === 0) break;
      resends.push(...resent);
    }
    expect(resends).toEqual(COUNTED);
    expect(capNotice(sk)).toStartWith("⚠️ Ripresa automatica sospesa");
  });

  test(`each resend's copy left unanswered by the route, a background notice under it: ${MAX_RESUME_ATTEMPTS} resends, then the cap is said`, async () => {
    const sk = topic("copy-refused");
    await answered(sk, "Ciao", "Ciao, dimmi.");
    const first = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onTextDelta("Lavoro", "Lavoro"));
    outageEnd("broker-died")(first.route);
    await drain(first.resp);
    // The person puts the chat back on the machine's default, which routing cannot reach.
    topic("copy-refused", false);
    const resends: unknown[] = [];
    for (let link = 1; link <= MAX_RESUME_ATTEMPTS + 3; link++) {
      const resent = await resumeSweep(sk, { refused: true });
      if (resent.length === 0) break;
      resends.push(...resent);
      lands(sk, "background-notice");
      // An unanswered message is the sweep's once it is older than a send in flight.
      ctx.db.run("UPDATE messages SET timestamp = ? WHERE session_key = ?", [new Date(Date.now() - 5 * 60_000).toISOString(), sk]);
    }
    expect(resends).toEqual(COUNTED);
    expect(capNotice(sk)).toStartWith("⚠️ Ripresa automatica sospesa");
    // Each resend wrote its copy, and nothing answered any of them.
    expect(ctx.loadLocalMessages(sk).filter((m) => m.role === "user" && m.content === MESSAGE)).toHaveLength(1 + MAX_RESUME_ATTEMPTS);
  });

  /** The answer that hangs from the report is the copy's all the same: once whole, a wake cut after it starts its own count. */
  test("a report between the resend's copy and its answer row, the answer whole, then a wake cut by the watchdog: resent from 1", async () => {
    const sk = topic("report-in-the-gap-answered");
    await answered(sk, "Ciao", "Ciao, dimmi.");
    const first = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onTextDelta("Lavoro", "Lavoro"));
    outageEnd("broker-died")(first.route);
    await drain(first.resp);
    send = resentTurn();
    expect(await withReportInTheGap(sk, () => resumeSweep(sk, { through: true }))).toEqual([1]);
    opened!.onDone({ result: "Build fatto." } as never);
    await drain(live.shift()!);
    const wake = await open(sk, { messages: [], mode: "woken" }, (h) => {
      h.onTextDelta("Leggo l'output del task", "Leggo l'output del task");
      h.onAborted!({ turnEnd: cancelled("watchdog") } as never);
    });
    await drain(wake.resp);
    expect(await resumeSweep(sk)).toEqual([1]);
  });
});

describe("a chain in flight at the deploy goes on from the number main read", () => {
  /**
   * Verifier probe of 28/09: the second resend is live when the deploy
   * restarts the server, before its banner reached the row. Its reattach leg
   * rebuilds the row from the replay, with no banner, under the copy of the
   * message, and the watchdog cuts it. Read off that row and the copy above
   * it, the chain counted from zero: four more resends, six in all. Main
   * walked past the copy to the cut the resend was traced on.
   */
  test("its resend reattached without the banner and cut: resent from 3, then the cap is said", async () => {
    const sk = topic("deploy-reattach");
    await answered(sk, "Ciao", "Ciao, dimmi.");
    const first = await open(sk, { messages: [{ role: "user", content: MESSAGE }] }, (h) => h.onTextDelta("Lavoro", "Lavoro"));
    outageEnd("broker-died")(first.route);
    await drain(first.resp);
    send = resentTurn();
    const before = await resumeSweep(sk, { through: true });
    await cutResent("broker-died");
    before.push(...await resumeSweep(sk, { through: true }));
    expect(before).toEqual([1, 2]);
    // The deploy: the rows were written before the table, which is born empty.
    ctx.db.run("DELETE FROM resend_counts WHERE session_key = ?", [sk]);
    // The old process's route, mute after the restart: not the next resend's to read.
    const oldRoute = live.shift()!;
    reload(sk, "alive");
    await reattachLeg(sk, (h) => { h.onTextDelta("Riprendo il build", "Riprendo il build"); h.onAborted!({ turnEnd: cancelled("watchdog") } as never); });
    expect(ctx.loadLocalMessages(sk).at(-1)!.blocks?.some((b) => b.kind === "ripreso")).toBe(false);
    const after: unknown[] = [];
    try {
      for (let link = 1; link <= MAX_RESUME_ATTEMPTS + 2; link++) {
        const resent = await resumeSweep(sk, { through: true });
        if (resent.length === 0) break;
        after.push(...resent);
        await cutResent("broker-died");
      }
    } finally { await oldRoute.body?.cancel().catch(() => {}); }
    expect(after).toEqual([3, 4]);
    expect(capNotice(sk)).toStartWith("⚠️ Ripresa automatica sospesa");
  });
});
