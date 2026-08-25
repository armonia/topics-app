import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/**
 * Lo Stop sul PRIMO turno non butta via una chat che ha già lavorato.
 *
 * ── L'incidente (10 agosto 2026, chat «Armonia — finance») ──────────────────
 * Un turno lungo otto minuti — decine di tool, nessun secondo messaggio
 * dell'utente — viene fermato. Il client chiedeva la cancellazione perché
 * contava UN messaggio utente (`decideClientWipeOnStop`: `userMessageCount<=1`)
 * e in questa app tutto il lavoro di un turno sta dentro l'unica riga
 * assistente: «1+1» è la forma sia di un turno mai partito sia di uno che ha
 * macinato per minuti. Il server, che il predicato giusto ce l'aveva già,
 * rifiutava — a log `[Abort] Ignored clearMessages=true … e il turno aveva già
 * prodotto lavoro` — ma il client eseguiva lo stesso il suo ramo distruttivo:
 * svuota la mappa, cancella la cache, e chi chiama CHIUDE la pane (o, dalla
 * riga in sidebar, ARCHIVIA il topic). La chat spariva dalla vista pur restando
 * intatta su disco.
 *
 * Ora il predicato è uno solo (`shared/clear-messages-policy.ts`) e la parola
 * definitiva è del server (`cleared` nella risposta di `/api/chat/abort`).
 *
 * È un COMPORTAMENTO, non un layout: video acceso, il .webm è la prova.
 * Il gemello che tiene in piedi il caso opposto — «primo turno mai partito, si
 * butta» — è `empty-turn-on-stop.spec.ts`; il predicato ha i suoi test di unità
 * in `shared/clear-messages-policy.test.ts` e `stopSessionPolicy.test.ts`.
 *
 * @covers CHAT-01
 */
test.use({ video: "on" });

test.describe.serial("Stop sul primo turno che ha già lavorato", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  const assistantBubbles = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="chat-message"][data-role="assistant"]');
  const userBubbles = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="chat-message"][data-role="user"]');

  test.beforeAll(async ({ request }) => {
    topicName = `stop-first-turn-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find(t => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
    // UNA sola domanda: è la forma dell'incidente. Con due scambi lo stop
    // cadrebbe fuori dal ramo "prima chat, si butta" e il test non misurerebbe
    // niente.
    await seedMessage(request, { sessionKey, role: "user", content: "rifammi il report" });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `messageInput` è STRICT: una pane chat superstite di un altro file lo
  // farebbe risolvere a 2 elementi. Reset a questo topic.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("la chat resta in pagina, la pane resta aperta, il topic non viene archiviato", async ({ page, chatPage, request }) => {
    // Turno guidato dal server (come quando lo si guarda da un'altra finestra):
    // il segnaposto nasce da `stream:start` e si riempie coi chunk. È il modo
    // di avere in pagina un primo turno che HA prodotto qualcosa senza dover
    // far girare un modello vero.
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
    // La domanda seminata è in pagina ⇒ `loadHistory` è passata ⇒ il client è
    // "idratato" e il suo predicato è autorizzato a parlare. Senza questo, lo
    // stop cadrebbe nel ramo "non so cosa c'è nel thread" e il test passerebbe
    // per la ragione sbagliata.
    await expect(userBubbles(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(assistantBubbles(page)).toHaveCount(0);

    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();
    // `messageId` è obbligatorio nello schema inbound: senza, il client SCARTA
    // il frame come malformato e il segnaposto non nasce nemmeno.
    inject!(JSON.stringify({ type: "stream:start", sessionKey, topicId, messageId: "srv-first-turn" }));
    await expect(assistantBubbles(page)).toHaveCount(1, { timeout: 10_000 });
    inject!(JSON.stringify({ type: "stream:content_chunk", sessionKey, topicId, content: "Sto rigenerando il report" }));
    await expect(assistantBubbles(page).last()).toContainText("Sto rigenerando il report", { timeout: 10_000 });

    const stop = page.getByRole("button", { name: /Stop generating/ }).first();
    await expect(stop).toBeVisible({ timeout: 10_000 });
    await stop.click();

    // Fermato — e questa è la riga che prima falliva: la chat resta.
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await expect(userBubbles(page)).toHaveCount(1);
    await expect(userBubbles(page).last()).toContainText("rifammi il report");
    await expect(assistantBubbles(page)).toHaveCount(1);
    await expect(assistantBubbles(page).last()).toContainText("Sto rigenerando il report");

    // La pane non si chiude: il composer è ancora lì.
    await expect(chatPage.messageInput).toBeVisible();

    // E il topic non è stato archiviato — è la mossa che la riga in sidebar si
    // prendeva da sola sullo stesso `true`.
    const after = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await after.json()) as { topics: Record<string, { id: string; archived?: boolean }> };
    const mine = Object.values(topics).find(t => t.id === topicId);
    expect(mine, "il topic deve esistere ancora").toBeTruthy();
    expect(mine!.archived ?? false, "lo stop non archivia il topic").toBe(false);
  });

  test("dopo un reload la domanda è ancora lì: il server non ha cancellato niente", async ({ page, request }) => {
    const res = await request.get(`${BASE}/api/history/${encodeURIComponent(sessionKey)}?limit=0`, {
      ignoreHTTPSErrors: true,
    });
    expect(res.ok(), "la history deve rispondere").toBe(true);
    const { messages } = (await res.json()) as { messages: Array<{ role: string; content: string }> };
    expect(messages.filter(m => m.role === "user").map(m => m.content)).toEqual(["rifammi il report"]);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await expect(userBubbles(page)).toHaveCount(1, { timeout: 15_000 });
  });
});
