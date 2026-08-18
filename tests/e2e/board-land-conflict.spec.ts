/**
 * board-land-conflict.spec.ts — un land che va in CONFLITTO dice perché.
 *
 * La card torna in lavorazione: è giusto (il merge non è avvenuto, il lavoro
 * non è finito), ma la riga di storico diceva «user → In Progress» — identica a
 * quella che scrive un umano quando ritira una consegna a mano. Chi rivedeva
 * vedeva un dietrofront senza causa e col firmatario sbagliato: l'umano aveva
 * cliccato «Landa su main», il ritiro è della macchina.
 *
 * La colonna di partenza è `review`, non `done`: dal 13/08 il land non promuove
 * più la card prima di fondere, perché tre card erano finite in `done` coi rami
 * mai arrivati su main. Il fatto sotto esame non cambia — il ritiro porta la
 * ragione ed è firmato dal sistema — ma la riga lo dice a partire da review.
 *
 * Il conflitto qui è VERO: repo git in /tmp, worktree vero via
 * `POST /api/worktrees`, la stessa riga cambiata in due modi diversi sul branch
 * del task e su main. Il merge che fallisce è `git` che fallisce, non un finto.
 * L'unica scorciatoia è il legame task→topic, che nel mondo vero lo fa il
 * dispatcher spawnando un agente: `POST /api/test/tasks/:id/bind-topic` fa quel
 * solo passo (route armata solo con TOPICS_E2E=1, vedi server/routes/e2e.ts).
 *
 * È anche la clip di consegna: si clicca «Landa su main» e si guarda la riga
 * comparire nel thread con la sua ragione. Un comportamento, non uno screenshot.
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
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

/** La stessa riga, cambiata in due modi: il conflitto è garantito, non sperato. */
const BEFORE = ["uno", "due", "tre", "quattro"].join("\n") + "\n";
const SUL_TASK = ["uno", "due", "TRE dal task", "quattro"].join("\n") + "\n";
const SU_MAIN = ["uno", "due", "TRE da main", "quattro"].join("\n") + "\n";

interface WorktreeRow { id: string; status: string; absPath: string; branchName: string }

const REPO = `/tmp/topics-e2e-landconflict-${Date.now()}`;
const PROJECT_ID = boardIdForPath(REPO);
const TASK_TEXT = "Rinominare la terza riga";

