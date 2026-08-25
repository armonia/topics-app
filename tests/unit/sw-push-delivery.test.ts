/**
 * UNA VOCE SOLA — misurata sul service worker VERO.
 *
 * `client/public/sw.js` non è importabile da un test (è uno script classico, non
 * un modulo, e gira in un global suo). La tentazione sarebbe riscriverne la
 * decisione in un file «puro» e testare quella: sarebbe un test che passa anche
 * se il worker spedito fa il contrario. Qui invece si carica il FILE che viene
 * spedito, dentro un `ServiceWorkerGlobalScope` finto, e gli si consegna un
 * evento `push` come farebbe il browser.
 *
 * Le due proprietà che la card promette:
 *   · `native` (default) → notifica di SISTEMA, sempre, anche con l'app aperta.
 *     Il doppione lo evita la pagina, che tace da sé sugli eventi coperti dal
 *     push (`client/src/lib/notify/pushVoice.ts`, testato a parte).
 *   · `in-app` + una finestra VISIBILE → nessuna notifica di sistema, il
 *     contenuto va alla pagina. Ad app chiusa (nessuna finestra visibile) si
 *     ricade sul sistema: è l'unica voce rimasta, ed è il caso che dà il titolo
 *     alla card.
 *
 * E la terza, che nasce dalla COMPOSIZIONE con i tasti (`actions`): scegliere
 * dove si legge l'avviso non è scegliere di non poterci rispondere. I tasti
 * viaggiano su ENTRAMBE le voci — al sistema come `actions` della notifica, alla
 * pagina dentro il postMessage. Le `requests` già composte accompagnano solo la
 * notifica di sistema: le esegue il worker, che non può importare niente. La
 * pagina riceve i soli id e la richiesta se la compone (`runNotificationAction`).
  * @covers CHAT-BANNER-01
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SW_SOURCE = readFileSync(join(import.meta.dir, "..", "..", "client", "public", "sw.js"), "utf-8");

interface FakeClient { visibilityState: "visible" | "hidden"; posted: unknown[] }

function fakeClient(visibilityState: "visible" | "hidden"): FakeClient {
  const c: FakeClient = { visibilityState, posted: [] };
  (c as FakeClient & { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => { c.posted.push(m); };
  return c;
}

/**
 * Carica il worker vero e restituisce di che cosa dispone il test.
 *
 * `maxActions` è il tetto che il BROWSER impone ai tasti di una notifica di
 * sistema: si inietta come `Notification` perché nel worker è letto da lì, e
 * perché la regola del tutto-o-niente sopra quel tetto è una delle cose da
 * misurare. Assente = nessun `Notification` nello scope, cioè il fallback a 2.
 */
