/**
 * A ROW TAKEN BACK BY A REATTACH KEEPS THE MARKS IT OPENS WITH, AND THE RESUME
 * READS THEM THE SAME AFTER A RESTART AS BEFORE.
 * @covers RESUME-01, CHAT-BUBBLE-02
 *
 * The marks are a wake's `woken` and a resend's `ripreso`. Two things had to
 * hold for them to survive a restart, and each test goes through both:
 *   - the route that OPENS the row writes them on it before any event. They
 *     used to reach the row with the first tool or the tenth chunk, and a wake
 *     or a probe into an API still down sees neither: only `api_retry`, or a
 *     model still thinking. A reload in that window left a row without them;
 *   - the reattach that takes the row back keeps them, since its replay never
 *     writes them (it is neither a wake nor a resend).
 * Lost, they cost two things: a wake cut by an outage on the reattached leg
 * was promised "Riprende da solo" and the sweep resent the person's previous
 * message, one the turn before the wake had already answered (a second paid
 * turn); a free probe into an API still down spent a resume attempt, and the
 * chat lost its redone-answer banner while offering Retry.
 *
 * Every row under test is opened by the real route (`mode: "woken"`, or a
 * resend with `ripresa`), left open as a reload leaves it (the broker only
 * detaches), then taken through the boot's partial sweep, the reattach route
 * (`mode: "reattach"`), the end of the leg and the real resume sweep. Nothing
 * writes the marks by hand.
 *
 * And the marks are still not work. A row of marks alone that NO reattach takes
 * back (the broker's list unconfirmed at boot, the daemon gone) is an empty
 * placeholder to the history's cleanup, as it was when the marks lived in
 * memory only: deleted, so the sweep finds the person's message unanswered and
 * resends it. Kept as work, it was closed with its banner alone, and the
 * message was never resent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { createHistoryRouter } from "./history";
import { _resetTurnBodyFlushers } from "../lib/turn-body-flush";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { endReattachLeg } from "../lib/closed-outside";
import { resumeVerdict, riprendiTurniInterrotti } from "../lib/ripresa-boot";
import { outageNoticeResumes } from "../lib/cancelled-notice";
import { clearProviderHold, resetProviderHoldStore } from "../lib/provider-hold";
import { decodeCol } from "../../shared/message-blob";
import { isRedoneAnswer, turnIsOnlyError } from "../../client/src/components/Chat/turnError";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, ContentBlock, Topic } from "../types";

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

/**
 * One provider for both servers. Before the reload it opens the turn: a wake
 * the CLI started on its own (`adoptWokenTurn`), or a resend whose CLI is still
 * retrying (`sendChat` never settles). After it, the broker hands the reattach
 * leg the replay of the turn in flight, then how it ended.
 */
let opened: StreamHandler | undefined;
let replay: (h: StreamHandler) => void = () => {};
const provider = {
  name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
  get connected() { return true; },
  registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
  adoptWokenTurn: (_sk: string, h: StreamHandler) => { opened = h; return true; },
  sendChat: (_sk: string, _content: unknown, h: StreamHandler) => { opened = h; return new Promise(() => {}); },
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
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: body.sessionKey, provider: "claude-code", ...body }) }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  return resp;
}

/**
 * The turn as the old server leaves it: the route opened the row, the CLI got
 * as far as `live` shows, then the server reloaded. Returns the row's id and a
 * teardown for the route this process still holds (a real reload kills it).
 */
async function openThenReload(sk: string, body: Record<string, unknown>, live: (h: StreamHandler) => void) {
  opened = undefined;
  const resp = await post({ sessionKey: sk, ...body });
  const row = ctx.loadLocalMessages(sk).filter((m) => m.role === "assistant").at(-1)!;
  live(opened!);
  const oldRoute = opened!;
  bootWithChildAlive(sk);
  return {
    rowId: row.id,
    teardown: async () => {
      oldRoute.onAborted?.({ turnEnd: { end: "cancelled", cause: "server-shutdown" } } as never);
      await resp.body?.cancel().catch(() => {});
    },
  };
}

