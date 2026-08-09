/**
 * La sidebar del progetto, misurata invece che guardata.
 *
 * CHIUSA NON È PIÙ UNA COLONNA. Era una rail verticale da 40px con un
 * `border-r` che scendeva per tutta la finestra a contenere tre icone: una
 * seconda superficie accanto alla riga di chrome, con una tinta sua e un filo
 * che non separava niente. «Facciamo diventare la sidebar chiusa direttamente
 * parte della tabbar progetto, in linea e non disposte verticalmente ma
 * orizzontalmente, usando il design a card e riportando anche titolo progetto,
 * così da togliere linea laterale inutile quando collassata» (Attilio, 09/08).
 *
 * Quindi ciò che si misura è cambiato con lei:
 * 1. Chiusa, la colonna NON ESISTE — né la rail né il suo filo verticale — e i
 *    suoi comandi stanno dentro `.pane-chrome-bar`.
 * 2. Quei comandi hanno la misura e l'aria di una tab, perché ora sono in fila
 *    con le tab (è l'invariante di `tab-bar-command-air.spec.ts`, qui riletta
 *    sulla striscia del progetto).
 * 3. Il nome del progetto si vede: chiusa, prima, non c'era da nessuna parte.
 * 4. Pastiglie. Sono l'unica cosa che resta accesa da chiusa. Il repo di prova
 *    ha una modifica non committata, quindi git deve mostrare 1 senza che
 *    nessuno apra il pannello: GitChanges e lazy e da chiusa non e montato,
 *    quindi il numero puo arrivare solo dallo store condiviso.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

const PROJ = `/tmp/e2e-rail-${Date.now()}`;

test.describe("sidebar progetto: la rail collassata", () => {
  test.beforeAll(() => {
    mkdirSync(PROJ, { recursive: true });
    // Un repo vero con una modifica vera, non un mock: se il conteggio smette
    // di arrivare fino alla rail, questo test lo vede. `initGitRepo` porta
    // identita e `commit.gpgsign=false`, senza cui su CI il commit si appende.
    writeFileSync(`${PROJ}/README.md`, "uno\n");
    initGitRepo(PROJ, "primo");
    writeFileSync(`${PROJ}/README.md`, "uno\ndue\n");
  });
  test.afterAll(() => {
    rmSync(PROJ, { recursive: true, force: true });
  });

  test("chiusa, la barra è una fila di card DENTRO la riga delle tab", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // Collassa la sidebar del progetto (il bottone vive nel suo header).
    await win.getByRole("button", { name: "Nascondi la barra" }).click();

    const strip = win.locator('[data-testid="project-rail-inline"]');
    await expect(strip).toBeVisible({ timeout: 5000 });

    // 1. LA COLONNA NON C'È PIÙ, e con lei il filo verticale. È metà della
    //    richiesta — «togliere linea laterale inutile quando collassata» — e
    //    senza questa asserzione il resto passerebbe anche con la rail ancora
    //    lì accanto, semplicemente ignorata.
    await expect(win.locator('[data-testid="project-sidebar-rail"]')).toHaveCount(0);
    await expect(win.locator('[data-testid="project-sidebar"]')).toHaveCount(0);

    // 2. E STA DENTRO la riga di chrome, non accanto: è la differenza fra
    //    «in linea» e «appoggiata di fianco».
    const tabRow = win.locator(".pane-chrome-bar").first();
    await expect(tabRow).toBeVisible();
    expect(
      await strip.evaluate((el) => !!el.closest(".pane-chrome-bar")),
      "la striscia deve stare DENTRO .pane-chrome-bar",
    ).toBe(true);

    const tabBox = (await tabRow.boundingBox())!;
    const expandBtn = strip.getByRole("button", { name: "Espandi la barra" });
    await expect(expandBtn).toBeVisible();
    const btnBox = (await expandBtn.boundingBox())!;

    // 3. STESSA MEDIANA dei tab — l'invariante che questo test difende da
    //    sempre, solo su un'altra geometria.
    const btnCenter = btnBox.y + btnBox.height / 2;
    const tabCenter = tabBox.y + tabBox.height / 2;
    expect(
      Math.abs(btnCenter - tabCenter),
      `il bottone di espansione (centro ${btnCenter}) deve stare sulla mediana dei tab (${tabCenter})`,
    ).toBeLessThanOrEqual(1);

    // 4. E STESSA MISURA di una tab: in fila con loro, un comando più alto o
    //    più basso respira diverso dalla sua vicina — è il difetto tolto dal
    //    «+» il 09/08, che qui rientrerebbe dalla porta di servizio.
    const boxes = await strip.locator("button").evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    // Il metro è una TAB VERA della stessa barra quando ce n'è una; qui la
    // finestra di progetto nasce senza tab aperte, e allora vale la misura che
    // il breakpoint impone a questa larghezza (`ROW_ACTION_BOX`: `md:w-7` = 28
    // sopra i 768px, che è dove gira questo progetto). Scritto così e non con
    // un ternario che restituisce lo stesso numero da tutte e due le parti —
    // quello sarebbe un'asserzione che non può fallire.
    // `count()` prima di `evaluate()`: un locator vuoto non fallisce subito, ASPETTA
    // il suo timeout — trenta secondi buttati e poi la pagina chiusa sotto al test.
    const tab = tabRow.locator("[data-pane-id]").first();
    const tabH = (await tab.count()) > 0
      ? await tab.evaluate((e) => Math.round(e.getBoundingClientRect().height))
      : null;
    const attesa = tabH ?? 28;
    for (const h of boxes) {
      // Il nome del progetto è una card-tab, i comandi sono box quadrati della
      // stessa misura: una sola altezza per tutta la striscia.
      expect(h, `altezza di un elemento della striscia: ${boxes.join(", ")}`).toBe(attesa);
    }

    // 5. NIENTE NOME DEL PROGETTO, ed è voluto: c'è stato per un giro e Attilio
    //    l'ha tolto (09/08). La riga sopra porta già la tab del progetto col suo
    //    nome, e ripeterlo un rigo sotto sono due card con la stessa parola a
    //    40px di distanza. L'asserzione è negativa e resta: senza, il giorno che
    //    qualcuno lo rimette nessuno se ne accorge finché non lo vede.
    await expect(strip.getByTestId("project-rail-inline-name")).toHaveCount(0);

    // 6. La pastiglia git porta il numero delle modifiche.
    //    Il ramo arriva dallo store, quindi si aspetta invece di leggere subito:
    //    al primo montaggio l'etichetta e ancora quella senza ramo.
    const gitBtn = strip.getByRole("button", { name: /Modifiche git/ });
    await expect
      .poll(async () => (await gitBtn.getAttribute("aria-label")) ?? "", { timeout: 15000 })
      .toMatch(/Modifiche git · .+/);
    await expect(
      gitBtn.locator("span").first(),
      "con una modifica non committata la striscia mostra 1",
    ).toHaveText("1", { timeout: 15000 });

    // I numeri a referto: se questo test diventa rosso, dice di quanto.
    const stripBox = (await strip.boundingBox())!;
    console.log(
      `[striscia] x=${stripBox.x.toFixed(1)} w=${stripBox.width.toFixed(1)} ` +
        `altezze=[${boxes.join(",")}] ` +
        `btnCenterY=${btnCenter.toFixed(1)} tabCenterY=${tabCenter.toFixed(1)} ` +
        `Δcentro=${Math.abs(btnCenter - tabCenter).toFixed(2)}px`,
    );

    // Ritaglio sulla riga, dove si guarda.
    await page.screenshot({
      path: "test-results/project-sidebar-rail.png",
      clip: { x: tabBox.x, y: tabBox.y - 2, width: 460, height: 60 },
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

    // «File» chiusa deve leggersi come una riga, non come un titolo sospeso
    // sul vuoto. Il suo contenitore resta flex-1 anche da chiusa (spinge Git e
    // Processi in fondo), quindi il divisore da 1px finisce in fondo alla
    // colonna: senza un bordo proprio, sotto la riga non c'e nessuna linea.
    const filesRow = win.locator("div").filter({ hasText: /^File$/ }).last();
    await expect(filesRow).toBeVisible({ timeout: 10000 });
    await filesRow.click();
    await expect
      .poll(async () => filesRow.evaluate(el => parseFloat(getComputedStyle(el).borderBottomWidth) || 0), { timeout: 5000 })
      .toBeGreaterThan(0);

    // Aprire «Processi» deve mostrare qualcosa. L'altezza e in pixel e viene
    // salvata: strizzata all'altezza dell'intestazione, la sezione si apriva su
    // zero pixel di contenuto e il chevron ruotava a vuoto.
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

    // Il primo movimento deve superare la soglia anti-click (DRAG_SLOP_PX),
    // altrimenti non e un drag.
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 40, g.y + g.height / 2, { steps: 5 });
    await page.mouse.move(g.x + g.width / 2 + 90, g.y + g.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.round((await bar.boundingBox())!.width), { timeout: 5000 })
      .toBeGreaterThan(280);

    // La maniglia non si dipinge: il bordo della barra deve restare quello di
    // ogni altro bordo, e l'unico segnale che si puo trascinare e il cursore.
    // Senza questa riga la tinta al passaggio era tornata viva senza che
    // nessun test se ne accorgesse.
    await grip.hover();
    const dipinta = await grip.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(dipinta, "la maniglia resta trasparente anche al passaggio").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(await grip.evaluate(el => getComputedStyle(el).cursor)).toBe("col-resize");

    // Doppio click: torna alla misura di partenza.
    await grip.dblclick();
    await expect
      .poll(async () => Math.round((await bar.boundingBox())!.width), { timeout: 5000 })
      .toBe(224);
  });

  test("in modalità fluttuante la maniglia resta trasparente e i divisori veri no", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });
    await expect(win.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 10000 });

    // La classe si accende solo su desktop, quindi in E2E non comparirebbe mai
    // e questo caso resterebbe non coperto. Si aggiunge da fuori come fa la
    // scena "floating" della landing (client/src/demo/landing-cursor.js), che
    // e il motivo per cui App.tsx tiene quel className costante.
    const acceso = await page.evaluate(() => {
      const shell = document.querySelector(".flex.bg-app-bg.overflow-hidden");
      if (!shell) return false;
      shell.classList.add("floating-splits");
      return true;
    });
    expect(acceso, "il guscio dell'app si trova e accetta la classe").toBe(true);

    const dati = await win.evaluate(el => {
      const bar = el.querySelector('[data-testid="project-sidebar"]')!;
      const grip = el.querySelector('[data-testid="project-sidebar-resizer"]')!;
      // Un divisore vero della barra: 1px, con il suo `bg-app-border`.
      const linea = el.querySelector('.h-\\[1px\\].bg-app-border');
      return {
        grip: getComputedStyle(grip).backgroundColor,
        bordoBarra: getComputedStyle(bar).borderRightColor,
        linea: linea ? getComputedStyle(linea).backgroundColor : null,
        dentroCard: !!grip.closest("[data-split-card]"),
      };
    });

    // Il punto della regressione: una regola agganciata a `cursor-col-resize`
    // dipingeva gli 8px della maniglia in colore bordo, e a destra della barra
    // usciva una cucitura spessa dove ovunque c'e un capello.
    expect(dati.dentroCard, "la maniglia sta dentro una card, dove la regola arriva").toBe(true);
    expect(dati.grip, "la maniglia non si dipinge nemmeno da fluttuante").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // E la regola deve continuare a fare il suo mestiere: restituire la linea a
    // chi ce l'aveva. Cancellarla avrebbe passato l'asserzione qui sopra e
    // spento i divisori del progetto.
    expect(dati.linea, "il divisore da 1px tiene il colore di un bordo qualsiasi").toBe(dati.bordoBarra);
  });
});
