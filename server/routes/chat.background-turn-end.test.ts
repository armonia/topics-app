/**
 * A turn that ends WAITING on its own background work is not a finished turn
 * (notifications-redesign 1.1, defects D1 and bgwait-1).
 *
 * Driven on the real chat route and the real registered ClaudeCodeProvider,
 * fed the CLI session recorded on 25/09 (`background-work.fixture.ts`): the
 * first turn launches a background Agent, a background Bash and a Monitor,
 * answers "Launched." and ends; seven turns the CLI opens by itself follow,
 * one per report, and the eighth ends with nothing left running.
 *
 * Today the first `stream:end` reads as a clean "your turn" (no word of the
 * work), so the push, the bell row and the blue fill all fire on a chat that is
 * waiting. The contract: `stream:end` carries `background.count`, the subject
 * stays `background` with no history row and no push, and the whole wait
 * announces ONCE, when the last turn ends with nothing in flight.
 *
 * A turn that arms a RECURRING cron is a calendar, not a wait: it ends
 * `finished(done)` with `background.count = 0`, while the goal loop keeps
 * reading the cron as background work (`backgroundOfTurn`).
 * @covers ATTN-02
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { registerProvider, removeProvider } from "../providers";
import { ClaudeCodeProvider } from "../providers/claude-code";
import { SidechainTracker } from "../providers/claude/sidechain-tracker";
import { recordedBackgroundSession, recordedSessionCron } from "../providers/claude/background-work.fixture";
import { backgroundOfTurn } from "../services/goal-continuation";
import { getDatabase } from "../db";
import { configureAttentionStore, getAttention, resetAttentionStore } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import type { StreamHandler } from "../providers/types";
import type { AppContext } from "../types";
import type { Topic } from "../types";

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

const ROOT = testTmpDir("chat-bg-turn-end-attn");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => { removeProvider("claude-code"); ClaudeCodeProvider.observeWokenTurns(() => {}); cleanupTestDataDir(ROOT); });

type Frame = Record<string, unknown>;

interface Harness {
  ctx: AppContext;
  frames: Frame[];
  pushes: unknown[];
  provider: ClaudeCodeProvider;
  pp: Record<string, any>;
  router: ReturnType<typeof createChatRouter>;
  topic: Topic;
  /** Every POST the route answered, so the test can wait for the woken ones. */
  inflight: Promise<unknown>[];
}

async function harness(label: string): Promise<Harness> {
  const ctx = await createTestAppContext();
  const frames: Frame[] = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Frame); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Frame); };
  const pushes: unknown[] = [];
  configureAttentionStore({ sendPush: (p) => { pushes.push(p); } });

  const sessionKey = `topic:${label}`;
  const topic = {
    id: `t-${label}`, name: label, slug: label, parentId: null, links: [], sessionKey,
    color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "claude-code",
  } as Topic;
  ctx.saveSingleTopic(topic);

  const provider = registerProvider({ type: "claude-code" } as never) as ClaudeCodeProvider;
  const pp: Record<string, any> = {
    sessionKey, alive: true, streamHandler: null, pendingResolve: null, pendingReject: null,
    fullText: "", activeToolCalls: new Set(), subAgentEmit: new Map(), sidechain: new SidechainTracker(),
    pendingInputs: new Map(), lastEventAt: Date.now(), inactivityTimer: null, lifetimeTimer: null, heartbeatInterval: null,
    readline: { close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    spawnedWith: { autonomy: null, model: null, effort: null },
  };
  (provider as any).processes.set(sessionKey, pp);
  (provider as any).sendChat = (_sk: string, _msg: string, handler: StreamHandler) => new Promise((resolve, reject) => {
    pp.streamHandler = handler; pp.preRegistered = null; pp.pendingResolve = resolve; pp.pendingReject = reject;
  });

  const router = createChatRouter(ctx, {
    resolveProvider: () => provider,
    detectLocalhostAutoNav: () => {},
    bindTopicToProject: () => {},
    resolveProjectRef: () => null,
    getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [],
    autoBindProject: () => {},
    watchSessionForSubagents: () => {},
    updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(),
    WORKSPACE_DIR: `${ROOT}/ws`,
  } as never);
  const inflight: Promise<unknown>[] = [];
  // A wake the CLI opens by itself goes through the same route, as
  // `adottaTurniRisvegliati` in server.ts does it.
  ClaudeCodeProvider.observeWokenTurns((sk) => {
    if (sk !== sessionKey) return false;
    inflight.push(post(router, { sessionKey, messages: [], mode: "woken", provider: "claude-code" }));
    return true;
  });
  return { ctx, frames, pushes, provider, pp, router, topic, inflight };
}

