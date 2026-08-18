/**
 * board-review-quiet-note.spec.ts — annotare una consegna NON la rigetta.
 *
 * Il contratto sotto test. Su una card in review con un agente dietro, scrivere
 * nel campo libero della card la RIMANDA indietro: il server traduce il commento
 * in `reviewDecision(reject)` + `dispatcher.resume()`, la card torna In Progress
 * e l'agente riparte. È giusto per «rispondi all'agent», ed era l'unica cosa che
 * quel campo sapesse fare: il bottone diceva «Commenta» e rigettava. 363 uscite
 * review→in_progress a mano nello storico, e chi ha scritto la regola ci è
 * cascato lo stesso, volendo solo lasciare scritto «verificata» sotto la card.
 *
 * Adesso i gesti sono due e si chiamano come il loro effetto: «Rimanda» fa
 * quello di sempre, «Nota» salva e basta. Questo test guarda il secondo, ed è
 * l'unico che possa stare su una card in `review` invece che su una in `todo`
 * (le spec sorelle — board-diff-review, board-task-changes-panel — seminano in
 * `todo` proprio perché in review il commento faceva partire un dispatch vero).
 *
 * DOVE VIVE IL GESTO QUIETO, dal 18/08 (`1cc5c7d48`): nel DRAWER, non piu' sulla
 * card. In una colonna dove ogni voce e' un'uscita, un bottone che non fa
 * avanzare niente non e' una decisione di review — «se uno vuole fare una nota
 * lo mette il backlog». Sulla card resta il campo (il suo testo lo raccoglie la
 * scelta principale) ma senza un bottone tutto suo. Questo test segue il gesto
 * dove e' andato, e sulla card verifica che NON ci sia piu': se tornasse,
 * tornerebbe anche la colonna con due uscite che non escono.
 *
 * DUE STATI, e servono entrambi: la nota COMPARE nel thread, e la card RESTA
 * dove sta. Uno solo dei due non dice niente.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const REPO = `/tmp/e2e-nota-${Date.now()}`;

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
const PROJECT_ID = boardIdForPath(REPO);

const T_CONSEGNA = "Rifare la scheda prodotto";
const NOTA = "verificata: il video mostra il caso B";

let topicId: string | null = null;
let taskId = "";
const createdTasks: string[] = [];

async function createTask(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  return id;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-nota/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). Zero a suite normale. */
const beat = (page: Page, ms = 1200) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Una nota su una card in review non la rigetta", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-nota" }, null, 2));
    // Identita' via `-c` e non dalla macchina: senza, `git commit` muore con
    // «Please tell me who you are» su CI e mai in locale. Vedi la nota in
    // `helpers/file-project.ts:initGitRepo`, che esiste per questo stesso motivo.
    execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", "init", "-q", "-b", "main"], { cwd: REPO, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", "add", "-A"], { cwd: REPO, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: REPO, stdio: "pipe" });

    const proj = await request.post(`${API}/projects`, { data: { name: `e2e-nota-${Date.now()}`, path: REPO } });
    expect(proj.ok()).toBe(true);

    const topic = await createTopic(request, "E2E-Nota", { projectPath: REPO });
    topicId = topic.id;

    // La card deve avere un TOPIC LEGATO, o non è una review d'agente e i due
    // gesti non hanno ragione di esistere: senza agente dietro, un commento è
    // già solo un commento.
    taskId = await createTask(request, { text: T_CONSEGNA, status: "todo" });
    expect((await request.post(`${API}/test/tasks/${taskId}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
    expect((await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { status: "review" } })).ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    rmSync(REPO, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
  });

  test("«Nota» salva sotto la card e la lascia in Review", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // (1) SULLA CARD IL GESTO QUIETO NON C'E' PIU', ed e' il cambiamento del
    //     18/08 (`1cc5c7d48`): un commento che non risveglia nessuno non e' una
    //     decisione di review, e in una colonna dove ogni voce e' un'uscita era
    //     l'unica che non faceva avanzare niente. Il gesto NON sparisce dal
    //     prodotto: si sposta nel drawer, dove si scrive per esteso e si vede il
    //     thread. Questo test lo segue li'.
    await expect(card.getByTestId("card-reply-quiet-note")).toHaveCount(0);
    // E il gemello di prima resta via: «Rimanda» accanto al campo chiamava la
    // stessa `review('reject', testo)` di «Rimandalo avanti» nella riga qui
    // sopra — due bottoni per una porta sola, a due centimetri di distanza.
    await expect(card.getByTestId("card-reply-send-back")).toHaveCount(0);
    // IL GESTO CHE RISVEGLIA RESTA RAGGIUNGIBILE, ed e' nella riga delle scelte.
    // Qui e' «Rifai cosi'…» (`redo`, che prende il testo) e non «Rimandalo
    // avanti»: questa card e' `review-plain`, perche' `taskChoiceState` sceglie
    // `review-branch` solo con un RAMO e `review-unfinished` solo con
    // `delivered_by = 'system'`, e questa l'ha portata in review una PATCH
    // umana. La riga di prima pretendeva `send-back`, che in `review-plain` non
    // c'e' mai stato: era verde per un'altra ragione, non perche' misurasse
    // questo.
    await expect(card.getByTestId("task-choice-redo")).toBeVisible();
    // E il campo resta, e dice cosa fa PRIMA che uno scriva: il testo lo
    // raccoglie la scelta principale, non un bottone tutto suo.
    await expect(card.getByPlaceholder(/Una nota, che resta qui/)).toBeVisible();
    await beat(page);

    // (2) Si apre il drawer e si scrive li' la nota, col gesto quieto.
    await page.getByTestId("kanban-column-review").getByText(T_CONSEGNA).click({ timeout: 15000 });
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    const nota = drawer.getByTestId("task-reply-quiet-note");
    // Si chiama come il suo effetto: un'icona con tooltip non basterebbe, era
    // proprio il nome a mentire («Commenta» che rigettava).
    await expect(nota).toContainText("Nota");
    await drawer.locator("textarea").first().fill(NOTA);
    await beat(page);
    await nota.click();

    // (3) PRIMO STATO: la nota c'è davvero, e si legge nel thread.
    await expect(drawer.getByText(NOTA)).toBeVisible({ timeout: 10000 });
    await beat(page);

    // (4) SECONDO STATO: la card NON si è mossa. È tutto il punto.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("kanban-column-body-review").locator(`[data-task-card="${taskId}"]`))
      .toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("kanban-column-body-in_progress").locator(`[data-task-card="${taskId}"]`))
      .toHaveCount(0);
    await beat(page);

    // (5) E il server è d'accordo con lo schermo: niente rigetto, niente
    //     transizione. Se la board mentisse, questa riga lo direbbe.
    const got = await page.request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
    const { task } = (await got.json()) as { task: { status: string } };
    expect(task.status).toBe("review");
  });
});
