/**
 * THE TURN-END HOOK IS READ IN CHAT AND NEVER HOLDS THE TURN.  @covers HOOKS-02
 *
 * The route fires the user's `turn-end` hook in the same deferred slot as the
 * goal loop, after the stream is finalised. Three things are proven on the
 * `chat.cut-turn-notice` harness: a refusing hook becomes one more assistant
 * row plus the two broadcasts the system-message verb sends; a provider that
 * is not the native runtime never triggers it; and a hook that has not
 * answered yet does not keep the assistant row partial, which is the
 * "SHALL NEVER block" of the spec measured on the row.
 *
 * And the continuation (HOOKS-04): a hook that answers `{"decision":"block"}`
 * buys exactly one marked `user` row through this very route, the next turn's
 * payload says `stop_hook_active`, and the fourth request in a row is ignored.
 * @covers HOOKS-04
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { setGoal } from "../services/goals";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";
import type { LifecycleHookPayload, HookOutcome } from "../services/lifecycle-hooks";
import type { ContentBlock } from "../types";

const ROOT = testTmpDir("chat-turn-end-hook");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const WS = testTmpDir("chat-turn-end-hook-ws");

interface Harness {
  frames: Array<Record<string, unknown>>;
  seen: Array<[string, LifecycleHookPayload]>;
  startTurn: (sessionKey: string) => Promise<StreamHandler>;
  assistantRows: (sessionKey: string) => Array<{ content: string; partial: boolean }>;
  userRows: (sessionKey: string) => Array<{ content: string; blocks?: ContentBlock[] }>;
  /** The StreamHandler of the latest turn the route started (a continuation's too). */
  latest: () => StreamHandler | undefined;
  /** POST a message to the route with extra body fields (a machine turn); the new turn's handler. */
  post: (sessionKey: string, content: string, extra?: Record<string, unknown>) => Promise<StreamHandler | undefined>;
  ctx: AppContext;
}

async function harness(opts: { providerName: string; answer: () => Promise<HookOutcome>; verdicts?: string[] }): Promise<Harness> {
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: opts.providerName,
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    // The goal loop's judge: an answer per call when the test gives them.
    complete: async () => ({ content: opts.verdicts?.shift() ?? "" }),
  } as unknown as AIProvider;

  const seen: Array<[string, LifecycleHookPayload]> = [];
  const chatRouter = createChatRouter(ctx, {
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
    WORKSPACE_DIR: WS,
    hooks: { run: (event: string, payload: LifecycleHookPayload) => { seen.push([event, payload]); return opts.answer(); } },
  } as never);

  const post = async (sessionKey: string, content: string, extra: Record<string, unknown> = {}) => {
    const before = captured;
    const url = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...extra }),
    }), url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    for (let i = 0; i < 40 && captured === before; i++) await Bun.sleep(50);
    return captured;
  };

  const startTurn = async (sessionKey: string): Promise<StreamHandler> => {
    const topic: Topic = {
      id: `t-${sessionKey}`, name: "hook", slug: "hook", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: opts.providerName,
    } as Topic;
    ctx.saveSingleTopic(topic);
    captured = undefined;
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "hello" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  const assistantRows = (sessionKey: string) =>
    (ctx as AppContext).loadLocalMessages(sessionKey)
      .filter((m) => m.role === "assistant")
      .map((m) => ({ content: m.content, partial: m.partial === true }));

  const userRows = (sessionKey: string) =>
    (ctx as AppContext).loadLocalMessages(sessionKey)
      .filter((m) => m.role === "user")
      .map((m) => ({ content: m.content, blocks: m.blocks as ContentBlock[] | undefined }));

  return { frames, seen, startTurn, assistantRows, userRows, latest: () => captured, post, ctx: ctx as AppContext };
}

const settle = () => Bun.sleep(80);