async function post(router: Harness["router"], body: Record<string, unknown>): Promise<unknown> {
  const url = new URL("http://topics.test/api/chat");
  const resp = await router(new Request(url.toString(), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), url, "/api/chat", "POST");
  resp?.body?.cancel().catch(() => {});
  return resp;
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const pending = h.inflight.splice(0);
    await Promise.all(pending);
    await Bun.sleep(15);
    if (h.inflight.length === 0) return;
  }
}

function historyRows(topicId: string): number {
  return (getDatabase().query("SELECT COUNT(*) AS c FROM notification_log WHERE target_id = ?").get(topicId) as { c: number }).c;
}

const streamEnds = (h: Harness) => h.frames.filter((f) => f.type === "stream:end" && f.sessionKey === h.pp.sessionKey);

describe("a chat turn that leaves background work running", () => {
  beforeEach(() => { removeProvider("claude-code"); });

  test("ends as background, and the whole wait announces once at turn 8", async () => {
    const h = await harness("bg-wait");
    const events = recordedBackgroundSession();
    const firstResult = events.findIndex((e) => e.type === "result");

    await post(h.router, { sessionKey: h.pp.sessionKey, messages: [{ role: "user", content: "launch the three background jobs" }] });
    for (let i = 0; i < 50 && !h.pp.streamHandler; i++) await Bun.sleep(10);
    expect(h.pp.streamHandler).not.toBeNull();

    for (const e of events.slice(0, firstResult + 1)) (h.provider as any).handleStreamEvent(h.pp, e);
    await Bun.sleep(120);

    const first = streamEnds(h)[0];
    expect(first).toBeDefined();
    // The frame says what the chat waits on: the Agent, the Bash, the Monitor.
    expect((first.background as { count: number } | undefined)?.count).toBe(3);
    const subject = topicSubject(h.topic.id);
    expect(getAttention(subject).state).toBe("working");
    expect(getAttention(subject).epoch).toBe(0);
    expect(historyRows(h.topic.id)).toBe(0);
    expect(h.pushes).toHaveLength(0);

    // The seven turns the CLI opens by itself, each adopted through the route.
    for (const e of events.slice(firstResult + 1)) {
      (h.provider as any).handleStreamEvent(h.pp, e);
      await settle(h);
    }
    await Bun.sleep(150);
    await settle(h);

    const ends = streamEnds(h);
    expect(ends.length).toBe(8);
    // Every woken turn but the last still had work in flight: no announce.
    for (const end of ends.slice(0, -1)) {
      expect(((end.background as { count: number } | undefined)?.count ?? 0) > 0).toBe(true);
    }
    expect((ends.at(-1)!.background as { count: number } | undefined)?.count ?? 0).toBe(0);
    const final = getAttention(subject);
    expect(final.state).toBe("finished");
    expect(final.outcome).toBe("done");
    // ONE epoch for the whole session, one history row, one push.
    expect(final.epoch).toBe(1);
    expect(historyRows(h.topic.id)).toBe(1);
    expect(h.pushes).toHaveLength(1);
  });

  test("a recurring cron ends the turn finished(done) with background.count 0, and the goal loop still waits on it", async () => {
    const h = await harness("cron-recurring");
    const lines = recordedSessionCron().map(({ event }) => {
      // The recording armed a one-shot; the same lines with `recurring: true`
      // are what CronCreate answers for a /loop.
      // Dated now: a cron armed on 25/09 is past the two-hour bound today.
      const r = (event as { tool_use_result?: Record<string, unknown> }).tool_use_result;
      if (r && typeof r.id === "string" && "recurring" in r) return { ...event, timestamp: new Date().toISOString(), tool_use_result: { ...r, recurring: true } };
      return event;
    });
    const firstResult = lines.findIndex((e) => e.type === "result");

    await post(h.router, { sessionKey: h.pp.sessionKey, messages: [{ role: "user", content: "check CI every five minutes" }] });
    for (let i = 0; i < 50 && !h.pp.streamHandler; i++) await Bun.sleep(10);
    for (const e of lines.slice(0, firstResult + 1)) (h.provider as any).handleStreamEvent(h.pp, e);
    await Bun.sleep(120);

    const end = streamEnds(h)[0];
    expect(end).toBeDefined();
    expect((end.background as { count: number } | undefined)?.count ?? -1).toBe(0);
    const subject = topicSubject(h.topic.id);
    expect(getAttention(subject).state).toBe("finished");
    expect(getAttention(subject).outcome).toBe("done");
    // The cron is in the map, marked recurring: shown, never counted.
    expect(getAttention(subject).background).toEqual([expect.objectContaining({ kind: "cron", recurring: true })]);
    // The goal loop's own reading is unchanged: the armed cron defers its verdict.
    expect(backgroundOfTurn(h.provider, h.pp.sessionKey).backgroundWork).toBe(true);
  });
});
