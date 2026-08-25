import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { unmockChatStream } from "./helpers/sse-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * Escape con un modale aperto NON deve interrompere il turno dell'AI.
 *
 * Il bug. Escape, quando non c'è nulla da chiudere, interrompe il turno in
 * streaming (SIGINT alla claude-code). "Nulla da chiudere" era una lista
 * scritta a mano di quattro flag dentro `useKeyboardShortcuts`: showSearch,
 * showNewTopic, showShortcuts, showFileSearch. Impostazioni non era in lista —
 * e nemmeno il roster agenti, l'editor di profilo, il lightbox delle anteprime.
 * Con uno di quelli aperto, Escape cadeva nel ramo "interrompi" e uccideva il
 * turno DIETRO al modale: dall'esterno sembrava solo che il modale si fosse
 * chiuso, e la risposta era morta a metà senza che nessuno lo dicesse.
 *
 * La prova sta nella coppia di asserzioni, non in una sola: il primo Escape
 * chiude Impostazioni e il turno resta VIVO; il secondo — a schermo pulito —
 * interrompe davvero. Se il gate fosse troppo largo il secondo fallirebbe, se
 * fosse assente fallirebbe il primo.
 *
 * È la controprova ad aver trovato il secondo guasto: Escape non interrompeva
 * NULLA. Il ramo "interrompi" usava il paneId a fuoco come sessionKey, ma per
 * una chat il pane è il TOPIC (`<uuid>`) e la sessione è `topic:<uuid8>` —
 * cercava una sessione inesistente e non faceva niente, in silenzio. Ora la
 * chiave la risolve `sessionKeyForPaneId` (state/pane/adapters).
 *
 * Video acceso: è un comportamento, e uno screenshot non prova un
 * comportamento.
 *
 * @covers CMD-01
 */
test.use({ video: "on" });

test.describe("Escape non ammazza il turno se c'è un modale aperto", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `escape-guard-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("Impostazioni aperto: Escape chiude il modale e lascia vivo lo streaming", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // Tiene aperta la POST /api/chat: il turno resta `partial` e l'indicatore
    // resta su abbastanza da poterci lavorare sopra (stesso espediente di
    // chat-streaming-indicator.spec.ts — un mock che risponde subito
    // finalizzerebbe il turno entro un frame).
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 30_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("scrivi qualcosa di lungo");
    await chatPage.messageInput.press("Enter");

    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // ⌘, — le Preferenze. La palette dei comandi annunciava questa scorciatoia
    // accanto a "Settings" e non la ascoltava nessuno: ora esiste.
    await page.keyboard.press("Meta+Comma");
    const settings = page.locator('[data-testid="settings-panel"]');
    await expect(settings).toBeVisible({ timeout: 5_000 });

    // IL PUNTO: Escape chiude Impostazioni…
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden({ timeout: 5_000 });

    // …e il turno è ancora vivo. Con la lista scritta a mano qui era già morto.
    await expect(chatPage.streamingIndicator).toBeVisible();
    await page.waitForTimeout(800);
    await expect(chatPage.streamingIndicator).toBeVisible();

    // Controprova: a schermo pulito Escape interrompe davvero. Se il gate fosse
    // troppo largo (per esempio se contasse anche un menu o un popover) questa
    // fallirebbe, e il bug sarebbe solo cambiato di verso.
    await page.keyboard.press("Escape");
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    await unmockChatStream(page);
  });

  test("il pannello delle scorciatoie mostra anche quelle desktop", async ({ page }) => {
    // `desktopOnly` voleva dire "solo nella shell desktop", ma il filtro le
    // toglieva SEMPRE. Su web restano nascoste (giusto), e le famiglie che
    // mancavano del tutto — annulla/ripeti, giro fra le tab, Escape — ora ci
    // sono su ogni host.
    await goToApp(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+Slash");

    const panel = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Le famiglie che prima non esistevano nel pannello.
    await expect(panel.getByText("Undo (layout, tabs)")).toBeVisible();
    await expect(panel.getByText("Next panel", { exact: true })).toBeVisible();
    await expect(panel.getByText("Interrupt the running turn")).toBeVisible();
    await expect(panel.getByText("Settings", { exact: true })).toBeVisible();

    // I tasti sono TOKEN, non caratteri: `keys.split('')` rendeva "Enter" come
    // E · n · t · e · r e "⌘1-9" come ⌘ · 1 · - · 9. Un solo <kbd> "Enter"
    // prima non poteva esistere.
    await expect(panel.locator("kbd").filter({ hasText: /^Enter$/ }).first()).toBeVisible();
    await expect(panel.locator("kbd").filter({ hasText: /^Tab$/ }).first()).toBeVisible();

    await panel.screenshot({ path: "test-results/keyboard-shortcuts-panel.png" });
  });
});
