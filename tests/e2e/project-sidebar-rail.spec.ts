/**
 * project-sidebar-rail.spec.ts — la rail della sidebar progetto, misurata.
 *
 * COSA PROVA, e perché a misura invece che a occhio.
 *
 * 1) ALLINEAMENTO. Collassata, la sidebar è una colonna da 40px il cui primo
 *    elemento è il bottone che la riapre. Quel bottone deve cadere sulla stessa
 *    linea mediana delle tab della finestra accanto: la riga di chrome è la
 *    stessa (h-10) e l'occhio legge subito uno scarto di 2px come «storto».
 *    Prima stava dentro un `py-2` + `gap-1`, cioè 2px più in basso: uno
 *    screenshot non lo avrebbe mai fatto fallire, un `boundingBox` sì.
 *
 * 2) BORDO PIENO. Il separatore sotto al bottone era un trattino `w-6` centrato
 *    — 24px su 40 — invece del bordo che attraversa la colonna e prosegue nella
 *    riga delle tab. Qui si asserisce che la riga di header della rail è larga
 *    quanto la rail, e che il suo bordo inferiore esiste davvero.
 *
 * 3) PASTIGLIE. Con la sidebar chiusa le tre icone sono l'unica superficie che
 *    resta: devono portare i numeri. Il repo di prova ha una modifica non
 *    committata, quindi l'icona git deve mostrare «1» senza che nessuno apra il
 *    pannello — che è il punto: `GitChanges` è lazy e da collassata NON è
 *    montato, quindi il numero può arrivare solo dallo store condiviso.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

const PROJ = `/tmp/e2e-rail-${Date.now()}`;

test.describe("sidebar progetto — la rail collassata", () => {
  test.beforeAll(() => {
    mkdirSync(PROJ, { recursive: true });
    // Un repo VERO con una modifica vera: il badge deve nascere dallo stato di
    // git, non da un mock. Se domani il conteggio smette di arrivare fino alla
    // rail, questo test lo vede. `initGitRepo` porta con sé l'identità e
    // `commit.gpgsign=false` — senza, su CI il commit fallisce o resta appeso.
    writeFileSync(`${PROJ}/README.md`, "uno\n");
    initGitRepo(PROJ, "primo");
    writeFileSync(`${PROJ}/README.md`, "uno\ndue\n");
  });
  test.afterAll(() => {
    rmSync(PROJ, { recursive: true, force: true });
  });

  test("il bottone di espansione è allineato ai tab e il bordo è pieno", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // Collassa la sidebar del progetto (il bottone vive nel suo header).
    await win.getByRole("button", { name: "Nascondi la barra" }).click();

    const rail = win.locator('[data-testid="project-sidebar-rail"]');
    const railHeader = win.locator('[data-testid="project-sidebar-rail-header"]');
    await expect(rail).toBeVisible({ timeout: 5000 });

    const expandBtn = rail.getByRole("button", { name: "Espandi la barra" });
    await expect(expandBtn).toBeVisible();

    const railBox = (await rail.boundingBox())!;
    const headerBox = (await railHeader.boundingBox())!;
    const btnBox = (await expandBtn.boundingBox())!;

    // ── 2) il bordo attraversa tutta la rail ──────────────────────────────
    expect(
      Math.abs(headerBox.width - railBox.width),
      "la riga di header deve essere larga quanto la rail (bordo a piena larghezza)",
    ).toBeLessThanOrEqual(1);
    const borderPx = await railHeader.evaluate(
      (el) => parseFloat(getComputedStyle(el).borderBottomWidth) || 0,
    );
    expect(borderPx, "la riga di header deve avere un bordo inferiore").toBeGreaterThan(0);
    // Stessa altezza di chrome della riga dei tab: 40px (h-10).
    expect(Math.round(headerBox.height), "la riga di chrome della rail è h-10").toBe(40);

    // ── 1) allineamento con la tab bar della finestra accanto ─────────────
    // La riga dei tab è la prima riga di chrome dentro la finestra, alla
    // stessa quota della rail: si confrontano le linee mediane.
    const tabRow = win.locator(".chrome-glass.border-b").first();
    await expect(tabRow).toBeVisible();
    const tabBox = (await tabRow.boundingBox())!;

    const btnCenter = btnBox.y + btnBox.height / 2;
    const tabCenter = tabBox.y + tabBox.height / 2;
    expect(
      Math.abs(btnCenter - tabCenter),
      `il bottone di espansione (centro ${btnCenter}) deve stare sulla mediana dei tab (${tabCenter})`,
    ).toBeLessThanOrEqual(1);

    // I due bordi inferiori devono cadere sulla stessa linea, altrimenti il
    // «taglio» orizzontale della testata si vede spezzato.
    expect(
      Math.abs((headerBox.y + headerBox.height) - (tabBox.y + tabBox.height)),
      "il bordo della rail e quello della tab bar devono essere alla stessa quota",
    ).toBeLessThanOrEqual(1);

    // ── 3) la pastiglia git porta il numero delle modifiche ───────────────
    const gitBtn = rail.getByRole("button", { name: /Modifiche git/ });
    await expect(gitBtn, "il tooltip git deve nominare il ramo").toHaveAttribute(
      "aria-label",
      /Modifiche git · .+/,
    );
    await expect(
      gitBtn.locator("span").first(),
      "con una modifica non committata la rail mostra 1",
    ).toHaveText("1", { timeout: 15000 });

    // I numeri nel verbale, non solo nelle asserzioni: se un giorno questo test
    // diventa rosso, la riga qui sotto dice DI QUANTO si è spostato.
    console.log(
      `[rail] rail.w=${railBox.width} header.w=${headerBox.width} header.h=${headerBox.height} ` +
        `btnCenterY=${btnCenter.toFixed(1)} tabCenterY=${tabCenter.toFixed(1)} ` +
        `Δcentro=${Math.abs(btnCenter - tabCenter).toFixed(2)}px ` +
        `Δbordo=${Math.abs((headerBox.y + headerBox.height) - (tabBox.y + tabBox.height)).toFixed(2)}px ` +
        `borderBottom=${borderPx}px`,
    );

    // Ritaglio sulla giunzione rail↔tab bar: è lì che si guarda se il taglio
    // orizzontale è continuo e se la pastiglia si legge.
    await page.screenshot({
      path: "test-results/project-sidebar-rail.png",
      clip: { x: railBox.x, y: railBox.y, width: 340, height: 150 },
    });
  });

  test("la riga «File» chiusa ha il suo bordo, e Processi si apre su qualcosa", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // ── «File» chiusa deve leggersi come una riga, non come un titolo
    // sospeso sopra il vuoto. Il suo contenitore resta `flex-1` anche da
    // chiusa (serve a spingere Git e Processi in fondo), quindi il divisore da
    // 1px finisce in fondo alla colonna: senza un bordo PROPRIO, la riga non
    // ha nessuna linea sotto di sé.
    const filesRow = win.locator("div").filter({ hasText: /^File$/ }).last();
    await expect(filesRow).toBeVisible({ timeout: 10000 });
    await filesRow.click();
    await expect
      .poll(async () => filesRow.evaluate(el => parseFloat(getComputedStyle(el).borderBottomWidth) || 0), { timeout: 5000 })
      .toBeGreaterThan(0);

    // ── Aprire «Processi» deve mostrare qualcosa. L'altezza è in pixel e
    // salvata: strizzata all'altezza dell'intestazione, la sezione «si apriva»
    // su zero pixel di contenuto — il chevron ruotava e non compariva niente.
    await page.evaluate((p) => {
      sessionStorage.setItem(`project-sidebar-bottom-heights:${p}`, JSON.stringify({ git: 200, processes: 32 }));
    }, PROJ);
    await page.reload();
    await expect(win).toHaveCount(1, { timeout: 15000 });
    const procRow = win.locator("button").filter({ hasText: /^Processi$/ }).last();
    await expect(procRow).toBeVisible({ timeout: 10000 });
    const section = procRow.locator("..");
    await procRow.click();
    await expect
      .poll(async () => (await section.boundingBox())?.height ?? 0, { timeout: 5000 })
      .toBeGreaterThan(60);
  });

  test("la barra si ridimensiona dal bordo, e il doppio click la riporta al default", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    const bar = win.locator('[data-testid="project-sidebar"]');
    const grip = win.locator('[data-testid="project-sidebar-resizer"]');
    await expect(bar).toBeVisible({ timeout: 10000 });
    const start = (await bar.boundingBox())!;
    expect(Math.round(start.width), "parte dalla misura di default").toBe(224);

    // Trascina il bordo verso destra. Il primo movimento deve superare la
    // soglia anti-click (DRAG_SLOP_PX), altrimenti non è un drag.
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 40, g.y + g.height / 2, { steps: 5 });
    await page.mouse.move(g.x + g.width / 2 + 90, g.y + g.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.round((await bar.boundingBox())!.width), { timeout: 5000 })
      .toBeGreaterThan(280);

    // Doppio click sul bordo: torna alla misura di partenza.
    await grip.dblclick();
    await expect
      .poll(async () => Math.round((await bar.boundingBox())!.width), { timeout: 5000 })
      .toBe(224);
  });
});
