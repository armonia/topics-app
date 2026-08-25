/**
 * IL PONTE MCP DEL BROWSER — chi entra, e SU QUALE PANNELLO finisce.
 *
 * Le sei rotte `…/browser/*` sono la porta da cui una CLI guida il browser di
 * Topics, e finora l'unica parte davvero senza rete era la più ramificata: la
 * RISOLUZIONE DEL CONTESTO. Lo stesso `contextId` può nascere da tre posti —
 * una chat topic, un task di board, un terminale — e ogni rotta lo ricava a
 * modo suo (open-pane ha tre rami suoi, le altre passano da
 * `resolveBrowserContext`, due accettano un override esplicito da validare
 * contro l'inventario vivo). Sbagliare ramo non dà un errore: dà un pannello
 * INVISIBILE guidato al posto di quello che l'umano guarda — il guasto
 * originale che aveva prodotto il broadcast-prima-del-dispatch.
 *
 * Cosa NON si finge qui: il dispatcher dei tool e l'inventario delle schede
 * sono quelli veri. Finto è solo il `BrowserService` (`navigate`,
 * `getOrCreate`, `listContexts`, `destroyContext`), così le asserzioni cadono
 * sul contextId che il ponte ha SCELTO, non su un mock del ponte stesso.
 * @covers BROWSER-CHAT-03
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserBridgeRouter, type TerminalSessionRef } from "./browser-bridge";
import type { AppContext, Topic } from "../types";
import type { BrowserService } from "../browser-service";

const TOKEN = "gateway-token-di-prova";

function makeTopic(id: string, over: Partial<Topic> = {}): Topic {
  return {
    id,
    name: `Topic ${id}`,
    slug: id,
    parentId: null,
    links: [],
    sessionKey: `topic:${id}`,
    color: "#000",
    icon: "MessageSquare",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    ...over,
  } as Topic;
}

interface HarnessOpts {
  /** Build senza browser: ogni rotta che ne ha bisogno deve rispondere 503. */
  noService?: boolean;
  /** URL finale di `navigate` (per il caso redirect). Default: quello chiesto. */
  navigateTo?: string;
  /** `destroyContext` esplode: è il caso di una pane solo-nativa, senza contesto headless. */
  destroyThrows?: boolean;
  /**
   * Dà al contesto finto uno `storageState()`, cioè quel che serve a
   * `browser_save_state` per riuscire. Senza, l'export esplode e il tool
   * risponde `{error}` — che è esattamente l'altro caso da provare.
   */
  storageState?: { cookies: unknown[]; origins: unknown[] };
  /**
   * «Una pane si è agganciata al contextId?» — il segnale con cui open-pane
   * decide se armare il ripiego `browser:force-open` e cosa rispondere.
   * Default `true` (il caso normale: la finestra c'è e monta il pannello).
   * `false` = nessuna finestra la prende; `"dopo-force-open"` = la prende solo
   * dopo che il ripiego è stato emesso, che è il caso che il ripiego esiste
   * per coprire.
   */
  paneAttached?: boolean | "dopo-force-open";
}