/** A reattach leg through the real route, read to its end, then ended as server.ts ends it (broker idle). */
async function reattachLeg(sk: string, emit: (h: StreamHandler) => void): Promise<void> {
  replay = emit;
  const resp = await post({ sessionKey: sk, messages: [], mode: "reattach", dispatched: true });
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

/** The `blocks` column as it is on disk, not as a reader's flush would make it. */
const blocksOnDisk = (id: string): unknown => {
  const raw = decodeCol((ctx.db.prepare("SELECT blocks FROM messages WHERE id = ?").get(id) as { blocks: unknown }).blocks);
  return raw ? JSON.parse(raw) : null;
};
const blocksOf = (id: string): ContentBlock[] => ctx.getMessageById(id)?.blocks ?? [];
const verdictOf = (id: string) => {
  const row = ctx.getMessageById(id)!;
  return resumeVerdict({ sessionKey: row.id, ruolo: "assistant", blocks: row.blocks ?? [], timestampMs: Date.parse(row.timestamp), attempts: 0 }, Date.now());
};
const lastError = (blocks: ContentBlock[]) => blocks.filter((b) => b.kind === "error").at(-1) as { text: string; cause?: string } | undefined;
const retry = (attempt: number) => ({ attempt, maxAttempts: 10, delayMs: 30_000, reason: "overloaded" });

describe("a wake reattached after a restart and then cut by an outage is not resumed", () => {
  // What the wake's CLI had done when the server reloaded: nothing but retries
  // into the dark API, or thinking. Neither writes the row.
  const beforeReload = {
    "only retries": (h: StreamHandler) => { h.onRetry!(retry(1)); h.onRetry!(retry(2)); },
    "thinking": (h: StreamHandler) => { for (let i = 0; i < 40; i++) h.onThinkingDelta!(`pensiero ${i} `); },
  } as const;
  for (const [seen, live] of Object.entries(beforeReload)) {
    for (const cause of ["api-unavailable", "broker-died"] as const) {
      test(`${seen}, then ${cause}: the row keeps its woken mark, the notice asks the person, and the sweep resends nothing`, async () => {
        const sk = topic(`reattach-wake-${seen.replace(" ", "-")}-${cause}`);
        ctx.appendLocalMessage(sk, "user", "Lancia il build e avvisami");
        const first = ctx.createPartialMessage(sk, "assistant");
        ctx.updateLastMessage(sk, { content: "Build lanciato, ti avviso.", partial: undefined, streamedAt: undefined, latencyMs: 500, endReason: "done" }, { rowId: first.id });
        // The Monitor wakes the agent: the route opens the wake's row, then a save reloads the server.
        const wake = await openThenReload(sk, { messages: [], mode: "woken", wokenLabel: "build finito" }, live);
        expect(wake.rowId).not.toBe(first.id);
        expect(blocksOnDisk(wake.rowId)).toEqual([{ kind: "woken", label: "build finito" }]);
        // The replay starts from the wake's own start, then the outage.
        await reattachLeg(sk, (h) => {
          if (seen === "thinking") {
            for (let i = 0; i < 40; i++) h.onThinkingDelta!(`pensiero ${i} `);
            h.onToolStart("t1", "Bash", {});
            h.onToolResult("t1", "ok");
            h.onTextDelta("Il build è passato, ", "Il build è passato, ");
          }
          if (cause === "api-unavailable") h.onDone({ result: "", turnEnd: { end: "error", cause, detail: "Request timed out" } } as never);
          else h.onAborted!({ turnEnd: { end: "error", cause } } as never);
        });
        const blocks = blocksOf(wake.rowId);
        expect(blocks[0]).toEqual({ kind: "woken", label: "build finito" });
        const notice = lastError(blocks)!;
        expect(notice.cause).toBe(cause);
        expect(outageNoticeResumes(`⚠️ ${notice.text}`)).toBe(false);
        expect(verdictOf(wake.rowId)).toBe("no");
        expect(await sweep(sk)).toEqual([]);
        await wake.teardown();
      });
    }
  }
});

describe("a free probe reattached after a restart stays free", () => {
  test("its CLI only retrying when the server reloads, then cut by the API still down: it keeps its banner, the sweep resends it without spending an attempt, and the chat shows the redone answer", async () => {
    const sk = topic("reattach-probe");
    const cut = (at: string) => ({ kind: "error", text: "Turno interrotto: l'API di Claude non rispondeva più.", cause: "api-unavailable", at }) as ContentBlock;
    ctx.appendLocalMessage(sk, "user", "Misura la catena");
    // The first cut, traced by the sweep that resent it (attempt 1, counted).
    const cutRow = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { content: "", blocks: [cut(new Date(Date.now() - 60_000).toISOString()), { kind: "ripreso", attempt: 1 }], partial: undefined, streamedAt: undefined, latencyMs: 10, endReason: "done" }, { rowId: cutRow.id });
    // The resend is the probe: the route opens its row, its CLI retries into the blackout.
    const probe = await openThenReload(sk, { messages: [{ role: "user", content: "Misura la catena" }], ripresa: 1 }, (h) => h.onRetry!(retry(1)));
    expect(blocksOnDisk(probe.rowId)).toEqual([{ kind: "ripreso", attempt: 1 }]);
    // Nothing to replay but retries, then the CLI gives up on the API.
    await reattachLeg(sk, (h) => h.onDone({ result: "", turnEnd: { end: "error", cause: "api-unavailable", detail: "API Error: Request timed out" } } as never));
    const blocks = blocksOf(probe.rowId);
    expect(blocks.map((b) => b.kind)).toEqual(["ripreso", "error"]);
    expect(isRedoneAnswer(blocks)).toBe(true);
    // Retry is not offered under a notice that says the chat resumes by itself.
    expect(turnIsOnlyError({ ...ctx.getMessageById(probe.rowId)!, blocks })).toBe(false);
    expect(await sweep(sk)).toEqual([1]);
    await probe.teardown();
  });
});

