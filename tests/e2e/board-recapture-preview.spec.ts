/**
 * board-recapture-preview.spec.ts — «Ricattura evidenza» sulla card in review.
 *
 * `prepareForReview` girava in un punto solo: il bordo d'ingresso in review.
 * Una card che l'evidenza l'ha PERSA (i due cancelli dell'11/08 l'hanno ritirata
 * a 23 card) poteva riaverla solo uscendo da review e rientrandoci. Cioè un
 * turno d'agente per una foto.
 *
 * Qui il giro è QUELLO VERO, dal click alla foto: repo git in /tmp, worktree in
 * modalità `branch` (`POST /api/worktrees`), un `dev` script dentro il worktree
 * che serve una pagina, e il preview manager del server che lo avvia, lo
 * riconosce sulla porta, lo fotografa e attacca l'immagine alla card. L'unica
 * scorciatoia è il legame task→topic, che nel mondo vero lo fa il dispatcher
 * spawnando un agente: `POST /api/test/tasks/:id/bind-topic` fa quel solo passo.
 *
 * Il comportamento ha DUE stati e uno screenshot non lo direbbe: card senza
 * anteprima → click → anteprima. Ed è anche la clip di consegna: RECAPTURE-01
 * gira dentro `clipDiConsegna` (helpers/clip.ts), che sotto `E2E_CLIP=1` accende
 * un contesto DEDICATO sul solo tratto utile, misura il .webm e alza se sfora i
 * 20s del protocollo. Il setup — l'app che parte, il progetto che si apre, la
 * board che si monta — sta nel `prologo`, su una pagina il cui video si butta.
 *
 * Il secondo test è il ramo onesto: un worktree senza niente da avviare non
 * produce un'anteprima finta, produce una review-note col MOTIVO. E in nessuno
 * dei due casi il task si muove di colonna o l'agente si sveglia.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  createTopic,
  deleteTopic,
  deleteTask,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  waitForProjectPaneType,
} from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

const STAMP = Date.now();
/** Il repo che SI avvia: il suo `dev` serve la pagina che finirà sulla card. */
const REPO = `/tmp/topics-e2e-recapture-${STAMP}`;
/** Il repo che NON si avvia: nessuno script, quindi nessuna anteprima possibile. */
const MUTED_REPO = `/tmp/topics-e2e-recapture-muto-${STAMP}`;
const PROJECT_ID = boardIdForPath(REPO);
const MUTED_PROJECT_ID = boardIdForPath(MUTED_REPO);

/**
 * La pagina dell'anteprima. Grande e con poche parole di proposito: la foto
 * finisce dentro una card larga 268px, e il cancello della consegna è «a 268px
 * devi ancora saper dire cosa mostra».
 */
const PAGINA = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>Catalogo</title></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
             background:#0b1220;color:#e5e7eb;font-family:-apple-system,Helvetica,sans-serif">
  <div style="font-size:96px;font-weight:800;letter-spacing:-2px">Catalogo</div>
  <div style="font-size:34px;color:#38bdf8;margin-top:8px">l'anteprima del worktree</div>
</body></html>`;

const SERVER_JS = `const port = Number(process.env.PORT || 3000);
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch() { return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } }); },
});
`;

interface WorktreeRow { id: string; status: string; absPath: string; branchName: string }
interface TaskRow { id: string; status: string; previewImage?: string | null; dispatchAttempts?: number }
interface Comment { author: string; content: string; kind?: string }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** Repo git con un commit su `main`. `scripts` assente ⇒ niente da avviare. */
function seedRepo(path: string, name: string, avviabile: boolean) {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    `${path}/package.json`,
    JSON.stringify({ name, ...(avviabile ? { scripts: { dev: "bun run preview-server.js" } } : {}) }, null, 2),
  );
  if (avviabile) {
    writeFileSync(`${path}/preview-server.js`, `const PAGE = ${JSON.stringify(PAGINA)};\n${SERVER_JS}`);
  }
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", "init"]);
}

/** Progetto + worktree `branch` pronto: è quello che il dispatcher dà a un agente. */
async function seedWorktree(request: APIRequestContext, repo: string, name: string): Promise<WorktreeRow> {
  const proj = await request.post(`${API}/projects`, { data: { name, path: repo } });
  expect(proj.ok(), `POST /projects per ${name}`).toBe(true);
  const project = (await proj.json()) as { id: string };

  const wtRes = await request.post(`${API}/worktrees`, {
    data: { project_id: project.id, mode: "branch", base_ref: "main" },
  });
  expect(wtRes.status()).toBe(202);
  const created = (await wtRes.json()) as { id: string };

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await request.get(`${API}/worktrees/${created.id}`);
    if (res.ok()) {
      const row = (await res.json()) as WorktreeRow;
      if (row.status !== "pending") {
        if (row.status !== "ready") throw new Error(`worktree non pronto: ${row.status}`);
        return row;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("worktree ancora pending dopo 20s");
}

/**
 * Una card CONSEGNATA: in review, legata alla topic dell'agente (è quel legame
 * che accende `isAgentReview`, e quindi il bottone) e senza anteprima.
 */
async function seedCardInReview(
  request: APIRequestContext,
  opts: { repo: string; projectId: string; wt: WorktreeRow; titolo: string; topicName: string },
): Promise<{ taskId: string; topicId: string }> {
  const topic = await createTopic(request, opts.topicName, { projectPath: opts.repo });
  const bind = await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId: opts.wt.id } });
  expect(bind.ok()).toBe(true);

  const taskRes = await request.post(`${API}/boards/${opts.projectId}/tasks`, {
    data: { text: opts.titolo, status: "review" },
  });
  expect(taskRes.ok()).toBe(true);
  const taskId = ((await taskRes.json()) as { id: string }).id;

  const bound = await request.post(`${API}/test/tasks/${taskId}/bind-topic`, { data: { topicId: topic.id } });
  expect(bound.ok()).toBe(true);

  return { taskId, topicId: topic.id };
}

async function readTask(request: APIRequestContext, projectId: string, taskId: string) {
  const res = await request.get(`${API}/boards/${projectId}/tasks/${taskId}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { task?: TaskRow; comments?: Comment[] } & TaskRow;
}

