/**
 * board-project-selector.spec.ts — il selettore di progetto della board, UNO.
 *
 * Tre superfici lo usano (chip del composer task, «Sposta su…» del drawer,
 * filtro «Progetto» della kanban) e prima di questo giro divergevano:
 *  - PROJSEL-01 il chip del composer mostra l'ICONA del progetto scelto. Prima
 *    l'indice — l'unico posto da cui esce il `path`, e senza `path` non c'è
 *    icona — si caricava solo al focus o all'apertura del menu, quindi con una
 *    bozza ripristinata (che espande il composer SENZA focus) il chip restava
 *    col pallino di ripiego per sempre.
 *  - PROJSEL-02 aprire quel picker e scrivere nella ricerca non deve UCCIDERE
 *    il composer: il menu è portalato su <body>, la board lo scambiava per
 *    «l'utente sta scrivendo altrove» e smontava l'ospite React del menu.
 *  - PROJSEL-03 il filtro progetto della kanban è LO STESSO corpo: ricerca,
 *    icone, multi-selezione che NON chiude il menu a ogni clic.
 *  - PROJSEL-04 a 390px il bottone Invia resta dentro il composer invece di
 *    finire oltre il bordo di un `overflow-hidden`.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();
/** Due progetti VERI su disco: solo il primo ha una favicon. */
const PROJ_A = `/tmp/e2e-projsel-alpha-${STAMP}`;
const PROJ_B = `/tmp/e2e-projsel-beta-${STAMP}`;

/** BYTE-IDENTICAL a server/services/tasks.ts:projectIdForPath. */
function boardIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, "").split("/");
  const dirName = parts[parts.length - 1] || "project";
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
}
const ID_A = boardIdForPath(PROJ_A);
const ID_B = boardIdForPath(PROJ_B);

