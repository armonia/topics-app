import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * PIANO §1b.5 — il ring del composer mostra il contesto REALE del modello, e
 * sopra soglia offre la scelta PRIMA della compaction.
 *
 * La misura vera nasce da `onContextSize` durante un turno del modello: qui
 * non possiamo farne partire uno (nessun account nel test server), quindi
 * intercettiamo il solo confine che il client consuma — `GET
 * /api/context/live` — e verifichiamo tutto il resto per davvero: quale
 * numero disegna il ring, da quale sorgente dice di averlo preso, e cosa
 * offre la strip di preavviso. La forma della risposta è quella prodotta da
 * `classifyContext` (server/usage/context-window.ts), coperta a sua volta dai
 * suoi unit test.
 */
test.describe.serial("Context ring — contesto reale + preavviso di compaction", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Ring ctx " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("senza misura reale il ring resta sul preventivo dell'envelope", async ({ page }) => {
    await page.route("**/api/context/live*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ context: null }) }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const ring = page.getByTestId("chat-input-context-ring").first();
    await ring.waitFor({ state: "visible", timeout: 10_000 });
    await expect(ring).toHaveAttribute("data-context-source", "envelope");
    // Nessuna misura reale ⇒ nessun preavviso: la strip non deve MAI nascere
    // dal preventivo, che è un'altra domanda.
    await expect(page.getByTestId("context-notice")).toHaveCount(0);
  });

  test("con la misura reale il ring mostra quella, e sopra soglia offre la scelta", async ({ page }) => {
    await page.route("**/api/context/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          // Forma `usage_update` ACP (3.1): `used`/`size` dentro il blocco.
          context: {
            usage: { sessionUpdate: "usage_update", used: 186_000, size: 200_000 },
            percent: 93,
            level: "critical",
            estimated: false,
            model: "claude-opus-5",
            measuredAt: new Date().toISOString(),
          },
        }),
      }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const ring = page.getByTestId("chat-input-context-ring").first();
    await ring.waitFor({ state: "visible", timeout: 10_000 });
    await expect(ring).toHaveAttribute("data-context-source", "model");
    await expect(ring).toHaveAttribute("data-context-percent", "93");
    await expect(ring).toHaveAttribute("title", /186k \/ 200k \(93%\)/);

    // Preavviso: le due strade dell'umano, prima che la compaction accada.
    const notice = page.getByTestId("context-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveAttribute("data-context-level", "critical");
    await expect(notice.getByRole("button", { name: "Compact now" })).toBeVisible();
    await expect(notice.getByRole("button", { name: "New chat" })).toBeVisible();

    // Chiudibile: chi ha deciso non deve riavere l'avviso addosso a ogni token.
    await notice.getByTitle("Dismiss").click();
    await expect(notice).toHaveCount(0);
    // …ma il ring continua a dire il vero.
    await expect(ring).toHaveAttribute("data-context-percent", "93");
  });
});
