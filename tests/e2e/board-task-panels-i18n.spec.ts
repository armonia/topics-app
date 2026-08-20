/**
 * board-task-panels-i18n.spec.ts — i tre sotto-pannelli CONDIZIONALI del drawer
 * (Checks, Modifiche, Tentativi) letti in INGLESE.
 *
 * Perché esiste, e perché non basta il resto della suite. Ogni altra spec della
 * board gira in italiano — `playwright.config.ts` fissa `locale: "it-IT"`
 * apposta — quindi una stringa dimenticata dentro questi tre pannelli non
 * farebbe cadere niente: resterebbe italiana in un'app inglese, e lo scoprirebbe
 * un utente. Questi tre in particolare non li vede nemmeno lo scanner di
 * copertura (`scripts/i18n-coverage.ts`), perché il loro testo sta dentro
 * espressioni JSX multi-riga e non fra due tag.
 *
 * L'italiano NON si riprova qui: lo ancorano già `board-fanout.spec.ts`
 * («2 in parallelo», «1 in corso», «scelto», «scartato», «1 file») e
 * `board-diff-review.spec.ts` («^Modifiche», «1 commento sul diff, non ancora
 * inviati», «Scarta», «Invia all'agente»). Sono loro il cancello che dice se la
 * conversione ha spostato un byte dei valori italiani; questa spec dice l'altra
 * metà, cioè che esiste davvero un inglese.
 *
 * Lo stato è quello vero di una review di fan-out: un task in `review` con due
 * tentativi da confrontare e il worktree del tentativo 1 con due file cambiati.
 * Le scorciatoie sono due, entrambe di semina:
 *  - `POST /api/test/tasks/:id/attempts` (armata solo con TOPICS_E2E=1) — le
 *    stesse righe che nel mondo vero scrive il dispatcher lanciando N agenti.
 *  - i checks pre-review sono STUBBATI sulla risposta di
 *    `GET /boards/:p/tasks/:t`: `runChecksGate` gira solo dentro la consegna di
 *    una sessione d'agente autenticata (server/routes/tasks.ts), che qui non si
 *    può far partire. `ChecksSection` è una funzione pura del task, quindi lo
 *    stub le passa esattamente la forma che il server produce — il componente
 *    sotto esame resta codice di produzione.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

const REPO = `/tmp/topics-e2e-i18npanels-${Date.now()}`;
const PROJECT_ID = boardIdForPath(REPO);

/** DUE file cambiati, non uno: è il ramo plurale — «2 file» in italiano resta
 *  «2 file», in inglese diventa «2 files», e un solo file non lo proverebbe. */
const BEFORE = ["uno", "due", "tre"].join("\n") + "\n";
const AFTER = ["uno", "due", "TRE", "quattro"].join("\n") + "\n";

interface WorktreeRow { id: string; status: string; absPath: string; branchName: string }

let topicA: string | null = null;
let topicB: string | null = null;
let projectTopicId: string | null = null;
let taskId: string | null = null;
let worktreePath: string | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** Un giro di checks ROSSO come lo registra `svc.recordChecks` (shared/board.ts:CheckRun). */
const CHECKS_AT = "2026-08-11T09:30:00.000Z";
const CHECK_RUNS = [
  { name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 4200, timedOut: false, tail: "" },
  { name: "unit", cmd: "bun run test:unit", ok: false, code: 1, ms: 9100, timedOut: false, tail: "1 fail\nerror: script \"test:unit\" exited with code 1" },
];

/** Apre la board del progetto (stesso percorso di board-diff-review.spec.ts). */
async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /topics-e2e-i18npanels/);
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

