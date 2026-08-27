import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * LA RISPOSTA IN VOLO DISEGNATA DUE VOLTE.
 *
 * La bolla che una finestra disegna quando vede partire il turno di un'altra
 * nasceva con un id coniato in locale (`msg_…`), mentre la riga in DB ha il suo
 * (un uuid). Due nomi per lo stesso turno — e `stream:start` il nome vero lo
 * porta da sempre, si buttava e basta.
 *
 * Il conto arriva al primo ricarico della storia A TURNO APERTO, che non è un
 * caso di laboratorio: ogni `topic:updated` fuori banda ne scatena uno (è la
 * riconciliazione del thread in `usePanelLifecycle`), e a metà stream
 * `/api/history` RESTITUISCE la riga parziale con sopra il testo vivo. Il
 * segnaposto locale non era in quella risposta, quindi il filtro additivo lo
 * teneva: la stessa risposta due volte, una ferma e una che continuava a
 * crescere sotto.
 *
 * Video acceso: è un COMPORTAMENTO (una bolla che si sdoppia), non uno stato.
 */
test.use({ video: "on" });

const DURABLE = "3f6d0f1e-2b0a-4a55-9c8e-1a2b3c4d5e6f";
const TESTO = "Ho aperto la pratica e ho trovato la voltura del 2019.";
/** Il tetto anti-rimbalzo di `loadHistory`: sotto, la rilettura si salta. */
const HISTORY_DEDUP_MS = 5_000;

test.describe("Un turno in volo è UNA bolla sola", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;
  let topic: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    topicName = `inflight-identity-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const trovato = Object.values(topics.topics).find((x) => x.id === topicId)!;
    sessionKey = trovato.sessionKey;
    topic = trovato as unknown as Record<string, unknown>;
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * Apre il topic con la presa sulla WS. `storia` decide cosa risponde
   * `/api/history` a ogni chiamata: la prima volta la conversazione com'è, dopo
   * la riga parziale che il server restituisce a stream aperto.
   */
  async function apri(
    page: import("@playwright/test").Page,
    chatPage: { messageInput: import("@playwright/test").Locator },
    storia: () => { messages: unknown[]; isStreaming?: boolean },
  ) {
    let inject: ((data: string) => void) | null = null;
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const corpo = storia();
      await route.fulfill({
        status: 200,
        json: { total: corpo.messages.length, hasOrphanedMessage: false, compactionMarkers: [], ...corpo },
      });
    });
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

  const rowUser = {
    id: "u-inflight-1",
    role: "user",
    content: "che fine ha fatto la pratica?",
    timestamp: new Date().toISOString(),
  };

  test("il segnaposto porta l'id che il server ha annunciato", async ({ page, chatPage }) => {

    test.info().annotations.push({ type: "spec", description: "CHAT-BUBBLE-01" });
    const send = await apri(page, chatPage, () => ({ messages: [rowUser] }));
    send({ type: "stream:start", messageId: DURABLE });
    send({ type: "stream:content_chunk", content: TESTO });

    const bolla = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
    await expect(bolla).toContainText(TESTO, { timeout: 10_000 });
    // Il nome della bolla È quello della riga in DB. Senza, tutto il resto di
    // questo file non ha modo di funzionare.
    await expect(bolla).toHaveAttribute("data-message-id", DURABLE);
  });

  test("un ricarico della storia a metà turno non raddoppia la risposta", async ({ page, chatPage }) => {
    let openTurn = false;
    const send = await apri(page, chatPage, () =>
      openTurn
        ? {
            // Esattamente ciò che `routes/history.ts` restituisce a stream
            // attivo: il parziale NON si filtra e il testo vivo ci viene
            // sovrapposto.
            messages: [
              rowUser,
              { id: DURABLE, role: "assistant", content: TESTO, timestamp: new Date().toISOString(), partial: true },
            ],
            isStreaming: true,
          }
        : { messages: [rowUser] },
    );

    send({ type: "stream:start", messageId: DURABLE });
    send({ type: "stream:content_chunk", content: TESTO });
    const assistenti = page.locator('[data-testid="chat-message"][data-role="assistant"]');
    await expect(assistenti).toHaveCount(1, { timeout: 10_000 });
    openTurn = true;

    // La rilettura fuori banda: `topic:updated` su una pane aperta la scatena
    // (con 400 ms di anti-rimbalzo). Si aspetta il tetto di `loadHistory`, o la
    // richiesta verrebbe saltata come «appena fatta».
    await page.waitForTimeout(HISTORY_DEDUP_MS + 400);
    send({ type: "topic:updated", topic });

    // Una bolla sola, e il testo una volta sola dentro di lei.
    await expect(assistenti).toHaveCount(1, { timeout: 10_000 });
    await expect(assistenti.first()).toHaveAttribute("data-message-id", DURABLE);
    const quante = ((await assistenti.first().innerText()).match(/voltura del 2019/g) ?? []).length;
    expect(quante, "la stessa risposta non deve comparire due volte").toBe(1);

    // E il turno continua a scrivere DENTRO quella bolla, non accanto.
    send({ type: "stream:content_chunk", content: " Allego il numero." });
    await expect(assistenti.first()).toContainText("Allego il numero", { timeout: 10_000 });
    await expect(assistenti).toHaveCount(1);
  });
});