/** Il task, comunque lo impacchetti (la route risponde `{task, comments}`). */
function taskOf(body: { task?: TaskRow } & TaskRow): TaskRow {
  return body.task ?? body;
}

async function openProjectBoard(page: Page, nomeCartella: RegExp) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, nomeCartella);
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

test.describe("Board · «Ricattura evidenza» su una card in review", () => {
  test.describe.configure({ timeout: 180_000 });
  // 1280×680 = 0.531: la clip di consegna finisce dentro una card, che sopra
  // 0.70 di altezza/larghezza TAGLIA invece di rimpicciolire.
  test.use({ viewport: { width: 1280, height: 680 } });

  let wt: WorktreeRow | null = null;
  let mutedWt: WorktreeRow | null = null;
  let seeded: { taskId: string; topicId: string } | null = null;
  let mutedSeeded: { taskId: string; topicId: string } | null = null;

  test.beforeAll(async ({ request }) => {
    seedRepo(REPO, "e2e-recapture", true);
    seedRepo(MUTED_REPO, "e2e-recapture-muto", false);
    wt = await seedWorktree(request, REPO, `e2e-recapture-${STAMP}`);
    mutedWt = await seedWorktree(request, MUTED_REPO, `e2e-recapture-muto-${STAMP}`);

    seeded = await seedCardInReview(request, {
      repo: REPO, projectId: PROJECT_ID, wt,
      titolo: "Catalogo: griglia nuova", topicName: "E2E-Recapture",
    });
    mutedSeeded = await seedCardInReview(request, {
      repo: MUTED_REPO, projectId: MUTED_PROJECT_ID, wt: mutedWt,
      titolo: "Ricerca full-text", topicName: "E2E-RecaptureMuto",
    });

    // Il presupposto del test, dichiarato: si parte SENZA evidenza. Se cade
    // qui, il rosso dice "setup", non "bottone".
    expect(taskOf(await readTask(request, PROJECT_ID, seeded.taskId)).previewImage ?? null).toBeNull();
  });

  test.afterAll(async ({ request }) => {
    if (seeded) await deleteTask(request, PROJECT_ID, seeded.taskId);
    if (mutedSeeded) await deleteTask(request, MUTED_PROJECT_ID, mutedSeeded.taskId);
    if (seeded) await deleteTopic(request, seeded.topicId);
    if (mutedSeeded) await deleteTopic(request, mutedSeeded.topicId);
    for (const w of [wt, mutedWt]) {
      if (w) await request.delete(`${API}/worktrees/${w.id}`).catch(() => {});
      if (w && existsSync(w.absPath)) rmSync(w.absPath, { recursive: true, force: true });
    }
    rmSync(REPO, { recursive: true, force: true });
    rmSync(MUTED_REPO, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
  });

  test("RECAPTURE-01: card senza evidenza → un click → l'anteprima sulla card", async ({ request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-41" });
    const taskId = seeded!.taskId;
    await resetProjectPanes(request, REPO);
    await seedProjectPane(request, REPO);

    await clipDiConsegna({
      nome: "board-recapture-preview",
      // Il contesto è NOSTRO: niente di `use` arriva qui da solo. `locale`
      // perché le asserzioni sono in italiano e senza l'app risponde in
      // inglese; 1280×680 = 0,531 di rapporto, perché sopra 0,70 la card
      // taglia la clip dal basso invece di rimpicciolirla.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      // FUORI DALLA REGISTRAZIONE. Aprire il progetto e montare la board è
      // lavoro di scena, non la scena: sta su una pagina il cui video si
      // butta. Il layout resta scritto sul server (e nel localStorage del
      // contesto, che la scena condivide), quindi la pagina dopo lo ritrova
      // già aperto e non lo rimonta davanti alla telecamera.
      prologo: async (p) => {
        await p.goto("/");
        await openProjectBoard(p, /topics-e2e-recapture-\d/);
        await expect(p.locator(`[data-task-card="${taskId}"]`)).toBeVisible({ timeout: 15000 });
        await waitForProjectPaneType(request, REPO, "kanban");
      },
      scena: async (page) => {
        await page.goto("/");
        const card = page.locator(`[data-task-card="${taskId}"]`);
        await expect(card).toBeVisible({ timeout: 20000 });
        // PRIMO STATO: la card non ha niente da mostrare.
        await expect(card.getByTestId("preview-card")).toHaveCount(0);
        await didascalia(page, "Card in review, nessuna evidenza");
        await beat(page, 1300);

        await card.click();
        const drawer = page.getByTestId("task-detail-drawer");
        await expect(drawer).toBeVisible({ timeout: 10000 });

        const bottone = drawer.getByTestId("task-recapture-preview");
        await expect(bottone).toBeVisible({ timeout: 10000 });
        await didascalia(page, "Un click su «Ricattura evidenza»");
        await beat(page, 1300);
        await bottone.click();

        // SECONDO STATO: l'immagine arriva. Il tempo è quello vero (boot del dev
        // server nel worktree + primo paint + screenshot), non una soglia scelta.
        await didascalia(page, "Il worktree si avvia e si fotografa da solo");
        await expect(drawer.getByTestId("preview-drawer").locator("img")).toBeVisible({ timeout: 90_000 });
        await expect(card.getByTestId("preview-card").locator("img")).toBeVisible({ timeout: 15000 });
        await didascalia(page, "L'anteprima è sulla card");
        await beat(page, 1800);

        // L'immagine si VEDE: il server la serve (l'allowlist dei media la copre) e
        // ha pixel dentro. Un `<img>` rotto sarebbe visibile lo stesso.
        const misura = await card.getByTestId("preview-card").locator("img").evaluate((el) => {
          const img = el as HTMLImageElement;
          return { w: img.naturalWidth, h: img.naturalHeight };
        });
        expect(misura.w, "l'anteprima deve avere pixel, non essere un'immagine rotta").toBeGreaterThan(100);
      },
    });

    // E NON è successo nient'altro: stessa colonna, stessi tentativi, nessun
    // commento umano (che farebbe reject+resume, cioè il risveglio). Sta fuori
    // dalla scena: sono letture d'API, non hanno niente da far vedere.
    const body = await readTask(request, PROJECT_ID, taskId);
    const task = taskOf(body);
    expect(task.status, "il task resta in review").toBe("review");
    expect(task.dispatchAttempts ?? 0, "nessun tentativo consumato").toBe(0);
    expect(task.previewImage, "l'anteprima è scritta sul task").toBeTruthy();
    const comments = body.comments ?? [];
    expect(comments.filter((c) => c.kind === "comment"), "mai il canale che risveglia").toHaveLength(0);
    expect(comments.some((c) => c.kind === "review-note"), "l'esito viaggia su review-note").toBe(true);
  });

  test("RECAPTURE-02: niente da avviare → nessuna foto finta, una nota col motivo", async ({ page, request }) => {
    const taskId = mutedSeeded!.taskId;
    await resetProjectPanes(page.request, MUTED_REPO);
    await seedProjectPane(page.request, MUTED_REPO);
    await page.goto("/");
    await openProjectBoard(page, /topics-e2e-recapture-muto/);

    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    await drawer.getByTestId("task-recapture-preview").click();

    // La nota col motivo compare nel thread: è la risposta a chi ha cliccato.
    await expect(drawer.getByText(/nessuna anteprima possibile/i)).toBeVisible({ timeout: 60_000 });
    await beat(page, 2200);

    const body = await readTask(request, MUTED_PROJECT_ID, taskId);
    const task = taskOf(body);
    expect(task.previewImage ?? null, "nessuna evidenza falsa").toBeNull();
    expect(task.status).toBe("review");
    expect(task.dispatchAttempts ?? 0).toBe(0);
    const comments = body.comments ?? [];
    expect(comments.filter((c) => c.kind === "comment")).toHaveLength(0);
    const nota = comments.find((c) => c.kind === "review-note");
    expect(nota?.content, "il no deve essere motivato, non muto").toMatch(/Motivo:/);
  });
});