function harness(opts: HarnessOpts = {}) {
  const topics = new Map<string, Topic>();
  const terminals = new Map<string, TerminalSessionRef>();
  const taskOfTopic = new Map<string, { id: string }>();
  const taskOfPrefix = new Map<string, { text: string }>();
  const contexts: Array<{ id: string; url?: string; title?: string }> = [];

  const broadcasts: Array<Record<string, unknown> & { type: string }> = [];
  /** Le scritture del record `task-browser-tabs:<taskId>` (il db resta fuori). */
  const persisted: Array<{ taskId: string; contextId: string; url: string; title: string }> = [];
  const loginAttached: Array<{ contextId: string; handle: string }> = [];
  /**
   * Traccia UNICA di persistenza e broadcast, in ordine: la tab del task deve
   * essere scritta PRIMA di essere annunciata, altrimenti un dispatch senza
   * finestre aperte la perde di nuovo.
   */
  const order: string[] = [];
  const saved: string[] = [];
  const destroyed: string[] = [];
  const navigatedTopics = new Set<string>();
  /** Il PRIMO effetto del dispatcher vero: dice su quale contesto è atterrato. */
  const dispatchedOn: string[] = [];
  const navigations: Array<{ contextId: string; url: string }> = [];
  /** Su quali contextId la rotta ha chiesto «c'è una pane viva?». */
  const attachChecks: string[] = [];
  const evaluations: Array<{ contextId: string; expression: string }> = [];

  const page = (contextId: string) => ({
    replEvaluate: async (expression: string) => {
      evaluations.push({ contextId, expression });
      return "42";
    },
    waitForLoadState: async () => {},
    viewportSize: () => null,
    evaluate: async () => { throw new Error("pagina finta: niente evaluate"); },
  });

  const service = {
    listContexts: () => contexts,
    setAgentAction: (contextId: string) => { dispatchedOn.push(contextId); },
    broadcastAgentActive: () => {},
    navigate: async (contextId: string, url: string) => {
      navigations.push({ contextId, url });
      return { url: opts.navigateTo ?? url, title: "Titolo" };
    },
    getOrCreate: async (contextId: string) => ({
      page: page(contextId),
      context: opts.storageState ? { storageState: async () => opts.storageState } : undefined,
    }),
    destroyContext: async (id: string) => {
      if (opts.destroyThrows) throw new Error("nessun contesto headless per questa pane");
      destroyed.push(id);
    },
  } as unknown as BrowserService;

  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    // Copia fedele di utils.ts:matchRoute — confronta prima il NUMERO di
    // segmenti, ed è la ragione per cui montare questo router dov'era open-pane
    // non scavalca le rotte a cinque segmenti di topics.ts.
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/");
      const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: (msg: Record<string, unknown> & { type: string }) => { broadcasts.push(msg); order.push(`broadcast:${msg.type}`); },
    getTopicById: (id: string) => topics.get(id) ?? null,
    getTopicBySessionKey: (key: string) => [...topics.values()].find((t) => t.sessionKey === key) ?? null,
    loadTopics: () => ({ topics: Object.fromEntries(topics) }),
    saveSingleTopic: (t: Topic) => { saved.push(t.id); topics.set(t.id, t); },
  } as unknown as AppContext;

  const router = createBrowserBridgeRouter(ctx, {
    getTerminalSessionById: (id) => terminals.get(id),
    taskForTopic: (topicId) => taskOfTopic.get(topicId) ?? null,
    taskByIdPrefix: (prefix) => taskOfPrefix.get(prefix) ?? null,
    browserNavigatedTopics: navigatedTopics,
    persistTaskTab: (taskId, contextId, url, title) => { persisted.push({ taskId, contextId, url, title: title ?? "" }); order.push("persist"); },
    attachLoginHandle: (contextId, handle) => { loginAttached.push({ contextId, handle }); order.push("login-attach"); },
    paneAttachedTo: (contextId) => {
      attachChecks.push(contextId);
      if (opts.paneAttached === false) return false;
      if (opts.paneAttached === "dopo-force-open") {
        return broadcasts.some((b) => b.type === "browser:force-open");
      }
      return true;
    },
    // Le attese vere sono da secondi: qui bastano pochi millisecondi, o ogni
    // test del ramo «nessuna pane» pagherebbe due finestre piene.
    paneWaitMs: 20,
  }, opts.noService ? undefined : service);

  const post = async (path: string, body?: unknown, headers: Record<string, string> = { "x-gateway-token": TOKEN }) => {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
    return router(req, url, url.pathname, "POST");
  };

  return {
    router, post,
    topics, terminals, taskOfTopic, taskOfPrefix, contexts,
    broadcasts, persisted, loginAttached, order, saved, destroyed, navigatedTopics, dispatchedOn, navigations, evaluations, attachChecks,
    addTopic: (id: string, over?: Partial<Topic>) => { const t = makeTopic(id, over); topics.set(id, t); return t; },
    addTerminal: (id: string) => { terminals.set(id, { id, name: `Terminal ${id}`, cwd: "/tmp" }); },
    typed: (type: string) => broadcasts.filter((b) => b.type === type),
  };
}

let savedToken: string | undefined;
beforeEach(() => { savedToken = process.env.GATEWAY_TOKEN; process.env.GATEWAY_TOKEN = TOKEN; });
afterEach(() => {
  if (savedToken === undefined) delete process.env.GATEWAY_TOKEN;
  else process.env.GATEWAY_TOKEN = savedToken;
});

