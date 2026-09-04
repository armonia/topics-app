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
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("goal-continuation");
beforeAll(() => setupTestDataDir(TEST_DATA));

registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* gia' tolto */ } });

/** The bench: a topic with an active goal and the real route on top. */
async function banco(name: string, verdicts: string[]) {
  const sessionKey = `topic:${name}`;
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
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
  async function finisci(text: string) {
    const h = handlers[handlers.length - 1];
    if (!h) throw new Error("nessun turno in volo da chiudere");
    h.onTextDelta(text, text);
    h.onDone();
    // The end-of-turn hook is deferred (setTimeout 0) and goes through an
    // async judge: it gets one turn of the event loop.
    await new Promise((r) => setTimeout(r, 120));
  }

  const righe = () => ctx.db
    .query(`SELECT role, content, blocks FROM messages WHERE session_key = ? ORDER BY sort_order ASC`)
    .all(sessionKey) as Array<{ role: string; content: string; blocks: string | null }>;

  return { ctx: ctx as AppContext, topic, goal, handlers, judged, send, finisci, righe, sessionKey };
}

function blocksOf(row: { blocks: string | null }): ContentBlock[] {
  try { return JSON.parse(row.blocks ?? "null") ?? []; } catch { return []; }
}

async function chiudi() {
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
    await b.finisci("ho fatto metà del lavoro, manca il resto");

    // A SECOND TURN STARTED: this is what did not happen before.
    expect(b.handlers.length).toBe(2);
    expect(b.judged[0]).toContain("portare la barra a verde");

    // And the row that opened it is NOT a user bubble: it carries the marker.
    const utenti = b.righe().filter((r) => r.role === "user");
    expect(utenti.length).toBe(2);
    const nudge = blocksOf(utenti[1]!);
    expect(nudge).toEqual([{ kind: "goal-nudge", attempt: 1 }]);
    expect(utenti[1]!.content).toContain("portare la barra a verde");

    // The loop counter lives on the goal, not in memory.
    expect(getActiveGoal(b.ctx.db, b.topic.id)?.continuations).toBe(1);

    // The second turn closes on the `met` verdict, which switches the loop off.
    await b.finisci("fatto, la barra è verde e l'ho verificata");
    const dopo = getActiveGoal(b.ctx.db, b.topic.id);
    expect(dopo).toBe(null);
    expect(b.handlers.length).toBe(2);
    await chiudi();
  });

  test("giudice `met`: il goal si chiude raggiunto e nessun turno parte", async () => {
    const b = await banco("goal-met", ["met"]);
    await b.send("comincia");
    await b.finisci("fatto tutto, verificato");

    expect(b.handlers.length).toBe(1);
    expect(getActiveGoal(b.ctx.db, b.topic.id)).toBe(null);
    await chiudi();
  });

  test("una domanda all'utente ferma il ciclo e lascia l'obiettivo aperto", async () => {
    const b = await banco("goal-blocked", ["blocked_on_user"]);
    await b.send("comincia");
    await b.finisci("preferisci A o B?");

    expect(b.handlers.length).toBe(1);
    const goal = getActiveGoal(b.ctx.db, b.topic.id);
    expect(goal?.status).toBe("active");
    expect(goal?.loopState).toBe("blocked");
    await chiudi();
  });

  test("il tetto si ferma e lo scrive in chat", async () => {
    const b = await banco("goal-cap", ["continue"]);
    setGoalLoop(b.ctx.db, b.goal.id, { continuations: MAX_GOAL_CONTINUATIONS });

    await b.send("comincia");
    await b.finisci("continuo ancora un po'");

    expect(b.handlers.length).toBe(1);
    const goal = getActiveGoal(b.ctx.db, b.topic.id);
    expect(goal?.status).toBe("active");
    expect(goal?.loopState).toBe("stopped");

    const avviso = b.righe().find((r) => blocksOf(r).some((x) => x.kind === "goal-stop"));
    expect(avviso?.content).toContain(String(MAX_GOAL_CONTINUATIONS));
    await chiudi();
  });

  test("un giudice illeggibile non compra niente e non scrive niente", async () => {
    const b = await banco("goal-mute", ["non lo so"]);
    const prima = b.righe().length;
    await b.send("comincia");
    await b.finisci("mah");

    expect(b.handlers.length).toBe(1);
    expect(getActiveGoal(b.ctx.db, b.topic.id)?.status).toBe("active");
    expect(b.righe().length).toBe(prima + 2); // the question and the answer, nothing else
    await chiudi();
  });
});