let topicId: string | null = null;
let taskId: string | null = null;
let worktreePath: string | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** Apre la board del progetto (stesso percorso di board-diff-review.spec.ts). */
async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /topics-e2e-landconflict/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const alreadyOpen = page.getByTestId("kanban-board");
  if (await alreadyOpen.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) return;

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
  if (!opened) throw new Error("nessun menu + con la voce Board");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). Zero a suite normale. */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Board · il land in conflitto dice perché la card torna indietro", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    // 1. Repo vero col file conteso.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-landconflict" }, null, 2));
    writeFileSync(`${REPO}/conta.txt`, BEFORE);
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    // 2. Progetto + worktree in modalità branch (quello che il dispatcher dà a un agente).
    const proj = await request.post(`${API}/projects`, {
      data: { name: `e2e-landconflict-${Date.now()}`, path: REPO },
    });
    expect(proj.ok()).toBe(true);
    const project = (await proj.json()) as { id: string };

    const wtRes = await request.post(`${API}/worktrees`, {
      data: { project_id: project.id, mode: "branch", base_ref: "main" },
    });
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

    // 3. Il lavoro del task, committato sul suo branch…
    writeFileSync(`${wt.absPath}/conta.txt`, SUL_TASK);
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "conta: TRE dal task"]);
    // …e main che intanto ha cambiato LA STESSA riga: il merge non può riuscire.
    writeFileSync(`${REPO}/conta.txt`, SU_MAIN);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "conta: TRE da main"]);

    // 4. Topic legata al worktree (e al progetto, così compare in sidebar).
    const topic = await createTopic(request, "E2E-LandConflict", { projectPath: REPO });
    topicId = topic.id;
    const bind = await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId: wt.id } });
    expect(bind.ok()).toBe(true);

    // 5. Task in review, legato alla topic come farebbe il dispatcher: è lo
    //    stato in cui compare il bottone «Landa su main».
    const taskRes = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, {
      data: { text: TASK_TEXT, status: "todo" },
    });
    expect(taskRes.ok()).toBe(true);
    taskId = ((await taskRes.json()) as { id: string }).id;
    const bound = await request.post(`${API}/test/tasks/${taskId}/bind-topic`, { data: { topicId: topic.id } });
    expect(bound.ok()).toBe(true);
    const toReview = await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { status: "review" } });
    expect(toReview.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    if (topicId) await deleteTopic(request, topicId);
    if (worktreePath && existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    rmSync(REPO, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
  });

  test("BOARD-LAND-01: la transizione che ritira la consegna porta la ragione, e la firma è del sistema", async ({ page, request }) => {
    await page.goto("/");
    await openProjectBoard(page);

    await page.getByTestId("kanban-column-review").getByText(TASK_TEXT).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await beat(page);

    // Il gesto vero: «Landa su main» = accetta + merge. Il merge fallisce.
    await drawer.getByRole("button", { name: "Landa su main" }).click();

    // La riga di storico che prima non c'era: il PERCHÉ accanto al dove.
    //
    // Il land prova PRIMA a riportare main dentro il ramo (`realignOnMain`), e
    // qui è lì che si rompe: il ramo è indietro di un commit su main, e quel
    // commit tocca la stessa riga. È il conflitto di riallineamento, non quello
    // della fusione finale — e all'agente servono due istruzioni diverse
    // (server/routes/tasks.ts, ramo `res.status === "conflict"`), quindi le due
    // ragioni sono due frasi diverse e questa spec ancora la sua.
    const evento = drawer.getByTestId("task-status-event")
      .filter({ hasText: "ha fatto conflitto" });
    await expect(evento).toBeVisible({ timeout: 20000 });
    await expect(evento).toContainText("In Progress"); // la destinazione resta leggibile
    // Chi l'ha mossa: da agosto 2026 il chip NON scrive il nome quando è stata
    // l'app — un thread in cui ogni riga si firma «Topics» ha smesso di dire
    // qualcosa. Il fatto che conta qui è che NON l'ha mossa l'umano, e si legge
    // dal tooltip, che porta il nome E il ruolo grezzo scritto sul disco.
    await expect(evento).toHaveAttribute("title", /Topics \(system\)/);
    await expect(evento).not.toContainText("Topics");

    // E la nota che il land fallito lascia nel thread è UNA riga, quindi è un
    // chip: prima erano tre — il nome di chi ha parlato, il testo, l'ora — e su
    // una card che ha lavorato sono dieci righe così. Il nome e l'ora restano
    // sotto il mouse, dove servono a chi cerca l'istante e non a chi scorre.
    // (È il ramo `conflict` del land, non `skipped`: il testo è quello che
    //  `server/routes/tasks.ts` scrive lì, e la frase finale è sua sola.)
    const nota = drawer.getByTestId("task-app-note").filter({ hasText: "Rimando all'agent per riconciliare" });
    await expect(nota).toBeVisible({ timeout: 20000 });
    await expect(nota).toHaveAttribute("title", /Topics \(system\)/);
    await beat(page, 2200);

    // E sul dato: l'evento è una transizione verso `in_progress` con la ragione
    // attaccata, non un commento qualsiasi. La colonna di PARTENZA è `review`:
    // dal 13/08 il land non promuove più a `done` prima di fondere (tre card
    // erano finite chiuse coi rami mai arrivati su main), quindi la card che
    // torna indietro parte da dove il reviewer l'ha lasciata.
    const res = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
    expect(res.ok()).toBe(true);
    const got = (await res.json()) as { comments: { author: string; content: string; kind: string }[] };
    const riga = got.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(riga.author).toBe("system");
    expect(riga.content).toBe("review→in_progress · riportare main nel ramo (indietro di 1) ha fatto conflitto");
  });
});
