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
 *
 * @covers FILE-01
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

  /**
   * Processes open, so Files is not the last open island: closing that one
   * closes the whole column (26/11), and these tests close and reopen Files
   * inside an open column.
   */
  const apriProcessi = async (page: import("@playwright/test").Page) => {
    const processi = page.locator('[data-testid="project-sidebar-processes"]');
    await expect(processi).toBeVisible({ timeout: 10000 });
    if ((await processi.getAttribute("aria-expanded")) !== "true") await processi.click();
    await expect(processi).toHaveAttribute("aria-expanded", "true");
  };

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
    await apriProcessi(page);

    // Closed, the tree is out of sight. It is no longer unmounted (the section
    // is kept hidden, see project-sidebar-kept-sections.spec.ts), but the store
    // outside the component is still what serves a project that opens a section
    // for the first time, so the network cut below keeps the test honest.
    await header.click();
    await expect(albero).toBeHidden({ timeout: 5000 });

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
    await apriProcessi(page);
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

/**
 * Il bordo sotto l'intestazione File non lampeggia chiudendo la sezione.
 *
 * Chiudendo, la riga guadagna `border-b` — e con essa guadagnava anche il
 * COLORE, perche' la classe era `border-b border-app-border` dentro il ramo.
 * `transition-colors` anima `border-color` ma non la larghezza: il bordo
 * compariva istantaneo a 1px e poi il colore ci metteva 150ms ad arrivare a
 * destinazione, partendo da `currentColor` — il preflight di Tailwind v4 mette
 * `border: 0 solid` SENZA colore. Qui `currentColor` e' `--text-secondary`
 * (#5a5a5a) contro un `--border` di #e8e8e8: una linea quasi nera che
 * sbiadiva. Cioe' il lampo.
 *
 * La prova non e' un video: e' che il colore del bordo sia LO STESSO nei due
 * stati. Se non cambia, non c'e' niente da animare.
 */
test.describe("il bordo dell'accordion File non lampeggia", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "fe-bordo");
    ({ topicId, tmpDir, topicName } = project);
  });
  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("l'intestazione è una CARD, e la sua superficie non cambia aprendo e chiudendo", async ({
    fileExplorerPage,
    page,
  }) => {
    // ERA «il colore del bordo non cambia fra aperta e chiusa: solo la
    // larghezza», e guardava un `border-b` che compariva solo da chiusa. Quel
    // bordo non c'è più: «facciamo diventare gli accordion della sidebar
    // progetto delle card, come le tab» (Attilio, 09/08), e fra card impilate
    // questo repo vieta le linee — il fondo e la distanza dicono già dov'è il
    // confine.
    //
    // Il difetto che quel test sorvegliava però esiste ancora, ed è più
    // generale di un bordo: `transition-colors` anima QUALUNQUE colore che
    // cambia fra i due stati, e il preflight di Tailwind v4 (`border: 0 solid`,
    // senza colore) fa ricadere un bordo senza tinta su `currentColor`, cioè sul
    // colore del TESTO. Quindi qui si misura la stessa cosa su ciò che è rimasto:
    // la superficie della card non deve cambiare aprendo e chiudendo, e nessun
    // capello deve prendere il colore del testo.
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const header = page.locator('[data-testid="project-sidebar-files"]');
    await expect(header).toBeVisible({ timeout: 15000 });
    await apriProcessi(page);
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();

    // The section is an island (25/11): the card is the box around the header,
    // which keeps its ground, corners and inset; the header is a row inside it.
    const stile = () => header.evaluate((el: HTMLElement) => {
      const cs = getComputedStyle(el);
      const island = getComputedStyle(el.parentElement!);
      return {
        fondo: island.backgroundColor,
        raggio: island.borderRadius,
        rientro: island.marginLeft,
        fondoRiga: cs.backgroundColor,
        testo: cs.color,
        bordi: [cs.borderTopWidth, cs.borderBottomWidth, cs.borderLeftWidth, cs.borderRightWidth],
        coloriBordo: [cs.borderTopColor, cs.borderBottomColor],
      };
    });

    /**
     * LO STILE A RIPOSO: puntatore FUORI dalla card, transizione finita.
     *
     * Il fondo di una card di sezione cambia SOTTO IL PUNTATORE
     * (`hover:bg-black/[0.08]` dentro `RESTING_SURFACE`) e ci arriva in 150ms
     * (`transition-colors`). Un `click()` lascia il mouse proprio li' sopra,
     * quindi leggere subito dopo misura DOVE STA IL MOUSE e a che punto e'
     * l'animazione, non lo stato della sezione.
     *
     * Misurato il 18/08/2026: appena dopo il click il fondo legge ancora 0.05
     * (transizione in volo) e 400ms dopo legge 0.08 (hover arrivato). Su una
     * macchina scarica la lettura arrivava prima -> verde; con quattro shard
     * addosso arrivava dopo -> rosso, sempre su questa riga. Non era il codice:
     * era la misura.
     *
     * Quindi ogni lettura si prende parcheggiando il puntatore e aspettando che
     * il colore SMETTA di muoversi. Aspetta la stabilita', non un valore atteso:
     * se la superficie cambiasse davvero fra i due stati, questo la leggerebbe
     * comunque diversa e la riga sotto sarebbe rossa.
     */
    const styleAtRest = async () => {
      await page.mouse.move(5, 5);
      await expect
        .poll(() => header.evaluate((el: HTMLElement) => el.matches(":hover")), {
          timeout: 3000,
          message: "il puntatore e' rimasto sulla card: la misura direbbe dov'e' il mouse",
        })
        .toBe(false);
      let precedente = "";
      await expect
        .poll(
          async () => {
            const ora = await header.evaluate(
              (el: HTMLElement) => getComputedStyle(el).backgroundColor,
            );
            const fermo = ora === precedente;
            precedente = ora;
            return fermo;
          },
          { timeout: 3000, message: "il fondo continua a cambiare: transizione mai finita" },
        )
        .toBe(true);
      return await stile();
    };

    const aperta = await styleAtRest();
    // A card: its own ground, rounded corners, and an inset from the sides.
    expect(aperta.raggio, "l'intestazione è arrotondata come una tab").not.toBe("0px");
    expect(aperta.fondo, "l'intestazione ha un fondo suo").not.toMatch(/rgba\(0, 0, 0, 0\)/);
    expect(parseFloat(aperta.rientro), "ed è rientrata dai lati").toBeGreaterThan(0);

    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    const chiusa = await styleAtRest();

    // No border appears on closing: if someone put a conditional line back,
    // this catches it. The ground does change, and on purpose (25/11: no
    // background unless active in some way, as the tabs): open, the island is
    // a card; closed, it is only its header, a row with no ground of its own.
    expect(chiusa.bordi, "nessun bordo compare chiudendo").toEqual(aperta.bordi);
    expect(chiusa.fondo, "a closed island has no ground").toBe("rgba(0, 0, 0, 0)");
    expect(chiusa.fondoRiga, "header row at rest keeps the same surface").toBe(aperta.fondoRiga);
    // E nessun capello prende il colore del testo — il valore di partenza
    // sbagliato del preflight, che è il difetto vero dietro il vecchio test.
    for (const c of [...aperta.coloriBordo, ...chiusa.coloriBordo]) {
      if (parseFloat(chiusa.bordi[0]) > 0 || parseFloat(chiusa.bordi[1]) > 0) {
        expect(c, "un bordo non può avere il colore del testo").not.toBe(chiusa.testo);
      }
    }
  });
});
