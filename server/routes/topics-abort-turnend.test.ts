/**
 * `POST /api/chat/abort` DEPOSITA la ragione della fine. Prima non lo faceva.
 *
 * Chi guida un turno headless — `runHeadlessTurn` in server.ts, per conto del
 * dispatcher della board — legge il perché da `takeTurnEnd(sessionKey)`, e
 * quando non trova niente assume `{ end: "end_turn" }`: consegna riuscita.
 *
 * Da questa route non ci passava mai. `stream.abortController.abort()` fa
 * scattare il listener registrato dalla route di chat, che latcha
 * `streamState = "finalized"`; da quel momento `finalizeStream` esce alla prima
 * riga, quindi il `recordTurnEnd` che sta in fondo non gira. Risultato: uno stop
 * premuto da una persona arrivava al dispatcher come un turno finito bene, che
 * per le regole di ripresa (`consumesAttempt`, services/task-dispatcher.ts)
 * significa bruciare un tentativo e ripartire subito — sullo stesso task che
 * l'umano aveva appena fermato.
 *
 * Qui si guida l'handler vero contro un contesto finto con UNO stream vivo, e si
 * legge il registro. Il provider è registrato ma disconnesso, così la prova sta
 * sul deposito della route e non su cosa farebbe il provider.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { createTopicsRouter } from "./topics";
import { takeTurnEnd, resetTurnEndRegistry } from "../providers/turn-end-registry";
import { registerProvider, removeProvider } from "../providers";
import { testTmpDir } from "../../tests/integration/helpers";
import type { AppContext, StoredMessage, Topic } from "../types";

const PROVIDER_NAME = "openai";
const SESSION = "topic:abort-te";

// Un provider VERO nel registro, non un mock di modulo: `resolveProvider` in
// topics.ts passa da `getProvider`, e un `mock.module` su "../providers"
// sopravviverebbe a questo file inquinando gli altri test della cartella.
// Senza chiave, `connected` è false: la route non chiama il suo abort, e la
// prova resta sul deposito della route.
registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider(PROVIDER_NAME); } catch { /* già tolto */ } });

function makeTopic(): Topic {
  return {
    id: "t-abort", name: "abort", slug: "abort", parentId: null, links: [],
    sessionKey: SESSION, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: PROVIDER_NAME,
  } as Topic;
}

interface Harness {
  abort: (body: unknown) => Promise<Response | null>;
  aborted: { sse: boolean };
  rows: Map<string, StoredMessage>;
}

function harness(opts?: { withMessageRow?: boolean }): Harness {
  const topic = makeTopic();
  const aborted = { sse: false };
  const rows = new Map<string, StoredMessage>();
  const messageId = "m-partial";
  if (opts?.withMessageRow !== false) {
    rows.set(messageId, {
      id: messageId, role: "assistant", content: "mezza fra",
      timestamp: new Date().toISOString(), partial: true,
    });
  }

  const abortController = new AbortController();
  abortController.signal.addEventListener("abort", () => { aborted.sse = true; }, { once: true });

  const activeStreams = new Map<string, unknown>([[SESSION, {
    sessionKey: SESSION, startedAt: new Date().toISOString(), isThinking: false,
    lastActivity: new Date().toISOString(), content: "mezza frase", thinking: "",
    messageId, abortController,
  }]]);

  const ctx = {
    // `createTopicsRouter` compone `WORKSPACE_DIR` da qui al montaggio: deve
    // esistere come stringa anche se questa prova non tocca il filesystem.
    OPENCLAW_DIR: testTmpDir("abort-turnend"),
    activeStreams,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: () => null,
    broadcastToAll: () => {},
    getTopicById: (id: string) => (id === topic.id ? topic : null),
    getTopicBySessionKey: (key: string) => (key === SESSION ? topic : null),
    loadTopics: () => ({ topics: { [topic.id]: topic } }),
    saveSingleTopic: () => {},
    getMessageById: (id: string) => rows.get(id) ?? null,
    updateLastMessage: (_sk: string, updates: Partial<StoredMessage>) => {
      const row = rows.get(messageId);
      if (!row) return null;
      Object.assign(row, updates);
      return row;
    },
    discardIfEmptyTurn: () => null,
    endStream: (sk: string) => { activeStreams.delete(sk); return []; },
    loadLocalMessages: () => [],
    countMessagesBySession: () => rows.size,
    saveLocalMessages: () => {},
    projectStore: { list: () => [], getByPath: () => null, slugify: (s: string) => s },
  } as unknown as AppContext;

  const router = createTopicsRouter(ctx);
  const abort = (body: unknown) => {
    const url = new URL("http://topics.test/api/chat/abort");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return router(req, url, url.pathname, "POST") as Promise<Response | null>;
  };

  return { abort, aborted, rows };
}

beforeEach(() => resetTurnEndRegistry());

describe("POST /api/chat/abort — la fine del turno si deposita", () => {
  test("uno stop umano lascia `cancelled` con causa `user`, non una consegna riuscita", async () => {
    const h = harness();

    const resp = (await h.abort({ sessionKey: SESSION }))!;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, cleared: false });

    // Il valore che `runHeadlessTurn` ritira subito dopo il drain dell'SSE.
    // Prima era `undefined`, e il chiamante ripiegava su `{ end: "end_turn" }`.
    expect(takeTurnEnd(SESSION)).toMatchObject({ end: "cancelled", cause: "user" });
  });

  test("la si ritira UNA volta sola: la fine di questo turno non è quella del prossimo", async () => {
    const h = harness();
    await h.abort({ sessionKey: SESSION });

    expect(takeTurnEnd(SESSION)).toBeDefined();
    expect(takeTurnEnd(SESSION)).toBeUndefined();
  });

  test("l'SSE si chiude comunque: il deposito non sostituisce l'abort del controller", async () => {
    const h = harness();
    await h.abort({ sessionKey: SESSION });
    expect(h.aborted.sse).toBe(true);
  });

  test("nessuno stream vivo: niente da fermare e NIENTE da depositare", async () => {
    const h = harness();
    await h.abort({ sessionKey: SESSION }); // consuma lo stream
    resetTurnEndRegistry();

    const resp = (await h.abort({ sessionKey: SESSION }))!;
    expect(await resp.json()).toEqual({ ok: false, reason: "no_active_stream", cleared: false });
    // Un turno che questo server non sta guidando non ha una fine da raccontare:
    // depositarne una qui la attribuirebbe al turno headless di qualcun altro.
    expect(takeTurnEnd(SESSION)).toBeUndefined();
  });
});
