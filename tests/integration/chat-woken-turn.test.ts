/**
 * IL RISVEGLIO ARRIVA IN CHAT — la prova che il buco è chiuso.
 *
 * `claude-code-woken-turn.test.ts` pinna il contratto del PROVIDER: un turno
 * senza handler sveglia qualcuno, e gli eventi tenuti da parte si consegnano.
 * Ma quel test si ferma al bordo del provider: dimostra che la risposta viene
 * offerta, non che qualcuno la scriva da qualche parte.
 *
 * Qui si guida la route VERA (`POST /api/chat`, `mode: "woken"`) e si legge la
 * riga dal database VERO. È la domanda che conta per chi usa Topics: ho armato
 * un Monitor sul build, il build è fallito — me lo ritrovo in chat?
 *
 * Il buco che chiude: prima di questo lavoro la risposta del Monitor esisteva
 * sul filo della CLI e non arrivava da nessuna parte, perché nasce come turno
 * NUOVO dopo un `result` e dopo un `result` nessuno ascolta. Traccia misurata
 * il 20/08/2026 accanto a `onWokenTurn` in providers/claude-code.ts.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-woken-turn-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

interface Harness {
  ctx: AppContext;
  /** Semina una riga assistente conclusa, come quella del turno precedente. */
  rigaPrecedente: (content: string, blocks: unknown[]) => void;
  /** Chiama la route in modalità `woken` e torna lo handler che ha registrato. */
  adotta: (opts?: { adottabile?: boolean }) => Promise<{ resp: Response | null; handler?: StreamHandler }>;
  righe: () => Array<{ role: string; content: string; partial: boolean }>;
}

async function harness(sessionKey: string): Promise<Harness> {
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = () => {};

  const topic: Topic = {
    id: `t-${sessionKey}`, name: "monitor", slug: "monitor", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "claude-code",
  } as Topic;
  ctx.saveSingleTopic(topic);

  let captured: StreamHandler | undefined;
  /** Il provider finto risponde alla sola domanda che la modalità `woken` gli fa. */
  let adottabile = true;
  const provider = {
    name: "claude-code",
    capabilities: new Set(["streaming"]),
    contextStrategy: "inline-system",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    // È il cuore della modalità: SINCRONO, e torna un booleano. Gli eventi veri
    // li ha già in pancia il provider; qui si guida lo handler a mano, come fa
    // `drainWokenBuffer` con quelli tenuti da parte.
    adoptWokenTurn: (_sk: string, h: StreamHandler) => { if (!adottabile) return false; captured = h; return true; },
    sendChat: () => { throw new Error("un risveglio non deve MAI mandare un messaggio"); },
    defaultModel: () => "claude-opus-5",
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
    WORKSPACE_DIR: testTmpDir("chat-woken-ws"),
  } as never);

  const adotta = async (opts?: { adottabile?: boolean }) => {
    adottabile = opts?.adottabile ?? true;
    captured = undefined;
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // La forma che manda `runHeadlessWoken`: nessun messaggio, il provider
      // dichiarato, e il modo.
      body: JSON.stringify({ sessionKey, messages: [], mode: "woken", provider: "claude-code" }),
    });
    const resp = (await chatRouter(req, url, "/api/chat", "POST")) as Response | null;
    resp?.body?.cancel().catch(() => {});
    return { resp, handler: captured };
  };

  /** Scrive a mano una riga assistente «di prima», come farebbe un turno vero. */
  const rigaPrecedente = (content: string, blocks: unknown[]) => {
    const now = new Date().toISOString();
    ctx.db.run(
      `INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order)
       VALUES (?, ?, 'assistant', ?, ?, 0, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM messages WHERE session_key = ?))`,
      [`m-${Math.random().toString(36).slice(2)}`, sessionKey, content, JSON.stringify(blocks), now, sessionKey],
    );
  };

  const righe = () =>
    ctx.loadLocalMessages(sessionKey).map((m) => ({
      role: m.role, content: m.content, partial: m.partial === true,
    }));

  return { ctx, adotta, righe, rigaPrecedente };
}

