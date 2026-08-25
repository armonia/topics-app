/**
 * I TASTI della notifica, provati sul file che viene SPEDITO.
 *
 * `client/public/sw.js` è l'unico pezzo della catena fuori dal bundle: non
 * importa niente, non lo compila nessuno, e nessun typecheck lo guarda. È anche
 * l'ultimo anello — quello che il tasto lo esegue davvero. Un test che
 * reimplementasse la sua logica proverebbe la reimplementazione; questo carica
 * il sorgente vero in una sandbox con i global finti del service worker e lo
 * guida, così la riga che sbaglia è la riga che l'utente riceve.
 *
 * Il gemello lato server (quale tasto, per quale evento) sta in
 * `server/push-triggers.test.ts` e `shared/notify-actions.test.ts`.
  * @covers PUSH-02
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SW_PATH = join(import.meta.dir, "../../client/public/sw.js");

interface FetchCall { path: string; init: any }

/** Carica il sorgente vero di sw.js dietro i global di un service worker. */
function loadServiceWorker(opts?: { maxActions?: number; fetchOk?: boolean; fetchThrows?: boolean }) {
  const listeners = new Map<string, (event: any) => void>();
  const shown: Array<{ title: string; options: any }> = [];
  const fetchCalls: FetchCall[] = [];
  const focused: string[] = [];
  const posted: any[] = [];
  const opened: string[] = [];

  const self: any = {
    addEventListener: (type: string, handler: (event: any) => void) => listeners.set(type, handler),
    location: { origin: "https://topics.test" },
    registration: {
      showNotification: async (title: string, options: any) => { shown.push({ title, options }); },
    },
    skipWaiting: () => {},
  };
  const caches: any = {
    open: async () => ({ put: async () => {} }),
    match: async () => undefined,
    keys: async () => [],
    delete: async () => true,
  };
  const clients: any = {
    matchAll: async () => [{
      url: "https://topics.test/",
      focus: () => { focused.push("main"); return Promise.resolve(null); },
      postMessage: (m: any) => posted.push(m),
    }],
    openWindow: async (url: string) => { opened.push(url); },
  };
  const fetchFake = async (path: string, init: any) => {
    fetchCalls.push({ path, init });
    if (opts?.fetchThrows) throw new Error("offline");
    return { ok: opts?.fetchOk !== false, status: opts?.fetchOk === false ? 409 : 200 };
  };
  const NotificationFake: any = { maxActions: opts?.maxActions ?? 2 };

  const src = readFileSync(SW_PATH, "utf-8");
  // eslint-disable-next-line no-new-func -- caricare il sorgente vero È lo scopo del test
  new Function("self", "caches", "clients", "fetch", "Notification", "setTimeout", "URL", "Request", src)(
    self, caches, clients, fetchFake, NotificationFake, setTimeout, URL, Request,
  );

  return { listeners, shown, fetchCalls, focused, posted, opened };
}

/** Simula l'arrivo di una push col payload che compone il server. */
async function deliverPush(sw: ReturnType<typeof loadServiceWorker>, payload: unknown) {
  const waits: Promise<unknown>[] = [];
  sw.listeners.get("push")!({
    data: { json: () => payload },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  return sw.shown[sw.shown.length - 1];
}

/** Simula il click su un tasto (o sul corpo, con `action` vuota). */
async function clickNotification(sw: ReturnType<typeof loadServiceWorker>, action: string, data: any) {
  const waits: Promise<unknown>[] = [];
  let closed = false;
  sw.listeners.get("notificationclick")!({
    action,
    notification: { data, close: () => { closed = true; } },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  return { closed };
}

const ANSWER_ID = "answer:Landa%20su%20main";
const PAYLOAD = {
  title: "❓ L'agent ti sta chiedendo una cosa",
  body: "Lando su main?",
  tag: "task-review-t9",
  url: "/task/t9",
  actions: [{ id: ANSWER_ID, title: "Landa su main" }],
  requests: {
    [ANSWER_ID]: {
      method: "POST",
      path: "/api/boards/proj-x/tasks/t9/review",
      body: { decision: "reject", comment: "Landa su main" },
    },
  },
};

describe("service worker — disegnare i tasti", () => {
  test("le azioni del payload diventano i bottoni della notifica", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, PAYLOAD);
    expect(n.options.actions).toEqual([{ action: ANSWER_ID, title: "Landa su main" }]);
    // La richiesta resta attaccata alla notifica: al click non si ricompone nulla.
    expect(n.options.data.requests[ANSWER_ID].path).toBe("/api/boards/proj-x/tasks/t9/review");
    expect(n.options.data.url).toBe("/task/t9");
  });

  test("una push senza azioni resta la notifica-link di sempre", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, { title: "📋 Task pronto", body: "x", url: "/task/t1" });
    expect(n.options.actions).toBeUndefined();
    expect(n.options.data.requests).toEqual({});
  });

  test("se i tasti non ci stanno TUTTI non se ne mostra nessuno", async () => {
    // Il tetto è del browser (`Notification.maxActions`), non del contratto: su
    // una piattaforma che ne accetta uno solo, mostrarne due fa sparire in
    // silenzio proprio la risposta che non hai scelto di nascondere.
    const two = {
      ...PAYLOAD,
      actions: [{ id: "a", title: "Sì" }, { id: "b", title: "No" }],
    };
    expect((await deliverPush(loadServiceWorker({ maxActions: 2 }), two)).options.actions).toHaveLength(2);
    expect((await deliverPush(loadServiceWorker({ maxActions: 1 }), two)).options.actions).toBeUndefined();
    expect((await deliverPush(loadServiceWorker({ maxActions: 0 }), two)).options.actions).toBeUndefined();
  });

  test("azioni malformate non arrivano al browser", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, { ...PAYLOAD, actions: [{ id: 5 }, null, { title: "senza id" }] });
    expect(n.options.actions).toBeUndefined();
  });
});

