/**
 * The turn ends, the objective does not: the route carries it on by itself.
 *
 * This drives the REAL route (`POST /api/chat`) with a fake provider, because
 * what was missing was not a function but a CONNECTION: the rule and the judge
 * are proved pure in `server/services/goal-loop.test.ts`, and they stayed inert
 * until somebody called them at the end of a turn. The starting red of this
 * file is exactly that: a turn closed `end_turn` with an active goal produced
 * no continuation at all.
 *
 * The fake provider does two jobs, on purpose: `sendChat` is the turn and
 * `complete` is the JUDGE (the route asks the topic's provider for the
 * verdict). So a test decides what the judge answers without touching the route.
 *
 * @covers CHAT-GOALLOOP-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { registerProvider, removeProvider } from "../../server/providers";
import { setGoal, getActiveGoal, setGoalLoop } from "../../server/services/goals";
import { MAX_GOAL_CONTINUATIONS } from "../../server/services/goal-loop";
import { createGoalContinuation, goalContinuationForChatRoute, GOAL_CHECK_IN_LIMIT, GOAL_CHECK_IN_MS, GOAL_WAKE_RECHECK_MS, goalCheckInDelayMs, type TurnEndInfo } from "../../server/services/goal-continuation";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("goal-continuation");
beforeAll(() => setupTestDataDir(TEST_DATA));

registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* gia' tolto */ } });

/** The bench: a topic with an active goal and the real route on top. */
async function banco(name: string, verdicts: string[], opts: { backgroundWork?: () => boolean; backgroundState?: () => string; goalLoop?: unknown } = {}) {
  const sessionKey = `topic:${name}`;
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = () => {};

  const topic: Topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);
  const goal = setGoal(ctx.db, { topicId: topic.id, content: "portare la barra a verde" });

  const handlers: StreamHandler[] = [];
  const judged: string[] = [];
  const provider = {
    name: "fake-stream",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handlers.push(h); },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    ...(opts.backgroundWork ? { hasBackgroundWork: opts.backgroundWork } : {}),
    ...(opts.backgroundState ? { backgroundState: opts.backgroundState } : {}),
    start: () => {}, stop: () => {},
    complete: async (msgs: Array<{ content: string }>) => {
      judged.push(msgs[0]?.content ?? "");
      return { content: verdicts.shift() ?? "continue" };
    },
  } as unknown as AIProvider;

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
    WORKSPACE_DIR: testTmpDir(`${name}-ws`),
    ...(opts.goalLoop ? { goalLoop: opts.goalLoop } : {}),
  } as never);

  async function send(content: string, extra: Record<string, unknown> = {}) {
    const url = new URL("http://topics.test/api/chat");
    const resp = await router(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...extra }),
      }),
      url, "/api/chat", "POST",
    );
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
  }

  /** Closes the in-flight turn the way the model would: `end_turn`. */
  async function finish(text: string) {
    const h = handlers[handlers.length - 1];
    if (!h) throw new Error("nessun turno in volo da chiudere");
    h.onTextDelta(text, text);
    h.onDone();
    // The end-of-turn hook is deferred (setTimeout 0) and goes through an
    // async judge: it gets one turn of the event loop.
    await new Promise((r) => setTimeout(r, 120));
  }

  const rows = () => ctx.db
    .query(`SELECT role, content, blocks FROM messages WHERE session_key = ? ORDER BY sort_order ASC`)
    .all(sessionKey) as Array<{ role: string; content: string; blocks: string | null }>;

  return { ctx: ctx as AppContext, topic, goal, handlers, judged, send, finish, rows, sessionKey, frames };
}

function blocksOf(row: { blocks: string | null }): ContentBlock[] {
  try { return JSON.parse(row.blocks ?? "null") ?? []; } catch { return []; }
}

async function close() {
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
}

