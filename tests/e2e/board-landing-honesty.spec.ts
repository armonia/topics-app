/**
 * board-landing-honesty.spec.ts — «Done» non deve mentire sulla SINGOLA card.
 *
 * IL GUASTO CHE COPRE. Il 19/07 un task fu approvato, il suo branch potato, e
 * 139 righe non arrivarono mai su main: nessuno se ne accorse per otto giorni,
 * perché «done» era una colonna e non un fatto sul repo. L'audit periodico
 * (`server/services/landing-audit.ts`) adesso stampa il verdetto sul task, e la
 * top bar ne mostra il TOTALE — ma un totale non dice QUALE card. Chi guarda la
 * colonna Done continua a credere finito ciò che non è nel prodotto.
 *
 * COSA MISURA, in ordine di quanto costa sbagliarlo:
 *  1. la card in Done lo DICE, e dice anche su quale ramo sta il lavoro;
 *  2. il drawer lo ripete in cima E OFFRE L'AZIONE che lo risolve — prima la
 *     banda diceva «landa il branch» e non c'era niente da premere, perché il
 *     bottone «Landa su main» era recintato dentro `status === 'review'`;
 *  3. il CONTROLLO NEGATIVO: un task done il cui lavoro È su main non porta
 *     nessun allarme. Senza questa terza asserzione le prime due passerebbero
 *     anche con un chip incollato su ogni card, cioè con la board che grida
 *     sempre — che è l'altro modo di mentire.
 *
 * COME SEMINA. `landing_state` + `delivery_branch/commit` le scrivono solo il
 * dispatcher e la passata di audit contro un repo git vero; qui le mette
 * `POST /api/test/tasks/:id/landing` (armata solo con TOPICS_E2E=1, vedi
 * server/routes/e2e.ts), che chiama gli STESSI verbi del servizio. Il task resta
 * fermo in `done`: qui il contratto sotto esame è quello del client.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import {
  createTopic,
  deleteTopic,
  deleteTask,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
} from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "node:path";

const SHOTS = "test-results/review-column";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-landing-${Date.now()}`;

/** BYTE-IDENTICAL a server/services/tasks.ts:projectIdForPath (come board.spec.ts). */
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
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const UNLANDED_BRANCH = "topics/ramo-mai-landato";
const UNLANDED_COMMIT = "1dc0964aabbccddeeff00112233445566778899a";
const LANDED_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

type Req = import("@playwright/test").APIRequestContext;

/** Un task chiuso, con la fotografia di consegna e il verdetto dell'audit già scritti. */
async function seedDoneTask(
  request: Req,
  text: string,
  landing: {
    branch?: string | null; commit?: string | null; state: "landed" | "unlanded";
    filesChanged?: number; insertions?: number; deletions?: number;
  },
): Promise<string> {
  // Il servizio rifiuta per contratto un task che NASCE done ("cannot create a
  // task already done"): si nasce in backlog e ci si sposta, come farebbe la
  // review. Backlog e non todo: `todo` è la coda di esecuzione e su un board con
  // auto-dispatch acceso farebbe partire un agente vero.
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text, status: "backlog" },
  });
  expect(res.ok(), `create task: ${res.status()} ${await res.text()}`).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);

  const moved = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
    data: { status: "done" },
  });
  expect(moved.ok(), `move to done: ${moved.status()} ${await moved.text()}`).toBe(true);

  const seeded = await request.post(`${BASE}/api/test/tasks/${task.id}/landing`, {
    data: {
      branch: landing.branch ?? null, commit: landing.commit ?? null, state: landing.state,
      filesChanged: landing.filesChanged, insertions: landing.insertions, deletions: landing.deletions,
    },
  });
  // Un 404 qui significa route di test non armata: va detto SUBITO, non fra
  // dieci secondi travestito da chip mancante.
  expect(seeded.status(), "POST /api/test/tasks/:id/landing deve essere armata (TOPICS_E2E=1)").toBe(200);
  const body = (await seeded.json()) as { task?: { landingState?: string | null } };
  expect(body.task?.landingState, "il verdetto deve essere davvero sul task").toBe(landing.state);
  return task.id;
}

/** Apre la finestra del progetto e2e dalla riga in sidebar (come board.spec.ts). */
async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-landing/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

