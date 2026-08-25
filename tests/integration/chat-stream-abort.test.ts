/**
 * Il TESTO di un turno fermato, e da dove lo legge chi disegna.
 *
 * Due difetti veri sulla stessa riga di database, tutti e due invisibili finché
 * non si guarda la colonna giusta.
 *
 * 1. **`blocks` si ferma al decimo delta, `content` no.** La route persiste i
 *    blocchi ogni `SAVE_INTERVAL = 10` chunk, mentre `content` vive in memoria
 *    e viene scritto per intero da chi finalizza. Fermare un turno al
 *    quindicesimo delta lasciava la riga con quindici delta in `content` e dieci
 *    in `blocks` — e il client, quando i blocchi ci sono, rende QUELLI. La
 *    risposta appariva troncata mentre il finale era lì, una colonna più in là.
 *
 * 2. **Un token ripetuto spariva.** `onTextDelta` riceve il pezzo nuovo da tutti
 *    i provider tranne il gateway OpenClaw, ma la route trattava il primo
 *    argomento come CUMULATIVO: se era identico al precedente lo scartava come
 *    «niente di nuovo». Due pezzi uguali di fila — «the the», due `\n`, un `= =`
 *    in una tabella — e il secondo non arrivava né a schermo né su disco.
 *
 * Si guida la route VERA (`POST /api/chat`) con un provider finto che consegna
 * il proprio `StreamHandler`, poi si preme stop dalla route vera
 * (`POST /api/chat/abort`) e si legge la riga dal database vero.
 *
 * @covers CHAT-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { createTopicsRouter } from "../../server/routes/topics";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-stream-abort-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

// La rotta di abort risolve il provider dal REGISTRO (non dalle deps della chat
// router): serve una voce vera, e `openai` senza chiave è `connected: false`,
// quindi la rotta non chiama nessun abort di provider e la prova resta sul
// comportamento della route.
registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* già tolto */ } });

interface Harness {
  ctx: AppContext;
  /** Manda il primo messaggio e ritorna lo `StreamHandler` che la route registra. */
  startTurn: () => Promise<StreamHandler>;
  abort: () => Promise<Response | null>;
  row: () => { content: string; blocksText: string };
  fanout: { all: number; toTopic: number };
}

async function harness(sessionKey: string): Promise<Harness> {
  const ctx = await createTestAppContext();

  const fanout = { all: 0, toTopic: 0 };
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => { fanout.all++; };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = () => { fanout.toTopic++; };

  const topic: Topic = {
    id: `t-${sessionKey}`, name: "stop", slug: "stop", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);

  let captured: StreamHandler | undefined;
  const provider = {
    name: "fake-stream",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    // Resta pendente: il turno lo guidiamo noi dal manico dello handler, come
    // fa un provider vero mentre la sua `for await` gira.
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;

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
    WORKSPACE_DIR: testTmpDir("chat-stream-abort-ws"),
  } as never);

  // La rotta di abort è quella vera, montata sullo STESSO ctx: legge
  // `activeStreams` che la rotta di chat ha appena riempito.
  const topicsRouter = createTopicsRouter(ctx);

  const startTurn = async (): Promise<StreamHandler> => {
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "scrivi qualcosa" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    // Il corpo SSE non si legge: lo drenerebbe fino a `[DONE]`, che arriva solo
    // a turno finito. Qui interessa lo handler, che la route registra prima di
    // ritornare.
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("la route non ha registrato nessuno StreamHandler");
    return captured;
  };

  const abort = () => {
    const url = new URL("http://topics.test/api/chat/abort");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey }),
    });
    return topicsRouter(req, url, "/api/chat/abort", "POST") as Promise<Response | null>;
  };

  const row = () => {
    const messages = ctx.loadLocalMessages(sessionKey);
    const assistant = messages.filter((m) => m.role === "assistant").pop();
    if (!assistant) throw new Error("nessuna riga assistente");
    const blocksText = (assistant.blocks ?? [])
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    return { content: assistant.content, blocksText };
  };

  return { ctx, startTurn, abort, row, fanout };
}

