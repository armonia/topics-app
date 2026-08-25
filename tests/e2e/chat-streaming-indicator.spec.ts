import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { mockHangingStream, unmockChatStream } from "./helpers/sse-helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/**
 * The turn-activity indicator (playful rotating phrase + soft-glow dot + a live
 * turn timer) replaces the old three bouncing dots and the "Streaming..." row,
 * and a user-sent message must always snap the view to the bottom. Record video
 * so the indicator + timer + snap are durable evidence, not just a green tick.
 *
 * @covers CHAT-01
 */
test.use({ video: "on" });

test.describe("Chat streaming indicator", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `stream-indicator-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `streamingIndicator` e `messageInput` sono STRICT: una sola pane chat
  // superstite di un file precedente (il pane-store è condiviso da tutta la
  // suite) basta a farli risolvere a 2 elementi. Reset al topic di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("shows a playful phrase + a live ticking timer (no bounce dots)", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // Hold the /api/chat response open: `sendMessage` creates a `partial`
    // assistant placeholder BEFORE the response (useChat.ts:898), and the
    // client's stream watchdog is 3 min — so while the request hangs, the turn
    // stays `partial` and the indicator stays put for us to inspect. (A mock
    // that returns immediately would finalize the turn within a frame and the
    // indicator would flash by uncaught.)
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

    // The indicator is up…
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // …with a non-empty playful phrase (ends with the ellipsis, no digits)…
    const phrase = chatPage.streamingIndicator.locator('[data-testid="turn-phrase"]');
    await expect(phrase).toBeVisible();
    const phraseText = (await phrase.textContent())?.trim() ?? "";
    expect(phraseText.length).toBeGreaterThan(1);
    expect(phraseText).toMatch(/…$/);
    expect(phraseText).not.toMatch(/\d/);

    // …and NONE of the old three-dot bounce animation remains.
    await expect(chatPage.messageList.locator(".animate-bounce")).toHaveCount(0);

    // The timer advances: read it, wait, read again — it must have grown.
    const timer = chatPage.streamingIndicator.locator('[data-testid="turn-timer"]');
    const parseSecs = async () => {
      const t = (await timer.textContent()) ?? "";
      const m = t.match(/([\d.]+)\s*s/);
      return m ? parseFloat(m[1]) : NaN;
    };
    // First tick may be 0.0s; wait for a real value, then confirm growth.
    await expect(timer).toContainText(/s/, { timeout: 3_000 });
    const before = await parseSecs();
    await page.waitForTimeout(2_200);
    const after = await parseSecs();
    expect(Number.isFinite(before)).toBe(true);
    expect(after).toBeGreaterThanOrEqual(before + 0.9);

    await unmockChatStream(page);
  });

  test("stream:slow accende l'indicatore ambra, stream:resumed lo spegne", async ({ page, chatPage, request }) => {
    // Il server annunciava `stream:slow` e `stream:resumed` e NESSUNO li
    // ascoltava: al loro posto appendeva `\n\n---\n*[⏱ stream lento…]*` al
    // CONTENUTO del messaggio. Se il turno si chiudeva mentre era lento —
    // oppure, come nei dati reali, se il testo nuovo arrivava DOPO
    // l'annotazione — quel testo restava dentro per sempre e da quel momento
    // tornava al modello a ogni turno come se l'assistente lo avesse detto
    // (63 messaggi così nel DB reale, bonificati dalla migration 069).
    //
    // Qui si prova la sostituzione: l'evento arriva, l'indicatore lo mostra, e
    // sparisce quando lo stream riprende. Il segnale non tocca il contenuto.
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const sessionKey = Object.values(topics.topics).find((t) => t.id === topicId)?.sessionKey;
    expect(sessionKey, "il topic di questo file deve avere una sessionKey").toBeTruthy();

    // Pass-through sulla WS, tenendo la presa per iniettare un frame "dal
    // server". Va armata PRIMA di goto, o la connessione iniziale la scavalca.
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

    // Tiene aperta la POST: il turno resta `partial` e l'indicatore resta su.
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
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });
    // Parte NON lento.
    await expect(chatPage.streamingIndicator).not.toHaveAttribute("data-slow", "true");

    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();
    inject!(JSON.stringify({
      type: "stream:slow",
      sessionKey,
      topicId,
      messageId: "msg-slow-probe",
      graceMs: 60_000,
    }));

    await expect(chatPage.streamingIndicator).toHaveAttribute("data-slow", "true", { timeout: 10_000 });
    await expect(chatPage.streamingIndicator.locator('[data-testid="turn-phrase"]'))
      .toContainText(/stream lento/i);

    // E il CONTENUTO del messaggio non è stato toccato. L'indicatore vive dentro
    // la lista, quindi cercare la frase lì dentro trova l'indicatore stesso: il
    // segno che distingue l'annotazione vecchia è il `⏱` (che l'indicatore non
    // usa), insieme al separatore `---` con cui veniva incollata.
    await expect(chatPage.messageList).not.toContainText("⏱");

    inject!(JSON.stringify({ type: "stream:resumed", sessionKey, topicId }));
    await expect(chatPage.streamingIndicator).not.toHaveAttribute("data-slow", "true", { timeout: 10_000 });

    await unmockChatStream(page);
  });

  test("sending a message snaps the view to the bottom even when scrolled up", async ({ page, chatPage, request }) => {
    // Seed enough history to make the topic scrollable.
    for (let i = 0; i < 20; i++) {
      await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
        data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const scroller = chatPage.messageList;
    await expect(scroller).toBeVisible({ timeout: 10_000 });

    // Scroll up to the top so we are genuinely NOT at the bottom.
    //
    // NON convertire queste due pause in un expect.poll sulla distanza dal
    // fondo: provato, e il test diventa rosso 3 volte su 3 (contro 3 verdi su 3
    // qui). Lo scroll e' ANIMATO: il poll ritorna appena la distanza supera la
    // soglia, cioe' a scroll ancora IN VOLO, e l'animazione residua poi combatte
    // con lo snap-to-bottom del messaggio in arrivo (misurato: 543 px dal fondo
    // invece di <150). Qui la pausa non serve ad ARRIVARE, serve ad ASSESTARE —
    // ed e' l'unico caso in questo file in cui non e' sostituibile.
    await scroller.click();
    await page.keyboard.press("Home");
    await page.waitForTimeout(800);
    await page.keyboard.press("Home");
    await page.waitForTimeout(1_200);
    const distUp = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(distUp).toBeGreaterThan(150); // precondition: we really scrolled up

    // Send a message (hanging stream so the send itself doesn't need a turn).
    await mockHangingStream(page, "…");
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("torna giù per favore");
    await chatPage.messageInput.press("Enter");

    // The view must snap back to the bottom (150px = the app's at-bottom band).
    await expect
      .poll(
        async () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
        { timeout: 8_000 },
      )
      .toBeLessThan(150);

    await unmockChatStream(page);
  });
});
