/**
 * Aprire e chiudere la sezione Files non ricomincia da capo.
 *
 * IL SINTOMO. «Quando faccio velocemente apri e chiudi mi esce un loader ogni
 * volta dei file ma non dovrebbe essere in cache?». Non c'era nessuna cache:
 * `ProjectSidebar` monta il FileExplorer dentro `{expandedSections.files && …}`,
 * quindi chiudere la sezione lo SMONTA — e con lui morivano l'albero, le
 * cartelle aperte e `initialLoadDone`, che era una `useRef`. Quel ref serviva a
 * non far lampeggiare l'albero sulle ricariche dal watcher e funzionava, ma ha
 * esattamente la vita del componente.
 *
 * E lo spinner era GARANTITO, non probabile: `loading` nasceva `true`, quindi
 * il primo render era già il ramo spinner — a piena altezza, al posto
 * dell'albero — prima ancora che partisse la fetch.
 *
 * Ora albero, cartelle aperte e sottoalberi comprati pigramente vivono in uno
 * store per `projectPath` (`hooks/useProjectFiles.ts`) che sopravvive al
 * pannello. `loading` significa «non ho dati», mai «sto chiedendo».
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { resetPaneStore } from "./helpers/api-fixtures";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("l'albero dei file sopravvive alla chiusura", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "fe-cache");
    ({ topicId, tmpDir, topicName } = project);
  });
  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  /**
   * L'intestazione della sezione Files.
   *
   * Un testid e non il testo: l'etichetta e' tradotta (la suite gira in it-IT,
   * quindi a schermo c'e' «File») e il testo cambia da sotto i piedi.
   */
  const intestazione = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="project-sidebar-files"]');

  test("riaprendo la sezione l'albero c'e SUBITO, senza spinner", async ({
    fileExplorerPage,
    page,
  }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const albero = page.locator('[data-testid="file-tree"]');
    await expect(albero).toBeVisible({ timeout: 15000 });
    // Un file seminato che deve esserci sia prima sia dopo.
    await expect(albero.getByText("newfile.txt")).toBeVisible({ timeout: 10000 });

    const header = intestazione(page);
    await expect(header).toBeVisible({ timeout: 5000 });

    // Chiudi. L'albero sparisce dal DOM: il componente si smonta davvero, ed e'
    // esattamente per questo che serviva uno store fuori da lui.
    await header.click();
    await expect(albero).toHaveCount(0, { timeout: 5000 });

    // Riapri. Qui stava il difetto: si vedeva «Loading files...» a piena
    // altezza. La rete si taglia PRIMA di riaprire, cosi' se lo store non
    // servisse i dati dalla memoria il pannello non avrebbe nessun modo di
    // mostrarli — il test non puo' passare per fortuna.
    await page.route("**/api/files?**", route => route.abort());
    await header.click();

    await expect(albero).toBeVisible({ timeout: 5000 });
    await expect(albero.getByText("newfile.txt")).toBeVisible({ timeout: 5000 });
    // E lo spinner non deve esserci mai stato: se i dati arrivano dallo store,
    // `loading` resta falso.
    await expect(page.getByText("Loading files...")).toHaveCount(0);

    await page.unroute("**/api/files?**");
  });

  test("apri e chiudi RAPIDAMENTE non lascia il pannello in errore", async ({
    fileExplorerPage,
    page,
  }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const albero = page.locator('[data-testid="file-tree"]');
    await expect(albero).toBeVisible({ timeout: 15000 });
    await expect(albero.getByText("newfile.txt")).toBeVisible({ timeout: 10000 });

    const header = intestazione(page);
    for (let i = 0; i < 6; i++) {
      await header.click();
      await header.click();
    }

    // Dopo la raffica l'albero e' li, coi suoi file. Prima ogni giro mandava
    // una richiesta nuova senza annullare la precedente, e bastava che UNA
    // cadesse — la finestra di riavvio del server dura 3-5s e capita spesso su
    // questa macchina — perche' il pannello diventasse un riquadro rosso che
    // sostituiva un albero corretto.
    await expect(albero).toBeVisible({ timeout: 10000 });
    await expect(albero.getByText("newfile.txt")).toBeVisible({ timeout: 10000 });
  });

  test("una richiesta caduta non cancella l'albero: lo dice e basta", async ({
    fileExplorerPage,
    page,
  }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const albero = page.locator('[data-testid="file-tree"]');
    await expect(albero).toBeVisible({ timeout: 15000 });
    await expect(albero.getByText("newfile.txt")).toBeVisible({ timeout: 10000 });

    // Il server sparisce, come durante un hot-reload.
    await page.route("**/api/files?**", route => route.abort());

    // Si forza una revalidazione chiudendo e riaprendo.
    const header = intestazione(page);
    await header.click();
    await header.click();

    // L'albero RESTA. Al piu' compare una banda che dice che l'ultimo
    // aggiornamento non e' passato — che e' un'informazione, non una perdita.
    await expect(albero).toBeVisible({ timeout: 10000 });
    await expect(albero.getByText("newfile.txt")).toBeVisible({ timeout: 10000 });

    await page.unroute("**/api/files?**");
  });
});
