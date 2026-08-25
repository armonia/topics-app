import { expect, test } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

/**
 * «Aperto» ha UN registro autorevole, e la chiusura di una tab è il ritiro di
 * ciò che contiene.
 *
 * COSA PROVA CHE UN TEST DI UNITÀ NON PROVA. Che i tre registri — pane store,
 * `terminal_sessions`, `topics.archived` — dicono la stessa cosa che si vede
 * sullo schermo, e continuano a dirla dopo un giro completo attraverso il
 * client vero. Il guasto misurato il 03/08 (11 sessioni vive per tab chiuse a
 * luglio) non era una funzione sbagliata: era che nessuno aveva mai confrontato
 * le tre risposte, perché costava tre query.
 *
 * `GET /api/open` è quella query, e `divergences: 0` è l'asserzione che la
 * rende utile: significa che nessuno dei tre registri sta dicendo qualcosa che
 * il fatto smentisce.
 *
 * @covers RETIRE-01, RETIRE-02
 */
hermetic(test);

async function openInventory(request: any) {
  const res = await request.get(`${E2E_BASE}/api/open`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.describe.serial("Il ritiro ha un registro solo", () => {
  const topicName = `e2e-ritiro-${Date.now()}`;
  let topicId = "";

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    // QUI NON SI CREA UNA SESSIONE DI TERMINALE, e non è una dimenticanza.
    // Il PTY-bridge è un sidecar nativo che non è presente in ogni checkout:
    // senza, `POST /api/terminal/sessions` risponde 502 e — cinque secondi dopo
    // — il rigetto di `awaitBridgeCreate` fa cadere il server di test, il che
    // trasforma questo file in otto ECONNREFUSED che accusano il codice
    // sbagliato. Il caso terminale è provato in
    // `server/routes/ui-state.retirement.test.ts`, che esercita la stessa
    // cascata sul router vero e gira sempre; qui si prova ciò che solo il
    // client vero può provare — che dopo un giro completo di chiusura e
    // ricarica i tre registri dicono ancora la stessa cosa dello schermo.
    await resetPaneStore(request, [topicId]);
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test("prima: la query sola vede la tab, e nessun registro la smentisce", async ({ page, request }) => {
    await goToApp(page);
    await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 15000 });

    const inv = await openInventory(request);
    expect(inv.topics.map((t: any) => t.id)).toContain(topicId);
    expect(inv.divergences).toEqual([]);
  });

  test("chiudere la tab ritira ciò che contiene, e la ricarica non la riporta", async ({ page, request }) => {
    await goToApp(page);
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(tabBar).toBeVisible({ timeout: 15000 });

    // Chiudo dal menu contestuale: è l'imbuto che passa da `handleClosePanel`,
    // cioè lo stesso della X e di ⌘W.
    for (let i = 0; i < 4; i++) {
      const tab = tabBar.locator('[draggable="true"]').first();
      if ((await tab.count()) === 0) break;
      await tab.click({ button: "right" });
      const menu = page.locator('[role="menu"]').first();
      await expect(menu).toBeVisible({ timeout: 5000 });
      await menu.locator("button").filter({ hasText: /^Chiudi/ }).first().click();
      await expect(menu).toBeHidden({ timeout: 5000 });
    }

    // La ricarica è il passo che conta: è lì che il pane store si ri-idrata dal
    // server, ed è lì che una tab chiusa «ricompariva».
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    await expect
      .poll(async () => (await openInventory(request)).topics.some((t: any) => t.id === topicId), { timeout: 10000 })
      .toBe(false);

    const inv = await openInventory(request);
    expect(inv.topics.map((t: any) => t.id)).not.toContain(topicId);
    // Il numero che rende la query utile: i tre registri concordano col fatto.
    expect(inv.divergences).toEqual([]);
    // E lo schermo dice la stessa cosa.
    await expect(page.locator('[data-testid="panel-tab-bar"] [draggable="true"]')).toHaveCount(0);
  });
});