const topicIds: string[] = [];
const createdTasks: string[] = [];
/** Nome del progetto creato dalla UI in PROJSEL-05, da ripulire alla fine. */
let createdViaUi: string | null = null;

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  projectId: string,
  text: string,
): Promise<void> {
  const res = await request.post(`${BASE}/api/boards/${projectId}/tasks`, {
    data: { text, status: "todo" },
  });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${projectId}:${task.id}`);
}

/** Apre la Board generale dal «+» della barra standalone. */
async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

/**
 * Espande il composer prima di toccarne i controlli. Da chiuso la riga dei chip
 * è `max-h-0 opacity-0`: i bottoni ESISTONO e Playwright li considera visibili
 * (bounding box non nullo), ma sono alti zero e il click lo prende chi sta
 * sotto. Il fuoco sulla textarea è il gesto vero dell'utente.
 */
async function expandComposer(page: Page) {
  const composer = page.getByTestId("board-task-composer");
  await expect(composer).toBeVisible({ timeout: 10000 });
  await composer.locator("textarea").click();
  const chip = page.getByTestId("composer-project-chip");
  await expect.poll(async () => (await chip.boundingBox())?.height ?? 0, { timeout: 5000 }).toBeGreaterThan(10);
  return composer;
}

test.describe("Selettore progetto della board", () => {
  test.beforeAll(async ({ request }) => {
    for (const dir of [PROJ_A, PROJ_B]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/CLAUDE.md`, `# ${dir.split("/").pop()}\n`);
    }
    // Solo alpha ha un'icona: il caso «con icona» e quello «senza» stanno nella
    // stessa lista, così si vede che il ripiego è NIENTE e non un glifo finto.
    writeFileSync(
      `${PROJ_A}/favicon.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#22c55e"/></svg>\n',
    );
    // Un topic per progetto: è così che il server viene a conoscenza della dir
    // (l'indice `/api/all-boards/projects` e l'allowlist delle icone partono da lì).
    for (const [name, projectPath] of [["projsel-alpha", PROJ_A], ["projsel-beta", PROJ_B]] as const) {
      const t = await createTopic(request, `${name}-${STAMP}`, { projectPath });
      topicIds.push(t.id);
    }
    await apiCreateTask(request, ID_A, `Alpha task ${STAMP}`);
    await apiCreateTask(request, ID_B, `Beta task ${STAMP}`);
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [projectId, id] = key.split(":");
      await deleteTask(request, projectId!, id!).catch(() => {});
    }
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    for (const dir of [PROJ_A, PROJ_B]) rmSync(dir, { recursive: true, force: true });
    // Il progetto creato DALLA UI vive nel workspace del server di test: si
    // ritrova per nome nell'indice e si cancella dal suo `path`.
    if (createdViaUi) {
      const idx = (await (await request.get(`${BASE}/api/all-boards/projects`)).json()) as {
        projects: Array<{ name: string; path: string }>;
      };
      const made = idx.projects.find((p) => p.name === createdViaUi);
      if (made) rmSync(made.path, { recursive: true, force: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    // Il composer ricorda l'ultimo progetto scelto: si parte sempre da «auto».
    // UNA volta per tab, non a ogni navigazione: `addInitScript` gira anche
    // sul reload, e ripulire lì cancellerebbe proprio la scelta che il test sta
    // per verificare che sopravvive.
    await page.addInitScript(() => {
      try {
        if (sessionStorage.getItem("e2e-projsel-clean")) return;
        sessionStorage.setItem("e2e-projsel-clean", "1");
        localStorage.removeItem("board:composerProject");
        localStorage.removeItem("board:filters-all");
      } catch { /* private mode */ }
    });
  });

  test("PROJSEL-01: il chip del composer mostra nome e ICONA del progetto scelto", async ({ page }) => {
    // L'indice deve esistere lato server, altrimenti il test proverebbe solo
    // che una lista vuota resta vuota.
    const index = (await (await page.request.get(`${BASE}/api/all-boards/projects`)).json()) as {
      projects: Array<{ projectId: string; name: string; path: string }>;
    };
    expect(index.projects.map((p) => p.projectId)).toContain(ID_A);

    await page.goto("/");
    await openGlobalBoard(page);

    await expandComposer(page);
    const chip = page.getByTestId("composer-project-chip");
    await expect(chip).toContainText("Progetto auto");

    await chip.click();
    // `[role=listbox]` e non `[data-popover]`: il marchio è nuovo, e un rosso
    // «attributo assente» non direbbe niente sul comportamento.
    const menu = page.locator('[role="listbox"]').filter({ hasText: "Progetto del task" });
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: new RegExp(`^${PROJ_A.split("/").pop()}`) }).click();

    // Nome reale dall'indice (non l'id con l'hash sbucciato) …
    await expect(chip).toContainText(PROJ_A.split("/").pop()!);
    // … e l'icona VERA, decodificata: è la riga che prima mancava.
    const img = chip.locator("img");
    await expect(img).toBeVisible({ timeout: 10000 });
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    // IL caso che il bug rendeva impossibile: una BOZZA ripristinata espande il
    // composer da sola, senza che nessuno abbia mai messo il fuoco dentro. Con
    // l'indice caricato pigramente «al focus» il chip restava col pallino di
    // ripiego per sempre. Qui non si tocca niente: si guarda e basta.
    await page.request.put(`${BASE}/api/ui-state/board-composer-draft`, {
      data: { text: `Bozza ${STAMP}`, model: null, prio: null, planFirst: false },
    });
    // Scheda NUOVA, non un reload: il ripristino del caret rifocalizza il
    // composer solo se ERA quello attivo, e quel flag sta in sessionStorage —
    // che una scheda nuova non eredita. Così il composer si espande per la
    // bozza e NESSUNO gli dà il fuoco, che è il caso reale del bug.
    const fresh = await page.context().newPage();
    await fresh.goto("/");
    await expect(fresh.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    const chip2 = fresh.getByTestId("composer-project-chip");
    await expect(fresh.getByTestId("board-task-composer").locator("textarea")).toHaveValue(`Bozza ${STAMP}`, { timeout: 10000 });
    await expect(chip2).toContainText(PROJ_A.split("/").pop()!);
    await expect(chip2.locator("img")).toBeVisible({ timeout: 10000 });
    await fresh.close();
    await page.request.delete(`${BASE}/api/ui-state/board-composer-draft`).catch(() => {});
  });

  test("PROJSEL-02: cercare nel picker NON smonta il composer", async ({ page }) => {
    await page.goto("/");
    await openGlobalBoard(page);

    const composer = await expandComposer(page);
    await page.getByTestId("composer-project-chip").click();
    // `[role=listbox]` e non `[data-popover]`: il marchio è nuovo, e un rosso
    // «attributo assente» non direbbe niente sul comportamento.
    const menu = page.locator('[role="listbox"]').filter({ hasText: "Progetto del task" });
    const search = menu.getByPlaceholder("Cerca o crea…");
    await expect(search).toBeVisible();

    await search.fill("alpha");
    // Il composer è l'OSPITE React del menu: se sparisce lui, sparisce il menu.
    await expect(composer).toBeVisible();
    await expect(search).toBeVisible();
    await expect(search).toHaveValue("alpha");
    await expect(menu.getByRole("option", { name: new RegExp(PROJ_A.split("/").pop()!) })).toBeVisible();
    await expect(menu.getByRole("option", { name: new RegExp(PROJ_B.split("/").pop()!) })).toHaveCount(0);
  });

  test("PROJSEL-03: il filtro progetto della kanban è lo STESSO picker (ricerca + icone + multi)", async ({ page }) => {
    await page.goto("/");
    await openGlobalBoard(page);
    const board = page.getByTestId("kanban-board");
    await expect(board.getByText(`Alpha task ${STAMP}`)).toBeVisible({ timeout: 15000 });
    await expect(board.getByText(`Beta task ${STAMP}`)).toBeVisible();

    await page.getByTitle(/^Filtr(a|o) (per )?progetto/).click();
    const menu = page.locator('[role="listbox"]').filter({ hasText: /Progetto/ });
    await expect(menu).toBeVisible();
    // Il segno che è LO STESSO corpo del composer: la ricerca c'è.
    await expect(menu.getByPlaceholder("Cerca…")).toBeVisible();
    // Da un FILTRO non si crea un progetto: nessuna riga «Crea…».
    await expect(menu.getByText(/^Crea /)).toHaveCount(0);

    const alpha = menu.getByRole("option", { name: new RegExp(PROJ_A.split("/").pop()!) });
    await alpha.click();
    // Multi-selezione: il menu RESTA aperto e la riga risulta selezionata.
    await expect(menu).toBeVisible();
    await expect(alpha).toHaveAttribute("aria-selected", "true");
    // Il filtro filtra davvero.
    await expect(board.getByText(`Beta task ${STAMP}`)).toHaveCount(0);
    await expect(board.getByText(`Alpha task ${STAMP}`)).toBeVisible();

    // Seconda scelta → unione, non sostituzione.
    const beta = menu.getByRole("option", { name: new RegExp(PROJ_B.split("/").pop()!) });
    await beta.click();
    await expect(board.getByText(`Beta task ${STAMP}`)).toBeVisible();
    await expect(board.getByText(`Alpha task ${STAMP}`)).toBeVisible();

    // La ricerca c'è ed è viva.
    await menu.getByPlaceholder("Cerca…").fill("beta");
    await expect(menu.getByRole("option")).toHaveCount(1);
  });

  test("PROJSEL-04: a 390px il bottone Invia resta DENTRO il composer", async ({ page }) => {
    await page.goto("/");
    await openGlobalBoard(page);
    // Si stringe DOPO l'apertura: a 390px il «+» della barra sta sotto il
    // bottone che riapre la sidebar, e il test morirebbe su quel click invece
    // che sulla cosa che vuole misurare.
    await page.setViewportSize({ width: 390, height: 800 });

    const composer = await expandComposer(page);
    await composer.locator("textarea").fill("Un task qualsiasi");
    // Il testid, non il `title`: da quando l'avvio è una scelta (Todo o
    // Backlog) il titolo del bottone CAMBIA con la colonna scelta, quindi
    // cercarlo per titolo lega la prova a una copy che non è un'identità.
    const send = page.getByTestId("composer-send");
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();

    // La card ha una transizione di 200ms: si MISURA a regime, con un poll, non
    // al primo frame utile — altrimenti si accusa il layout di una geometria che
    // sta ancora animando.
    const geometry = async () => {
      const card = await composer.boundingBox();
      const s = await send.boundingBox();
      const chip = await page.getByTestId("composer-project-chip").boundingBox();
      if (!card || !s || !chip) return null;
      return {
        // Il baco era questo: la riga eccedeva e `overflow-hidden` tagliava via
        // il bottone, che finiva oltre il bordo destro della card.
        dentroADestra: s.x + s.width <= card.x + card.width + 1,
        dentroASinistra: s.x >= card.x - 1,
        dentroInBasso: s.y + s.height <= card.y + card.height + 1,
        // Chip e Invia sulla STESSA riga: se il bottone scende, la riga è andata a capo.
        stessaRiga: Math.abs((chip.y + chip.height / 2) - (s.y + s.height / 2)) < 14,
      };
    };
    await expect.poll(geometry, { timeout: 10000 }).toEqual({
      dentroADestra: true,
      dentroASinistra: true,
      dentroInBasso: true,
      stessaRiga: true,
    });
    // Cliccabile davvero, non solo dipinto dentro: nessuno lo copre.
    await expect(send).toBeVisible();
    const hit = await send.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && (top === el || el.contains(top));
    });
    expect(hit).toBe(true);
  });

  test("PROJSEL-05: «Nuovo progetto…» c'è SEMPRE, e crea davvero", async ({ page }) => {
    await page.goto("/");
    await openGlobalBoard(page);
    await expandComposer(page);
    await page.getByTestId("composer-project-chip").click();

    const menu = page.locator('[role="listbox"]').filter({ hasText: "Progetto del task" });
    const search = menu.getByPlaceholder("Cerca o crea…");
    const create = menu.getByTestId("project-picker-create");

    // A casella VUOTA la riga c'è già: prima compariva solo dopo aver digitato
    // un nome inesistente, cioè per chi guardava il menu non esisteva.
    await expect(create).toBeVisible();
    await expect(create).toContainText("Nuovo progetto…");
    // E porta il cursore dove si scrive il nome (la ricerca È la creazione).
    await search.blur();
    await create.click();
    await expect(search).toBeFocused();

    // Un nome che esiste già non promette una creazione che fallirebbe.
    await search.fill(PROJ_A.split("/").pop()!);
    await expect(create).toBeDisabled();

    // Un nome nuovo: la riga diventa il bottone che crea, e crea davvero.
    const fresh = `projsel${STAMP}`;
    await search.fill(fresh);
    await expect(create).toBeEnabled();
    await expect(create).toContainText(`Crea "${fresh}"`);
    // E DICE dove lo crea: la cartella è dedotta dal server, non configurata.
    const target = (await (await page.request.get(`${BASE}/api/all-boards/projects`)).json()) as {
      newProjectDir: string | null;
    };
    expect(target.newProjectDir).toBeTruthy();
    await expect(create).toContainText(`in ${target.newProjectDir!.split("/").pop()}`);
    createdViaUi = fresh;
    await create.click();

    // Creato → scelto: il chip lo mostra, e l'indice del server lo conosce.
    const chip = page.getByTestId("composer-project-chip");
    await expect(chip).toContainText(fresh, { timeout: 10000 });
    const idx = (await (await page.request.get(`${BASE}/api/all-boards/projects`)).json()) as {
      projects: Array<{ name: string; path: string }>;
    };
    const made = idx.projects.find((p) => p.name === fresh);
    expect(made).toBeTruthy();
    // Nato NELLA cartella annunciata, non sepolto nel workspace dell'agente.
    expect(made!.path).toBe(`${target.newProjectDir}/${fresh}`);

    // UNA riga sola: «nuovo» e «apri/crea» erano la stessa cosa detta due volte.
    await page.getByTestId("composer-project-chip").click();
    await expect(menu.getByTestId("project-picker-create")).toHaveCount(1);
    await expect(menu.getByTestId("project-picker-folder")).toHaveCount(0);
  });
});
