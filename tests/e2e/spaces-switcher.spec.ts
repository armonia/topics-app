/**
 * spaces-switcher.spec.ts — i GRUPPI (Spazi), dopo che sono scesi nella sidebar.
 *
 * Il modello che questo file protegge: **un gruppo è l'unità, e la sidebar è il
 * gruppo che stai guardando**. Da cui, in ordine:
 *   - il nome del gruppo attivo sta in cima alla sidebar;
 *   - la lista sotto mostra le tab di QUEL gruppo, non tutte;
 *   - gli altri gruppi stanno in fondo (SpaceBar), col "+" per aggiungerne;
 *   - un gruppo si può spostare in una finestra sua (`?space=<id>`), e quella
 *     finestra mostra quel gruppo e basta.
 *
 * Superfici: `SpaceTitle` (data-testid="sidebar-space-title"), `SpaceBar`
 * (data-testid="sidebar-space-bar", chip role="tab" / data-space-id) e il menu
 * contestuale delle tab ("Sposta nel gruppo" / "Nuovo gruppo").
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

test.describe.serial("Gruppi (Spazi)", () => {
  let idA = "";
  let idB = "";

  test.beforeAll(async ({ request }) => {
    const a = await createTopic(request, "SPACE-A-" + Date.now());
    const b = await createTopic(request, "SPACE-B-" + Date.now());
    idA = a.id;
    idB = b.id;
  });

  test.afterAll(async ({ request }) => {
    if (idA) await deleteTopic(request, idA);
    if (idB) await deleteTopic(request, idB);
  });

  /** Due chat aperte a livello app, e la pagina caricata. */
  async function openTwoStandaloneTabs(page: Page) {
    // Reset PRISTINO del pane-store, `spaces` compresi. Questo gruppo è
    // `.serial`: al retry Playwright rigira dal primo test, che pretende zero
    // gruppi, e senza reset troverebbe quello creato dal giro precedente.
    await resetPaneStore(page.request, [idA, idB]);
    await Promise.all([
      page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [idA, idB] },
      }).catch(() => {}),
      page.request.put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: [idA, idB], pinned: [idA, idB] },
      }).catch(() => {}),
      page.request.put(`${BASE}/api/ui-state/grid-layout`, {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      }).catch(() => {}),
    ]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-pane-id="${idB}"]`).first()).toBeVisible({ timeout: 10000 });
  }

  /** Crea un gruppo spostandoci dentro la tab `paneId` (via menu contestuale). */
  async function moveTabToNewGroup(page: Page, paneId: string) {
    await page.locator(`[data-pane-id="${paneId}"]`).first().click({ button: "right" });
    const moveEntry = page.getByText("Sposta nel gruppo", { exact: true });
    await expect(moveEntry, "il menu della tab offre 'Sposta nel gruppo'").toBeVisible({ timeout: 3000 });
    await moveEntry.click();
    // Scoped al MENU: "Nuovo gruppo" è anche l'invito in fondo alla sidebar
    // (stessa azione, stessa parola) e senza lo scope il locator è ambiguo.
    const newGroup = page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" });
    await expect(newGroup, "il sottomenu offre 'Nuovo gruppo'").toBeVisible({ timeout: 3000 });
    await newGroup.click();
  }

  test("SPACE-01: senza gruppi c'è solo l'invito a crearne uno, e nessun titolo", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    // La barra c'è sempre (è da lì che si scoprono i gruppi), ma con un gruppo
    // solo non ha chip da mostrare: nessun elenco, nessun titolo in cima.
    await expect(page.getByTestId("sidebar-space-bar")).toBeVisible();
    await expect(page.getByTestId("space-chip")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-space-title")).toHaveCount(0);
    await expect(page.getByTestId("space-add")).toHaveCount(1);
  });

  test("SPACE-01b: su desktop il 'nuovo gruppo' si accende solo passandoci sopra", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    const opacity = () => page.evaluate(() => {
      const el = document.querySelector('[data-testid="space-add"]');
      return el ? getComputedStyle(el).opacity : "missing";
    });
    // Lontano dalla sidebar: il comando c'è nel DOM ma è spento — in fondo alla
    // sidebar, per sempre acceso, sarebbe arredamento.
    await page.mouse.move(1000, 400);
    await expect.poll(opacity, { timeout: 3000 }).toBe("0");
    await page.locator('[aria-label="Topics sidebar"]').hover();
    await expect.poll(opacity, { timeout: 3000 }).toBe("1");
  });

  test("SPACE-02: 'Sposta nel gruppo → Nuovo gruppo' crea il gruppo e ci porta la tab (senza cambiare vista)", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    // La barra in fondo ora elenca "Principale" + il nuovo gruppo.
    const bar = page.getByTestId("sidebar-space-bar");
    await expect(bar.getByRole("tab"), "Principale + il nuovo gruppo").toHaveCount(2);
    await expect(bar.getByRole("tab", { name: "Principale" })).toBeVisible();

    // Semantica Arc: la finestra NON si sposta da sola — resta su Principale, e
    // la tab spostata esce dall'insieme visibile.
    await expect(
      bar.getByRole("tab", { name: "Principale" }),
      "il gruppo di partenza resta quello attivo dopo uno spostamento silenzioso",
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator(`[data-pane-id="${idA}"]`),
      "la tab spostata lascia l'insieme visibile",
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-pane-id="${idB}"]`).first(),
      "l'altra tab resta in Principale",
    ).toBeVisible();
  });

  test("SPACE-03: il chip commuta il gruppo, e la SIDEBAR segue (mostra le sue tab, non tutte)", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    const bar = page.getByTestId("sidebar-space-bar");
    const gruppo2 = bar.getByRole("tab", { name: /Gruppo 2/ });
    await expect(gruppo2, "il nuovo gruppo si chiama 'Gruppo 2'").toBeVisible();

    // Il titolo in cima dice quale gruppo stai guardando.
    await expect(page.getByTestId("sidebar-space-title")).toContainText("Principale");

    await gruppo2.click();
    await expect(gruppo2).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("sidebar-space-title")).toContainText("Gruppo 2");
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "la tab del gruppo attivo è visibile",
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator(`[data-pane-id="${idB}"]`),
      "quella dell'altro gruppo no",
    ).toHaveCount(0);

    // E la SIDEBAR è d'accordo: elenca la riga della tab di questo gruppo, non
    // quella dell'altro. È la regressione che questo riordino doveva chiudere —
    // prima la lista era la stessa per tutti i gruppi.
    const sidebar = page.getByTestId("sidebar-topic-list");
    await expect(sidebar.getByText("SPACE-A-", { exact: false }).first()).toBeVisible({ timeout: 5000 });
    await expect(sidebar.getByText("SPACE-B-", { exact: false })).toHaveCount(0);
  });

  test("SPACE-04: da un altro gruppo, il ritorno a 'Principale' è ABILITATO", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    const bar = page.getByTestId("sidebar-space-bar");
    await bar.getByRole("tab", { name: /Gruppo 2/ }).click();
    const tabAinSpace = page.locator(`[data-pane-id="${idA}"]`).first();
    await expect(tabAinSpace, "la tab A è visibile nel suo gruppo").toBeVisible({ timeout: 5000 });

    // Riapri il suo menu → "Sposta nel gruppo". La riga "Principale" deve essere
    // ABILITATA: senza, una tab spostata non tornerebbe più indietro (il bug era
    // che il sottomenu leggeva una pane ricostruita, senza `spaceId`).
    await tabAinSpace.click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    const principaleEntry = page.getByRole("button", { name: "Principale", exact: true });
    await expect(principaleEntry, "la riga di ritorno c'è").toBeVisible({ timeout: 3000 });
    await expect(principaleEntry, "ed è cliccabile").toBeEnabled();
  });

  test("SPACE-05: 'Sposta in una finestra' apre la finestra DI QUEL GRUPPO", async ({ page }) => {
    // Fuori da Tauri il pop-out passa da `window.open`: lo si intercetta per
    // leggere la URL, che è il contratto vero (`?space=<id>`). L'init script va
    // installato PRIMA della navigazione.
    await page.addInitScript(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = ((url?: string | URL) => {
        w.__opened.push(String(url ?? ""));
        return null;
      }) as typeof window.open;
    });
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    const bar = page.getByTestId("sidebar-space-bar");
    await bar.getByRole("tab", { name: /Gruppo 2/ }).click({ button: "right" });
    const detach = page.getByTestId("space-detach");
    await expect(detach, "il menu del gruppo offre di spostarlo in una finestra").toBeVisible({ timeout: 3000 });
    await detach.click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.length))
      .toBe(1);
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened[0], "e porta l'id del GRUPPO, non delle sue chat").toMatch(/[?&]space=space%3A/);
  });

  test("SPACE-06: una finestra `?space=` mostra QUEL gruppo, e non offre di cambiarlo", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    // L'id del gruppo appena creato, letto dal suo chip.
    const bar = page.getByTestId("sidebar-space-bar");
    const spaceId = await bar.getByRole("tab", { name: /Gruppo 2/ }).getAttribute("data-space-id");
    expect(spaceId, "il chip porta l'id del suo gruppo").toBeTruthy();

    await page.goto(`/?space=${encodeURIComponent(spaceId!)}`);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // La finestra è INCHIODATA a quel gruppo: mostra le sue tab…
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "la finestra-gruppo mostra le tab del suo gruppo",
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator(`[data-pane-id="${idB}"]`),
      "e non quelle degli altri",
    ).toHaveCount(0);
    // …dice quale gruppo è…
    await expect(page.getByTestId("sidebar-space-title")).toContainText("Gruppo 2");
    // …e non offre di andarsene: non c'è dove.
    await expect(page.getByTestId("sidebar-space-bar")).toHaveCount(0);
  });
});