describe("the turn-end hook in the chat route", () => {
  test("a refusing hook: its stderr is one more assistant row, broadcast like a system message", async () => {
    const h = await harness({ providerName: "topics", answer: async () => ({ ok: false, reason: "tests are red, fix them first" }) });
    const sk = "topic:turn-end-refused";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]![0]).toBe("turn-end");
    expect(h.seen[0]![1]).toEqual({ hook_event_name: "turn-end", session_id: sk, cwd: WS, stop_hook_active: false });

    const rows = h.assistantRows(sk);
    expect(rows.map((r) => r.content)).toEqual(["done", "tests are red, fix them first"]);
    expect(rows.every((r) => !r.partial)).toBe(true);
    const wire = h.frames.find((f) => f.type === "message:new" && f.content === "tests are red, fix them first");
    expect(wire).toMatchObject({ sessionKey: sk, role: "assistant", topicId: `t-${sk}` });
    expect(h.frames.some((f) => f.type === "message" && (f.message as { content?: string })?.content === "tests are red, fix them first")).toBe(true);
  });

  test("a hook that exits zero changes nothing", async () => {
    const h = await harness({ providerName: "topics", answer: async () => ({ ok: true }) });
    const sk = "topic:turn-end-silent";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();
    expect(h.seen).toHaveLength(1);
    expect(h.assistantRows(sk).map((r) => r.content)).toEqual(["done"]);
  });

  test("a provider that is not the native runtime never fires it", async () => {
    const h = await harness({ providerName: "fake-stream", answer: async () => ({ ok: false, reason: "never read" }) });
    const sk = "topic:turn-end-other-provider";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();
    expect(h.seen).toEqual([]);
    expect(h.assistantRows(sk).map((r) => r.content)).toEqual(["done"]);
  });

  test("a hook that has not answered does not hold the turn: the row is final before the verdict", async () => {
    let release: (v: HookOutcome) => void = () => {};
    const pending = new Promise<HookOutcome>((r) => { release = r; });
    const h = await harness({ providerName: "topics", answer: () => pending });
    const sk = "topic:turn-end-slow";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();

    // The hook was asked and is still running: the turn is already over.
    expect(h.seen).toHaveLength(1);
    const rows = h.assistantRows(sk);
    expect(rows).toEqual([{ content: "done", partial: false }]);
    expect(h.frames.some((f) => f.type === "stream:end")).toBe(true);

    release({ ok: false, reason: "late verdict" });
    await settle();
    expect(h.assistantRows(sk).map((r) => r.content)).toEqual(["done", "late verdict"]);
  });
});

