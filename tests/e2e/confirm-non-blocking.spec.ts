import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { unmockChatStream } from "./helpers/sse-helpers";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: riparte dalla baseline del globalSetup, non dallo stato
// lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * I sette `window.confirm` sono stati sostituiti da `useConfirm()` +
 * `ConfirmDialog` (React). `window.confirm` è un dialog modale NATIVO: in una
 * WKWebView CONGELA il thread della webview finché non lo chiudi a mano — chat
 * in streaming ferme, timer del turno fermo, l'app in ostaggio.
 *
 * Questo test prova che l'app NON è più in ostaggio: con il dialog di conferma
 * di `/clear` APERTO, il turno che sta ancora streammando nella STESSA pane
 * continua a vivere — il suo timer avanza. Con `window.confirm` il timer
 * resterebbe inchiodato (il thread è bloccato). Video come prova durevole.
 */
test.use({ video: "on" });

test.describe("ConfirmDialog non blocca il thread", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `confirm-nonblock-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `messageInput`/`streamingIndicator` sono STRICT: una pane chat superstite di
  // un file precedente (pane-store condiviso dalla suite) basta a farli
  // risolvere a 2 elementi. Reset al solo topic di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("con il dialog di /clear aperto, il turno accanto continua a streammare", async ({ page, chatPage }) => {

    test.info().annotations.push({ type: "spec", description: "CHAT-DIALOG-01" });
    test.setTimeout(60_000);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // Tiene APERTA la POST /api/chat: il turno resta `partial`, l'indicatore
    // resta su e il suo timer avanza finché non si chiude. (Un mock che chiude
    // subito la risposta finalizzerebbe il turno e l'indicatore sparirebbe —
    // per questo si tiene la presa aperta, come chat-streaming-indicator.spec.)
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 40_000));
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
    const timer = chatPage.streamingIndicator.locator('[data-testid="turn-timer"]');
    const parseSecs = async () => {
      const t = (await timer.textContent()) ?? "";
      const m = t.match(/([\d.]+)\s*s/);
      return m ? parseFloat(m[1]) : NaN;
    };
    await expect(timer).toContainText(/s/, { timeout: 3_000 });

    // Si arriva a `/clear` dal menu «Tools & commands»: la voce riempie il
    // composer con «/clear » e mette a fuoco la textarea (NON invia, e non apre
    // il menu slash inline). Poi Enter invia. Scritto a mano nel composer,
    // `fill("/clear")` lascerebbe il menu slash chiuso e un Escape per chiuderlo
    // cadrebbe sul gestore globale che INTERROMPE il turno — svuotando la lista.
    await page.getByRole("button", { name: "Tools & commands" }).click();
    await page.getByRole("button", { name: /Clear conversation/ }).click();

    // `/clear` è intercettato PRIMA dell'accodamento (ChatPane.tsx:825): apre il
    // dialog anche mentre il turno «ciao» è ancora in streaming.
    await chatPage.messageInput.press("Enter");

    // Il ConfirmDialog React (role="dialog", non un modale nativo).
    const dialog = page.getByRole("dialog", { name: "Clear conversation?" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // IL CUORE DEL TEST: con il dialog aperto, il timer del turno accanto DEVE
    // avanzare. Con `window.confirm` il thread sarebbe congelato e questo
    // resterebbe fermo.
    const before = await parseSecs();
    expect(Number.isFinite(before)).toBe(true);
    await page.waitForTimeout(2_200);
    const after = await parseSecs();
    expect(after).toBeGreaterThanOrEqual(before + 0.9);

    // E l'indicatore è ancora su: lo stream non è stato interrotto dal dialog.
    await expect(chatPage.streamingIndicator).toBeVisible();

    // Annulla: Escape chiude il dialog (useModalDialog), la conversazione NON
    // viene cancellata e il turno prosegue.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(chatPage.streamingIndicator).toBeVisible();

    await unmockChatStream(page);
  });
});
