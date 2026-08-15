import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * RIADOZIONE DI UN TURNO DOPO UN RIAVVIO DEL SERVER — quello che si vede.
 *
 * Il server riparte mentre un turno sta scrivendo, si riattacca al figlio
 * sopravvissuto e il provider gli ri-detta il turno dal suo JSONL. Quelle
 * arrivano come `stream:content_chunk`, che il client APPENDE alla bolla.
 *
 * Prima ad azzerare la bolla ci pensava il server, cancellando il corpo della
 * riga in DB al momento dell'adozione — e la copia di quel che cancellava
 * viveva solo in RAM, dentro la richiesta di riadozione. Bastava che quella
 * morisse prima di rimetterla a posto (un secondo riavvio del watcher, il
 * provider giù, un timeout) e la cancellazione diventava definitiva: restava il
 * messaggio dell'utente e una bolla vuota, per sempre. Visto su topic:dc2b90d0
 * il 10 agosto (riga nata alle 15:46:22.678, `streamed_at` 15:47:29.751, corpo
 * vuoto, `latency_ms` NULL).
 *
 * Adesso il record non si tocca e ad azzerarsi è la VISTA: `stream:start` porta
 * `reattached`, e il client svuota la bolla prima che il replay la riempia.
 * Qui si prova che quel segnale fa il suo mestiere — e il secondo test mostra
 * che senza di lui il replay si somma a sé stesso, che è il motivo per cui
 * esiste.
 *
 * Video acceso: è un COMPORTAMENTO (una bolla che si svuota e si riscrive), e
 * uno screenshot non lo dimostra.
 */
test.use({ video: "on" });

const TESTO = "Ho letto le mail e trovato la pratica di voltura.";
const MSG_ID = "reatt-bubble-0001";

/**
 * Le tre fasi qui succedono in un frame: sono frame WS, non azioni di
 * Playwright, quindi lo `slowMo` di `E2E_EVIDENCE` non le tocca e la clip
 * verrebbe illeggibile. Solo nella run di consegna ogni fase resta a schermo
 * quanto basta a vederla; nella run normale non si aspetta niente.
 */
const EVIDENZA = process.env.E2E_EVIDENCE === "1";
const posa = (page: import("@playwright/test").Page) =>
  EVIDENZA ? page.waitForTimeout(1_600) : Promise.resolve();

test.describe("Riadozione: la bolla si svuota, il record no", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `reattach-bubble-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics.topics).find((t) => t.id === topicId)!.sessionKey;
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /** Apre il topic con la presa sulla WS per iniettare frame "dal server". */
  async function apri(page: import("@playwright/test").Page, chatPage: { messageInput: import("@playwright/test").Locator }) {
    let inject: ((data: string) => void) | null = null;
    // Va armata PRIMA di goto, o la connessione iniziale la scavalca.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => inject !== null, { timeout: 10_000 }).toBe(true);
    return (frame: Record<string, unknown>) => inject!(JSON.stringify({ sessionKey, topicId, ...frame }));
  }

  /** Il turno che detta il suo testo, un pezzo alla volta come farebbe il vero. */
  async function detta(send: (f: Record<string, unknown>) => void) {
    for (const pezzo of [TESTO.slice(0, 20), TESTO.slice(20)]) {
      send({ type: "stream:content_chunk", content: pezzo });
    }
  }

  /**
   * Quante volte la frase compare nella bolla, LETTA COME LA LEGGE CHI GUARDA.
   *
   * `innerText` e non `textContent`: `toContainText` con una stringa passa anche
   * su un testo doppio, quindi le occorrenze si contano, e si contano
   * sull'inchiostro reso — un `textContent` conta anche quello che il markdown
   * non stampa.
   *
   * Ma `innerText` di un sottoalbero `visibility: hidden` è la STRINGA VUOTA, e
   * la lista sta appunto nascosta per i primi ~320ms dopo l'apertura: è il
   * sipario di `MessageList` (`LIST_REVEAL_FLOOR_MS`), che tiene ferma la chat
   * mentre Virtuoso misura le altezze. Tutta questa sequenza di frame ci sta
   * dentro — misurato: la bolla nasce a 40ms e si scopre a 350ms — quindi un
   * conteggio preso al volo leggeva zero su una bolla scritta giusta. Prima si
   * aspetta che la bolla sia visibile davvero (`toBeVisible` considera
   * `visibility: hidden` come NON visibile), poi si conta.
   */
  async function occorrenze(bolla: import("@playwright/test").Locator): Promise<number> {
    await expect(bolla).toBeVisible({ timeout: 10_000 });
    return ((await bolla.innerText()).match(/trovato la pratica di voltura/g) ?? []).length;
  }

  test("il replay riscrive la bolla senza raddoppiarla", async ({ page, chatPage }) => {
    const send = await apri(page, chatPage);
    const bolla = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();

    // Il turno originale: parte e scrive.
    send({ type: "stream:start", messageId: MSG_ID });
    await detta(send);
    await expect(bolla).toContainText(TESTO, { timeout: 10_000 });
    await posa(page);

    // Il server riparte e riadotta QUESTO turno: stessa bolla, `reattached`.
    send({ type: "stream:start", messageId: MSG_ID, reattached: true });
    // La bolla si svuota: è l'azzeramento che prima si faceva cancellando la
    // riga in DB.
    await expect(bolla).not.toContainText("voltura", { timeout: 10_000 });
    await posa(page);

    // Il provider ri-detta lo stesso turno da capo.
    await detta(send);
    send({ type: "stream:end", messageId: MSG_ID });
    await posa(page);

    // Una volta sola.
    await expect(bolla).toContainText(TESTO, { timeout: 10_000 });
    expect(await occorrenze(bolla), "il replay non deve sommarsi a quello che c'era già").toBe(1);
  });

  test("senza `reattached` il replay si somma: è il motivo per cui il segnale esiste", async ({ page, chatPage }) => {
    // Il controllo. Stessa sequenza, ma il secondo `stream:start` non dichiara
    // la riadozione: il client lo tratta come «bolla già in volo, non toccarla»
    // e le delta del replay si appendono a quelle di prima. Se un giorno questo
    // test diventasse verde senza il flag, vorrebbe dire che qualcun altro sta
    // azzerando la bolla — e la domanda sarebbe: a costo di cosa?
    const send = await apri(page, chatPage);
    const bolla = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();

    send({ type: "stream:start", messageId: MSG_ID });
    await detta(send);
    await expect(bolla).toContainText(TESTO, { timeout: 10_000 });
    await posa(page);

    send({ type: "stream:start", messageId: MSG_ID });
    await detta(send);
    send({ type: "stream:end", messageId: MSG_ID });
    await posa(page);

    await expect.poll(() => occorrenze(bolla), { timeout: 10_000 }).toBe(2);
  });
});