test.describe("Board · i pannelli condizionali del task parlano inglese", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    // 1. Repo vero con i due file che il "tentativo 1" modificherà.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-i18npanels" }, null, 2));
    writeFileSync(`${REPO}/conta.txt`, BEFORE);
    writeFileSync(`${REPO}/altro.txt`, BEFORE);
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    // 2. Progetto + worktree in modalità branch (quello che il dispatcher dà a un agente).
    const proj = await request.post(`${API}/projects`, { data: { name: `e2e-i18npanels-${Date.now()}`, path: REPO } });
    expect(proj.ok()).toBe(true);
    const project = (await proj.json()) as { id: string };

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

    // 3. Il "lavoro del tentativo 1": due file cambiati e committati.
    writeFileSync(`${wt.absPath}/conta.txt`, AFTER);
    writeFileSync(`${wt.absPath}/altro.txt`, AFTER);
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "due file cambiati"]);

    // 4. Le tre topic: quella del progetto (per la sidebar) e le due chat dei tentativi.
    projectTopicId = (await createTopic(request, "E2E-I18nPanels", { projectPath: REPO })).id;
    topicA = (await createTopic(request, "E2E-I18nPanels · tentativo 1", { projectPath: REPO })).id;
    topicB = (await createTopic(request, "E2E-I18nPanels · tentativo 2", { projectPath: REPO })).id;
    // Il worktree sta sulla chat del tentativo 1: è da lì che esce il diff.
    const bindWt = await request.patch(`${API}/topics/${topicA}`, { data: { worktreeId: wt.id } });
    expect(bindWt.ok()).toBe(true);

    // 5. Il task in review con i due tentativi, puntato sul tentativo 1.
    const taskRes = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Pannelli i18n E2E", status: "review" },
    });
    expect(taskRes.ok()).toBe(true);
    taskId = ((await taskRes.json()) as { id: string }).id;

    const seeded = await request.post(`${API}/test/tasks/${taskId}/attempts`, {
      data: {
        attempts: [
          { idx: 1, topicId: topicA, branch: "task/wt-a", state: "delivered", commit: "aaa111", filesChanged: 2, insertions: 4, deletions: 2, summary: "Toppa minima sul solo caso segnalato." },
          { idx: 2, topicId: topicB, branch: "task/wt-b", state: "delivered", commit: "bbb222", filesChanged: 7, insertions: 91, deletions: 13, summary: "Rifatta la funzione e coperta con due test." },
        ],
      },
    });
    expect(seeded.ok()).toBe(true);
    const bound = await request.post(`${API}/test/tasks/${taskId}/bind-topic`, { data: { topicId: topicA } });
    expect(bound.ok()).toBe(true);

    // Il diff deve esserci PRIMA della UI: se cade qui, il rosso dice "setup".
    const diff = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}/diff`);
    expect(diff.ok()).toBe(true);
    const bundle = (await diff.json()) as { code?: string; stat: unknown[] };
    expect(bundle.code).toBeUndefined();
    expect(bundle.stat).toHaveLength(2);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    for (const id of [topicA, topicB, projectTopicId]) if (id) await deleteTopic(request, id);
    if (worktreePath && existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    rmSync(REPO, { recursive: true, force: true });
    // La lingua torna com'era: è preferenza di UTENTE, condivisa da tutta la
    // suite attraverso `ui_state`, e lasciarla in inglese renderebbe rosse le
    // spec italiane che girano dopo.
    await request.put(`${API}/ui-state/settings`, { data: { language: "auto" } });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
  });

  test("I18N-PANELS-01: Checks, Changes e Attempts rendono in inglese", async ({ page }) => {
    // La lingua si scrive nei DUE depositi che l'app legge: localStorage (che
    // dipinge il primo frame) e `ui_state` (da cui idrata subito dopo). Scriverne
    // uno solo significa vedere l'inglese e poi guardarlo tornare italiano.
    await page.request.put(`${API}/ui-state/settings`, { data: { language: "en" } });
    await page.addInitScript(() => {
      const KEY = "app-settings";
      let cur: Record<string, unknown> = {};
      try { cur = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>; } catch { /* vuoto */ }
      localStorage.setItem(KEY, JSON.stringify({ ...cur, language: "en" }));
    });

    // I checks: unica via per averli senza far consegnare un agente vero.
    await page.route(
      (url) => url.pathname === `/api/boards/${PROJECT_ID}/tasks/${taskId}`,
      async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as { task?: Record<string, unknown> };
        if (body?.task) {
          body.task.checksState = "fail";
          body.task.checksAt = CHECKS_AT;
          body.task.checks = CHECK_RUNS;
        }
        await route.fulfill({ response: res, json: body });
      },
    );

    await page.goto("/");
    await openProjectBoard(page);
    await page.getByTestId("kanban-column-review").getByText("Pannelli i18n E2E").click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // ── Tentativi → Attempts ────────────────────────────────────────────────
    await expect(drawer.getByText("2 in parallel")).toBeVisible({ timeout: 15000 });
    await expect(drawer.getByText("Pick one: the task takes its branch")).toBeVisible();
    const first = drawer.getByTestId("task-attempt-1");
    const second = drawer.getByTestId("task-attempt-2");
    // Il diffstat: singolare e plurale, tradotti entrambi.
    await expect(first).toContainText("Attempt 1");
    await expect(first).toContainText("2 files · +4 −2");
    await expect(second).toContainText("7 files · +91 −13");
    await expect(drawer.getByRole("button", { name: "Pick this one" }).first()).toBeVisible();
    await first.getByRole("button", { name: "See the diff" }).click();
    await expect(first.getByRole("button", { name: "Close the diff" })).toBeVisible({ timeout: 10000 });
    await first.getByRole("button", { name: "Close the diff" }).click();

    // ── Modifiche → Changes ─────────────────────────────────────────────────
    const changes = drawer.getByRole("button", { name: /^Changes/ });
    await expect(changes).toBeVisible({ timeout: 15000 });
    await expect(changes).toContainText("2 files");
    await changes.click();
    // Il chip apre una tendina PORTALATA: sta fuori dal drawer nel DOM, quindi
    // il diff si cerca lì.
    const changesPanel = page.getByTestId("task-changes-panel");
    await expect(changesPanel).toBeVisible({ timeout: 10000 });

    // La barra delle note in sospeso vive solo con una nota scritta. L'aggancio
    // sta in `UnifiedDiff`, che il 20/08 ha smesso di essere italiano insieme
    // al resto di `client/src`: le tre àncore qui sotto erano in italiano e
    // sono passate all'inglese col resto del pannello. Se un giorno tornassero
    // rosse, la domanda giusta è «chi ha tolto la chiave», non «chi ha
    // cambiato il testo».
    // Con PIÙ di un file nessuna card si apre da sola (`defaultOpenFirst` vale
    // solo per un patch a file unico): il file va aperto, ed è il prezzo di
    // avere due file per provare il plurale.
    await changesPanel.getByRole("button", { name: /^conta\.txt/ }).click();
    // Qualunque riga agganciabile del file appena aperto: quale sia dipende da
    // come git spezza il patch, e questa spec non parla di quello.
    const commenta = changesPanel.getByRole("button", { name: /^Comment on .+:\d+$/ }).first();
    await expect(commenta).toBeVisible({ timeout: 10000 });
    await commenta.click();
    await changesPanel.getByPlaceholder("What is wrong with this line…").fill("Perché maiuscolo?");
    await changesPanel.getByRole("button", { name: "Add" }).click();

    await expect(changesPanel.getByText("1 comment on the diff, not sent yet")).toBeVisible({ timeout: 10000 });
    // «1 pending» sta sul CHIP, che è rimasto nel drawer: è la traccia che il
    // lavoro esiste anche a tendina chiusa.
    await expect(changes).toContainText("1 pending");
    await expect(changesPanel.getByRole("button", { name: "Send to the agent" })).toBeVisible();
    // Scartata subito: una bozza lasciata lì viaggia sul server e la ritroverebbe
    // il test seguente.
    await changesPanel.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText("1 comment on the diff, not sent yet")).toBeHidden();
    // La tendina si chiude: le sezioni che vengono dopo stanno sotto di lei.
    await page.keyboard.press("Escape");
    await expect(changesPanel).toBeHidden({ timeout: 5000 });

    // ── Checks ──────────────────────────────────────────────────────────────
    const checks = drawer.getByRole("button", { name: /^Checks RED/ });
    await expect(checks).toBeVisible({ timeout: 10000 });
    await expect(checks).toContainText("unit (exit 1)");
    await checks.click();
    await expect(drawer.getByText("The normal path is")).toBeVisible();
    await expect(drawer.getByText("the agent restarts with this output")).toBeVisible();

    // Solo sotto E2E_EVIDENCE, cioè quando questa spec sta girando per PRODURRE
    // la clip di consegna. Due cose che al test non servono e alla prova sì:
    // `toBeVisible` di Playwright non vuole l'elemento DENTRO il viewport (basta
    // che abbia un rettangolo), quindi il pannello Checks può essere asserito
    // verde mentre resta sotto il bordo del drawer — invisibile in video; e la
    // registrazione si chiude insieme al contesto, cioè l'ultimo mezzo secondo
    // non arriva nel file. Nel giro normale (senza la variabile) queste righe
    // non esistono e il gate non paga un secondo.
    if (process.env.E2E_EVIDENCE === "1") {
      await drawer.getByText("The normal path is").scrollIntoViewIfNeeded();
      await page.waitForTimeout(2500);
    }
  });
});
