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
 *
 * @covers LAYOUT-02
 */
import { expect, test } from "@playwright/test";
import { goToApp, ensureTopicVisible } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { mockChatStream, unmockChatStream } from "./helpers/sse-helpers";
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

  // La regola è l'INTERAZIONE, non lo sguardo: una chat nuova che non hai mai
  // toccato è un'anteprima e si richiude quando passi ad altro; toccata (un
  // clic dentro, un tasto, un doppio clic sulla tab) o con del testo, resta.
  test("non toccata si richiude, toccata resta", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await ensureTopicVisible(page, new RegExp(topicName));
    const hostRow = page.getByRole("treeitem", { name: new RegExp(topicName) }).first();
    await hostRow.dblclick();
    await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10_000 });

    // ── mai toccata → si richiude ───────────────────────────────────────
    await newChat(page);
    await expect(draftTabs(page)).toHaveCount(1, { timeout: 10_000 });
    // Un attimo sulla bozza: una che non ha mai avuto il fuoco non l'hai mai
    // lasciata, e la regola lo dice (DRAFT_MIN_LOOKED_AT_MS). Il fuoco gliel'ha
    // dato l'app, non un tuo clic: NON conta come «toccata».
    // DELIBERATE FIXED WAIT: DRAFT_MIN_LOOKED_AT_MS is a product timer. The
    // test has to sit past it, and a timer that has elapsed shows nothing.
    await page.waitForTimeout(800);
    await page
      .locator('[data-testid="panel-tab-bar"]')
      .first()
      .getByText(new RegExp(topicName))
      .first()
      .click();
    await expect(draftTabs(page)).toHaveCount(0, { timeout: 10_000 });

    // ── con del testo → resta, e questo non cambierà mai ────────────────
    await newChat(page);
    await expect(draftTabs(page)).toHaveCount(1, { timeout: 10_000 });
    const composer = page.getByRole("textbox", { name: /Message input for New Chat/ });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("questo non deve sparire");
    await page.waitForTimeout(800);
    await page
      .locator('[data-testid="panel-tab-bar"]')
      .first()
      .getByText(new RegExp(topicName))
      .first()
      .click();
    // Un secondo pieno oltre il tempo in cui la chiusura sarebbe scattata.
    // DELIBERATE FIXED WAIT: the assertion is that the draft did NOT close.
    await page.waitForTimeout(1500);
    await expect(draftTabs(page)).toHaveCount(1);

    // ── toccata (doppio clic sulla tab) → resta, anche se vuota ─────────
    // Svuoto il campo: senza testo l'unica cosa che la tiene in vita è il
    // gesto. È il caso che la regola nuova aggiunge, e va misurato da solo.
    await draftTabs(page).first().click();
    await composer.fill("");
    await draftTabs(page).first().dblclick();
    await page
      .locator('[data-testid="panel-tab-bar"]')
      .first()
      .getByText(new RegExp(topicName))
      .first()
      .click();
    await page.waitForTimeout(1500);
    await expect(draftTabs(page)).toHaveCount(1);
  });

  test("appena aperta non si chiude da sola, nemmeno con altre tab davanti", async ({ page, request }) => {
    // «Se sono su un'altra tab e faccio nuova tab dalla tab, mi si apre al volo
    // ma poi mi si chiude subito.» Questo è il percorso segnalato, misurato per
    // intero: due tab aperte, la chat nuova dal «+» della barra, e due secondi
    // dopo deve essere ancora lì col fuoco nel campo. Non ha mai fallito nel
    // server di test — il che è metà del problema, non una consolazione — ma
    // resta la rete: se un giorno quel percorso si mette a chiudere la tab,
    // cade qui e non addosso a chi la usa.
    const other = await createTopic(request, `Draft Sibling ${Date.now()}`);
    try {
      await resetPaneStore(request, [topicId, other.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      for (const n of [topicName, other.name]) {
        await ensureTopicVisible(page, new RegExp(n));
        await page.getByRole("treeitem", { name: new RegExp(n) }).first().dblclick();
      }
      await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10_000 });

      // Il «+» della barra, che è la strada segnalata.
      await page.getByTitle("Add pane").first().click();
      await page.getByTestId("pane-add-menu-new-chat").first().click();

      await expect(draftTabs(page)).toHaveCount(1, { timeout: 5_000 });
      // Ben oltre la finestra della chiusura differita: se rimbalza, muore qui.
      // DELIBERATE FIXED WAIT: negative assertion, the pane must NOT bounce.
      await page.waitForTimeout(2000);
      await expect(draftTabs(page)).toHaveCount(1);
      await expect(
        page.getByRole("textbox", { name: /Message input for New Chat/ }),
      ).toBeFocused({ timeout: 5_000 });
    } finally {
      await deleteTopic(request, other.id);
    }
  });

  test("il composer sta al centro finché la chat è vuota, poi si aggancia in fondo", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await ensureTopicVisible(page, new RegExp(topicName));
    await page.getByRole("treeitem", { name: new RegExp(topicName) }).first().dblclick();

    const composer = page.getByRole("textbox", { name: new RegExp(`Message input for ${topicName}`) });
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Vuota: il blocco (invito + composer) è centrato, cioè spostato in su.
    const block = page.locator('[data-testid="chat-input-area"]').filter({ has: composer });
    await expect(block).toHaveAttribute("data-composer-centered", "true", { timeout: 10_000 });
    const centeredTop = (await block.boundingBox())?.y ?? 0;
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    // Il primo messaggio la fa scendere.
    await mockChatStream(page, { chunks: ["ok"], userMessage: "primo messaggio" });
    await composer.fill("primo messaggio");
    await composer.press("Enter");

    await expect(block).toHaveAttribute("data-composer-centered", "false", { timeout: 15_000 });
    // …e giù vuol dire GIÙ: la transizione dura 420ms, quindi si misura dopo.
    await expect
      .poll(async () => (await block.boundingBox())?.y ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(centeredTop + 40);
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
    await unmockChatStream(page);
  });
});
