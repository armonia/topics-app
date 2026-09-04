/**
 * Il turno finisce, l'obiettivo no: la route lo prosegue da sola.
 *
 * Qui si guida la route VERA (`POST /api/chat`) con un provider finto, perché
 * il pezzo che mancava non era una funzione ma un COLLEGAMENTO: la regola e il
 * giudice si provano puri in `server/services/goal-loop.test.ts`, e restavano
 * inerti finché qualcuno non li chiamava alla fine di un turno. Il rosso di
 * partenza di questo file è esattamente quello: un turno chiuso `end_turn` con
 * un goal attivo non produceva nessuna continuazione.
 *
 * Il provider finto fa due mestieri, ed è voluto: `sendChat` è il turno,
 * `complete` è il GIUDICE (la route gli chiede il verdetto sul provider del
 * topic). Così un test decide cosa risponde il giudice senza toccare la route.
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

/** Il banco: una topic con un goal attivo e la route vera sopra. */
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

  /** Chiude il turno in volo come lo chiuderebbe il modello: `end_turn`. */
  async function finisci(text: string) {
    const h = handlers[handlers.length - 1];
    if (!h) throw new Error("nessun turno in volo da chiudere");
    h.onTextDelta(text, text);
    h.onDone();
    // Il gancio di fine turno è differito (setTimeout 0) e passa da un giudice
    // asincrono: gli si lascia un giro di eventi.
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
    // Il secondo verdetto chiude il ciclo: senza, questo test comprerebbe turni
    // finché non finisce il timeout, che è precisamente il difetto che il tetto
    // esiste per impedire in produzione.
    const b = await banco("goal-continue", ["continue", "met"]);

    await b.send("comincia");
    await b.finisci("ho fatto metà del lavoro, manca il resto");

    // UN SECONDO TURNO È PARTITO: è questo che prima non succedeva.
    expect(b.handlers.length).toBe(2);
    expect(b.judged[0]).toContain("portare la barra a verde");

    // E la riga che l'ha aperto NON è una bolla dell'utente: porta il marcatore.
    const utenti = b.righe().filter((r) => r.role === "user");
    expect(utenti.length).toBe(2);
    const nudge = blocksOf(utenti[1]!);
    expect(nudge).toEqual([{ kind: "goal-nudge", attempt: 1 }]);
    expect(utenti[1]!.content).toContain("portare la barra a verde");

    // Il contatore del ciclo è sul goal, non in memoria.
    expect(getActiveGoal(b.ctx.db, b.topic.id)?.continuations).toBe(1);

    // Il secondo turno si chiude col verdetto `met`, che spegne il ciclo.
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
    expect(b.righe().length).toBe(prima + 2); // la domanda e la risposta, nient'altro
    await chiudi();
  });
});
