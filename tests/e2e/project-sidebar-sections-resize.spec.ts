/**
 * I divisori fra le sezioni della sidebar di progetto, misurati mentre si
 * trascinano.
 *
 * «Se provo a ridimensionare i processi verso l'alto non si ridimensiona, anzi
 * si sposta git» (Attilio, 09/08). Ed è esattamente quello che faceva: il
 * divisore fra Git e Processi passava a `startBottomResize('git','processes')`,
 * cioè dichiarava GIT come la sezione che cresce tirando in su. Ma Git sta
 * SOPRA quel divisore. La colonna è ancorata in fondo — Files prende lo spazio
 * che avanza, Git e Processi hanno un'altezza in pixel — quindi alzare il
 * divisore deve far crescere ciò che gli sta SOTTO. Con i due invertiti si
 * otteneva il contrario esatto: Processi si stringeva e Git si allargava verso
 * il basso, e il divisore scendeva mentre il puntatore saliva.
 *
 * Non c'era un solo test su questo trascinamento: nessuno dei due sensi era
 * ancorato, quindi l'inversione poteva vivere tranquilla.
 *
 * Le tre invarianti che valgono per QUALSIASI divisore fra pannelli:
 *  1. il divisore segue il puntatore (RESIZE-1, RESIZE-3);
 *  2. la coppia è CONSERVATA — quello che perde uno lo prende l'altro, quindi
 *     ciò che sta sopra la coppia (Files) non si muove di un pixel (RESIZE-2);
 *  3. arrivati al minimo ci si ferma, non si sfonda spingendo fuori il vicino
 *     (RESIZE-4).
  * @covers PRESIZE-01
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

const PROJ = `/tmp/e2e-sezioni-${Date.now()}`;

/** Il minimo utile di ogni sezione, da `ProjectSidebar` — qui serve a sapere
 *  quanto si PUÒ tirare prima che il fermo entri in gioco. */
const MIN = { git: 160, processes: 96 } as const;

async function riquadro(loc: Locator, chi: string) {
  const b = await loc.boundingBox();
  if (!b) throw new Error(`${chi}: nessun riquadro (elemento non visibile?)`);
  return b;
}

/** Apre una sezione solo se è chiusa: `aria-expanded` è l'unica fonte, non
 *  «l'ho appena cliccata».
 *
 *  E si clicca a SINISTRA, sull'etichetta, non al centro: al centro della riga
 *  di Git c'è il bottone del ramo, che apre il suo menu e ferma la
 *  propagazione. Cliccare il centro apriva la sezione solo quando `git:status`
 *  era ancora in volo — con il gruppo destro vuoto il click passava, con il
 *  ramo già scritto no. Un bersaglio che dipende dalla velocità del server. */
async function garantisciAperta(header: Locator, chi: string) {
  await expect(header, `intestazione ${chi}`).toBeVisible({ timeout: 10000 });
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await header.click({ position: { x: 24, y: 14 } });
  }
  await expect(header, `${chi} deve risultare aperta`).toHaveAttribute("aria-expanded", "true", { timeout: 5000 });
}

/** Trascina un divisore in verticale. Il codice ignora i primi `DRAG_SLOP_PX`
 *  (4) e poi applica il delta pieno, quindi si passa dalla soglia con un
 *  movimento solo e si misura ciò che ne esce. */
async function trascina(page: Page, handle: Locator, dy: number) {
  const h = await riquadro(handle, "divisore");
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 6 });
  await page.mouse.up();
  // Il velo di trascinamento si smonta su mouseup; un frame per il re-render.
  await page.waitForTimeout(120);
}