/** Quindici delta: cinque oltre l'ultimo salvataggio periodico (SAVE_INTERVAL = 10). */
const DELTAS = Array.from({ length: 15 }, (_, i) => `d${i + 1} `);

describe("stop su un turno a metà: cosa resta scritto sulla riga", () => {
  test("i blocchi arrivano fino all'ULTIMO delta, non fino al decimo", async () => {
    const h = await harness("topic:abort-blocks");
    const handler = await h.startTurn();

    let cumulato = "";
    for (const d of DELTAS) { cumulato += d; handler.onTextDelta(d, cumulato); }

    const resp = (await h.abort())!;
    expect((await resp.json()).ok).toBe(true);

    const { content, blocksText } = h.row();
    // `content` era già giusto (lo scrive chi finalizza, dallo stream in
    // memoria). Il difetto stava tutto nella colonna che il client rende.
    expect(content).toBe(cumulato);
    expect(blocksText).toBe(cumulato);
    // E in particolare: la coda oltre il decimo delta c'è.
    expect(blocksText).toContain("d15 ");
  });

  test("un token ripetuto sopravvive: due delta identici di fila sono due", async () => {
    const h = await harness("topic:abort-repeat");
    const handler = await h.startTurn();

    // La vecchia euristica scartava il secondo "the " come «niente di nuovo».
    const pezzi = ["Ho detto ", "the ", "the ", "cosa?"];
    let cumulato = "";
    for (const p of pezzi) { cumulato += p; handler.onTextDelta(p, cumulato); }

    await h.abort();

    const { content, blocksText } = h.row();
    expect(content).toBe("Ho detto the the cosa?");
    expect(blocksText).toBe("Ho detto the the cosa?");
  });
});

describe("lo snapshot del sotto-agente va alla topic, non a tutti", () => {
  test("stream:tool_detail passa dal fan-out per topic", async () => {
    const h = await harness("topic:subagent-fanout");
    const handler = await h.startTurn();

    const prima = { ...h.fanout };
    handler.onSubAgentUpdate?.("task-1", {
      subAgentType: "scout",
      description: "cerca",
      actions: [{ kind: "tool", name: "Read", detail: "x" }],
      finished: false,
    } as never);

    // È lo snapshot INTERO del sotto-agente, rifatto a ogni colpo: i frame più
    // grossi del turno. Ogni finestra aperta su un'altra topic li riceveva tutti
    // per instradarli su `topicId` e buttarli.
    expect(h.fanout.toTopic).toBe(prima.toTopic + 1);
    expect(h.fanout.all).toBe(prima.all);

    await h.abort();
  });
});

/**
 * IL TURNO DEL 20/08 (topic:9f9e9629) CHE È FINITO SENZA DIRE NIENTE.
 *
 * Questa è la prova che chiude il cerchio: non la decisione pura
 * (`lib/cancelled-notice.test.ts`) né il ciclo del provider
 * (`native/abort-cause.test.ts`), ma la RIGA che resta in database dopo che il
 * server si è spento sopra un turno vivo — cioè esattamente ciò che l'utente
 * riapre e legge.
 *
 * Le condizioni ricreate, una per una:
 *   · un turno che ha già scritto della prosa e chiamato dei tool;
 *   · nessuno che preme Ferma;
 *   · l'annullamento che arriva dal provider con `cause: "server-shutdown"`,
 *     che è ciò che `NativeProvider.stop()` produce quando `stopAllProviders()`
 *     gira dentro `gracefulShutdown`.
 *
 * Contro il codice di prima questo test è ROSSO: `finalizeStream` su `aborted`
 * non scriveva niente, quindi la riga restava con la sola prosa a metà, senza
 * blocco `error` — e senza blocco `error` il client (`turnError.ts`) non accende
 * né il banner né il bottone «Riprova». Il turno moriva muto.
 */