/**
 * Apre la board del progetto dal "+" della finestra di progetto.
 *
 * IL GIRO E' INDURITO, ed e' la stessa forma di `board.spec.ts` (righe 87-105)
 * PAROLA PER PAROLA. Non e' pignoleria di stile: la versione ingenua di questa
 * funzione — `for (let i = 0; i < n; i++) await triggers.nth(i).click()` — passa
 * quando questo file gira DA SOLO e va rossa su tutti e tre i test quando gira
 * dentro la suite. Il workspace e' condiviso lungo la run: una pane lasciata da
 * una spec precedente contribuisce un trigger che sta nel DOM ma non e' sullo
 * schermo, e `click()` senza timeout resta appeso su «visible, enabled and
 * stable» finche' i 60 s di budget del test non sono finiti. Misurato il 12/08
 * sull'albero fuso con main: 3 falliti, ogni volta con
 * «locator.click: Test timeout of 60000ms exceeded» su questa riga.
 *
 * Le tre righe che lo evitano, e perche' ognuna serve:
 *  1. si scorre ALL'INDIETRO — il trigger appena montato (la finestra di
 *     progetto) e' l'ultimo, i relitti stanno davanti;
 *  2. `isVisible()` scarta il relitto PRIMA di toccarlo;
 *  3. `click({ timeout: 3000 })` mette un tetto: se un trigger inganna anche il
 *     controllo di visibilita', si perdono 3 secondi e si prova il prossimo,
 *     invece di bruciare il test intero su di lui.
 * E il click sulla VOCE sta FUORI dal giro: dentro, un `item.click()` fallito
 * ammazzerebbe la funzione senza lasciar provare i trigger rimasti.
 */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const n = await triggers.count();
  let opened = false;
  for (let i = n - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  expect(opened, "nessun menu + con la voce Board (kanban)").toBe(true);
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Done non mente: lo stato di atterraggio sta sulla card", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-landing" }, null, 2));
    // Favicon vera: dall'08/08 la riga della board mostra solo i progetti che
    // ne hanno una. Senza, il progetto non comparirebbe e il rosso parlerebbe
    // del setup invece che della regola.
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const topic = await createTopic(request, "E2E-Landing", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("LANDING-00: in review la card dice QUANTO lavoro si sta approvando", async ({ page }) => {
    // Misurato sulla board vera il 16/08: cinque card in review, e su tutte e
    // cinque il pulsante «Approva» senza un solo dato su cosa entrerebbe. Il
    // diff esisteva, ma solo aprendo il drawer - una card alla volta. Una
    // colonna che si legge solo aprendola non e' un cruscotto, e' un elenco
    // di titoli.
    const text = `Consegna misurata ${Date.now()}`;
    const res = await page.request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text, status: "backlog" },
    });
    expect(res.ok()).toBe(true);
    const task = (await res.json()) as { id: string };
    createdTasks.push(task.id);
    await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { status: "review" },
    });
    const seeded = await page.request.post(`${BASE}/api/test/tasks/${task.id}/landing`, {
      data: {
        branch: "topics/misurata", commit: "a".repeat(40), state: "unlanded",
        filesChanged: 7, insertions: 120, deletions: 30,
      },
    });
    expect(seeded.ok(), `seed landing: ${seeded.status()}`).toBe(true);
    // Il dato DEVE arrivare nel feed della lista, non solo nel dettaglio: la
    // card della colonna si disegna da lì. Verificarlo qui separa «il server
    // non lo manda» da «la UI non lo disegna», che sono due bug diversi.
    const feed = await (await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks`)).json() as
      { tasks: Array<{ id: string; deliveryFilesChanged: number | null }> };
    const dalFeed = feed.tasks.find((t) => t.id === task.id);
    expect(dalFeed?.deliveryFilesChanged, "la lista deve portare la misura").toBe(7);

    // REVIEW e' la quarta colonna: a 1280px sta fuori dallo schermo e il primo
    // giro di questo caso e' fallito misurando una colonna mai disegnata, non
    // un chip mancante. La finestra larga e' parte della prova.
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto("/");
    await openProjectBoard(page);

    const card = page.getByTestId("kanban-column-review").locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });
    const chip = card.getByTestId("card-delivery-stat");
    // La colonna REVIEW e' l'ultima e sul banco resta mezza fuori: `toBeVisible`
    // guarda il viewport, quindi senza portarla sotto gli occhi il caso
    // fallirebbe su un chip che ESISTE. Costato due giri di debug, con il dato
    // giusto nel DB, nel feed e perfino in mano al client.
    await chip.scrollIntoViewIfNeeded();
    // I numeri sulla CARD, non nel `title`: su touch l'hover non esiste, e una
    // colonna che si legge di fretta non si legge col mouse fermo sopra.
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("7 file");
    await expect(chip).toContainText("+120");
    await expect(chip).toContainText("-30");
    await card.screenshot({ path: join(SHOTS, "review-quanto-lavoro.png") });
  });

  test("LANDING-00c: i check verdi si DICONO, non si deducono dal silenzio", async ({ page }) => {
    // Prima esisteva solo il chip rosso: una card senza chip poteva voler dire
    // «controlli passati» oppure «nessuno li ha mai fatti girare». Due
    // situazioni opposte davanti allo stesso gesto, e il silenzio non diceva
    // quale delle due si stava guardando.
    const text = `Check verdi ${Date.now()}`;
    const res = await page.request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text, status: "backlog" },
    });
    const task = (await res.json()) as { id: string };
    createdTasks.push(task.id);
    await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { status: "review" },
    });
    const seeded = await page.request.post(`${BASE}/api/test/tasks/${task.id}/checks`, {
      data: { state: "pass" },
    });
    expect(seeded.ok(), `seed checks: ${seeded.status()}`).toBe(true);

    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto("/");
    await openProjectBoard(page);
    const card = page.getByTestId("kanban-column-review").locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("card-checks-green")).toBeVisible();
    // E il rosso NON c'e': un chip che dicesse entrambe le cose non sarebbe un
    // esito, sarebbe una decorazione.
    await expect(card.getByTestId("card-checks-running")).toHaveCount(0);
    await card.screenshot({ path: join(SHOTS, "review-check-verdi.png") });
  });

  test("LANDING-00d: la card dice da QUANTO aspetta una risposta", async ({ page }) => {
    // La data di aggiornamento in review era nascosta apposta, e faceva bene:
    // `updatedAt` si muove a ogni commento, quindi diceva «ora» su una card
    // ferma da giorni. `review_at` e' l'istante dell'INGRESSO, e risponde alla
    // domanda vera.
    const text = `Attesa lunga ${Date.now()}`;
    const res = await page.request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text, status: "backlog" },
    });
    const task = (await res.json()) as { id: string };
    createdTasks.push(task.id);
    await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { status: "review" },
    });
    // Indietro nel tempo di tre giorni: il chip tace sotto l'ora, quindi una
    // card appena creata non lo mostrerebbe - e un test che aspetta un'ora
    // vera non e' un test.
    const treGiorniFa = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    const t = await page.request.post(`${BASE}/api/test/tasks/${task.id}/review-at`, {
      data: { at: treGiorniFa },
    });
    expect(t.ok(), `seed review-at: ${t.status()}`).toBe(true);

    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto("/");
    await openProjectBoard(page);
    const card = page.getByTestId("kanban-column-review").locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });
    const chip = card.getByTestId("card-review-age");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("3g");
    await card.screenshot({ path: join(SHOTS, "review-attesa.png") });
  });

  test("LANDING-00b: senza misura la card non inventa uno zero", async ({ page }) => {
    // `null` e' «non misurato», zero sarebbe «misurato, non ha prodotto
    // niente»: due frasi diverse, e la seconda su una card senza worktree
    // sarebbe falsa. Un chip «0 file +0 -0» su ogni card e' rumore che si
    // impara a saltare, e il giorno che il numero conta non lo legge nessuno.
    const text = `Consegna non misurata ${Date.now()}`;
    const res = await page.request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text, status: "backlog" },
    });
    const task = (await res.json()) as { id: string };
    createdTasks.push(task.id);
    await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { status: "review" },
    });
    await page.request.post(`${BASE}/api/test/tasks/${task.id}/landing`, {
      data: { branch: "topics/muta", commit: "b".repeat(40), state: "unlanded" },
    });

    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto("/");
    await openProjectBoard(page);
    const card = page.getByTestId("kanban-column-review").locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("card-delivery-stat")).toHaveCount(0);
  });

  test("REVIEW-MUTA: una card senza misura dice PERCHE' non ce l'ha", async ({ page }) => {
    // Segnalato: «quelli in review non mi sembrano pronti da sistema per
    // essere fatti review da me, sembrano solo i task spostati». Misurato sul
    // db: 33 card in review, 31 senza fotografia di consegna, 30 senza nemmeno
    // una sessione - tutte con lo STESSO niente sotto, che voleva dire due
    // cose opposte.
    //
    // Qui la card entra in review senza ramo e senza agente: e' il caso piu'
    // comune sulla board vera, ed e' quello che sembrava «pronto» e non lo
    // era.
    const text = `Spostata a mano ${Date.now()}`;
    const res = await page.request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text, status: "backlog" },
    });
    const task = (await res.json()) as { id: string };
    createdTasks.push(task.id);
    await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { status: "review" },
    });

    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto("/");
    await openProjectBoard(page);
    const card = page.getByTestId("kanban-column-review").locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });

    // Nessuna misura inventata...
    await expect(card.getByTestId("card-delivery-stat")).toHaveCount(0);
    // ...ma la ragione detta, e leggibile senza aprire la card.
    const chip = card.getByTestId("card-moved-by-hand");
    await expect(chip, "una card senza ramo e senza agente deve dirlo").toBeVisible({ timeout: 5000 });
    // E il perche' per esteso, per chi si ferma sopra.
    await expect(chip).toHaveAttribute("title", /nessun ramo|Nessun agente/i);
  });

  test("LANDING-01: la card in Done dichiara «non su main» e nomina il ramo", async ({ page }) => {
    const text = `Non landato ${Date.now()}`;
    await seedDoneTask(page.request, text, {
      branch: UNLANDED_BRANCH,
      commit: UNLANDED_COMMIT,
      state: "unlanded",
    });

    await page.goto("/");
    await openProjectBoard(page);

    const done = page.getByTestId("kanban-column-done");
    const card = done.locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });

    // La parola, sulla card, senza passare da un hover: su touch il `title` non
    // esiste e la card resterebbe muta proprio dove si guarda la colonna.
    const chip = card.getByTestId("card-not-landed");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("non su main");
    // Il RAMO: senza, la card dice che c'è un problema e non dove sta il lavoro.
    // Nel testo va il nome SENZA il prefisso `topics/` (ce l'hanno tutti, e con
    // quello il troncamento mangiava proprio la parte che distingue un ramo
    // dall'altro); il nome intero resta nel `title`, che è il posto dove uno
    // lo copia.
    await expect(chip).toContainText(UNLANDED_BRANCH.replace(/^topics\//, ""));
    await expect(chip).toHaveAttribute("title", new RegExp(UNLANDED_BRANCH));
  });

  test("LANDING-02: il drawer lo ripete e OFFRE l'azione che lo risolve", async ({ page }) => {
    const text = `Drawer non landato ${Date.now()}`;
    await seedDoneTask(page.request, text, {
      branch: UNLANDED_BRANCH,
      commit: UNLANDED_COMMIT,
      state: "unlanded",
    });

    await page.goto("/");
    await openProjectBoard(page);

    const done = page.getByTestId("kanban-column-done");
    await expect(done.getByText(text)).toBeVisible({ timeout: 10000 });
    await done.getByText(text).click();

    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    const banner = drawer.getByTestId("task-not-landed-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("non su main");
    await expect(banner).toContainText(UNLANDED_BRANCH);
    await expect(banner).toContainText(UNLANDED_COMMIT.slice(0, 8));

    // L'AZIONE. La banda nomina il landing: se non c'è niente da premere, sta
    // dando un compito invece di offrire una via d'uscita.
    const land = banner.getByTestId("task-not-landed-land");
    await expect(land).toBeVisible();
    await expect(land).toBeEnabled();
  });

  test("LANDING-03: controllo negativo — un done LANDATO non porta allarmi", async ({ page }) => {
    const text = `Landato ${Date.now()}`;
    await seedDoneTask(page.request, text, {
      branch: "topics/ramo-landato",
      commit: LANDED_COMMIT,
      state: "landed",
    });

    await page.goto("/");
    await openProjectBoard(page);

    const done = page.getByTestId("kanban-column-done");
    const card = done.locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("card-not-landed")).toHaveCount(0);

    await done.getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-not-landed-banner")).toHaveCount(0);
  });
});
