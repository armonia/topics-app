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
import { createGoalContinuation, GOAL_CHECK_IN_LIMIT, goalCheckInDelayMs, type TurnEndInfo } from "../../server/services/goal-continuation";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("goal-continuation");
beforeAll(() => setupTestDataDir(TEST_DATA));

registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* gia' tolto */ } });

/** The bench: a topic with an active goal and the real route on top. */
async function banco(name: string, verdicts: string[], opts: { backgroundWork?: () => boolean } = {}) {
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
  } as never);

  async function send(content: string) {
    const url = new URL("http://topics.test/api/chat");
    const resp = await router(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
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
    const stop = news.find((f) => f.role === "assistant" && String(f.content).startsWith("Auto-continuation stopped"));
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
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const judged: string[] = [];
    const sent: string[] = [];
    let running = true;
    const onTurnEnd = createGoalContinuation({
      db: b.ctx.db,
      judge: async (prompt) => { judged.push(prompt); return verdicts.shift() ?? "continue"; },
      resend: async ({ text }) => { sent.push(text); },
      announce: () => {}, broadcast: () => {},
      isBusy: busy,
      backgroundWork: () => running,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
    });
    const turn = (over: Partial<TurnEndInfo> = {}): TurnEndInfo => ({
      sessionKey: b.sessionKey, topicId: b.topic.id, dispatched: false, end: "end_turn",
      discarded: false, pendingAsk: false, usedTools: true, lastAssistantText: "launched, waiting for them",
      backgroundWork: true, ...over,
    });
    const fire = async () => { timers.shift()!.fn(); await new Promise((r) => setTimeout(r, 20)); };
    return { b, timers, judged, sent, onTurnEnd, turn, fire, stop: () => { running = false; } };
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