function loadServiceWorker(windows: FakeClient[], maxActions?: number) {
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (ev: unknown) => void>();

  const self = {
    addEventListener: (type: string, fn: (ev: unknown) => void) => { handlers.set(type, fn); },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    location: { origin: "http://localhost:3333" },
    skipWaiting: () => {},
  };

  const clients = {
    matchAll: () => Promise.resolve(windows),
    openWindow: () => Promise.resolve(null),
  };

  const caches = {
    open: () => Promise.resolve({ put: () => Promise.resolve(), match: () => Promise.resolve(undefined), addAll: () => Promise.resolve() }),
    match: () => Promise.resolve(undefined),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- è il punto del test: si esegue il FILE spedito, non una sua copia
  new Function("self", "clients", "caches", "fetch", "Notification", SW_SOURCE)(
    self, clients, caches, () => Promise.reject(new Error("nessuna rete in questo test")),
    maxActions === undefined ? undefined : { maxActions },
  );

  return { shown, handlers };
}

/** Consegna un evento `push` come farebbe il browser, e aspetta il `waitUntil`. */
async function deliverPush(handlers: Map<string, (ev: unknown) => void>, payload: unknown): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const handler = handlers.get("push");
  if (!handler) throw new Error("il service worker non registra nessun handler `push`");
  handler({
    data: { json: () => payload },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
}

const PAYLOAD = { title: "📋 Task pronto per la review", body: "Sistemare il push", tag: "task-review-42", url: "/task/42" };

describe("service worker · consegna della push", () => {
  test("app CHIUSA (nessuna finestra): notifica di sistema — il caso della card", async () => {
    const { shown, handlers } = loadServiceWorker([]);
    await deliverPush(handlers, PAYLOAD);
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe(PAYLOAD.title);
    expect(shown[0].options.tag).toBe("task-review-42");
    // Il deep-link viaggia con la notifica: un risveglio che non ti porta dove
    // serve è metà del gesto. Insieme viaggiano le `requests` dei tasti — qui
    // vuote perché il payload non ne porta, ma la CHIAVE deve esserci: è quella
    // che `notificationclick` legge, e un `undefined` lì è un tasto morto.
    expect(shown[0].options.data).toEqual({ url: "/task/42", requests: {} });
  });

  test("preferenza `native` + app aperta: parla il SISTEMA, la pagina non riceve niente", async () => {
    const win = fakeClient("visible");
    const { shown, handlers } = loadServiceWorker([win]);
    await deliverPush(handlers, { ...PAYLOAD, whenOpen: "native" });
    expect(shown).toHaveLength(1);
    expect(win.posted).toHaveLength(0);
  });

  test("senza `whenOpen` si ricade su `native`: un payload vecchio non diventa silenzio", async () => {
    const win = fakeClient("visible");
    const { shown, handlers } = loadServiceWorker([win]);
    await deliverPush(handlers, PAYLOAD);
    expect(shown).toHaveLength(1);
    expect(win.posted).toHaveLength(0);
  });

  test("preferenza `in-app` + finestra VISIBILE: parla la pagina, il sistema tace", async () => {
    const win = fakeClient("visible");
    const { shown, handlers } = loadServiceWorker([win]);
    await deliverPush(handlers, { ...PAYLOAD, whenOpen: "in-app" });
    expect(shown).toHaveLength(0);
    expect(win.posted).toEqual([{
      type: "topics:push-banner",
      title: PAYLOAD.title,
      body: PAYLOAD.body,
      url: PAYLOAD.url,
      tag: PAYLOAD.tag,
      actions: [],
    }]);
  });

  test("preferenza `in-app` ma nessuna finestra VISIBILE: torna il sistema, o non parlerebbe nessuno", async () => {
    // Una finestra in background non è una finestra che puoi guardare: è
    // esattamente lo scenario «app chiusa» dal punto di vista dell'utente.
    const win = fakeClient("hidden");
    const { shown, handlers } = loadServiceWorker([win]);
    await deliverPush(handlers, { ...PAYLOAD, whenOpen: "in-app" });
    expect(shown).toHaveLength(1);
    expect(win.posted).toHaveLength(0);
  });

  // ── I TASTI, sull'una e sull'altra voce ────────────────────────────────
  // Le due funzioni sono arrivate separate e vivono nello stesso handler. Il
  // guasto che questi test escludono è la composizione MECCANICA: tenere i tasti
  // solo sul ramo di sistema (e allora `in-app` costa il quick-reply) oppure
  // spegnerli scegliendo `in-app` (stessa cosa, detta peggio).
  const ACTIONS = [{ id: "answer:S%C3%AC", title: "Sì" }, { id: "answer:No", title: "No" }];
  const REQUESTS = {
    "answer:S%C3%AC": { method: "POST", path: "/api/boards/p1/tasks/42/review", body: { decision: "reject", comment: "Sì" } },
    "answer:No": { method: "POST", path: "/api/boards/p1/tasks/42/review", body: { decision: "reject", comment: "No" } },
  };

  test("voce di SISTEMA: i tasti arrivano alla notifica, con le loro richieste", async () => {
    const { shown, handlers } = loadServiceWorker([]);
    await deliverPush(handlers, { ...PAYLOAD, actions: ACTIONS, requests: REQUESTS });
    expect(shown).toHaveLength(1);
    // `action`, non `id`: è il nome che vuole la Notification API.
    expect(shown[0].options.actions).toEqual([
      { action: "answer:S%C3%AC", title: "Sì" },
      { action: "answer:No", title: "No" },
    ]);
    expect(shown[0].options.data).toEqual({ url: "/task/42", requests: REQUESTS });
  });

  test("voce della PAGINA: gli STESSI tasti, o `in-app` costerebbe il quick-reply", async () => {
    const win = fakeClient("visible");
    const { shown, handlers } = loadServiceWorker([win]);
    await deliverPush(handlers, { ...PAYLOAD, whenOpen: "in-app", actions: ACTIONS, requests: REQUESTS });
    expect(shown).toHaveLength(0);
    // Alla pagina vanno i tasti, NON le richieste: quelle se le compone lei.
    const posted = win.posted[0] as { actions: unknown; requests?: unknown };
    expect(posted.actions).toEqual(ACTIONS);
    expect(posted.requests).toBeUndefined();
  });

  test("i tasti non ci stanno tutti (tetto del browser): il SISTEMA non ne mostra nessuno", async () => {
    // Tetto a 1 con due tasti dichiarati: mostrarne uno metterebbe a un click di
    // distanza una risposta mentre l'altra non si vede nemmeno.
    const { shown, handlers } = loadServiceWorker([], 1);
    await deliverPush(handlers, { ...PAYLOAD, actions: ACTIONS, requests: REQUESTS });
    expect(shown).toHaveLength(1);
    expect(shown[0].options.actions).toBeUndefined();
    // Le richieste restano comunque nella notifica: il click semplice deve
    // continuare ad aprire il task, e `data` è dove vive il suo url.
    expect(shown[0].options.data).toEqual({ url: "/task/42", requests: REQUESTS });
  });

  test("il tetto del browser NON taglia la pagina: lì i bottoni li disegna la app", async () => {
    const win = fakeClient("visible");
    const { shown, handlers } = loadServiceWorker([win], 1);
    await deliverPush(handlers, { ...PAYLOAD, whenOpen: "in-app", actions: ACTIONS, requests: REQUESTS });
    expect(shown).toHaveLength(0);
    expect((win.posted[0] as { actions: unknown }).actions).toEqual(ACTIONS);
  });

  test("un tasto malformato non arriva a nessuna delle due voci", async () => {
    const win = fakeClient("visible");
    const bad = [{ id: "approve", title: "Approva" }, { id: 42, title: null }];
    const { handlers } = loadServiceWorker([win]);
    await deliverPush(handlers, { ...PAYLOAD, whenOpen: "in-app", actions: bad });
    expect((win.posted[0] as { actions: unknown }).actions).toEqual([{ id: "approve", title: "Approva" }]);
  });

  test("un payload illeggibile non fa niente, e soprattutto non esplode nel worker", async () => {
    const { shown, handlers } = loadServiceWorker([]);
    const handler = handlers.get("push")!;
    const pending: Promise<unknown>[] = [];
    handler({ data: { json: () => { throw new Error("non è JSON"); } }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
    expect(shown).toHaveLength(0);
  });
});