describe("il server si spegne sopra un turno vivo", () => {
  test("LA RIGA PARLA: cartello, causa, e il lavoro già fatto sotto", async () => {
    const h = await harness("topic:shutdown-notice");
    const handler = await h.startTurn();

    // Il turno aveva già detto qualcosa — come il vero: «Ho capito il richiamo:
    // Nerissima Serpe — la pazzia è il verso ospite.»
    let cumulato = "";
    for (const d of ["Ho capito il richiamo. ", "Prima misuro il divario."]) {
      cumulato += d;
      handler.onTextDelta(d, cumulato);
    }

    // …e poi il server si spegne. Questa è la forma ESATTA con cui l'annuncio
    // arriva alla route: `onAborted` con la causa dichiarata dal provider.
    handler.onAborted?.({ result: cumulato, turnEnd: { end: "cancelled", cause: "server-shutdown" } });
    // La finalizzazione è asincrona (scrive, poi chiude l'SSE).
    await new Promise((r) => setTimeout(r, 50));

    const messages = h.ctx.loadLocalMessages("topic:shutdown-notice");
    const assistente = messages.filter((m) => m.role === "assistant").pop()!;

    // 1. LA RIGA C'È ANCORA. Un turno con del lavoro dentro non si butta.
    expect(assistente).toBeDefined();
    expect(assistente.partial).toBeFalsy();

    // 2. IL LAVORO GIÀ FATTO È SALVO: quello che il modello aveva scritto prima
    //    dello spegnimento resta leggibile.
    const prosa = (assistente.blocks ?? [])
      .filter((b) => b.kind === "text")
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    expect(prosa).toContain("Ho capito il richiamo");
    expect(prosa).toContain("Prima misuro il divario");

    // 3. E ACCANTO C'È LA SPIEGAZIONE. È il pezzo che mancava: senza un blocco
    //    `error`, `turnErrorOf` ritorna null e il client non disegna né il
    //    banner ambra né il bottone per rimandare il messaggio.
    const cartello = (assistente.blocks ?? []).find((b) => b.kind === "error");
    expect(cartello).toBeDefined();
    expect(cartello && cartello.kind === "error" ? cartello.text : "").toContain("riavviato");
  });

  /**
   * L'ALTRO VERSO, e va provato insieme al primo: la correzione non deve
   * trasformare lo stop a mano in un turno che spiega a chi ha premuto cosa ha
   * premuto. Un umano che ferma la risposta vede la sua prosa e basta.
   */
  test("lo stop premuto dall'umano resta muto come prima", async () => {
    const h = await harness("topic:shutdown-user-quiet");
    const handler = await h.startTurn();

    let cumulato = "";
    for (const d of ["Sto scrivendo", " una risposta."]) { cumulato += d; handler.onTextDelta(d, cumulato); }

    handler.onAborted?.({ result: cumulato, turnEnd: { end: "cancelled", cause: "user" } });
    await new Promise((r) => setTimeout(r, 50));

    const messages = h.ctx.loadLocalMessages("topic:shutdown-user-quiet");
    const assistente = messages.filter((m) => m.role === "assistant").pop()!;
    expect(assistente).toBeDefined();
    const cartello = (assistente.blocks ?? []).find((b) => b.kind === "error");
    expect(cartello).toBeUndefined();
    expect(assistente.content).toBe("Sto scrivendo una risposta.");
  });

  /**
   * IL CASO PIÙ CRUDO: lo spegnimento arriva PRIMA che il modello dica una sola
   * parola. Con la regola vecchia la riga era vuota e veniva buttata
   * (`shared/empty-turn.ts`), quindi in chat restava il messaggio dell'utente e
   * NIENTE dopo: nessuna risposta, nessuna spiegazione, nessun bottone. È il
   * silenzio nella sua forma peggiore, perché non lascia nemmeno una traccia da
   * cui capire cos'è successo.
   */
  test("spegnimento prima di una sola parola: resta comunque il cartello", async () => {
    const h = await harness("topic:shutdown-vuoto");
    const handler = await h.startTurn();

    handler.onAborted?.({ result: "", turnEnd: { end: "cancelled", cause: "server-shutdown" } });
    await new Promise((r) => setTimeout(r, 50));

    const messages = h.ctx.loadLocalMessages("topic:shutdown-vuoto");
    const assistente = messages.filter((m) => m.role === "assistant").pop();
    expect(assistente).toBeDefined();
    // Il testo porta il cartello: è ciò che legge la ricerca ⌘K e ciò che
    // rende un client vecchio, che il blocco `error` non lo conosce.
    expect(assistente!.content).toContain("⚠️");
    expect(assistente!.content).toContain("riavviato");
  });
});