describe("a row of opening marks that no reattach takes back is an empty placeholder to the history", () => {
  /** The reload of `openThenReload`, with the broker's list unconfirmed: the
   *  new process holds no stream and no flusher, and keeps every open row. */
  async function openThenReloadUnadopted(sk: string, body: Record<string, unknown>) {
    opened = undefined;
    const resp = await post({ sessionKey: sk, ...body });
    const rowId = ctx.loadLocalMessages(sk).filter((m) => m.role === "assistant").at(-1)!.id;
    const oldRoute = opened!;
    oldRoute.onRetry!(retry(1));
    _resetTurnBodyFlushers();
    ctx.activeStreams.delete(sk);
    runBootPartialSweep(ctx.db as unknown as PartialSweepDb, { listConfirmed: false, liveSessions: new Set() });
    return {
      rowId,
      teardown: async () => {
        oldRoute.onAborted?.({ turnEnd: { end: "cancelled", cause: "server-shutdown" } } as never);
        await resp.body?.cancel().catch(() => {});
      },
    };
  }
  /** A window opening the chat with the broker unreachable. `limit` 0 is the
   *  pane's whole-thread read, 50 the capped one: two readers of the partials. */
  async function openHistory(sk: string, limit: number): Promise<void> {
    const router = createHistoryRouter(ctx, {
      matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
      providerForSessionKey: () => ({ brokerTurnState: async () => "unknown" }) as never,
    });
    const path = `/api/history/${encodeURIComponent(sk)}`;
    const url = new URL(`http://topics.test${path}`);
    const resp = (await router(new Request(url, { method: "POST", body: JSON.stringify({ limit }), headers: { "content-type": "application/json" } }), url, path, "POST"))!;
    expect(resp.status).toBe(200);
  }
  /** Minutes later, past the grace a person's unanswered message gets. */
  const minutesLater = (sk: string) =>
    ctx.db.run("UPDATE messages SET timestamp = ? WHERE session_key = ?", [new Date(Date.now() - 3 * 60_000).toISOString(), sk]);
  const rowExists = (id: string) => ctx.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id) != null;

  for (const limit of [0, 50]) {
    test(`a resend lost with its CLI retrying is deleted by the history (limit ${limit}) and resent by the sweep`, async () => {
      const sk = topic(`unadopted-probe-${limit}`);
      ctx.appendLocalMessage(sk, "user", "Misura la catena");
      const cutRow = ctx.createPartialMessage(sk, "assistant");
      const cut = { kind: "error", text: "Turno interrotto: l'API di Claude non rispondeva più.", cause: "api-unavailable", at: new Date(Date.now() - 60_000).toISOString() } as ContentBlock;
      ctx.updateLastMessage(sk, { content: "", blocks: [cut, { kind: "ripreso", attempt: 1 }], partial: undefined, streamedAt: undefined, latencyMs: 10, endReason: "done" }, { rowId: cutRow.id });
      const probe = await openThenReloadUnadopted(sk, { messages: [{ role: "user", content: "Misura la catena" }], ripresa: 1 });
      expect(blocksOnDisk(probe.rowId)).toEqual([{ kind: "ripreso", attempt: 1 }]);
      await openHistory(sk, limit);
      expect(rowExists(probe.rowId)).toBe(false);
      minutesLater(sk);
      expect(await sweep(sk)).toEqual([2]);
      await probe.teardown();
    });

    test(`a wake lost before it produced anything is deleted by the history (limit ${limit}), and the answered message is not resent`, async () => {
      const sk = topic(`unadopted-wake-${limit}`);
      ctx.appendLocalMessage(sk, "user", "Lancia il build e avvisami");
      const first = ctx.createPartialMessage(sk, "assistant");
      ctx.updateLastMessage(sk, { content: "Build lanciato, ti avviso.", partial: undefined, streamedAt: undefined, latencyMs: 500, endReason: "done" }, { rowId: first.id });
      const wake = await openThenReloadUnadopted(sk, { messages: [], mode: "woken", wokenLabel: "build finito" });
      expect(blocksOnDisk(wake.rowId)).toEqual([{ kind: "woken", label: "build finito" }]);
      await openHistory(sk, limit);
      expect(rowExists(wake.rowId)).toBe(false);
      minutesLater(sk);
      expect(await sweep(sk)).toEqual([]);
      await wake.teardown();
    });
  }
});
