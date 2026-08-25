import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { unmockChatStream } from "./helpers/sse-helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/**
 * "Un turno che non ha prodotto niente non lascia niente."
 *
 * Fermare una risposta PRIMA che il modello dicesse qualcosa finalizzava il
 * segnaposto creato all'inizio dello stream: una bolla vuota che restava in
 * chat e sopravviveva a ogni reload. Nel DB reale se ne contavano a decine nei
 * giorni di dispatch.
 *
 * È un COMPORTAMENTO, non un layout: video acceso, il .webm è la prova.
 * Il lato server (riga cancellata + contabilità dei rami riparata) sta in
 * `tests/integration/empty-turn-discard.test.ts`; la regola di cosa sia "vuoto"
 * è una sola, `shared/empty-turn.ts`, con i suoi test di unità.
 *
 * @covers CHAT-01
 */
test.use({ video: "on" });

test.describe.serial("Turno vuoto allo stop", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `empty-turn-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find(t => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
    // Storia già presente, e DUE scambi: con un solo turno lo stop cade nel ramo
    // "prima domanda, ho cambiato idea" e azzera la chat intera
    // (`decideClientWipeOnStop`) — il test misurerebbe un'altra cosa.
    await seedMessage(request, { sessionKey, role: "user", content: "domanda di prima" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di prima" });
    await seedMessage(request, { sessionKey, role: "user", content: "e poi?" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di poi" });
  });

  /** Bolle assistente già in chat prima che cominci il turno sotto esame. */
  const SEEDED = 2;

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `messageInput` e `streamingIndicator` sono STRICT: una pane chat superstite
  // di un altro file li farebbe risolvere a 2 elementi. Reset a questo topic.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  const assistantBubbles = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="chat-message"][data-role="assistant"]');

  test("stop prima che il modello dica qualcosa non lascia una bolla vuota", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect(assistantBubbles(page)).toHaveCount(SEEDED, { timeout: 15_000 });

    // Tiene la POST aperta: il segnaposto dell'assistente viene creato PRIMA
    // della risposta, quindi il turno resta `partial` e vivo — esattamente la
    // finestra in cui l'umano preme stop.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 20_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("ciao");
    await chatPage.messageInput.press("Enter");

    // Il segnaposto c'è: una bolla assistente in più, ancora vuota.
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });
    await expect(assistantBubbles(page)).toHaveCount(SEEDED + 1, { timeout: 10_000 });

    const stop = page.getByRole("button", { name: /Stop generating/ }).first();
    await expect(stop).toBeVisible({ timeout: 5_000 });
    await stop.click();

    // Fermato: niente indicatore e, soprattutto, niente bolla vuota di troppo.
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await expect(assistantBubbles(page)).toHaveCount(SEEDED, { timeout: 10_000 });
    // La domanda appena scritta resta: si scarta il turno vuoto, non il turno.
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]').last())
      .toContainText("ciao");

    // …e il composer dice CHI ha fermato il turno. Scartata la bolla vuota, la
    // pagina è indistinguibile da una risposta mai arrivata: senza il segnale
    // dello stop qui compariva «la connessione può essersi interrotta», cioè la
    // rete accusata di una cosa fatta dall'umano un secondo prima.
    const banner = page.locator('[data-testid="no-reply-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveAttribute("data-reason", "stopped");
    await expect(banner).toContainText("Turno interrotto");
    await expect(banner).not.toContainText(/connessione/i);

    await unmockChatStream(page);
  });

  test("una risposta mai arrivata resta un guasto: lì il banner accusa la connessione", async ({ page, chatPage, request }) => {
    // L'altra metà del banner. Stessa forma in pagina — ultimo messaggio
    // dell'utente, niente stream — ma nessuno ha premuto stop: qui «la
    // connessione può essersi interrotta» è la diagnosi giusta, e va detta.
    await seedMessage(request, { sessionKey, role: "user", content: "e questa chi la risponde?" });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const banner = page.locator('[data-testid="no-reply-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute("data-reason", "interrupted");
    await expect(banner).toContainText("Nessuna risposta");
  });

  test("mezza frase è lavoro: quella bolla resta", async ({ page, chatPage }) => {
    // Turno guidato da un'ALTRA finestra: il segnaposto qui nasce da `stream:start`
    // e si riempie coi chunk, come per chi sta solo guardando.
    let inject: ((data: string) => void) | null = null;
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
    await expect(assistantBubbles(page)).toHaveCount(SEEDED, { timeout: 15_000 });

    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();
    // `messageId` è obbligatorio nello schema inbound: senza, il client SCARTA
    // il frame come malformato e il segnaposto non nasce nemmeno.
    inject!(JSON.stringify({ type: "stream:start", sessionKey, topicId, messageId: "srv-msg-1" }));
    await expect(assistantBubbles(page)).toHaveCount(SEEDED + 1, { timeout: 10_000 });
    inject!(JSON.stringify({ type: "stream:content_chunk", sessionKey, topicId, content: "Sto guard" }));
    await expect(assistantBubbles(page).last()).toContainText("Sto guard", { timeout: 10_000 });

    const stop = page.getByRole("button", { name: /Stop generating/ }).first();
    await expect(stop).toBeVisible({ timeout: 10_000 });
    await stop.click();

    // Aveva prodotto qualcosa: la bolla resta, con dentro quello che aveva detto.
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await expect(assistantBubbles(page)).toHaveCount(SEEDED + 1);
    await expect(assistantBubbles(page).last()).toContainText("Sto guard");
  });

  test("il turno scartato dal server sparisce anche a chi sta solo guardando", async ({ page, chatPage }) => {
    // L'altra metà: qui nessuno ha premuto stop, l'ha fatto un'altra finestra.
    // Il server cancella la riga e lo dice con `stream:end.discardedMessageId` —
    // se questa finestra non lo ascoltasse, resterebbe con una bolla vuota che
    // il DB non ha più, e sparirebbe solo al reload.
    let inject: ((data: string) => void) | null = null;
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
    await expect(assistantBubbles(page)).toHaveCount(SEEDED, { timeout: 15_000 });

    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();
    inject!(JSON.stringify({ type: "stream:start", sessionKey, topicId, messageId: "srv-msg-2" }));
    await expect(assistantBubbles(page)).toHaveCount(SEEDED + 1, { timeout: 10_000 });

    // L'id è quello della riga del DB: il segnaposto locale ne ha uno generato
    // in casa, quindi il ripiego "l'ultima bolla, se è vuota" è la parte che
    // conta davvero — cercarlo per id qui non troverebbe niente.
    inject!(JSON.stringify({
      type: "stream:end", sessionKey, topicId,
      reason: "user_abort", discardedMessageId: "row-che-il-server-ha-cancellato",
    }));

    await expect(assistantBubbles(page)).toHaveCount(SEEDED, { timeout: 10_000 });
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    // E la storia di prima non è stata toccata.
    await expect(assistantBubbles(page).last()).toContainText("risposta di poi");
  });

  test("dopo un reload il DB non ha bolle vuote", async ({ page, request }) => {
    // La prova che il vuoto non è solo nascosto in pagina: la history che il
    // server restituisce ha esattamente i messaggi veri.
    const res = await request.get(`${BASE}/api/history/${encodeURIComponent(sessionKey)}?limit=0`, {
      ignoreHTTPSErrors: true,
    });
    expect(res.ok(), "la history deve rispondere").toBe(true);
    const { messages } = (await res.json()) as { messages: Array<{ role: string; content: string }> };
    const emptyAssistants = messages.filter(m => m.role === "assistant" && !m.content.trim());
    expect(emptyAssistants, "nessuna riga assistente vuota in DB").toHaveLength(0);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(SEEDED, { timeout: 15_000 });
  });
});