describe("il turno risvegliato dal Monitor finisce in chat", () => {
  test("la risposta si scrive sulla riga, come un turno qualunque", async () => {
    const h = await harness("topic:woken-chat");
    const { resp, handler } = await h.adotta();
    expect(resp?.status).toBe(200);
    expect(handler).toBeDefined();

    // È il testo del risveglio misurato sul wire: la risposta che prima cadeva.
    handler!.onTextDelta("Il build è fallito: BUILD-FALLITO-XYZ", "Il build è fallito: BUILD-FALLITO-XYZ");
    handler!.onDone({ result: "Il build è fallito: BUILD-FALLITO-XYZ" });
    // La finalizzazione della route è asincrona (scrive, poi chiude l'SSE).
    await Bun.sleep(60);

    const righe = h.righe();
    const assistente = righe.filter((r) => r.role === "assistant");
    expect(assistente.length).toBe(1);
    expect(assistente[0]!.content).toBe("Il build è fallito: BUILD-FALLITO-XYZ");
    // Turno chiuso, non una riga rimasta a metà.
    expect(assistente[0]!.partial).toBe(false);
  });

  /**
   * IL RISVEGLIO NON EREDITA IL TURNO DI PRIMA.
   *
   * `mode: "woken"` riusa la macchina del riattacco, e per un pezzo l'ha riusata
   * TROPPO: prendeva anche l'istantanea della riga precedente. Quell'istantanea
   * esiste perché un riattacco SVUOTA la riga che riusa e deve poter ripescare
   * ciò che il replay non ri-emette (`reattachMerge.ts`); un risveglio invece
   * apre una riga NUOVA, quindi il merge gli incollava addosso il turno prima.
   *
   * Misurato sulla chat 205d1fbb il 20/08: tre righe di fila con gli stessi due
   * tool e lo stesso testo «armato», di cui una sola vera.
   */
  test("non eredita blocchi e testo della riga precedente", async () => {
    const h = await harness("topic:woken-no-eredita");
    // Il turno di prima: due tool e una frase, conclusi.
    h.rigaPrecedente("armato", [
      { kind: "tool", toolCall: { id: "t1", name: "Monitor", status: "success" } },
      { kind: "text", text: "armato" },
    ]);

    const { handler } = await h.adotta();
    handler!.onTextDelta("Il build e' fallito", "Il build e' fallito");
    handler!.onDone({ result: "Il build e' fallito" });
    await Bun.sleep(60);

    const righe = h.righe().filter((r) => r.role === "assistant");
    expect(righe.length).toBe(2);
    // La riga vecchia resta com'era…
    expect(righe[0]!.content).toBe("armato");
    // …e la nuova porta SOLO il suo contenuto, non quello di prima.
    expect(righe[1]!.content).toBe("Il build e' fallito");
    expect(righe[1]!.content).not.toContain("armato");
  });

  /**
   * IL RISVEGLIO A MANI VUOTE NON LASCIA UNA RIGA.
   *
   * Un Monitor che si chiude sveglia un turno per annunciarlo, e quel turno
   * spesso non ha niente da dire: la CLI emette la sua sentinella
   * («No response requested.»). Nessuno l'ha chiesto, quindi il silenzio è la
   * risposta giusta — e in chat non deve restare niente.
   */
  test("un risveglio che non ha niente da dire non lascia una riga", async () => {
    const h = await harness("topic:woken-vuoto");
    const prima = h.righe().length;
    const { handler } = await h.adotta();
    handler!.onTextDelta("No response requested.", "No response requested.");
    handler!.onDone({ result: "No response requested." });
    await Bun.sleep(80);

    expect(h.righe().length).toBe(prima);
  });

  test("NESSUN messaggio utente viene inventato per far partire il turno", async () => {
    // È la trappola in cui era già caduto il riattacco: `messages: []` + un ramo
    // che ripiega su `sendChat` = un turno fabbricato che risponde «Ciao! Come
    // posso aiutarti?» al posto della risposta vera. Il provider finto qui
    // ESPLODE se `sendChat` viene chiamato, quindi il test fallirebbe forte.
    const h = await harness("topic:woken-no-user");
    const { handler } = await h.adotta();
    handler!.onTextDelta("evento", "evento");
    handler!.onDone({ result: "evento" });
    await Bun.sleep(60);

    expect(h.righe().filter((r) => r.role === "user")).toEqual([]);
  });

  test("se il turno non è più adottabile non si scrive niente sopra la chat", async () => {
    // La corsa vera: fra la sveglia e questa chiamata l'utente ha scritto (o il
    // figlio è morto). Il provider dice `false` e la gamba deve morire senza
    // lasciare una riga vuota in conversazione.
    const h = await harness("topic:woken-gone");
    const { resp } = await h.adotta({ adottabile: false });
    // La route risponde comunque 200 con uno stream: il fallimento arriva sul
    // filo, non come codice HTTP (stessa forma di ogni altro guasto di turno).
    expect(resp?.status).toBe(200);
    await Bun.sleep(60);

    const assistente = h.righe().filter((r) => r.role === "assistant");
    // Nessuna risposta vuota, e soprattutto nessuna riga lasciata `partial`
    // che il prossimo riattacco riuserebbe.
    expect(assistente.filter((r) => r.partial)).toEqual([]);
    // E NIENTE CARTELLO D'ERRORE. È il punto di questo test: «l'ha preso
    // qualcun altro» non è un guasto da mostrare a chi sta chattando — la
    // risposta vera sta arrivando sull'altro turno, e un «non sono riuscito ad
    // avviare il turno» in mezzo sarebbe rumore su una chat che funziona.
    for (const r of assistente) {
      expect(r.content).not.toContain("Non sono riuscito");
      expect(r.content).not.toContain("WOKEN_TURN_GONE");
    }
  });

  test("un provider che non sa adottare viene RESPINTO, non ripiegato su sendChat", async () => {
    const ctx = await createTestAppContext();
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
    (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
      .broadcastToTopicSubscribers = () => {};
    const sessionKey = "topic:woken-unsupported";
    ctx.saveSingleTopic({
      id: `t-${sessionKey}`, name: "x", slug: "x", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "senza-adozione",
    } as Topic);

    const provider = {
      name: "senza-adozione",
      capabilities: new Set(["streaming"]),
      contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: () => {},
      unregisterStreamHandler: () => {},
      sendChat: () => { throw new Error("non deve essere chiamato"); },
      defaultModel: () => "m",
      abort: async () => {}, start: () => {}, stop: () => {},
      complete: async () => ({ content: "" }),
    } as unknown as AIProvider;

    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider,
      detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
      resolveProjectRef: () => null, getProjectIdForTopic: () => null,
      getWorkspaceProjects: () => [], autoBindProject: () => {},
      watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(),
      WORKSPACE_DIR: testTmpDir("chat-woken-unsupported-ws"),
    } as never);

    const url = new URL("http://topics.test/api/chat");
    const resp = (await chatRouter(
      new Request(url.toString(), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [], mode: "woken", provider: "senza-adozione" }),
      }),
      url, "/api/chat", "POST",
    )) as Response | null;

    expect(resp?.status).toBe(501);
    expect((await resp!.json()).code).toBe("woken_unsupported");
    // E la chat resta intatta: nessuna riga aperta per un turno mai adottato.
    expect(ctx.loadLocalMessages(sessionKey)).toEqual([]);
  });
});
