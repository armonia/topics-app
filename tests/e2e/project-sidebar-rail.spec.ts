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
  * @covers PRAIL-01
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
    test.info().annotations.push({ type: "spec", description: "PRAIL-01" });
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
    const expandBtn = strip.getByTestId("project-card");
    await expect(expandBtn).toBeVisible();
    const btnBox = (await expandBtn.boundingBox())!;

    // 3. STESSA MEDIANA — ma della SCATOLA DEL CONTENUTO, non della riga.
    //
    //    Finché la riga era simmetrica le due coincidevano, e questo test
    //    confrontava il comando con il centro della barra. Da quando la riga
    //    subordinata porta l'incasso solo in coda (34 di scatola, 28 di
    //    contenuto, 6 sotto — vedi `sub-chrome-row.spec.ts`) le due mediane
    //    distano 3px, e il test è diventato rosso su una geometria CORRETTA.
    //    L'invariante vero è sempre stato «il comando sta in mezzo a ciò che la
    //    riga concede», non «in mezzo alla riga».
    const contenuto = await tabRow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const top = r.top + parseFloat(cs.paddingTop);
      const bottom = r.bottom - parseFloat(cs.paddingBottom);
      return { top, bottom, center: (top + bottom) / 2 };
    });
    const btnCenter = btnBox.y + btnBox.height / 2;
    expect(
      Math.abs(btnCenter - contenuto.center),
      `il comando (centro ${btnCenter}) deve stare sulla mediana del contenuto della riga (${contenuto.center})`,
    ).toBeLessThanOrEqual(1);

    // 4. E STESSA MISURA di una tab: in fila con loro, un comando più alto o
    //    più basso respira diverso dalla sua vicina — è il difetto tolto dal
    //    «+» il 09/08, che qui rientrerebbe dalla porta di servizio.
    const riga = win.getByTestId("project-rail-row");
    await expect(riga, "i tre comandi stanno in una riga SOTTO il titolo").toBeVisible({ timeout: 10000 });
    // SOTTO significa sotto: `toBeVisible()` non sa niente di occlusione, e la
    // riga nasceva nel flusso della cella a y=0 — cioè esattamente dietro
    // `.pane-chrome-bar`, che è `position:absolute; top:0`. Test verde, riga
    // invisibile («ancora uguale, non vedi i tasti sotto il trigger», Attilio
    // 09/08). Si misura il RAPPORTO fra le due scatole, non la visibilità.
    const barraBox = (await win.locator(".pane-chrome-bar").first().boundingBox())!;
    const rowBox = (await riga.boundingBox())!;
    expect(
      rowBox.y,
      `la riga deve cominciare sotto la barra (barra finisce a ${barraBox.y + barraBox.height}, riga comincia a ${rowBox.y})`,
    ).toBeGreaterThanOrEqual(barraBox.y + barraBox.height - 1);
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
      // La card del progetto è una tab, i comandi sono box quadrati della
      // stessa misura: una sola altezza per tutta la striscia.
      expect(h, `altezza di un elemento della striscia: ${boxes.join(", ")}`).toBe(attesa);
    }

    // 4-bis. E LA STESSA CARD ANCHE DA APERTA. «Tieni la stessa card per quando
    //    si apre» (Attilio, 09/08): erano due cose diverse — un bottone col solo
    //    glifo da chiusa, un `<span>` a 12px semibold più un bottone separato da
    //    aperta. Si riapre e si misura, invece di fidarsi del fatto che il
    //    componente sia lo stesso: quello che conta è che a schermo abbiano la
    //    stessa altezza e lo stesso corpo.
    const closedH = boxes[0];
    const closedFont = await strip.getByTestId("project-card")
      .evaluate((el) => getComputedStyle(el).font);
    await strip.getByTestId("project-card").click();
    const openCard = win.getByTestId("project-card");
    await expect(openCard).toBeVisible({ timeout: 5000 });
    const aperta = await openCard.evaluate((el) => ({
      h: Math.round(el.getBoundingClientRect().height),
      font: getComputedStyle(el).font,
      label: el.getAttribute("aria-label"),
    }));
    expect(aperta.h, "la card aperta è alta come quella chiusa").toBe(closedH);
    expect(aperta.font, "stesso corpo").toBe(closedFont);
    expect(aperta.label, "da aperta il gesto si inverte").toBe("Nascondi la barra");
    // E si richiude, o i controlli qui sotto misurerebbero l'altro stato.
    await openCard.click();
    await expect(strip).toBeVisible({ timeout: 5000 });

    // 5. IL NOME DEL PROGETTO STA DENTRO L'APERTORE, non accanto a lui.
    //    Tre forme in tre giri: nessun nome (tre icone identiche in ogni
    //    finestra), poi una card col nome ACCANTO al bottone quadrato — «togli
    //    il nome» —, e infine «metti il titolo del progetto nell'apertore»
    //    (Attilio, 09/08). L'asserzione tiene tutte e tre: UNA card, che porta
    //    il nome ED è il comando.
    await expect(strip.getByTestId("project-card")).toHaveText(PROJ.split("/").pop()!);
    expect(
      await strip.getByTestId("project-card").evaluate((el) => el.getAttribute("aria-label")),
      "la card È l'apertore: il suo nome accessibile è il gesto, non il titolo",
    ).toBe("Espandi la barra");
    await expect(strip.locator('[data-testid="project-rail-inline-name"]')).toHaveCount(0);

    // 6. La pastiglia git porta il numero delle modifiche.
    //    Il ramo arriva dallo store, quindi si aspetta invece di leggere subito:
    //    al primo montaggio l'etichetta e ancora quella senza ramo.
    const gitBtn = riga.getByRole("button", { name: /Modifiche git/ });
    await expect
      .poll(async () => (await gitBtn.getAttribute("aria-label")) ?? "", { timeout: 15000 })
      .toMatch(/Modifiche git · .+/);
    await expect(
      gitBtn.locator("span").first(),
      "con una modifica non committata la striscia mostra 1",
    ).toHaveText("1", { timeout: 15000 });

    // 6-bis. E LA PASTIGLIA STA TUTTA DENTRO LA RIGA.
    //
    //    Stava a `-top-1`, cioè un pixel sopra il bottone: dentro una riga da 40
    //    col bottone centrato ci stava, dentro la riga subordinata da 34 col
    //    contenuto a filo in cima cadeva a y=39 contro una scatola che comincia
    //    a 40 — e l'`overflow-hidden` della barra la tagliava a metà. «I
    //    contatori vengono tagliati dalla top bar» (Attilio, 09/08).
    //
    //    Si misura il CONTENIMENTO, non la posizione: sopra o sotto è una scelta
    //    che può cambiare, «dentro la riga» no.
    const pastiglia = await gitBtn.locator("span").first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const barra = el.closest('[data-testid="project-rail-row"]')!.getBoundingClientRect();
      return {
        sopra: Math.round((r.top - barra.top) * 10) / 10,
        sotto: Math.round((barra.bottom - r.bottom) * 10) / 10,
        anello: getComputedStyle(el).boxShadow,
      };
    });
    expect(pastiglia.sopra, "la pastiglia non sborda in cima").toBeGreaterThanOrEqual(0);
    expect(pastiglia.sotto, "e non sborda in fondo").toBeGreaterThanOrEqual(0);
    // Niente anello: era un cerchio chiaro che serviva a staccarla dal tratto
    // dell'icona quando le stava sopra. Sull'angolo basso non attraversa niente.
    expect(pastiglia.anello, "la pastiglia non porta un anello attorno").toBe("none");

    // I numeri a referto: se questo test diventa rosso, dice di quanto.
    const stripBox = (await strip.boundingBox())!;
    console.log(
      `[striscia] x=${stripBox.x.toFixed(1)} w=${stripBox.width.toFixed(1)} ` +
        `altezze=[${boxes.join(",")}] ` +
        `btnCenterY=${btnCenter.toFixed(1)} contenutoCenterY=${contenuto.center.toFixed(1)} ` +
        `Δcentro=${Math.abs(btnCenter - contenuto.center).toFixed(2)}px`,
    );

    // Ritaglio sulla riga, dove si guarda.
    await page.screenshot({
      path: "test-results/project-sidebar-rail.png",
      clip: { x: tabBox.x, y: tabBox.y - 2, width: 460, height: 60 },
    });
  });

  test("la riga «File» chiusa ha il suo bordo, e Processi si apre su qualcosa", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PRAIL-01" });
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // «File» chiusa deve leggersi come una riga, non come un titolo sospeso sul
    // vuoto. Ci arrivava con un `border-b` che compariva solo da chiusa; ora ci
    // arriva perche' E' UNA CARD — fondo suo, angoli, rientro — in tutti e due
    // gli stati. «Gli accordion della sidebar progetto diventano delle card,
    // come le tab» (Attilio, 09/08), e fra card impilate una linea ripete cio'
    // che fondo e distanza dicono gia'.
    const filesRow = win.locator('[data-testid="project-sidebar-files"]');
    await expect(filesRow).toBeVisible({ timeout: 10000 });
    await filesRow.click();
    const card = await filesRow.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        fondo: cs.backgroundColor,
        raggio: cs.borderRadius,
        rientro: parseFloat(cs.marginLeft),
        bordoSotto: parseFloat(cs.borderBottomWidth) || 0,
      };
    });
    expect(card.fondo, "da chiusa la riga ha un fondo suo").not.toMatch(/rgba\(0, 0, 0, 0\)/);
    expect(card.raggio, "ed e' arrotondata come una tab").not.toBe("0px");
    expect(card.rientro, "ed e' rientrata dai lati come ogni altra card").toBeGreaterThan(0);
    expect(card.bordoSotto, "e NON ha piu' una linea sotto").toBe(0);

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
    test.info().annotations.push({ type: "spec", description: "PRAIL-01" });
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
    test.info().annotations.push({ type: "spec", description: "PRAIL-01" });
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
      return {
        grip: getComputedStyle(grip).backgroundColor,
        // Il colore di un capello QUI, letto dal token invece che dal bordo
        // della colonna. Era `getComputedStyle(bar).borderRightColor`, e quel
        // bordo non esiste piu' — «lo vogliamo togliere proprio il bordo»
        // (Attilio, 09/08). La lettura pero' non falliva: senza `border-r`,
        // `borderRightColor` ricade su `currentColor`, cioe' sul colore del
        // TESTO, e l'asserzione qui sotto e' andata rossa parlando di colori
        // invece che di un elemento sparito. Il token e' la sorgente vera.
        capello: getComputedStyle(bar).getPropertyValue("--border").trim(),
        dentroCard: !!grip.closest("[data-split-card]"),
      };
    });

    // Il punto della regressione: una regola agganciata a `cursor-col-resize`
    // dipingeva gli 8px della maniglia in colore bordo, e a destra della barra
    // usciva una cucitura spessa dove ovunque c'e un capello.
    expect(dati.dentroCard, "la maniglia sta dentro una card, dove la regola arriva").toBe(true);
    expect(dati.grip, "la maniglia non si dipinge nemmeno da fluttuante").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // E la regola deve continuare a fare il suo mestiere: NON spegnere il colore
    // dei capelli dentro la colonna. Cancellarla avrebbe passato l'asserzione
    // qui sopra e portato via con se' anche i bordi veri.
    expect(dati.capello, "dentro la colonna `--border` resta un colore vero").toMatch(/hsl|rgb|#/);
  });
});