// ---------------------------------------------------------------------------
// La risoluzione del contesto: topic, task, terminale, niente.
// ---------------------------------------------------------------------------
describe("risoluzione del contesto — le tre provenienze di un contextId", () => {
  test("chat topic: l'indirizzo per :id e quello per :sessionKey portano allo STESSO pannello", async () => {
    const h = harness();
    h.addTopic("t1");

    const byId = await h.post("/api/topics/t1/browser/focus-pane");
    const bySession = await h.post("/api/sessions/topic%3At1/browser/focus-pane");

    expect(await byId!.json()).toEqual({ ok: true, contextId: "t1" });
    // La sessionKey arriva percent-encoded dal sottoprocesso MCP: senza
    // decodifica `topic%3At1` non troverebbe nessuna topic e finirebbe in 404.
    expect(await bySession!.json()).toEqual({ ok: true, contextId: "t1" });
  });

  test("un pannello già aperto vince sull'id della topic (browserState.contextId)", async () => {
    const h = harness();
    h.addTopic("t1", { browserState: { url: "https://x", contextId: "ctx-esistente", lastActiveAt: 1 } });

    const resp = await h.post("/api/topics/t1/browser/focus-pane");

    expect(await resp!.json()).toEqual({ ok: true, contextId: "ctx-esistente" });
  });

  test("terminale: la sessionKey che non è di nessuna chat diventa term-<id>, non un 404", async () => {
    const h = harness();
    h.addTerminal("term-abc");

    const resp = await h.post("/api/sessions/term-abc/browser/focus-pane");

    expect(await resp!.json()).toEqual({ ok: true, contextId: "term-term-abc" });
  });

  test("sessione senza chat né terminale ⇒ 404 che dice come uscirne", async () => {
    const h = harness();

    const resp = await h.post("/api/sessions/fantasma/browser/focus-pane");

    expect(resp!.status).toBe(404);
    expect((await resp!.json()).error).toContain("browser_list_tabs");
  });

  test("topic id inesistente ⇒ 404 (e NON ripiega sul terminale omonimo)", async () => {
    const h = harness();
    h.addTerminal("t1");

    const resp = await h.post("/api/topics/t1/browser/focus-pane");

    // La forma :id parla di topic: se la topic non c'è la richiesta è sbagliata,
    // non «prova anche fra i terminali».
    expect(resp!.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// open-pane: il ramo scelto decide CHI apre il pannello.
// ---------------------------------------------------------------------------
describe("open-pane — tre rami, tre pannelli diversi", () => {
  test("chat: broadcast PRIMA del dispatch, poi la navigazione sullo stesso contextId", async () => {
    const h = harness();
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/" });

    expect(await resp!.json()).toEqual({ url: "https://example.com/", title: "Titolo", visible: true });
    // L'ordine è il fix del guasto: prima il client monta il pannello sotto
    // ctxId, poi ci si naviga dentro. Invertito, Playwright guidava un fantasma.
    expect(h.broadcasts[0]).toMatchObject({ type: "browser:navigate", topicId: "t1", contextId: "t1", url: "https://example.com/" });
    expect(h.navigations).toEqual([{ contextId: "t1", url: "https://example.com/" }]);
    // Seminata: il ripiego «ho visto un localhost nel testo» non deve riaprire
    // un pannello che l'agente ha già aperto di sua volontà.
    expect(h.navigatedTopics.has("t1")).toBe(true);
  });

  test("chat: se la navigazione redirige, il pannello visibile insegue l'URL finale", async () => {
    const h = harness({ navigateTo: "https://example.com/finale" });
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/inizio" });

    expect(await resp!.json()).toEqual({ url: "https://example.com/finale", title: "Titolo", visible: true });
    expect(h.typed("browser:navigate").map((b) => b.url)).toEqual([
      "https://example.com/inizio",
      "https://example.com/finale",
    ]);
  });

  test("task: apre la scheda DENTRO il drawer del task e non tocca il browser headless", async () => {
    const h = harness();
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });

    const resp = await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://example.com/" });

    expect(await resp!.json()).toEqual({ url: "https://example.com/", title: "" });
    // contextId STABILE per (task, topic): riaprire riusa la stessa scheda.
    expect(h.typed("browser:open-task-tab")[0]).toMatchObject({
      taskId: "12345678-task",
      contextId: "task-12345678-aaaaaaaaa",
      url: "https://example.com/",
    });
    expect(h.typed("browser:navigate")).toEqual([]);
    // Nessun dispatch: il pannello del task può essere smontato (drawer chiuso),
    // e un browser_open headless guiderebbe un fantasma invisibile.
    expect(h.navigations).toEqual([]);
    // Il legame va persistito, o l'observe/act successivo non ritrova la scheda.
    expect(h.saved).toEqual(["aaaaaaaa-topic"]);
    expect(h.topics.get("aaaaaaaa-topic")!.browserState).toMatchObject({
      url: "https://example.com/",
      contextId: "task-12345678-aaaaaaaaa",
    });
  });

  // --- IL MANIFESTO: il nome È l'identità della tab ---
  //
  // Il guasto che questi test recintano: con un contextId stabile per (task,
  // topic) il SECONDO `open_browser_pane` navigava la prima tab invece di
  // aggiungerne una, quindi un task poteva consegnare UNA pagina sola.

  test("manifesto: due nomi diversi coniano due tab, non una che ri-naviga", async () => {
    const h = harness();
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });

    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://app.test/", name: "App" });
    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://report.test/", name: "Report" });

    expect(h.persisted).toEqual([
      { taskId: "12345678-task", contextId: "task-12345678-napp", url: "https://app.test/", title: "App" },
      { taskId: "12345678-task", contextId: "task-12345678-nreport", url: "https://report.test/", title: "Report" },
    ]);
    // Il nome viaggia anche nel broadcast e nella risposta all'agente: è
    // l'etichetta pinnata (`titleSource:'agent'`), non il titolo della pagina.
    expect(h.typed("browser:open-task-tab").map((m) => m.title)).toEqual(["App", "Report"]);
  });

  test("manifesto: lo STESSO nome ri-naviga la sua tab (idempotente, niente doppioni)", async () => {
    const h = harness();
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });

    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://app.test/uno", name: "App" });
    // Stesso nome, slug identico anche se scritto diverso: «App» e «app» sono
    // la stessa superficie per l'umano, e devono esserlo per il manifesto.
    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://app.test/due", name: "app" });

    expect(h.persisted.map((p) => p.contextId)).toEqual(["task-12345678-napp", "task-12345678-napp"]);
    expect(h.persisted[1].url).toBe("https://app.test/due");
  });

  test("manifesto: un nome fatto di soli simboli ricade sulla tab senza nome", async () => {
    const h = harness();
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });

    // `slugTabName("###")` è "" — coniare `task-…-n` collezionerebbe tutti i
    // nomi degeneri in UNA tab sola, che è peggio del ripiego.
    const resp = await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://x.test/", name: "###" });

    expect(await resp!.json()).toEqual({ url: "https://x.test/", title: "" });
    expect(h.persisted[0].contextId).toBe("task-12345678-aaaaaaaaa");
    expect(h.persisted[0].title).toBe("");
  });

  test("manifesto: fuori da un task il nome viene ignorato (nessun record di task)", async () => {
    const h = harness();
    h.addTopic("t1");

    await h.post("/api/topics/t1/browser/open-pane", { url: "https://x.test/", name: "App" });

    // Una chat qualsiasi non ha un manifesto: il pane-store globale etichetta
    // dal titolo di pagina, e scrivere `task-browser-tabs:*` da qui popolerebbe
    // il drawer di task che non l'hanno chiesto.
    expect(h.persisted).toEqual([]);
    expect(h.typed("browser:open-task-tab")).toEqual([]);
  });

  test("task: la scheda è SCRITTA prima di essere annunciata (un dispatch gira senza finestre)", async () => {
    const h = harness();
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });

    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://example.com/" });

    expect(h.persisted).toEqual([{
      taskId: "12345678-task",
      contextId: "task-12345678-aaaaaaaaa",
      url: "https://example.com/",
      title: "",
    }]);
    // L'ORDINE è il punto: finché l'unico scrittore era il client, «nessuna
    // finestra Topics aperta» voleva dire tab persa. Se il broadcast precedesse
    // la scrittura, un crash nel mezzo lascerebbe di nuovo il task senza il suo
    // risultato.
    expect(h.order).toEqual(["persist", "broadcast:browser:open-task-tab"]);
  });

  test("chat e terminale non scrivono nessun record di task", async () => {
    const h = harness();
    h.addTopic("t1");
    h.addTerminal("abc");

    await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/" });
    await h.post("/api/sessions/abc/browser/open-pane", { url: "https://example.com/" });

    // `task-browser-tabs:<id>` esiste solo per i dispatch di board: scriverlo da
    // una chat qualsiasi popolerebbe il drawer di task che non l'hanno chiesto.
    expect(h.persisted).toEqual([]);
  });

  test("task: con TOPICS_TASK_BROWSER=0 il fork è spento e si torna al pannello di layout", async () => {
    const prev = process.env.TOPICS_TASK_BROWSER;
    process.env.TOPICS_TASK_BROWSER = "0";
    try {
      const h = harness(); // il kill-switch si legge alla COSTRUZIONE del router
      const topic = h.addTopic("aaaaaaaa-topic");
      h.taskOfTopic.set(topic.id, { id: "12345678-task" });

      await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://example.com/" });

      expect(h.typed("browser:open-task-tab")).toEqual([]);
      expect(h.typed("browser:navigate")).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.TOPICS_TASK_BROWSER;
      else process.env.TOPICS_TASK_BROWSER = prev;
    }
  });

  test("terminale: apre il pannello ACCANTO al terminale e non naviga niente lato server", async () => {
    const h = harness();
    h.addTerminal("42");

    const resp = await h.post("/api/sessions/42/browser/open-pane", { url: "https://example.com/" });

    expect(await resp!.json()).toEqual({ url: "https://example.com/", title: "", visible: true });
    expect(h.broadcasts).toEqual([{
      type: "browser:open-near-pane",
      paneId: "terminal:42",
      contextId: "term-42",
      url: "https://example.com/",
    }]);
    expect(h.navigations).toEqual([]);
  });

  test("senza url ⇒ 400, su entrambi i rami", async () => {
    const h = harness();
    h.addTopic("t1");
    h.addTerminal("42");

    expect((await h.post("/api/topics/t1/browser/open-pane", {}))!.status).toBe(400);
    expect((await h.post("/api/sessions/42/browser/open-pane", {}))!.status).toBe(400);
    expect(h.broadcasts).toEqual([]);
  });

  test("build senza browser ⇒ 503 prima di qualunque broadcast", async () => {
    const h = harness({ noService: true });
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/" });

    expect(resp!.status).toBe(503);
    expect(h.broadcasts).toEqual([]);
  });

  test("aprire e chiudere un pannello NON chiedono il token del gateway", async () => {
    const h = harness();
    h.addTopic("t1");

    // Asimmetria voluta e verificata qui perché è una scelta di sicurezza:
    // navigare un pannello non legge cookie e non espone gli URL altrui, mentre
    // import-chrome/list-tabs/:tool sì — e infatti sono dietro il token.
    const open = await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/" }, {});
    const close = await h.post("/api/topics/t1/browser/close-pane", {}, {});

    expect(open!.status).toBe(200);
    expect(close!.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// «Aperto» deve voler dire VISTO.
//
// Il guasto dell'11/08/2026: contesto browser vivo (compare in
// browser_list_tabs, risponde a browser_status, ha la pagina caricata) e
// NESSUNA pane montata — perché il frame `browser:navigate` era caduto fra i due
// consumatori (il gruppo standalone lo scaricava sul progetto, il progetto lo
// rifiutava perché la topic non era sua). Il ripiego previsto,
// `browser:force-open`, aveva tipo, schema e gestore client ma nessun
// emettitore. E il tool rispondeva «Opened browser pane at …» lo stesso: da
// fuori i due esiti erano indistinguibili.
// ---------------------------------------------------------------------------
describe("open-pane — «visibile» non si dà per scontato", () => {
  test("nessuna pane aggancia il contextId ⇒ ripiego force-open, e la risposta lo DICE", async () => {
    const h = harness({ paneAttached: false });
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/" });

    expect(await resp!.json()).toEqual({ url: "https://example.com/", title: "Titolo", visible: false });
    expect(h.typed("browser:force-open")).toEqual([
      { type: "browser:force-open", contextId: "t1", url: "https://example.com/" },
    ]);
    expect(h.attachChecks).toContain("t1");
  });

  test("il ripiego funziona: la pane si aggancia dopo force-open ⇒ visible", async () => {
    const h = harness({ paneAttached: "dopo-force-open" });
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/" });

    expect(await resp!.json()).toMatchObject({ visible: true });
    expect(h.typed("browser:force-open")).toHaveLength(1);
  });

  test("pane già agganciata ⇒ nessun force-open (il ripiego non raddoppia i pannelli)", async () => {
    const h = harness();
    h.addTopic("t1");

    await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/" });

    expect(h.typed("browser:force-open")).toEqual([]);
  });

  test("dopo un redirect, il force-open porta l'URL FINALE (non quello di partenza)", async () => {
    const h = harness({ paneAttached: false, navigateTo: "https://example.com/finale" });
    h.addTopic("t1");

    await h.post("/api/topics/t1/browser/open-pane", { url: "https://example.com/inizio" });

    // Una pane forzata carica l'initialUrl e basta (su Tauri il server non la
    // guida via CDP): darle l'URL di partenza la lascerebbe sulla pagina
    // sbagliata mentre il contesto headless è già altrove.
    expect(h.typed("browser:force-open")[0]).toMatchObject({ url: "https://example.com/finale" });
  });

  test("terminale non renderizzato da nessuna parte: stesso ripiego, stessa risposta onesta", async () => {
    const h = harness({ paneAttached: false });
    h.addTerminal("42");

    const resp = await h.post("/api/sessions/42/browser/open-pane", { url: "https://example.com/" });

    expect(await resp!.json()).toEqual({ url: "https://example.com/", title: "", visible: false });
    expect(h.typed("browser:force-open")[0]).toMatchObject({ contextId: "term-42" });
  });

  test("la scheda di un task NON passa dal ripiego: vive nel drawer, e il suo record è già persistito", async () => {
    const h = harness({ paneAttached: false });
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });

    const resp = await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://example.com/" });

    // Forzare una pane standalone qui SPOSTEREBBE la tab fuori dal task, che è
    // il posto in cui il reviewer la cerca.
    expect(h.typed("browser:force-open")).toEqual([]);
    expect(await resp!.json()).toEqual({ url: "https://example.com/", title: "" });
  });
});

// ---------------------------------------------------------------------------
// close-pane: chi decide quale pannello muore.
// ---------------------------------------------------------------------------
describe("close-pane", () => {
  test("un contextId esplicito vince sulla topic, e il contesto headless viene distrutto", async () => {
    const h = harness();
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/close-pane", { contextId: "ctx-di-un-altro" });

    expect(await resp!.json()).toEqual({ ok: true, contextId: "ctx-di-un-altro" });
    expect(h.typed("browser:close-pane")).toEqual([{ type: "browser:close-pane", contextId: "ctx-di-un-altro" }]);
    expect(h.destroyed).toEqual(["ctx-di-un-altro"]);
  });

  test("senza contextId ripiega su topic → terminale, e 404 se non resta niente", async () => {
    const h = harness();
    h.addTopic("t1");
    h.addTerminal("42");

    expect(await (await h.post("/api/topics/t1/browser/close-pane"))!.json()).toMatchObject({ contextId: "t1" });
    expect(await (await h.post("/api/sessions/42/browser/close-pane"))!.json()).toMatchObject({ contextId: "term-42" });

    const orfana = await h.post("/api/sessions/fantasma/browser/close-pane");
    expect(orfana!.status).toBe(404);
  });

  test("un pannello nativo senza contesto headless si chiude lo stesso", async () => {
    // Caso normale su Tauri: la pane è una WKWebView, non c'è nessun contesto
    // Playwright da distruggere e `destroyContext` esplode. La chiusura è
    // client-originated: il broadcast è la cosa che conta, la distruzione è
    // best-effort e non deve trasformare un successo in un 500.
    const h = harness({ destroyThrows: true });
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/close-pane");

    expect(resp!.status).toBe(200);
    expect(h.typed("browser:close-pane")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// I cancelli delle rotte sensibili.
// ---------------------------------------------------------------------------
describe("cancello del token — le quattro rotte che leggono o espongono roba altrui", () => {
  const sensibili = [
    "/api/topics/t1/browser/import-chrome",
    "/api/topics/t1/browser/eval",
    "/api/topics/t1/browser/list-tabs",
    "/api/topics/t1/browser/focus-pane",
  ];

  test("token sbagliato o assente ⇒ 401", async () => {
    const h = harness();
    h.addTopic("t1");
    for (const path of sensibili) {
      expect((await h.post(path, {}, {}))!.status).toBe(401);
      expect((await h.post(path, {}, { "x-gateway-token": "sbagliato" }))!.status).toBe(401);
    }
  });

  test("server SENZA GATEWAY_TOKEN configurato ⇒ 401 comunque, non un cancello aperto", async () => {
    delete process.env.GATEWAY_TOKEN;
    const h = harness();
    h.addTopic("t1");
    for (const path of sensibili) {
      expect((await h.post(path, {}, { "x-gateway-token": "" }))!.status).toBe(401);
    }
  });

  test("token buono ma build senza browser ⇒ 503", async () => {
    const h = harness({ noService: true });
    h.addTopic("t1");
    for (const path of sensibili) {
      expect((await h.post(path))!.status).toBe(503);
    }
  });
});

// ---------------------------------------------------------------------------
// L'override di contextId: guidare una scheda che non è la tua.
// ---------------------------------------------------------------------------
describe("override del contextId — «manage any tab»", () => {
  test("un contextId vivo scavalca quello della sessione", async () => {
    const h = harness();
    h.addTopic("t1");
    h.contexts.push({ id: "altra-scheda", url: "https://altrove", title: "Altrove" });

    const resp = await h.post("/api/topics/t1/browser/eval", { expression: "1+1", contextId: "altra-scheda" });

    expect(resp!.status).toBe(200);
    expect(h.dispatchedOn).toEqual(["altra-scheda"]);
    expect(h.evaluations).toEqual([{ contextId: "altra-scheda", expression: "1+1" }]);
  });

  test("un contextId MORTO ⇒ 404 con l'elenco di quelli vivi, e nessun contesto fantasma creato", async () => {
    const h = harness();
    h.addTopic("t1");
    h.contexts.push({ id: "viva" });

    const resp = await h.post("/api/topics/t1/browser/eval", { expression: "1+1", contextId: "morta" });

    expect(resp!.status).toBe(404);
    const { error } = await resp!.json();
    expect(error).toContain("morta");
    expect(error).toContain("viva");
    // Il punto: senza validazione `getOrCreateContext` avrebbe creato un
    // contesto headless nuovo su un id inventato.
    expect(h.dispatchedOn).toEqual([]);
  });

  test("focus-pane valida l'override allo stesso modo (mettere a fuoco una pane morta non vuol dire niente)", async () => {
    const h = harness();
    h.addTopic("t1");

    const resp = await h.post("/api/topics/t1/browser/focus-pane", { contextId: "morta" });

    expect(resp!.status).toBe(404);
    expect(h.typed("browser:focus-pane")).toEqual([]);
  });

  test("senza pannello proprio E senza override ⇒ 404 che indica browser_list_tabs", async () => {
    const h = harness();

    const resp = await h.post("/api/sessions/fantasma/browser/eval", { expression: "1+1" });

    expect(resp!.status).toBe(404);
    expect((await resp!.json()).error).toContain("browser_list_tabs");
  });
});

// ---------------------------------------------------------------------------
// list-tabs e la proiezione del blocco generico.
// ---------------------------------------------------------------------------
describe("list-tabs — l'inventario, e di chi è ciascuna scheda", () => {
  test("elenca TUTTE le schede vive e marca la propria", async () => {
    const h = harness();
    h.addTopic("t1");
    h.addTerminal("42");
    h.taskOfPrefix.set("12345678", { text: "Sistema il ponte" });
    h.contexts.push({ id: "t1", url: "https://uno", title: "Uno" });
    h.contexts.push({ id: "term-42", url: "https://due", title: "Due" });
    h.contexts.push({ id: "task-12345678-aaaaaaaa", url: "https://tre", title: "Tre" });

    const resp = await h.post("/api/sessions/42/browser/list-tabs");
    const { tabs } = await resp!.json();

    expect(tabs.map((t: { contextId: string }) => t.contextId)).toEqual([
      "term-42",              // la propria va in cima
      "t1",                   // poi le topic
      "task-12345678-aaaaaaaa",
    ]);
    expect(tabs[0]).toMatchObject({ isOwn: true, kind: "terminal", url: "https://due", label: "Terminal 42 · tmp" });
    expect(tabs[1]).toMatchObject({ isOwn: false, kind: "topic", label: "Topic t1" });
    // L'etichetta del task arriva dal `contextId`, non da una colonna: è la
    // seconda lettura sui task che il ponte si fa iniettare.
    expect(tabs[2].label).toContain("Sistema il ponte");
  });

  test("un chiamante SENZA pannello proprio elenca lo stesso (nessun 404)", async () => {
    const h = harness();
    h.contexts.push({ id: "una-scheda", url: "https://x" });

    const resp = await h.post("/api/sessions/fantasma/browser/list-tabs");

    expect(resp!.status).toBe(200);
    const { tabs } = await resp!.json();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].isOwn).toBe(false);
  });
});

describe("il blocco generico :tool non ingoia le rotte degli altri", () => {
  test("un endpoint che non è nella mappa dei tool ⇒ il router passa la mano (null)", async () => {
    const h = harness();
    h.addTopic("t1");

    // Se questo tornasse una Response, ogni rotta `…/browser/<qualcosa>` futura
    // verrebbe intercettata qui invece che dal suo blocco.
    expect(await h.post("/api/topics/t1/browser/inventata")).toBeNull();
  });

  test("una rotta fuori dal ponte non viene toccata", async () => {
    const h = harness();
    expect(await h.post("/api/topics/t1/system-message", { content: "ciao" })).toBeNull();
  });
});

/**
 * LOGIN GIÀ INIETTATO — la metà di andata.
 *
 * L'agente entra una volta in una pagina protetta e chiama `browser_save_state`.
 * Perché il reviewer che apre quella tab dopo NON trovi il muro del login,
 * l'handle va legato alla TAB (`task-tab-persist`), non alla sessione: il turno
 * dell'agente finisce, la tab resta. Qui si prova solo la decisione del ponte —
 * chi viene legato, con quale handle, e quando NON legare niente.
 */
describe("save_state — l'handle finisce sulla tab del task", () => {
  let savedDataDir: string | undefined;
  let tmpDir = "";

  beforeEach(() => {
    // Lo store degli stati è un vero file su disco: lo dirotto in un tmp, così
    // il test non tocca `~/.openclaw` né lo store dell'utente.
    savedDataDir = process.env.DATA_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "bridge-state-"));
    process.env.DATA_DIR = tmpDir;
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const STATE = { cookies: [{ name: "sid", value: "x" }], origins: [] };

  test("salvataggio riuscito su una tab del task ⇒ l'handle viene legato a QUELLA tab", async () => {
    const h = harness({ storageState: STATE });
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });
    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://app.test/", name: "App" });

    const resp = await h.post("/api/topics/aaaaaaaa-topic/browser/save-state", { handle: "app-login" });

    expect(resp!.status).toBe(200);
    expect(h.loginAttached).toEqual([{ contextId: "task-12345678-napp", handle: "app-login" }]);
  });

  test("l'handle registrato è quello NORMALIZZATO, non la stringa grezza", async () => {
    const h = harness({ storageState: STATE });
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });
    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://app.test/" });

    await h.post("/api/topics/aaaaaaaa-topic/browser/save-state", { handle: "App Login!" });

    // È il NOME DEL FILE che il tool ha scritto: registrarne un altro farebbe
    // fallire in silenzio il `browser_load_state` della riapertura.
    expect(h.loginAttached).toEqual([{ contextId: "task-12345678-aaaaaaaaa", handle: "App_Login_" }]);
  });

  test("un salvataggio FALLITO non lega niente", async () => {
    // Nessuno `storageState` ⇒ l'export esplode ⇒ il tool risponde `{error}`.
    const h = harness();
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });
    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://app.test/" });

    const resp = await h.post("/api/topics/aaaaaaaa-topic/browser/save-state", { handle: "app-login" });

    expect(resp!.status).toBe(502);
    // Legare un handle che non esiste su disco darebbe una tab che promette un
    // login e poi atterra sul muro comunque.
    expect(h.loginAttached).toEqual([]);
  });

  test("gli altri tool non legano niente", async () => {
    const h = harness({ storageState: STATE });
    const topic = h.addTopic("aaaaaaaa-topic");
    h.taskOfTopic.set(topic.id, { id: "12345678-task" });
    await h.post("/api/topics/aaaaaaaa-topic/browser/open-pane", { url: "https://app.test/" });

    await h.post("/api/topics/aaaaaaaa-topic/browser/eval", { expression: "1+1" });

    expect(h.loginAttached).toEqual([]);
  });
});