test.describe("sidebar progetto: i divisori fra le sezioni", () => {
  test.beforeAll(() => {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(`${PROJ}/README.md`, "uno\n");
    initGitRepo(PROJ, "primo");
    writeFileSync(`${PROJ}/README.md`, "uno\ndue\n");
    // ABBASTANZA MODIFICHE DA AVERE SLACK, e la premessa e' cambiata sotto
    // questi test il 10/08: le sezioni aperte non partono piu' da un'altezza
    // FISSA (Git 200, Processi 150) ma dal loro CONTENUTO, fra il minimo utile
    // e 1/N della colonna. Con un solo file modificato Git nasce ESATTAMENTE al
    // suo minimo (160) e quindi non ha un pixel da cedere: il divisore Git↔
    // Processi diventa inerte, ed e' il comportamento giusto — non si stringe
    // sotto la misura in cui un pannello smette di contenere se stesso.
    //
    // Questi test misurano il VERSO del trascinamento e la conservazione della
    // coppia, non l'altezza di partenza: perche' restino veri serve uno stato in
    // cui c'e' qualcosa da spostare. Dieci file modificati lo danno.
    for (let i = 0; i < 10; i++) writeFileSync(`${PROJ}/f${i}.txt`, `riga ${i}\n`);
  });
  test.afterAll(() => {
    rmSync(PROJ, { recursive: true, force: true });
  });

  /** Apre la finestra di progetto con Git e Processi ESPANSE: nascono chiuse
   *  (`{files:true, git:false, processes:false}`) e il divisore fra le due
   *  esiste solo quando lo sono entrambe. */
  async function apri(page: Page, request: Parameters<typeof resetPaneStore>[0]) {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    // Apertura e altezze delle sezioni si salvano PER PROGETTO, e il progetto
    // qui è uno solo: senza questa pulizia il secondo test parte dalle misure
    // lasciate dal primo, e «tirane 40 in giù» può trovarsi già a fondo corsa.
    await page.addInitScript(() => {
      try {
        for (const k of Object.keys(sessionStorage)) {
          if (k.startsWith("sidebar-sections") || k.startsWith("project-sidebar-")) sessionStorage.removeItem(k);
        }
      } catch { /* contesto senza storage: pazienza */ }
    });

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // Le intestazioni sono TOGGLE, e l'apertura delle sezioni sopravvive fra un
    // test e l'altro (è per progetto, e il progetto qui è sempre lo stesso):
    // cliccarle alla cieca chiude quello che il test precedente ha lasciato
    // aperto. Misurato: 1 verde, 2 ballerino, 3 e 4 rossi — parità alternata,
    // la firma di un toggle premuto a comando invece che a bisogno.
    await garantisciAperta(win.getByTestId("project-sidebar-git"), "git");
    await garantisciAperta(win.getByTestId("project-sidebar-processes"), "processi");

    const divisore = win.getByTestId("project-sidebar-split-git-processes");
    await expect(divisore).toHaveAttribute("data-resize-active", "true", { timeout: 5000 });

    // IL CONTENUTO DEVE ESSERE ARRIVATO PRIMA DI MISURARE, ed e' una premessa
    // nata il 10/08: da quando l'altezza di una sezione aperta la decide il suo
    // CONTENUTO, misurare mentre `git:status` e' ancora in volo vuol dire
    // leggere un'altezza che sta per cambiare da sola — e il trascinamento
    // parte da un numero che un istante dopo non e' piu' vero. Si aspettano le
    // righe dei file, poi che il rettangolo si fermi.
    await expect(win.locator("[data-git-file]").first()).toBeVisible({ timeout: 15000 });
    const boxGitPerFermarsi = win.getByTestId("project-sidebar-git").locator("xpath=..");
    await expect
      .poll(async () => Math.round((await boxGitPerFermarsi.boundingBox())?.height ?? 0), { timeout: 10000 })
      .toBeGreaterThan(MIN.git);
    await page.waitForTimeout(250);

    return {
      win,
      divisore,
      git: win.getByTestId("project-sidebar-git"),
      processi: win.getByTestId("project-sidebar-processes"),
      // I contenitori con l'altezza in pixel: è QUELLA che il trascinamento
      // muove. Le intestazioni sono card di altezza fissa dentro di essi.
      boxGit: win.getByTestId("git-changes").locator("xpath=.."),
      boxProcessi: win.getByTestId("project-sidebar-processes").locator("xpath=.."),
      files: win.getByTestId("project-sidebar-files"),
      boxFiles: win.getByTestId("project-sidebar-files").locator("xpath=.."),
      divisoreFiles: win.getByTestId("project-sidebar-split-files"),
    };
  }

  test("RESIZE-1: tirando in ALTO il divisore, cresce ciò che gli sta SOTTO (Processi)", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PRESIZE-01" });
    const { divisore, boxGit, boxProcessi } = await apri(page, request);

    const primaGit = await riquadro(boxGit, "git");
    const primaProc = await riquadro(boxProcessi, "processi");
    const primaDiv = await riquadro(divisore, "divisore");

    const DY = -40;
    await trascina(page, divisore, DY);

    const afterGit = await riquadro(boxGit, "git");
    const afterProc = await riquadro(boxProcessi, "processi");
    const afterDiv = await riquadro(divisore, "divisore");

    // Il divisore SEGUE il puntatore. È la formulazione che coglie
    // l'inversione a prescindere dai fermi: col segno rovesciato scendeva
    // esattamente di quanto il puntatore saliva.
    expect(
      afterDiv.y - primaDiv.y,
      `il divisore deve salire con il puntatore (prima ${primaDiv.y}, dopo ${afterDiv.y})`,
    ).toBeLessThan(0);

    // Processi (SOTTO) cresce, Git (SOPRA) si stringe.
    expect(
      Math.round(afterProc.height - primaProc.height),
      `Processi deve crescere di ~${-DY} (prima ${primaProc.height}, dopo ${afterProc.height})`,
    ).toBeGreaterThan(20);
    expect(
      Math.round(afterGit.height - primaGit.height),
      `Git deve stringersi (prima ${primaGit.height}, dopo ${afterGit.height})`,
    ).toBeLessThan(0);
  });

  test("RESIZE-2: la coppia è CONSERVATA — il tetto di Git non si muove", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PRESIZE-01" });
    const { divisore, boxGit, boxProcessi } = await apri(page, request);

    const primaGit = await riquadro(boxGit, "git");
    const primaProc = await riquadro(boxProcessi, "processi");
    const sommaPrima = primaGit.height + primaProc.height;

    await trascina(page, divisore, -40);

    const afterGit = await riquadro(boxGit, "git");
    const afterProc = await riquadro(boxProcessi, "processi");

    // Quello che perde uno lo prende l'altro: la somma resta, e quindi il
    // tetto della coppia — cioè il bordo alto di Git, cioè il fondo di Files —
    // non si sposta. È qui che si vedeva «si sposta git».
    expect(
      Math.abs(afterGit.height + afterProc.height - sommaPrima),
      `la somma delle due deve restare ${sommaPrima} (ora ${afterGit.height + afterProc.height})`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(afterGit.y - primaGit.y),
      `il tetto di Git non deve muoversi (prima ${primaGit.y}, dopo ${afterGit.y})`,
    ).toBeLessThanOrEqual(2);
  });

  test("RESIZE-3: e tirando in BASSO succede l'opposto, senza deriva", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PRESIZE-01" });
    const { divisore, boxGit, boxProcessi } = await apri(page, request);

    const primaGit = await riquadro(boxGit, "git");
    const primaProc = await riquadro(boxProcessi, "processi");

    // Processi parte da 150 e il suo minimo è 96: 40 in giù ci stanno.
    await trascina(page, divisore, 40);

    const afterGit = await riquadro(boxGit, "git");
    const afterProc = await riquadro(boxProcessi, "processi");

    expect(
      Math.round(afterProc.height - primaProc.height),
      `Processi deve stringersi (prima ${primaProc.height}, dopo ${afterProc.height})`,
    ).toBeLessThan(0);
    expect(
      Math.round(afterGit.height - primaGit.height),
      `Git deve crescere (prima ${primaGit.height}, dopo ${afterGit.height})`,
    ).toBeGreaterThan(20);
  });

  test("RESIZE-4: al minimo ci si FERMA — nessuno spinge fuori il vicino", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PRESIZE-01" });
    const { divisore, boxGit, boxProcessi } = await apri(page, request);

    const primaGit = await riquadro(boxGit, "git");
    const primaProc = await riquadro(boxProcessi, "processi");
    const sommaPrima = primaGit.height + primaProc.height;

    // Una tirata assurda verso l'alto: Git (minimo 160, parte da 200) può
    // cedere 40 e non un pixel di più.
    await trascina(page, divisore, -400);

    const afterGit = await riquadro(boxGit, "git");
    const afterProc = await riquadro(boxProcessi, "processi");

    expect(
      Math.round(afterGit.height),
      `Git non deve scendere sotto il suo minimo (${MIN.git})`,
    ).toBeGreaterThanOrEqual(MIN.git - 2);
    // E il fermo non deve diventare uno scivolo per l'altro: senza la stretta
    // sul delta, Processi continuerebbe a crescere mentre Git è già fermo, e
    // la coppia sfonderebbe la colonna spingendo Files fuori.
    expect(
      Math.abs(afterGit.height + afterProc.height - sommaPrima),
      `la somma deve restare ${sommaPrima} anche a fondo corsa (ora ${afterGit.height + afterProc.height})`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(afterGit.y - primaGit.y),
      `il tetto di Git non deve muoversi nemmeno a fondo corsa (prima ${primaGit.y}, dopo ${afterGit.y})`,
    ).toBeLessThanOrEqual(2);
  });

  test("RESIZE-5: contro Files il fermo è Files stessa — non si può cancellarla tirando", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PRESIZE-01" });
    const { divisoreFiles, files, boxFiles } = await apri(page, request);
    await expect(divisoreFiles).toHaveAttribute("data-resize-active", "true");

    const testa = await riquadro(files, "intestazione files");

    // Una tirata assurda verso l'alto sul divisore che separa Files dal blocco
    // in fondo. Files non ha un'altezza in stato — assorbe con `flex-1` — e
    // senza un tetto la sezione di sotto cresceva all'infinito: l'albero
    // spariva e poi spariva anche la card, spinta fuori dalla colonna.
    await trascina(page, divisoreFiles, -1000);

    const dopoTesta = await riquadro(files, "intestazione files");
    const afterBox = await riquadro(boxFiles, "scatola files");

    // La card di Files resta INTERA e nella colonna.
    expect(
      Math.round(dopoTesta.height),
      `l'intestazione di Files non deve stringersi (prima ${testa.height}, dopo ${dopoTesta.height})`,
    ).toBe(Math.round(testa.height));
    // E sotto di lei resta una riga d'albero: è il pavimento, come il minimo
    // utile di Git e Processi.
    expect(
      Math.round(afterBox.height - dopoTesta.height),
      `sotto l'intestazione deve restare almeno una riga (scatola ${afterBox.height}, testa ${dopoTesta.height})`,
    ).toBeGreaterThanOrEqual(20);
  });
});
