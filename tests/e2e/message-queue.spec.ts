import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * La coda del turno: quello che succede a un messaggio scritto MENTRE l'agente
 * sta ancora rispondendo.
 *
 * Il guasto che questo file inchioda: **«ferma» faceva partire.** Il drain
 * viveva in un effetto di `ChatPane` la cui unica condizione era «non sta più
 * streammando» — e lo stop è esattamente questo. Si premeva stop per fermare
 * l'agente e partiva il messaggio successivo, senza che nessuno l'avesse
 * chiesto. Gli altri due che si provano qui: un comando col cancelletto scritto
 * durante lo streaming finiva in coda e poi partiva come TESTO, e chi scriveva
 * dopo uno stop scavalcava quello che aveva scritto prima.
 *
 * È COMPORTAMENTO, non layout: video acceso, il .webm è la prova.
 * La logica pura sta in `client/src/state/chatQueue.ts` coi suoi test di unità;
 * qui si verifica che in pagina succeda davvero.
 */
test.use({ video: "on" });

test.describe.serial("Coda dei messaggi", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `msg-queue-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find(t => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
    // Due scambi di storia: con un solo turno lo stop cade nel ramo "prima
    // domanda, ho cambiato idea" e azzera la chat intera (`decideClientWipeOnStop`).
    await seedMessage(request, { sessionKey, role: "user", content: "domanda di prima" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di prima" });
    await seedMessage(request, { sessionKey, role: "user", content: "e poi?" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di poi" });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * Intercetta gli invii e li REGISTRA. `hang` tiene la POST aperta: è la
   * finestra in cui l'umano scrive il messaggio successivo e preme stop.
   */
  async function interceptSends(page: import("@playwright/test").Page) {
    const sent: string[] = [];
    const state = { hang: true };
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      // Il corpo è un `ChatRequest`: il turno appena scritto è l'ULTIMO messaggio.
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      if (state.hang) await new Promise((r) => setTimeout(r, 20_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });
    return { sent, state };
  }

  const queueBadge = (page: import("@playwright/test").Page) =>
    page.getByTestId("message-queue-badge");

  async function openChat(page: import("@playwright/test").Page, chatPage: { messageInput: import("@playwright/test").Locator }) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  test("stop TIENE il messaggio in coda invece di farlo partire", async ({ page, chatPage }) => {
    // Il frame che faceva il danno arriva dal WS: dopo un abort il server
    // annuncia comunque `stream:end`, e «lo stream è finito» era l'unica
    // condizione che serviva alla coda per ripartire. Qui lo si inietta a mano,
    // com'è nella realtà — senza, il test passerebbe anche col freno tolto
    // (provato: la strada dell'SSE locale si ferma prima, sull'AbortError).
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });

    const { sent } = await interceptSends(page);
    await openChat(page, chatPage);
    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();

    await chatPage.messageInput.fill("primo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });
    expect(sent).toEqual(["primo"]);

    // Scritto MENTRE l'agente risponde: va in coda, e la coda si vede.
    await chatPage.messageInput.fill("secondo");
    await chatPage.messageInput.press("Enter");
    await expect(queueBadge(page)).toHaveText(/1\s*da inviare/, { timeout: 10_000 });
    await expect(chatPage.messageInput).toHaveValue("");

    const stop = page.getByRole("button", { name: /Stop generating/ }).first();
    await expect(stop).toBeVisible({ timeout: 5_000 });
    await stop.click();

    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    // Il server dice la sua: turno finito. È il momento esatto in cui la coda
    // partiva da sola.
    await page.waitForTimeout(500);
    inject!(JSON.stringify({ type: "stream:end", sessionKey, topicId, reason: "user_abort" }));

    // IL PUNTO: fermato vuol dire fermo. Nessun secondo invio…
    // L'attesa copre TUTTA la finestra in cui il drain riproverebbe
    // (`TURN_DRAIN_MAX_ATTEMPTS × TURN_DRAIN_RETRY_MS` = 2s).
    await page.waitForTimeout(4_000);
    expect(sent, "lo stop non deve far partire il messaggio in coda").toEqual(["primo"]);
    // …e il messaggio non è perso: è ancora lì, correggibile.
    await expect(queueBadge(page)).toHaveText(/1\s*da inviare/);
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]').last())
      .toContainText("primo");
  });

  test("riprendendo, la coda riparte dalla TESTA: nessun sorpasso", async ({ page, chatPage }) => {
    const { sent, state } = await interceptSends(page);
    await openChat(page, chatPage);
    // La coda del test precedente è durevole per costruzione: si svuota qui,
    // altrimenti questo scenario partirebbe da uno stato che non è il suo.
    if (await queueBadge(page).isVisible().catch(() => false)) {
      await queueBadge(page).click();
      await page.getByRole("button", { name: "Svuota" }).click();
    }
    await expect(queueBadge(page)).toBeHidden();

    await chatPage.messageInput.fill("uno");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    for (const testo of ["due", "tre"]) {
      await chatPage.messageInput.fill(testo);
      await chatPage.messageInput.press("Enter");
    }
    // «Da inviare», non «in coda»: la lista di cose da fare dell'agente diceva
    // anche lei «in coda», e due strisce affiancate col nome della stessa cosa
    // non si distinguono. (Era «(2 messages queued)», una scritta nuda in
    // arancione attaccata al bordo inferiore del composer.)
    await expect(queueBadge(page)).toHaveText(/2\s*da inviare/, { timeout: 10_000 });

    await page.getByRole("button", { name: /Stop generating/ }).first().click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    // L'umano riprende scrivendo. Da qui gli invii vanno a buon fine subito.
    state.hang = false;
    await chatPage.messageInput.fill("quattro");
    await chatPage.messageInput.press("Enter");

    // "quattro" è l'ULTIMO: quello che era in coda da prima parte per primo.
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["uno", "due", "tre", "quattro"]);
    await expect(queueBadge(page)).toBeHidden({ timeout: 10_000 });
  });

  test("un comando col cancelletto non si accoda: agisce subito", async ({ page, chatPage }) => {
    const { sent } = await interceptSends(page);
    await openChat(page, chatPage);

    await chatPage.messageInput.fill("primo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // Lo spazio in coda chiude il menù di completamento: senza, Invio
    // selezionerebbe la voce evidenziata invece di mandare.
    await chatPage.messageInput.fill("/help ");
    await chatPage.messageInput.press("Enter");

    // Il comando ha risposto sul posto…
    await expect(page.getByText("/status — Show session status").first())
      .toBeVisible({ timeout: 10_000 });
    // …e non è finito in coda, dove sarebbe poi partito come testo verso il modello.
    await expect(queueBadge(page)).toBeHidden();
    await page.waitForTimeout(500);
    expect(sent).toEqual(["primo"]);
  });

  /**
   * IL CASO IN CUI IL CLIENT NON PUÒ SAPERE DA SOLO CHE LA SESSIONE È OCCUPATA.
   *
   * `decideSend` accoda quando è QUESTA finestra a stare streammando. Ma la
   * sessione può essere occupata da qualcun altro: un'altra finestra sullo
   * stesso topic, o — il caso vero di tutti i giorni — un task dispatchato che
   * sta lavorando nella sua topic mentre l'umano ci scrive dentro. Lì il client
   * spedisce in buona fede, ed è il SERVER a doverlo fermare.
   *
   * Prima non lo fermava nessuno: `/api/chat` era l'unica route mutante di
   * sessione senza cancello, e la seconda POST sovrascriveva la voce di
   * `activeStreams` — il `finally` del primo turno chiudeva il secondo, col
   * messageId sbagliato. Ora risponde 409, ed è il canale di STEERING della
   * chat: lo stesso patto che la board ha già per i task, dove un commento
   * umano viene bufferizzato e consegnato al confine del turno.
   *
   * Il 409 lo fa il server (`server/routes/chat.ts`, provato in unità da
   * `server/routes/chat.front-door.test.ts` con la sua controprova). Qui si
   * verifica l'ALTRA metà del patto, che fino a ieri era codice morto perché
   * nessun 409 esisteva: il messaggio torna in TESTA alla coda, non resta una
   * bolla fantasma in chat, e parte da solo appena il turno dell'altro finisce.
   */
  test("«turno già in volo» (409): il messaggio va in TESTA alla coda e parte a fine turno", async ({ page, chatPage }) => {
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });

    const sent: string[] = [];
    // Il primo invio trova la sessione occupata da un altro; il secondo (quello
    // che parte dalla coda) la trova libera.
    let occupata = true;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      if (occupata) {
        occupata = false;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "a response is already streaming for this session",
            code: "stream_in_flight",
            messageId: "msg-di-qualcun-altro",
          }),
        });
      }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await openChat(page, chatPage);
    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();
    if (await queueBadge(page).isVisible().catch(() => false)) {
      await queueBadge(page).click();
      await page.getByRole("button", { name: "Svuota" }).click();
    }
    await expect(queueBadge(page)).toBeHidden();

    const TESTO = "scrivo mentre l'agente sta lavorando qui";
    await chatPage.messageInput.fill(TESTO);
    await chatPage.messageInput.press("Enter");

    // Respinto ⇒ in coda, e la coda si vede.
    await expect(queueBadge(page)).toHaveText(/1\s*da inviare/, { timeout: 10_000 });
    expect(sent).toEqual([TESTO]);
    // E NON resta in chat come se fosse partito: l'unico posto in cui vive è
    // la coda. Prima la domanda restava in pagina mentre il testo viveva in un
    // ref invisibile — un messaggio spedito che non era mai esistito.
    await expect(
      page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: TESTO }),
    ).toHaveCount(0);

    // Il turno dell'altro finisce: il server lo annuncia a tutti.
    inject!(JSON.stringify({ type: "stream:end", sessionKey, topicId }));

    // IL PUNTO: riparte da solo, con lo stesso testo, una volta sola.
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual([TESTO, TESTO]);
    await expect(queueBadge(page)).toBeHidden({ timeout: 10_000 });
  });
});
