/**
 * board-card-choices.spec.ts — una card che non è chiusa offre SCELTE, non solo
 * un commento libero.
 *
 * Il caso che mancava: le opzioni rapide sulla card esistevano SOLO se l'agente
 * le aveva proposte (il blocco ```question```). Quando non lo faceva — cioè
 * quasi sempre — all'umano restava la casella di testo vuota, e davanti al vuoto
 * la card resta ferma. Ora le scelte si ricavano dallo STATO della card
 * (`taskChoices`), quindi ci sono sempre, e il commento libero è l'ultima
 * opzione invece dell'unica.
 *
 * È anche la clip di consegna: quattro card nei quattro stati, e per ognuna una
 * decisione presa con UN click, senza scrivere niente.
 *   · review con ramo    → «Serve a me» (la card esce dalla review, @io)
 *   · review senza ramo  → «Approva» (la card chiude)
 *   · in corso           → «Ferma» (l'agente si stacca, la card si parcheggia)
 *   · bloccata           → «Sblocca: <bloccante>» (il legame cade, la card parte)
 *
 * @covers KANBAN-02
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const REPO = `/tmp/e2e-scelte-${Date.now()}`;

const PROJECT_ID = boardIdForPath(REPO);

const T_RAMO = "Rifare la scheda prodotto";
const T_PIANO = "Piano per il nuovo listino";
const T_CORSO = "Migrare le foto sul bucket";
const BLOCKING_T = "Scegliere il fornitore";
const BLOCKED_T = "Pubblicare la scheda nuova";

function git(cwd: string, args: string[]) {
  // L'identita' passata con `-c` e non presa dalla macchina: senza, `git commit`
  // muore con «Please tell me who you are» ovunque non ci sia una config globale,
  // cioe' su CI e mai sul portatile di chi scrive la spec. E' lo stesso difetto
  // che `helpers/file-project.ts:initGitRepo` documenta di aver gia' pagato, ed
  // era ricopiato senza identita' in cinque spec. `commit.gpgsign=false` copre
  // l'altro verso: chi firma i commit resta appeso su una passphrase che nessuno
  // vede.
  execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
}

interface WorktreeRow { id: string; status: string; absPath: string }

let topicId: string | null = null;
let worktreePath: string | null = null;
const createdTasks: string[] = [];
const taskIds: Record<string, string> = {};

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
  const btn = projectRow(page, /e2e-scelte/);
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

test.describe("Scelte sempre presenti sulla card", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    // 1. Repo vero: senza, non c'è nessun ramo consegnato da landare.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-scelte" }, null, 2));
    writeFileSync(`${REPO}/scheda.txt`, "prima\n");
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    const proj = await request.post(`${API}/projects`, { data: { name: `e2e-scelte-${Date.now()}`, path: REPO } });
    expect(proj.ok()).toBe(true);
    const project = (await proj.json()) as { id: string };

    // 2. Worktree in modalità branch — quello che il dispatcher dà a un agente.
    const wtRes = await request.post(`${API}/worktrees`, { data: { project_id: project.id, mode: "branch", base_ref: "main" } });
    expect(wtRes.status()).toBe(202);
    const created = (await wtRes.json()) as { id: string };
    const deadline = Date.now() + 15_000;
    let wt: WorktreeRow | null = null;
    while (Date.now() < deadline) {
      const res = await request.get(`${API}/worktrees/${created.id}`);
      if (res.ok()) {
        const row = (await res.json()) as WorktreeRow;
        if (row.status !== "pending") { wt = row; break; }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!wt || wt.status !== "ready") throw new Error(`worktree non pronto: ${wt?.status}`);
    worktreePath = wt.absPath;

    // 3. Il "lavoro dell'agente", committato sul suo ramo.
    writeFileSync(`${wt.absPath}/scheda.txt`, "dopo\n");
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "scheda: rifatta"]);

    const topic = await createTopic(request, "E2E-Scelte", { projectPath: REPO });
    topicId = topic.id;
    expect((await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId: wt.id } })).ok()).toBe(true);

    // 4a. Card in REVIEW CON RAMO: legata alla topic dell'agente, poi mandata in
    //     review — è il passaggio che fotografa il ramo consegnato.
    taskIds.ramo = await createTask(request, { text: T_RAMO, status: "todo" });
    expect((await request.post(`${API}/test/tasks/${taskIds.ramo}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
    expect((await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskIds.ramo}`, { data: { status: "review" } })).ok()).toBe(true);
    // Se questa cade, il rosso parla del SETUP: senza ramo la card mostrerebbe
    // le scelte dell'altro stato e il test verificherebbe un'altra cosa.
    const ramo = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskIds.ramo}`);
    expect(((await ramo.json()) as { task: { deliveryBranch: string | null } }).task.deliveryBranch).toBeTruthy();

    // 4b. Card in REVIEW SENZA RAMO (una consegna che non è codice).
    taskIds.piano = await createTask(request, { text: T_PIANO, status: "review" });

    // 4c. Card IN CORSO, con l'agente davvero al lavoro (chip `working`: lo
    //     scrive solo il dispatcher, qui lo semina la route di test).
    taskIds.corso = await createTask(request, { text: T_CORSO, status: "in_progress" });
    expect((await request.post(`${API}/test/tasks/${taskIds.corso}/dispatch-state`, { data: { state: "working" } })).ok()).toBe(true);

    // 4d. Card BLOCCATA da un'altra card aperta.
    taskIds.bloccante = await createTask(request, { text: BLOCKING_T, status: "backlog" });
    taskIds.bloccata = await createTask(request, { text: BLOCKED_T, status: "backlog", blockedByTaskId: taskIds.bloccante });
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    if (worktreePath && existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    rmSync(REPO, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
  });

  test("quattro stati, quattro decisioni in un click — senza scrivere niente", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-02" });
    await page.goto("/");
    await openProjectBoard(page);

    const card = (id: string) => page.locator(`[data-task-card="${id}"]`);
    const choice = (id: string, choiceId: string) => card(id).getByTestId(`task-choice-${choiceId}`);

    // ── 1. Review CON ramo: landare, rimandare indietro, prenderselo ──────────
    const ramo = card(taskIds.ramo);
    await expect(ramo).toBeVisible({ timeout: 10000 });
    await expect(choice(taskIds.ramo, "land")).toHaveText("Landa su main");
    await expect(choice(taskIds.ramo, "send-back")).toHaveText("Rimanda indietro");
    await expect(choice(taskIds.ramo, "take-over")).toHaveText("Serve a me");
    await beat(page);
    // Un click: la card esce dalla review e passa in mano all'umano (@io).
    await choice(taskIds.ramo, "take-over").click();
    await expect(page.getByTestId("kanban-column-body-in_progress").locator(`[data-task-card="${taskIds.ramo}"]`))
      .toBeVisible({ timeout: 10000 });
    await expect(ramo).toContainText("@io");
    await beat(page);

    // ── 2. Review SENZA ramo: approva / rifai così… / archivia ────────────────
    // The words come from the one table (`taskActionWords`): the same ones the
    // card's context menu and the drawer's own buttons say.
    const piano = card(taskIds.piano);
    await expect(choice(taskIds.piano, "accept")).toHaveText("Approva");
    await expect(choice(taskIds.piano, "redo")).toHaveText("Rifai così…");
    await expect(choice(taskIds.piano, "drop")).toHaveText("Archivia");
    // Il commento libero RESTA — ultima opzione, non l'unica.
    await expect(piano.getByPlaceholder("…oppure commenta")).toBeVisible();
    await beat(page);
    await choice(taskIds.piano, "accept").click();
    await expect(page.getByTestId("kanban-column-body-done").locator(`[data-task-card="${taskIds.piano}"]`))
      .toBeVisible({ timeout: 10000 });
    await beat(page);

    // ── 3. In corso: fermarsi o farsi consegnare quello che c'è ───────────────
    // Qui le due scelte NON sono bottoni sulla card: stanno dietro il `⋯` della
    // riga. Sono azioni rare su una card che non chiede niente (sta lavorando),
    // e due bottoni pieni pesavano su ogni card in corso della board. Il menu è
    // in un portal su `<body>`, quindi il pannello si cerca dalla pagina e non
    // dentro la card.
    //
    // Il chip `working` senza un turno vivo dietro è, per il server, un orfano da
    // recuperare: il giro di `reconcile` (10s) se lo riprende e rimette la card
    // in coda. Lo si rimette finché la card non mostra il suo menu — poi le
    // asserzioni e il click stanno dentro la finestra.
    const menuBtn = card(taskIds.corso).getByTestId("task-choices-menu");
    await expect.poll(async () => {
      await page.request.post(`${API}/test/tasks/${taskIds.corso}/dispatch-state`, { data: { state: "working" } });
      // La board si aggiorna sui broadcast, e la route di test non ne emette:
      // una PATCH innocua sullo stesso task ne emette uno col chip fresco.
      await page.request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskIds.corso}`, { data: { priority: 2 } });
      return await menuBtn.count();
    }, { timeout: 30_000, intervals: [400, 800, 1500] }).toBeGreaterThan(0);
    // E la card in corso NON porta più la riga di bottoni: è il punto del menu.
    await expect(card(taskIds.corso).getByTestId("task-choices")).toHaveCount(0);
    await menuBtn.click();
    const menu = page.getByTestId("task-choices-panel");
    await expect(menu.getByTestId("task-choice-stop")).toHaveText("Ferma");
    await expect(menu.getByTestId("task-choice-deliver-now")).toHaveText("Consegna quello che hai");
    await menu.getByTestId("task-choice-stop").click();
    // Fermare stacca l'agente e PARCHEGGIA il task: esce da In Progress.
    await expect(page.getByTestId("kanban-column-body-in_progress").locator(`[data-task-card="${taskIds.corso}"]`))
      .toHaveCount(0, { timeout: 10000 });
    await beat(page);

    // ── 4. Bloccata: il bottone NOMINA il bloccante ───────────────────────────
    const bloccata = card(taskIds.bloccata);
    // Il fatto sotto esame è che la card NOMINI il bloccante, non il verbo con
    // cui lo dice: il chip è passato da «in attesa di: X» ad «aspetta: X»
    // (12/08, vedi lib/board.ts) e un'asserzione sulla frase intera si rompeva
    // senza che niente fosse rotto.
    await expect(bloccata.getByTestId("card-blocked-by")).toContainText(BLOCKING_T);
    // Here too the choices live behind the `⋯` at the end of the chip row, and
    // for one reason more than the working card's: the row of buttons was the
    // LAST thing on the card, that is the geometric centre of a short one, so
    // the click meant to open the drawer pressed «sblocca» instead. The panel     allow-italian: quoted UI string
    // is in a portal on `<body>`: it is looked up from the page.
    await expect(bloccata.getByTestId("task-choices")).toHaveCount(0);
    await bloccata.getByTestId("task-choices-menu").click();
    const choicesPanel = page.getByTestId("task-choices-panel");
    await expect(choicesPanel.getByTestId("task-choice-unblock")).toHaveText(`Sblocca: ${BLOCKING_T}`);
    await expect(choicesPanel.getByTestId("task-choice-unlink")).toHaveText("Togli il legame");
    await beat(page);
    await choicesPanel.getByTestId("task-choice-unblock").click();
    // Un click: il legame cade e la card è in Todo, pronta a partire.
    await expect(page.getByTestId("kanban-column-body-todo").locator(`[data-task-card="${taskIds.bloccata}"]`))
      .toBeVisible({ timeout: 10000 });
    await expect(bloccata.getByTestId("card-blocked-by")).toHaveCount(0);
    await beat(page, 1800);
  });
});
