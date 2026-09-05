import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * QUATTRO AZIONI DELLA CHAT CHE FALLIVANO IN SILENZIO.
 *
 * Ogni scenario rompe UNA rotta e guarda lo schermo. Prima di questo giro lo
 * schermo era identico a quello di un successo: `catch {}`, `console.warn`, o un
 * `void` su una promessa che nessuno guardava. Il toast è la sola prova che
 * conta, e ci si legge dentro la frase del server («boom»), non una nostra copia
 * tradotta: così l'asserzione non congela un testo dell'interfaccia.
 *
 * Sulla rinomina dell'obiettivo la prova è doppia: il toast E il campo di
 * modifica ancora aperto col testo digitato. Chiuderlo prima della risposta
 * rimetteva a schermo il titolo vecchio, che è esattamente il disegno del
 * successo, e il testo appena scritto spariva.
 *
 * @covers CHAT-FAIL-01
 */
test.describe("Errori silenziosi nelle azioni della chat", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `silent-fail-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${topicId.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `chatPage.messageInput` è STRICT (nessun `.first()`): basta una pane chat
  // lasciata aperta da un'altra spec per far fallire tutto il file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function openChat(page: Page, chatPage: { messageInput: Locator }) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Il toast di errore a schermo, col testo che il server ha davvero mandato. */
  function errorToast(page: Page) {
    return page.getByTestId("toast").filter({ hasText: "boom" });
  }

  test("«Remember this» rifiutato lo dice invece di disegnare un successo", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "una risposta da ricordare",
    });

    await openChat(page, chatPage);
    const bubble = page.getByTestId("chat-message").filter({ hasText: "una risposta da ricordare" });
    await expect(bubble).toBeVisible({ timeout: 15_000 });

    await page.route("**/api/memory/*/append", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    // La barra azioni compare all'hover della bolla.
    await bubble.hover();
    await bubble.getByRole("button", { name: "Save to memory" }).click();

    await expect(errorToast(page)).toBeVisible({ timeout: 10_000 });
  });

  test("la rinomina dell'obiettivo che fallisce tiene il campo aperto col testo digitato", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await request.put(`/api/topics/${topicId}/goal`, { data: { content: "Obiettivo di partenza" } });

    await openChat(page, chatPage);
    const bar = page.getByTestId("goal-bar");
    await expect(bar).toContainText("Obiettivo di partenza", { timeout: 15_000 });

    // Solo la SCRITTURA: la GET del goal deve continuare a rispondere, altrimenti
    // la barra sparisce e il test proverebbe un'altra cosa.
    await page.route("**/api/topics/*/goal", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });

    await bar.getByTestId("goal-edit").click();
    const field = page.getByTestId("goal-bar-edit").getByRole("textbox");
    await expect(field).toBeVisible();
    await field.fill("Obiettivo riscritto");
    await field.press("Enter");

    await expect(errorToast(page)).toBeVisible({ timeout: 10_000 });
    // Il campo è ancora lì, e dentro c'è quello che la persona ha scritto: non
    // il titolo vecchio, che sarebbe indistinguibile da un salvataggio riuscito.
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("Obiettivo riscritto");

    const stored = await (await request.get(`/api/topics/${topicId}/goal`)).json();
    expect(stored.goal?.content).toBe("Obiettivo di partenza");
  });

  test("la pastiglia di contesto che non si spegne lo dice, e resta accesa", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await patchTopic(request, topicId, { contextFiles: [`${process.cwd()}/package.json`] });

    await openChat(page, chatPage);
    const pill = page.getByTestId("context-pill").filter({ hasText: "package.json" });
    await expect(pill).toBeVisible({ timeout: 15_000 });

    await page.route("**/api/topics/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });

    await pill.click();

    await expect(errorToast(page)).toBeVisible({ timeout: 10_000 });
    // Nessun aggiornamento ottimistico: il file è ancora nel contesto, e la
    // pastiglia lo dice restando accesa.
    await expect(pill).not.toHaveAttribute("title", /excluded/);
  });

  test("un'immagine illeggibile non porta via le altre e viene nominata", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await openChat(page, chatPage);

    // Un PNG vero da 1x1 e una manciata di byte che nessun decodificatore
    // accetta: `img.onerror` scatta sulla seconda, e prima si portava via anche
    // la prima insieme al testo del composer.
    const readable =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.evaluate((pngBase64) => {
      const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "buona.png", { type: "image/png" }));
      data.items.add(new File([new Uint8Array([1, 2, 3, 4])], "rotta.png", { type: "image/png" }));
      const target = document.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Message input"]');
      target?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, readable);

    // Quella leggibile è entrata nel composer.
    await expect(page.getByTestId("composer-attachment")).toHaveCount(1, { timeout: 10_000 });
    // E lo scarto ha un nome: senza, l'unico segno era un'anteprima in meno.
    await expect(page.getByTestId("toast").filter({ hasText: "rotta.png" })).toBeVisible({ timeout: 10_000 });
  });
});