describe("service worker — eseguire il tasto premuto", () => {
  test("il tasto CHIAMA, e non apre nulla: un gesto, non due", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, PAYLOAD);
    const { closed } = await clickNotification(sw, ANSWER_ID, n.options.data);
    expect(closed).toBe(true);
    expect(sw.fetchCalls).toHaveLength(1);
    expect(sw.fetchCalls[0].path).toBe("/api/boards/proj-x/tasks/t9/review");
    expect(sw.fetchCalls[0].init.method).toBe("POST");
    expect(JSON.parse(sw.fetchCalls[0].init.body)).toEqual({ decision: "reject", comment: "Landa su main" });
    expect(sw.opened).toHaveLength(0);
    expect(sw.posted).toHaveLength(0);
  });

  test("la chiamata porta i cookie: senza, il gate d'autenticazione la respinge", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, PAYLOAD);
    await clickNotification(sw, ANSWER_ID, n.options.data);
    expect(sw.fetchCalls[0].init.credentials).toBe("same-origin");
  });

  test("server che rifiuta → si apre il task, dove il perché si legge", async () => {
    const sw = loadServiceWorker({ fetchOk: false });
    const n = await deliverPush(sw, PAYLOAD);
    await clickNotification(sw, ANSWER_ID, n.options.data);
    expect(sw.fetchCalls).toHaveLength(1);
    expect(sw.posted).toEqual([{ type: "topics:open-url", url: "/task/t9" }]);
  });

  test("offline → stesso ripiego, mai un tasto che sparisce nel vuoto", async () => {
    const sw = loadServiceWorker({ fetchThrows: true });
    const n = await deliverPush(sw, PAYLOAD);
    await clickNotification(sw, ANSWER_ID, n.options.data);
    expect(sw.posted).toEqual([{ type: "topics:open-url", url: "/task/t9" }]);
  });

  test("click sul CORPO della notifica: apre come sempre, non esegue niente", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, PAYLOAD);
    await clickNotification(sw, "", n.options.data);
    expect(sw.fetchCalls).toHaveLength(0);
    expect(sw.posted).toEqual([{ type: "topics:open-url", url: "/task/t9" }]);
  });
});

describe("service worker — il cancello su cosa un tasto può chiamare", () => {
  const REJECTED = [
    { why: "fuori dalla board", path: "/api/topics/t9/messages" },
    { why: "assoluta verso un altro host", path: "https://altrove.example/api/boards/p/tasks/t" },
    { why: "risale l'albero", path: "/api/boards/p/tasks/t/../../publish" },
    { why: "non è una stringa", path: 42 },
  ];

  for (const { why, path } of REJECTED) {
    test(`path rifiutato (${why}) → nessuna chiamata, si apre il task`, async () => {
      const sw = loadServiceWorker();
      const n = await deliverPush(sw, {
        ...PAYLOAD,
        requests: { [ANSWER_ID]: { method: "POST", path, body: {} } },
      });
      await clickNotification(sw, ANSWER_ID, n.options.data);
      expect(sw.fetchCalls).toHaveLength(0);
      expect(sw.posted).toEqual([{ type: "topics:open-url", url: "/task/t9" }]);
    });
  }

  test("metodo non previsto → niente chiamata (un tasto non cancella)", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, {
      ...PAYLOAD,
      requests: { [ANSWER_ID]: { method: "DELETE", path: "/api/boards/p/tasks/t9", body: {} } },
    });
    await clickNotification(sw, ANSWER_ID, n.options.data);
    expect(sw.fetchCalls).toHaveLength(0);
  });

  test("azione premuta senza richiesta associata → si apre il task", async () => {
    const sw = loadServiceWorker();
    const n = await deliverPush(sw, PAYLOAD);
    await clickNotification(sw, "sconosciuta", n.options.data);
    expect(sw.fetchCalls).toHaveLength(0);
    expect(sw.posted).toEqual([{ type: "topics:open-url", url: "/task/t9" }]);
  });
});

describe("service worker — la copia spedita", () => {
  test("public/sw.js è identico a client/public/sw.js", () => {
    // La build copia `client/public/` dentro `public/`, ma il file è anche
    // TRACCIATO: modificare la sorgente senza ricostruire lascia in `public/`
    // una copia vecchia — che è esattamente quella che il server serve, quindi
    // quella che riceverebbe i tasti senza saperli eseguire.
    const built = readFileSync(join(import.meta.dir, "../../public/sw.js"), "utf-8");
    expect(built).toBe(readFileSync(SW_PATH, "utf-8"));
  });
});