describe("fine turno con un obiettivo attivo", () => {
  test("«ho fatto metà»: la route manda da sola la continuazione, marcata", async () => {
    // The second verdict closes the loop: without it this test would buy turns
    // until the timeout, which is precisely the fault the ceiling exists to
    // prevent in production.
    const b = await banco("goal-continue", ["continue", "met"]);

    await b.send("comincia");
    await b.finish("ho fatto metà del lavoro, manca il resto");

    // A SECOND TURN STARTED: this is what did not happen before.
    expect(b.handlers.length).toBe(2);
    expect(b.judged[0]).toContain("portare la barra a verde");

    // And the row that opened it is NOT a user bubble: it carries the marker.
    const users = b.rows().filter((r) => r.role === "user");
    expect(users.length).toBe(2);
    const nudge = blocksOf(users[1]!);
    expect(nudge).toEqual([{ kind: "goal-nudge", attempt: 1 }]);
    expect(users[1]!.content).toContain("portare la barra a verde");

    // The loop counter lives on the goal, not in memory.
    expect(getActiveGoal(b.ctx.db, b.topic.id)?.continuations).toBe(1);

    // The second turn closes on the `met` verdict, which switches the loop off.
    await b.finish("fatto, la barra è verde e l'ho verificata");
    const after = getActiveGoal(b.ctx.db, b.topic.id);
    expect(after).toBe(null);
    expect(b.handlers.length).toBe(2);
    await close();
  });

  test("background work still running: no judge, no nudge, until a turn ends with it over", async () => {
    // Card C6, chat 7e9caa28, 24/09: five nudges in 104 s while it waited for
    // five of its own verifiers. The CLI wakes itself when they report.
    let running = true;
    const b = await banco("goal-background", ["continue", "met"], { backgroundWork: () => running });

    await b.send("lancia i verificatori in background");
    await b.finish("cinque verificatori lanciati, aspetto i loro esiti");
    expect(b.judged).toEqual([]);
    expect(b.handlers.length).toBe(1);
    expect(getActiveGoal(b.ctx.db, b.topic.id)?.continuations).toBe(0);

    // The work reports; the turn that closes after it is judged like any other.
    running = false;
    await b.send("esiti arrivati?");
    await b.finish("quattro verdi, uno rosso: correggo");
    expect(b.judged.length).toBe(1);
    expect(b.handlers.length).toBe(3);
    await b.finish("corretto e verificato");
    await close();
  });

  test("giudice `met`: il goal si chiude raggiunto e nessun turno parte", async () => {
    const b = await banco("goal-met", ["met"]);
    await b.send("comincia");
    await b.finish("fatto tutto, verificato");

    expect(b.handlers.length).toBe(1);
    expect(getActiveGoal(b.ctx.db, b.topic.id)).toBe(null);
    await close();
  });

  test("una domanda all'utente ferma il ciclo e lascia l'obiettivo aperto", async () => {
    const b = await banco("goal-blocked", ["blocked_on_user"]);
    await b.send("comincia");
    await b.finish("preferisci A o B?");

    expect(b.handlers.length).toBe(1);
    const goal = getActiveGoal(b.ctx.db, b.topic.id);
    expect(goal?.status).toBe("active");
    expect(goal?.loopState).toBe("blocked");
    await close();
  });

  test("il tetto si ferma e lo scrive in chat", async () => {
    const b = await banco("goal-cap", ["continue"]);
    setGoalLoop(b.ctx.db, b.goal.id, { continuations: MAX_GOAL_CONTINUATIONS });

    await b.send("comincia");
    await b.finish("continuo ancora un po'");

    expect(b.handlers.length).toBe(1);
    const goal = getActiveGoal(b.ctx.db, b.topic.id);
    expect(goal?.status).toBe("active");
    expect(goal?.loopState).toBe("stopped");

    const warning = b.rows().find((r) => blocksOf(r).some((x) => x.kind === "goal-stop"));
    expect(warning?.content).toContain(String(MAX_GOAL_CONTINUATIONS));
    await close();
  });

  // topic:33966f4e, 23/09: two continuations that ran Bash, Read and the browser
  // tools were stopped as «2 turns in a row with no tool run». The route read the
  // tools still IN FLIGHT at the end of the turn, a list every finished tool
  // leaves: at `onDone` it is empty by construction, so every turn looked idle.
  test("un turno che ha usato tool finiti non conta come fermo", async () => {
    const b = await banco("goal-tools-ran", ["continue", "continue", "met"]);
    await b.send("comincia");
    for (const text of ["primo giro", "secondo giro"]) {
      const h = b.handlers[b.handlers.length - 1]!;
      h.onToolStart(`tool-${text}`, "Bash", { command: "ls" });
      h.onToolResult(`tool-${text}`, "ok");
      await b.finish(text);
    }
    expect(getActiveGoal(b.ctx.db, b.topic.id)?.idleTurns).toBe(0);
    expect(b.rows().some((r) => blocksOf(r).some((x) => x.kind === "goal-stop"))).toBe(false);
    expect(b.handlers.length).toBe(3);
    await close();
  });

  // The live window draws what the FRAME says, not what the row says: before
  // 23/09 `message:new` went out without the marks, and every window watching
  // the chat showed «Objective still open: ...» as the person's own bubble
  // until a reload read the row back.
  test("i frame message:new portano la marcatura della riga", async () => {
    const b = await banco("goal-frames", ["continue", "continue"]);
    await b.send("comincia");
    await b.finish("primo giro senza tool");
    await b.finish("secondo giro senza tool");
    const news = b.frames.filter((f) => f.type === "message:new");
    const nudge = news.find((f) => f.role === "user" && String(f.content).startsWith("Objective still open"));
    expect(nudge?.blocks).toEqual([{ kind: "goal-nudge", attempt: 1 }]);
    const stop = news.find((f) => f.role === "assistant" && String(f.content).startsWith("Auto-continuation paused"));
    expect(stop?.blocks).toEqual([{ kind: "goal-stop", reason: "stalled" }]);
    const human = news.find((f) => f.role === "user" && f.content === "comincia");
    expect(human && "blocks" in human).toBe(false);
    await close();
  });

  test("un giudice illeggibile non compra niente e non scrive niente", async () => {
    const b = await banco("goal-mute", ["non lo so"]);
    const prima = b.rows().length;
    await b.send("comincia");
    await b.finish("mah");

    expect(b.handlers.length).toBe(1);
    expect(getActiveGoal(b.ctx.db, b.topic.id)?.status).toBe("active");
    expect(b.rows().length).toBe(prima + 2); // the question and the answer, nothing else
    await close();
  });
});

