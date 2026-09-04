/**
 * Il pannello delle modifiche git: il menu, la casella del messaggio, la riga.
 *
 * Tre comportamenti che a occhio sembravano dettagli e non lo erano.
 *
 * 1. IL MENU CONTESTUALE PERDEVA I SUOI BERSAGLI. Le voci leggevano
 *    `selectedFiles` al momento del click, e quella selezione si azzera da sola
 *    a ogni cambio della lista dei file modificati — e da quando il watcher dei
 *    FILE rinfresca lo stato git, la lista cambia anche solo perche' qualcun
 *    altro sta salvando nel repo. Il sintomo che si vedeva era gentile: il nome
 *    del file spariva dall'intestazione del menu. Quello che NON si vedeva e'
 *    che Stage/Unstage/Discard restavano cliccabili e agivano su una lista
 *    vuota.
 *
 * 2. IL MESSAGGIO DI COMMIT ERA UN <input>. Una riga sola: un commit con un
 *    corpo, o la risposta a punti elenco del generatore, arrivavano schiacciati
 *    su una riga da leggere con le frecce.
 *
 * 3. LE AZIONI RISERVAVANO SPAZIO VUOTO. Stavano in un blocco sempre presente
 *    e solo trasparente (`opacity-0`), accanto al conteggio delle righe: ogni
 *    riga della lista portava un buco per tutta la vita del pannello. Ora
 *    conteggio e azioni condividono una cella e si scambiano.
 *
 * @covers FILE-02
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { resetPaneStore } from "./helpers/api-fixtures";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * Apre la sezione Git, che nella barra laterale nasce chiusa.
 *
 * `aria-expanded` e non un click alla cieca: l'intestazione e' un toggle, e
 * cliccarla su una sezione gia' aperta la RICHIUDE.
 */
async function apriGit(page: import("@playwright/test").Page) {
  const gitChanges = page.locator('[data-testid="git-changes"]');
  await expect(gitChanges).toBeVisible({ timeout: 10000 });
  const header = gitChanges.locator('[data-testid="project-sidebar-git"]');
  await expect(header).toBeVisible({ timeout: 10000 });
  // Si clicca l'ETICHETTA, non il centro della riga: al centro c'e' il nome
  // del ramo, che e' un CONTROLLO — cliccarlo apre la tendina dei rami e la
  // sezione resta chiusa (misurato: `elementFromPoint` al centro restituisce
  // lo span del branch).
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await header.getByText("Git", { exact: true }).click();
  }
  return gitChanges;
}

test.describe("pannello delle modifiche git", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "git-ui");
    ({ topicId, tmpDir, topicName } = project);
  });
  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("il menu tiene il file su cui e stato aperto, anche se la lista cambia sotto", async ({
    fileExplorerPage,
    page,
    request,
  }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const gitChanges = await apriGit(page);

    const riga = gitChanges.locator('[data-git-file="src/index.ts"]');
    await expect(riga.first()).toBeVisible({ timeout: 10000 });

    await riga.first().click({ button: "right" });
    const menu = page.locator('[role="menu"]').filter({ hasText: "index.ts" });
    await expect(menu).toBeVisible({ timeout: 5000 });

    // Ora la lista dei file modificati cambia SOTTO il menu aperto: un file
    // nuovo nella cartella diventa una voce non tracciata in piu'. E' lo stesso
    // evento che produce un agente che salva, o l'utente in un altro editor.
    await request.post("/api/files/create", {
      data: { path: `${tmpDir}/scosso.txt`, type: "file" },
    });

    // Il menu deve continuare a dire su cosa agisce. Prima qui restava
    // l'intestazione vuota — e le voci sotto agivano sul nulla.
    await expect(menu).toContainText("index.ts");
    // The menu entry follows the language now, and the suite runs in Italian
    // (`playwright.config.ts` pins `locale: "it-IT"`): the English word here
    // was the defect, not the anchor.
    await expect(menu.getByText("Scarta", { exact: false })).toBeVisible();

    await page.keyboard.press("Escape");
  });

  test("la casella del messaggio cresce con le righe, invece di scorrerle", async ({
    fileExplorerPage,
    page,
  }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const gitChanges = await apriGit(page);

    const casella = gitChanges.locator('[data-testid="commit-message-input"]');
    await expect(casella).toBeVisible({ timeout: 10000 });

    // E' una textarea: un <input> non puo' andare a capo, ed era il punto.
    expect(await casella.evaluate(el => el.tagName)).toBe("TEXTAREA");

    // L'altezza di UNA riga si misura dopo un giro di ridimensionamento, non
    // sul montaggio: appena montata la casella ha ancora l'altezza intrinseca
    // di `rows`, che non e' il valore con cui la si confronta dopo.
    await casella.fill("una riga");
    const oneRow = (await casella.boundingBox())!.height;

    await casella.fill("primo\nsecondo\nterzo\nquarto");
    await expect
      .poll(async () => (await casella.boundingBox())!.height, { timeout: 3000 })
      .toBeGreaterThan(oneRow);

    // E torna indietro: senza l'azzeramento dell'altezza prima di rimisurare,
    // `scrollHeight` resta il massimo storico e la casella cresce e basta.
    await casella.fill("una riga");
    await expect
      .poll(async () => (await casella.boundingBox())!.height, { timeout: 3000 })
      .toBe(oneRow);
  });

  test("le azioni della riga stanno dove sta il conteggio, e a riposo non occupano niente", async ({
    fileExplorerPage,
    page,
  }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const gitChanges = await apriGit(page);

    const riga = gitChanges.locator('[data-git-file="src/index.ts"]').first();
    await expect(riga).toBeVisible({ timeout: 10000 });

    // A riposo: il conteggio si vede, le azioni no. `visibility: hidden` e non
    // `opacity: 0` — con l'opacita' Playwright le considerava VISIBILI, quindi
    // un test come questo sarebbe passato senza che l'utente vedesse niente.
    const stage = riga.locator('button[title="Stage"]');
    await expect(stage).toBeHidden();

    // Al passaggio del mouse si scambiano: le azioni compaiono e il conteggio
    // sparisce, nello stesso posto.
    await riga.hover();
    await expect(stage).toBeVisible();
    await expect(riga.locator('button[title="Discard changes"]')).toBeVisible();

    // Nessun salto: la cella e' una sola, i due contenuti sono impilati.
    const box = (await riga.boundingBox())!;
    await page.mouse.move(box.x - 20, box.y);
    await expect(stage).toBeHidden();
    const dopo = (await riga.boundingBox())!;
    expect(dopo.height).toBe(box.height);
  });
});