describe("a turn-end hook that asks to carry on (HOOKS-04)", () => {
  /** The handler of the turn the route starts after `prev`, or `prev` when none comes within 2 s. */
  const nextTurn = async (h: Harness, prev: StreamHandler) => {
    for (let i = 0; i < 40 && h.latest() === prev; i++) await Bun.sleep(50);
    return h.latest();
  };
  const end = (h: StreamHandler, text: string) => {
    h.onTextDelta(text, text);
    h.onDone({ result: text, turnEnd: { end: "end_turn" } });
  };

  test("one marked user row through the route, and the next payload says stop_hook_active", async () => {
    let asks = 1;
    const h = await harness({
      providerName: "topics",
      answer: async () => (asks-- > 0 ? { ok: true, continueWith: "run the retrospective" } : { ok: true }),
    });
    const sk = "topic:turn-end-continue";
    const first = await h.startTurn(sk);
    end(first, "puoi chiuderla");
    await settle();

    // Exactly one row the hook bought, marked, never the person's.
    const users = h.userRows(sk);
    expect(users.map((u) => u.content)).toEqual(["hello", "run the retrospective"]);
    expect((users[0]!.blocks ?? []).some((b) => b.kind === "hook-nudge")).toBe(false);
    expect(users[1]!.blocks).toEqual([{ kind: "hook-nudge", attempt: 1 }]);
    expect(h.seen[0]![1].stop_hook_active).toBe(false);

    // The continuation's turn is a real turn of the route: when it ends the
    // hook runs again and is told a hook started it.
    const second = await nextTurn(h, first);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    end(second!, "retrospective done");
    await settle();
    expect(h.seen).toHaveLength(2);
    expect(h.seen[1]![1]).toEqual({ hook_event_name: "turn-end", session_id: sk, cwd: WS, stop_hook_active: true });
    // It said nothing this time: no third user row.
    expect(h.userRows(sk)).toHaveLength(2);
  });

  test("a hook that always asks stops after 3 continuations in a row", async () => {
    const h = await harness({ providerName: "topics", answer: async () => ({ ok: true, continueWith: "again" }) });
    const sk = "topic:turn-end-ceiling";
    let turn = await h.startTurn(sk);
    for (let i = 0; i < 4; i++) {
      end(turn, `turn ${i}`);
      await settle();
      const next = i < 3 ? await nextTurn(h, turn) : h.latest();
      if (next === turn) break;
      turn = next!;
    }
    const nudges = h.userRows(sk).filter((u) => u.blocks?.some((b) => b.kind === "hook-nudge"));
    expect(nudges.map((u) => u.blocks)).toEqual([
      [{ kind: "hook-nudge", attempt: 1 }],
      [{ kind: "hook-nudge", attempt: 2 }],
      [{ kind: "hook-nudge", attempt: 3 }],
    ]);
    // Four ends, four hook runs, the last one ignored.
    expect(h.seen).toHaveLength(4);
    expect(h.seen.map(([, p]) => p.stop_hook_active)).toEqual([false, true, true, true]);
  });

  test("a turn the person stopped is not continued", async () => {
    const h = await harness({ providerName: "topics", answer: async () => ({ ok: true, continueWith: "carry on" }) });
    const sk = "topic:turn-end-cancelled";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("half", "half");
    handler.onDone({ result: "half", turnEnd: { end: "cancelled" } });
    await settle();
    expect(h.userRows(sk).map((u) => u.content)).toEqual(["hello"]);
  });

  // ── Defects found by the independent review of PR 1623 ────────────────────
  const hookRows = (h: Harness, sk: string) =>
    h.userRows(sk).filter((u) => u.blocks?.some((b) => b.kind === "hook-nudge"));

  test("defect 1: a machine turn in between does not reset the ceiling", async () => {
    // The hook asks every time but the second: there a goal nudge (a machine
    // turn, no hook attempt on its body) takes the next turn instead.
    let call = 0;
    const h = await harness({
      providerName: "topics",
      answer: async () => (++call === 2 ? { ok: true } : { ok: true, continueWith: "again" }),
    });
    const sk = "topic:turn-end-machine-between";
    let turn = await h.startTurn(sk);
    end(turn, "t0"); await settle();              // hook asks -> nudge 1
    turn = (await nextTurn(h, turn))!;
    end(turn, "t1"); await settle();              // hook silent
    turn = (await h.post(sk, "Objective still open: carry on", { goalNudge: 1 }))!;
    for (let i = 0; i < 4; i++) {
      end(turn, `m${i}`); await settle();
      const next = await nextTurn(h, turn);
      if (next === turn) break;
      turn = next!;
    }
    expect(hookRows(h, sk).map((u) => u.blocks)).toEqual([
      [{ kind: "hook-nudge", attempt: 1 }],
      [{ kind: "hook-nudge", attempt: 2 }],
      [{ kind: "hook-nudge", attempt: 3 }],
    ]);
  });

  test("defect 2: a hook that answers after a newer turn does not send the old continuation", async () => {
    let release: (v: HookOutcome) => void = () => {};
    let first = true;
    const h = await harness({
      providerName: "topics",
      answer: () => {
        if (!first) return Promise.resolve({ ok: true });
        first = false;
        return new Promise<HookOutcome>((r) => { release = r; });
      },
    });
    const sk = "topic:turn-end-stale";
    const t0 = await h.startTurn(sk);
    end(t0, "done"); await settle();
    // Meanwhile the person sends T1 and stops it.
    const t1 = await h.post(sk, "one more thing");
    t1!.onTextDelta("half", "half");
    t1!.onDone({ result: "half", turnEnd: { end: "cancelled" } });
    await settle();
    release({ ok: true, continueWith: "stale verdict about T0" });
    await settle();
    expect(hookRows(h, sk)).toEqual([]);
  });

  test("defect 4: a native sub-agent's chat is never continued by a hook", async () => {
    const h = await harness({ providerName: "topics", answer: async () => ({ ok: true, continueWith: "carry on" }) });
    const sk = "topic:turn-end-subagent";
    (h.ctx.db as unknown as { run: (sql: string, ...a: string[]) => void }).run(
      `INSERT INTO subagents (id, parent_session_key, name, cwd, state, created_at, runtime, session_key) VALUES (?, 'topic:parent', 'child', ?, 'retired', ?, 'topics', ?)`,
      `t-${sk}`, WS, new Date().toISOString(), sk,
    );
    const handler = await h.startTurn(sk);
    end(handler, "report"); await settle();
    expect(hookRows(h, sk)).toEqual([]);
    const state = (h.ctx.db as unknown as { query: (s: string) => { get: (...a: string[]) => { state: string } } })
      .query("SELECT state FROM subagents WHERE session_key = ?").get(sk);
    expect(state.state).toBe("retired");
  });

  test("defect 5: when the goal loop buys a turn, the hook does not buy a second one for the same end", async () => {
    const h = await harness({ providerName: "topics", verdicts: ["continue", "met"], answer: async () => ({ ok: true, continueWith: "carry on" }) });
    const sk = "topic:turn-end-goal";
    const t0 = await h.startTurn(sk);
    setGoal(h.ctx.db as never, { topicId: `t-${sk}`, content: "finish the refactor" });
    end(t0, "step done");
    // The goal loop continues: its turn, and no hook row beside it.
    const goalTurn = await nextTurn(h, t0);
    expect(goalTurn).not.toBe(t0);
    await settle();
    expect(hookRows(h, sk)).toEqual([]);
    // The goal is met at the end of its turn: that end is the hook's, once.
    end(goalTurn!, "all done");
    await nextTurn(h, goalTurn!);
    await settle();
    const users = h.userRows(sk);
    expect(users.filter((u) => u.blocks?.some((b) => b.kind === "goal-nudge"))).toHaveLength(1);
    expect(hookRows(h, sk).map((u) => u.blocks)).toEqual([[{ kind: "hook-nudge", attempt: 1 }]]);
    expect(users.at(-1)?.content).toBe("carry on");
  });

  test("B: a goal the loop does not continue (met) leaves the turn end to the hook", async () => {
    const h = await harness({ providerName: "topics", verdicts: ["met"], answer: async () => ({ ok: true, continueWith: "run the retrospective" }) });
    const sk = "topic:turn-end-goal-met";
    const t0 = await h.startTurn(sk);
    setGoal(h.ctx.db as never, { topicId: `t-${sk}`, content: "finish the refactor" });
    end(t0, "puoi chiuderla");
    await nextTurn(h, t0);
    await settle();
    expect(hookRows(h, sk).map((u) => u.content)).toEqual(["run the retrospective"]);
  });

  test("A: Retry of a hook turn that failed keeps the row marked, never the person's", async () => {
    let asks = 1;
    const h = await harness({ providerName: "topics", answer: async () => (asks-- > 0 ? { ok: true, continueWith: "run the retrospective" } : { ok: true }) });
    const sk = "topic:turn-end-retry";
    const t0 = await h.startTurn(sk);
    end(t0, "puoi chiuderla");
    const hookTurn = await nextTurn(h, t0);
    hookTurn!.onError("upstream connection reset");
    await settle();
    // The client's Retry: the text alone, no marks on the body.
    await h.post(sk, "run the retrospective");
    await settle();
    const copies = h.userRows(sk).filter((u) => u.content === "run the retrospective");
    expect(copies.length).toBe(2);
    expect(copies.map((u) => u.blocks)).toEqual([[{ kind: "hook-nudge", attempt: 1 }], [{ kind: "hook-nudge", attempt: 1 }]]);
  });
});