/**
 * The two turns that left a deferred goal silent for good (review of card C6):
 * a background job that never reports, so no turn ever ends again, and the
 * empty wake that follows the last report, which the route discards. Driven on
 * the service with a hand-moved timer, the same DB and goal as the route bench.
 */
describe("a goal deferred on background work", () => {
  async function bench(name: string, verdicts: string[], busy = () => false) {
    const b = await banco(name, []);
    const timers: Array<{ fn: () => void; ms: number; due: number }> = [];
    const judged: string[] = [];
    const sent: string[] = [];
    let running = true;
    let clock = 0;
    const onTurnEnd = createGoalContinuation({
      db: b.ctx.db,
      judge: async (prompt) => { judged.push(prompt); return verdicts.shift() ?? "continue"; },
      resend: async ({ text }) => { sent.push(text); },
      announce: () => {}, broadcast: () => {},
      isBusy: busy,
      backgroundWork: () => running,
      setTimer: (fn, ms) => { const h = { fn, ms, due: clock + ms }; timers.push(h); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
      now: () => clock,
    });
    const turn = (over: Partial<TurnEndInfo> = {}): TurnEndInfo => ({
      sessionKey: b.sessionKey, topicId: b.topic.id, dispatched: false, end: "end_turn",
      discarded: false, pendingAsk: false, usedTools: true, lastAssistantText: "launched, waiting for them",
      backgroundWork: true, ...over,
    });
    const fire = async () => { timers.shift()!.fn(); await new Promise((r) => setTimeout(r, 20)); };
    /** Move the clock, firing every timer that falls due on the way. */
    const advance = async (ms: number) => {
      clock += ms;
      for (const due of timers.filter((x) => x.due <= clock)) {
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { b, timers, judged, sent, onTurnEnd, turn, fire, advance, stop: () => { running = false; } };
  }

  test("a job that never reports: the goal checks in after thirty minutes, the way Claude Code does", async () => {
    const t = await bench("goal-checkin", ["continue"]);
    expect(await t.onTurnEnd(t.turn())).toBe("background");
    expect(t.judged).toEqual([]);
    expect(t.timers.map((x) => x.ms)).toEqual([30 * 60_000]);

    await t.fire();
    expect(t.judged.length).toBe(1);
    expect(t.sent.length).toBe(1);
    expect(t.sent[0]).toContain("still running");

    // The nudge's own turn ends with the job still up: deferred again, and the
    // next check-in waits twice as long.
    expect(await t.onTurnEnd(t.turn({ lastAssistantText: "still up, checked it" }))).toBe("background");
    expect(t.timers.map((x) => x.ms)).toEqual([goalCheckInDelayMs(1)]);
    await close();
  });

  test("check-ins stop after three, until a turn ends with the work over", async () => {
    const t = await bench("goal-checkin-cap", ["continue", "continue", "continue"]);
    for (let i = 0; i < GOAL_CHECK_IN_LIMIT; i++) {
      await t.onTurnEnd(t.turn());
      await t.fire();
    }
    expect(t.judged.length).toBe(GOAL_CHECK_IN_LIMIT);
    await t.onTurnEnd(t.turn());
    expect(t.timers).toEqual([]);
    await close();
  });

  test("a check-in that finds a turn in flight stays out of its way", async () => {
    const t = await bench("goal-checkin-busy", ["continue"], () => true);
    await t.onTurnEnd(t.turn());
    await t.fire();
    expect(t.judged).toEqual([]);
    expect(t.sent).toEqual([]);
    await close();
  });

  test("a Stop on an empty turn drops the waiting turn: no nudge now, none in thirty minutes", async () => {
    // Stopped before its first token, the turn is discarded like an empty wake;
    // treating it as one bought a paid turn the person had just refused.
    const t = await bench("goal-stop-empty", ["continue"]);
    await t.onTurnEnd(t.turn());
    t.timers.length = 0;
    expect(await t.onTurnEnd(t.turn({ end: "cancelled", cause: "user", discarded: true, lastAssistantText: "" }))).toBe("skipped");
    t.stop();
    expect(await t.onTurnEnd(t.turn({ end: "cancelled", cause: "user", discarded: true, backgroundWork: false, lastAssistantText: "" }))).toBe("skipped");
    expect(t.timers).toEqual([]);
    expect(t.judged).toEqual([]);
    expect(t.sent).toEqual([]);
    await close();
  });

  test("a check-in that meets the last wake in flight leaves the waiting turn to that wake", async () => {
    let busy = true;
    const t = await bench("goal-checkin-meets-wake", ["continue"], () => busy);
    await t.onTurnEnd(t.turn({ lastAssistantText: "the suite is running on the PC" }));
    await t.fire();
    expect(t.judged).toEqual([]);
    busy = false;
    t.stop();
    // The wake it met turns out empty and is discarded: the waiting turn is still there to judge.
    expect(await t.onTurnEnd(t.turn({ discarded: true, backgroundWork: false, lastAssistantText: "" }))).toBe("continued");
    expect(t.judged[0]).toContain("the suite is running on the PC");
    await close();
  });

  test("G1: the check-in counts from when the goal started waiting, not from the last turn end", async () => {
    // Verification of 25/09: a Monitor ticking every twenty minutes re-armed
    // the thirty-minute check-in at each tick, so it never fired.
    const t = await bench("goal-checkin-since", ["continue"]);
    await t.onTurnEnd(t.turn());
    await t.advance(20 * 60_000);
    expect(await t.onTurnEnd(t.turn({ lastAssistantText: "tick 1" }))).toBe("background");
    expect(t.timers.map((x) => x.due)).toEqual([30 * 60_000]);
    await t.advance(20 * 60_000);
    expect(t.judged.length).toBe(1);
    expect(t.judged[0]).toContain("tick 1");
    await close();
  });

  test("G1, silent ticks: an empty wake with the work still listed leaves the clock alone", async () => {
    // A Monitor tick answered "No response requested." is discarded by the
    // route; handling it by dropping the waiting turn re-armed from each tick.
    const t = await bench("goal-checkin-silent-ticks", ["continue"]);
    await t.onTurnEnd(t.turn({ lastAssistantText: "watching the deploy" }));
    for (let i = 0; i < 3; i++) {
      await t.advance(20 * 60_000);
      if (t.judged.length) break;
      expect(await t.onTurnEnd(t.turn({ discarded: true, lastAssistantText: "" }))).toBe("background");
    }
    expect(t.judged.length).toBe(1);
    expect(t.judged[0]).toContain("watching the deploy");
    await close();
  });

  test("the person's own empty turn (a /compact) starts a fresh stretch, it does not fire the old one", async () => {
    const t = await bench("goal-checkin-compact", ["continue"]);
    await t.onTurnEnd(t.turn({ lastAssistantText: "watching the deploy" }));
    await t.advance(29 * 60_000);
    expect(await t.onTurnEnd(t.turn({ discarded: true, fromHuman: true, lastAssistantText: "" }))).toBe("background");
    expect(t.timers.map((x) => x.due)).toEqual([59 * 60_000]);
    await t.advance(0);
    expect(t.judged).toEqual([]);
    await close();
  });

  test("a check-in due while a wake ran fires when that wake ends empty with the work still listed", async () => {
    let busy = true;
    const t = await bench("goal-checkin-due-then-empty", ["continue"], () => busy);
    await t.onTurnEnd(t.turn({ lastAssistantText: "suite on the PC" }));
    await t.advance(30 * 60_000);
    expect(t.judged).toEqual([]);
    busy = false;
    await t.onTurnEnd(t.turn({ discarded: true, lastAssistantText: "" }));
    await t.advance(0);
    expect(t.judged.length).toBe(1);
    await close();
  });

  test("G2: a message from the person re-enables the check-ins spent on the work still running", async () => {
    const t = await bench("goal-checkin-human", ["continue", "continue", "continue", "continue"]);
    for (let i = 0; i < GOAL_CHECK_IN_LIMIT; i++) {
      await t.onTurnEnd(t.turn());
      await t.fire();
    }
    await t.onTurnEnd(t.turn());
    expect(t.timers).toEqual([]);
    // The person writes; their turn ends with the job still up.
    expect(await t.onTurnEnd(t.turn({ fromHuman: true, lastAssistantText: "answered the human" }))).toBe("background");
    expect(t.timers.map((x) => x.ms)).toEqual([GOAL_CHECK_IN_MS]);
    await close();
  });

  test("a task that just reported: the goal waits for its wake, not for a judge and a nudge that would meet it", async () => {
    // The last snapshot is empty and the report's wake is queued: a nudge now
    // would collide with that wake (409) and judge a turn about to be superseded.
    const t = await bench("goal-wake-queued", ["continue"]);
    expect(await t.onTurnEnd(t.turn({ backgroundWakeOnly: true }))).toBe("background");
    expect(t.timers.map((x) => x.ms)).toEqual([GOAL_WAKE_RECHECK_MS]);
    expect(t.judged).toEqual([]);
    // The wake comes and ends with the work over: it is the turn judged.
    t.stop();
    expect(await t.onTurnEnd(t.turn({ backgroundWork: false, lastAssistantText: "all five green" }))).toBe("continued");
    expect(t.timers).toEqual([]);
    expect(t.judged.length).toBe(1);
    expect(t.judged[0]).toContain("all five green");
    await close();
  });

  test("a wake that never comes is judged after a minute, without spending a check-in", async () => {
    const t = await bench("goal-wake-missing", ["continue"]);
    await t.onTurnEnd(t.turn({ backgroundWakeOnly: true, lastAssistantText: "suite done, reading it" }));
    t.stop();
    await t.advance(GOAL_WAKE_RECHECK_MS);
    expect(t.judged.length).toBe(1);
    expect(t.sent.length).toBe(1);
    await close();
  });

  test("a Stop of the background work: the goal stops waiting, and no check-in revives it", async () => {
    // The Stop of a chat whose turn is closed ends no turn, so nothing else
    // would drop the waiting one (`/api/chat/abort`, reason `background_stopped`).
    const t = await bench("goal-background-stopped", ["continue"]);
    await t.onTurnEnd(t.turn({ lastAssistantText: "the suite is running" }));
    expect(t.timers.length).toBe(1);
    t.onTurnEnd.stopWaiting(t.b.sessionKey);
    t.stop();
    expect(t.timers).toEqual([]);
    await t.advance(GOAL_CHECK_IN_MS * 8);
    expect(t.judged).toEqual([]);
    expect(t.sent).toEqual([]);
    await close();
  });

  test("the boot's check-in judges the model's last words, not a notice written after them (third review of 25/09)", async () => {
    const b = await banco("goal-boot-notice", []);
    b.ctx.appendLocalMessage(b.sessionKey, "assistant", "started the dev server, watching it");
    b.ctx.appendLocalMessage(b.sessionKey, "assistant", "", undefined, [{ kind: "background-notice", event: "deferred", change: "model", text: "The model change applies" }]);
    const prompts: string[] = [];
    const armed: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if ((ms ?? 0) >= GOAL_CHECK_IN_MS) { armed.push(fn); return { unref() {} }; }
      return realSetTimeout(fn, ms);
    }) as never;
    try {
      const loop = goalContinuationForChatRoute({
        ctx: b.ctx as never,
        resolveProvider: () => ({ name: "fake", complete: async (m) => { prompts.push(m[0].content); return { content: "done" }; } }),
        log: () => {},
      });
      await loop.resumeAfterBoot([b.sessionKey]);
      armed.shift()!();
      for (let i = 0; i < 50 && !prompts.length; i++) await Bun.sleep(20);
    } finally { globalThis.setTimeout = realSetTimeout; }
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("started the dev server, watching it");
    expect(prompts[0]).not.toContain("said nothing");
    await close();
  });

  test("after a restart the boot hands back the goals that waited: the check-in is armed again", async () => {
    // The waiting turns lived in the old process. A session kept for its
    // background work, whose job never reports, left its goal unpursued for good.
    const b = await banco("goal-boot-resume", []);
    b.ctx.appendLocalMessage(b.sessionKey, "assistant", "started the dev server, watching it");
    const logs: string[] = [];
    const loop = goalContinuationForChatRoute({
      ctx: b.ctx as never,
      resolveProvider: () => ({ name: "fake", complete: async () => ({ content: "continue" }) }),
      log: (m) => logs.push(m),
    });
    await loop.resumeAfterBoot([b.sessionKey, "topic:not-a-topic"]);
    expect(logs).toEqual([expect.stringContaining(`${b.sessionKey}: background work still running, the goal waits for the turn it wakes (check-in in 30 min)`)]);
    // A board card's session is the dispatcher's: nothing is armed for it.
    const at = new Date().toISOString();
    b.ctx.db.run(
      `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at) VALUES ('task-boot', 'p', 'x', 'in_progress', ?, ?, ?)`,
      [b.topic.id, at, at],
    );
    logs.length = 0;
    await goalContinuationForChatRoute({ ctx: b.ctx as never, resolveProvider: () => ({}) as never, log: (m) => logs.push(m) })
      .resumeAfterBoot([b.sessionKey]);
    expect(logs).toEqual([]);
    await close();
  });

  test("the empty wake after the last report hands the judge the turn that did the work", async () => {
    const t = await bench("goal-empty-wake", ["continue"]);
    await t.onTurnEnd(t.turn({ lastAssistantText: "fixed four of five, the fifth is running" }));
    t.stop();
    // "No response requested.": the route discards it, and it was the only
    // turn left to end.
    expect(await t.onTurnEnd(t.turn({ discarded: true, backgroundWork: false, lastAssistantText: "" }))).toBe("continued");
    expect(t.judged.length).toBe(1);
    expect(t.judged[0]).toContain("fixed four of five");
    await close();
  });
});

/**
 * The second review of 25/09, on the real stack with the recorded CLI (r1:
 * Workflow + Monitor): the turns deferred on background work were never
 * judged, so their tools never reset the idle streak, and the wake reporting
 * the work finished stopped the loop as "nothing is moving". And a check-in
 * whose judge thought for 18 to 25 s met a Monitor's wake with a 409.
 */
describe("a goal waiting on background work, second review", () => {
  const MIN = 60_000;
  async function stack(name: string, opts: { judge?: () => Promise<string>; busy?: () => boolean; wakeQueued?: () => boolean } = {}) {
    const b = await banco(name, []);
    let clock = 0;
    let running = true;
    const timers: Array<{ fn: () => void; ms: number; due: number }> = [];
    const judged: string[] = [];
    const sent: string[] = [];
    const onTurnEnd = createGoalContinuation({
      db: b.ctx.db,
      judge: async (prompt) => { judged.push(prompt); return opts.judge ? opts.judge() : "continue"; },
      resend: async ({ text }) => { if (opts.busy?.()) throw new Error("the chat route answered 409"); sent.push(text); },
      announce: () => {}, broadcast: () => {},
      isBusy: opts.busy ?? (() => false),
      backgroundWork: () => running,
      wakeQueued: opts.wakeQueued,
      setTimer: (fn, ms) => { const h = { fn, ms, due: clock + ms }; timers.push(h); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
      now: () => clock,
    });
    const turn = (over: Partial<TurnEndInfo> = {}): TurnEndInfo => ({
      sessionKey: b.sessionKey, topicId: b.topic.id, dispatched: false, end: "end_turn",
      discarded: false, pendingAsk: false, usedTools: true, lastAssistantText: "", backgroundWork: true, ...over,
    });
    const advance = async (ms: number) => {
      const end = clock + ms;
      for (;;) {
        const next = timers.filter((x) => x.due <= end).sort((a, c) => a.due - c.due)[0];
        if (!next) break;
        clock = next.due; timers.splice(timers.indexOf(next), 1); next.fn();
        await new Promise((r) => setTimeout(r, 20));
      }
      clock = end;
    };
    const goal = () => getActiveGoal(b.ctx.db, b.topic.id)!;
    return { b, timers, judged, sent, onTurnEnd, turn, advance, goal, done: () => { running = false; }, setClock: (t: number) => { clock = t; } };
  }

  test("the wake that reports the work finished continues the goal: deferred turns that ran tools, and wakes, are progress", async () => {
    const t = await stack("goal-r1-final-wake");
    // The person's turn launches Workflow and Monitor, then two Monitor ticks answered in words.
    expect(await t.onTurnEnd(t.turn({ fromHuman: true, lastAssistantText: "Both are running" }))).toBe("background");
    for (let i = 1; i <= 2; i++) {
      await t.advance(10 * MIN);
      expect(await t.onTurnEnd(t.turn({ woken: true, usedTools: false, lastAssistantText: `The monitor printed tick-${i}.` }))).toBe("background");
    }
    await t.advance(10 * MIN);
    expect(t.judged.length).toBe(1);
    // The nudge's turn checks with a tool, the work still listed: deferred.
    expect(await t.onTurnEnd(t.turn({ usedTools: true, lastAssistantText: "Checked: step 3/5" }))).toBe("background");
    await t.advance(15 * MIN);
    t.done();
    expect(await t.onTurnEnd(t.turn({ woken: true, backgroundWork: false, usedTools: false, lastAssistantText: "The workflow finished: 5/5" }))).toBe("continued");
    expect(t.goal().loopState).toBe("running");
    await close();
  });

  test("a stall pauses the loop, and the person's next message lifts the pause", async () => {
    const t = await stack("goal-stall-pause");
    t.done();
    await t.onTurnEnd(t.turn({ backgroundWork: false, usedTools: false, lastAssistantText: "thinking about it" }));
    expect(await t.onTurnEnd(t.turn({ backgroundWork: false, usedTools: false, lastAssistantText: "still thinking" }))).toBe("stalled");
    expect(t.goal().loopState).toBe("blocked");
    expect(await t.onTurnEnd(t.turn({ backgroundWork: false, fromHuman: true, usedTools: true, lastAssistantText: "done what you asked" }))).toBe("continued");
    expect(t.goal().loopState).toBe("running");
    await close();
  });

  test("a check-in whose judge meets a wake spends nothing, sends nothing, and keeps the goal waiting", async () => {
    let busy = false;
    let release: (v: string) => void = () => {};
    const t = await stack("goal-checkin-race", { judge: () => new Promise((r) => { release = r; }), busy: () => busy });
    await t.onTurnEnd(t.turn({ fromHuman: true, lastAssistantText: "deploy started, Monitor on its log" }));
    t.setClock(30 * MIN);
    t.timers.shift()!.fn();
    busy = true; // a Monitor's event woke the CLI while the judge thought
    release("continue");
    await new Promise((r) => setTimeout(r, 30));
    expect(t.sent).toEqual([]);
    expect(t.goal().continuations).toBe(0);
    busy = false;
    // The tick is answered with nothing: the goal keeps waiting, with a check-in armed.
    expect(await t.onTurnEnd(t.turn({ woken: true, discarded: true, usedTools: false }))).toBe("background");
    expect(t.timers.length).toBe(1);
    await close();
  });

  test("a check-in that finds a wake queued looks again in a minute, without paying the judge", async () => {
    let queued = true;
    const t = await stack("goal-checkin-wake-queued", { wakeQueued: () => queued });
    await t.onTurnEnd(t.turn({ fromHuman: true, lastAssistantText: "suite running" }));
    await t.advance(30 * MIN);
    expect(t.judged).toEqual([]);
    expect(t.timers.map((x) => x.ms)).toEqual([GOAL_WAKE_RECHECK_MS]);
    queued = false;
    await t.advance(GOAL_WAKE_RECHECK_MS);
    expect(t.judged.length).toBe(1);
    await close();
  });

  test("a wake that fails while the work runs keeps the goal waiting; only the person's Stop ends it", async () => {
    const t = await stack("goal-failed-wake");
    await t.onTurnEnd(t.turn({ fromHuman: true, lastAssistantText: "deploy started" }));
    await t.advance(5 * MIN);
    await t.onTurnEnd(t.turn({ woken: true, end: "error", cause: "provider-error", usedTools: false, lastAssistantText: "API Error: 529" }));
    expect(t.timers.length).toBe(1);
    await t.onTurnEnd(t.turn({ end: "cancelled", cause: "user", discarded: true, usedTools: false }));
    expect(t.timers).toEqual([]);
    await close();
  });
});

/**
 * What the chat route tells the goal about a turn, read off the real route: the
 * second review of 25/09 mutated `fromHuman: false` and `backgroundWakeOnly:
 * false` in chat.ts and 59 and 79 tests stayed green, because every goal test
 * injected those flags by hand.
 */
describe("the chat route's turn end, as the goal hears it", () => {
  function listener() {
    const seen: TurnEndInfo[] = [];
    return { seen, loop: { useRoute() {}, stopWaiting() {}, resumeAfterBoot: async () => {}, onTurnEnd: async (i: TurnEndInfo) => { seen.push(i); return "seen"; } } };
  }

  test("a person's message is fromHuman, and a queued wake is said as such", async () => {
    const l = listener();
    const b = await banco("goal-wiring-human", [], { backgroundState: () => "wake-queued", goalLoop: l.loop });
    await b.send("controlla la suite");
    await b.finish("lanciata, aspetto il report");
    expect(l.seen.at(-1)).toMatchObject({ fromHuman: true, woken: false, backgroundWork: true, backgroundWakeOnly: true });
    await close();
  });

  test("the goal's own continuation is not the person, and running work is not a queued wake", async () => {
    const l = listener();
    const b = await banco("goal-wiring-nudge", [], { backgroundState: () => "running", goalLoop: l.loop });
    await b.send("Objective still open: carry on", { goalNudge: 1 });
    await b.finish("ancora in corso");
    expect(l.seen.at(-1)).toMatchObject({ fromHuman: false, backgroundWork: true, backgroundWakeOnly: false });
    await close();
  });
});
