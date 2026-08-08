/**
 * «Aperta ma non aperta»: il ciclo di vita della chat NUOVA.
 *
 * Una bozza (`draft:<uuid>`) è un foglio bianco, non una tab come le altre.
 * Tre regole, tutte e tre nate da altrettante segnalazioni:
 *
 *   1. nasce col fuoco nel campo di testo — «quando creo una nuova chat,
 *      dovrebbe mettere in focus l'input»;
 *   2. ne esiste UNA sola vuota: chiedere un'altra chat nuova riporta il fuoco
 *      su quella — «posso creare anche più chat al momento vuote, ma ne devo
 *      poter creare solo una e mi fa refocus»;
 *   3. se ne va quando smetti di guardarla, ma SOLO se è ancora bianca — «se
 *      apro la tab nuova chat, poi rimetto una tab esistente, si deve chiudere
 *      il nuovo tab se è vuoto». Una parola scritta la rende tua, e da lì in
 *      poi resta.
 *
 * La 3 ha un gemello che vale il doppio: la bozza con dentro del testo NON si
 * chiude. Una chiusura automatica che si porta via quello che avevi scritto
 * sarebbe peggio del difetto che ripara.
 */
import { expect, test } from "@playwright/test";
import { goToApp, ensureTopicVisible } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** ⌘T = «una chat nuova, secca» (useKeyboardShortcuts → `topics:new-chat`). */
async function newChat(page: import("@playwright/test").Page) {
  await page.keyboard.press("Meta+t");
}

/** Le tab «New Chat» VISIBILI nella barra: sono le bozze non ancora promosse. */
function draftTabs(page: import("@playwright/test").Page) {
  return page
    .locator('[data-testid="panel-tab-bar"]')
    .first()
    .getByText(/^New Chat$/);
}

test.describe.serial("Bozza · aperta ma non aperta", () => {
  let topicId = "";
  const topicName = `Draft Host ${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("nasce col fuoco nel campo di testo, e resta una sola", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await ensureTopicVisible(page, new RegExp(topicName));
    await page.getByRole("treeitem", { name: new RegExp(topicName) }).first().dblclick();
    await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10_000 });

    await newChat(page);
    await expect(draftTabs(page)).toHaveCount(1, { timeout: 10_000 });

    // 1. Il fuoco è nel composer della bozza: si può scrivere subito, senza
    //    prima cliccare dentro.
    const composer = page.getByRole("textbox", { name: /Message input for New Chat/ });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await expect(composer).toBeFocused({ timeout: 5_000 });

    // 2. Un secondo ⌘T non apre un secondo foglio bianco.
    await newChat(page);
    await expect(draftTabs(page)).toHaveCount(1);
    await expect(composer).toBeFocused({ timeout: 5_000 });
  });

  test("vuota si congeda quando cambi tab, con dentro del testo resta", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await ensureTopicVisible(page, new RegExp(topicName));
    const hostRow = page.getByRole("treeitem", { name: new RegExp(topicName) }).first();
    await hostRow.dblclick();
    await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10_000 });

    // ── vuota → se ne va ────────────────────────────────────────────────
    await newChat(page);
    await expect(draftTabs(page)).toHaveCount(1, { timeout: 10_000 });
    // Torno sulla chat che c'era: il foglio bianco non ha più ragione di stare.
    await page
      .locator('[data-testid="panel-tab-bar"]')
      .first()
      .getByText(new RegExp(topicName))
      .first()
      .click();
    await expect(draftTabs(page)).toHaveCount(0, { timeout: 10_000 });

    // ── con del testo → resta ───────────────────────────────────────────
    await newChat(page);
    await expect(draftTabs(page)).toHaveCount(1, { timeout: 10_000 });
    const composer = page.getByRole("textbox", { name: /Message input for New Chat/ });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("questo non deve sparire");
    await page
      .locator('[data-testid="panel-tab-bar"]')
      .first()
      .getByText(new RegExp(topicName))
      .first()
      .click();
    // Un secondo pieno oltre il tempo in cui la chiusura sarebbe scattata.
    await page.waitForTimeout(1000);
    await expect(draftTabs(page)).toHaveCount(1);
  });
});