/**
 * «RIPRENDO DA SOLO» SI PROMETTE SOLO DOVE È VERO.
 *
 * `avvisoPerTurno` sa dire «non serve che tu faccia niente» al posto di
 * «Riprova» — ma il campo che lo attiva non veniva passato da NESSUNO: la coda
 * esisteva nel codice e non è mai comparsa a schermo, nemmeno sui turni che il
 * boot riprendeva davvero. Chi vedeva un turno ucciso da un riavvio leggeva
 * «Riprova rimanda il tuo messaggio»: premendolo partivano due turni, entrambi
 * a pagamento.
 *
 * E LA CAUSA RIPRENDIBILE È UNA SOLA DELLE TRE. `riprendiTurniInterrotti` è una
 * funzione di BOOT (`server.ts`, in coda al giro di riadozione):
 *
 *  · `server-shutdown` → un boot segue per definizione, il processo sta morendo
 *    mentre scriviamo il cartello. La promessa si mantiene da sé.
 *  · `watchdog` / `wall-clock` → il server RESTA SU: quella funzione non gira,
 *    e nessuno riprende niente. Prometterlo qui sarebbe il verso peggiore
 *    dell'errore — oggi si spreca un turno in modo VISIBILE, con la promessa si
 *    perderebbe il turno in SILENZIO.
 */
describe("la promessa di ripresa sul cartello", () => {
  test("spegnimento del server: la card dice che non serve fare niente", async () => {
    const h = await harness("topic:ripresa-shutdown");
    const handler = await h.startTurn();
    handler.onAborted?.({ result: "", turnEnd: { end: "cancelled", cause: "server-shutdown" } });
    await new Promise((r) => setTimeout(r, 50));

    const m = h.ctx.loadLocalMessages("topic:ripresa-shutdown").filter((x) => x.role === "assistant").pop()!;
    const cartello = (m.blocks ?? []).find((b) => b.kind === "error");
    const testo = cartello && cartello.kind === "error" ? cartello.text : "";
    expect(testo).toContain("Riprendo da solo");
    // E NON il bottone: chiedere un gesto per una cosa che sta già succedendo
    // fa spendere un turno in più.
    expect(testo).not.toContain("«Riprova»");
  });

  test("watchdog e limite di tempo: resta «Riprova», perché nessuno riprende", async () => {
    for (const cause of ["watchdog", "wall-clock"] as const) {
      const h = await harness(`topic:ripresa-${cause}`);
      const handler = await h.startTurn();
      handler.onAborted?.({ result: "", turnEnd: { end: "cancelled", cause } });
      await new Promise((r) => setTimeout(r, 50));

      const m = h.ctx.loadLocalMessages(`topic:ripresa-${cause}`).filter((x) => x.role === "assistant").pop()!;
      const cartello = (m.blocks ?? []).find((b) => b.kind === "error");
      const testo = cartello && cartello.kind === "error" ? cartello.text : "";
      expect(testo, cause).toContain("«Riprova»");
      expect(testo, cause).not.toContain("Riprendo da solo");
    }
  });
});
