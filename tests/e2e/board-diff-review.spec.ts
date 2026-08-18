/**
 * board-diff-review.spec.ts — revisione riga-per-riga del diff di un task.
 *
 * Prima si poteva solo scrivere "nel file X, verso riga 40, quel controllo è
 * sbagliato" a mano nel thread: l'umano ricopiava a occhio path e numero di
 * riga dal diff, e l'agente li ricercava a occhio nel codice. Adesso ogni riga
 * del diff ha un aggancio, le note si accumulano come una revisione in sospeso
 * e partono in UN commento solo — uno perché su un task in review ogni commento
 * risveglia l'agente (server/routes/tasks.ts), quindi una nota per volta sarebbe
 * un turno buttato per nota.
 *
 * Il test gira su un worktree VERO: repo git in /tmp, `POST /api/worktrees`,
 * un commit dentro il worktree, e il diff che l'app mostra è quello che `git`
 * produce davvero. L'unica scorciatoia è il legame task→topic, che nel mondo
 * vero lo fa il dispatcher spawnando un agente: `POST /api/test/tasks/:id/bind-topic`
 * fa quel solo passo (route armata solo con TOPICS_E2E=1, vedi server/routes/e2e.ts).
 *
 * Il task resta in `todo`, NON in `review`: in review il commento fa partire
 * `dispatcher.resume()`, cioè un agente vero. Qui il contratto sotto esame è
 * quello del client — le note diventano un commento unico e ben formato — e la
 * consegna all'agente è comportamento di server già coperto altrove.
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

/** Il file che il "task" modifica: righe numerate, così l'ancora è verificabile a occhio. */
const BEFORE = ["uno", "due", "tre", "quattro", "cinque"].join("\n") + "\n";
const AFTER = ["uno", "due", "TRE", "quattro", "cinque", "sei"].join("\n") + "\n";

interface WorktreeRow { id: string; status: string; absPath: string; branchName: string }

const REPO = `/tmp/topics-e2e-diffreview-${Date.now()}`;
const PROJECT_ID = boardIdForPath(REPO);

let topicId: string | null = null;
let taskId: string | null = null;
let worktreePath: string | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** Apre la board del progetto (stesso percorso di board.spec.ts). */
async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /topics-e2e-diffreview/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  // Idempotente, e non per eleganza: la Board è un SINGLETON del progetto e il
  // layout sopravvive al reload, quindi al secondo giro è già aperta — e il menu
  // + non la elenca più, perché filtra i singleton già presenti. Senza questo
  // ritorno anticipato, "riapri la board dopo il reload" fallisce con "nessun
  // menu + con la voce Board", che sembra un bug del menu e non lo è.
  const alreadyOpen = page.getByTestId("kanban-board");
  if (await alreadyOpen.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) {
    return;
  }

  // Più barre portano un PaneAddMenu e l'ordine nel DOM non è garantito: solo
  // quella del progetto elenca "Board". Si prova finché la voce compare.
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("nessun menu + con la voce Board");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Board · revisione del diff riga per riga", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    // 1. Repo vero, con il file che il task modificherà.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-diffreview" }, null, 2));
    writeFileSync(`${REPO}/conta.txt`, BEFORE);
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    // 2. Progetto + worktree in modalità branch (quello che il dispatcher dà a un agente).
    const proj = await request.post(`${API}/projects`, {
      data: { name: `e2e-diffreview-${Date.now()}`, path: REPO },
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

    // 3. Il "lavoro dell'agente": una riga cambiata e una aggiunta, committate.
    writeFileSync(`${wt.absPath}/conta.txt`, AFTER);
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "conta: TRE maiuscolo e una riga in piu'"]);

    // 4. Topic legata al worktree (e al progetto, così compare in sidebar).
    const topic = await createTopic(request, "E2E-DiffReview", { projectPath: REPO });
    topicId = topic.id;
    const bind = await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId: wt.id } });
    expect(bind.ok()).toBe(true);

    // 5. Task sulla board, legato alla topic come farebbe il dispatcher.
    const taskRes = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Revisione diff E2E", status: "todo" },
    });
    expect(taskRes.ok()).toBe(true);
    taskId = ((await taskRes.json()) as { id: string }).id;

    const bound = await request.post(`${API}/test/tasks/${taskId}/bind-topic`, {
      data: { topicId: topic.id },
    });
    expect(bound.ok()).toBe(true);

    // Il diff deve esserci PRIMA di aprire la UI: se questa asserzione cade, il
    // rosso dice "setup", non "componente".
    const diff = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}/diff`);
    expect(diff.ok()).toBe(true);
    const bundle = (await diff.json()) as { code?: string; patch: string };
    expect(bundle.code).toBeUndefined();
    expect(bundle.patch).toContain("conta.txt");
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

  test("BOARD-DIFF-01: una nota su una riga parte come UN commento con path e riga giusti", async ({ page, request }) => {
    await page.goto("/");
    await openProjectBoard(page);

    await page.getByTestId("kanban-column-todo").getByText("Revisione diff E2E").click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // Il chip "Modifiche" esiste solo se il task ha un worktree con diff.
    // Da agosto 2026 il diff NON è più una sezione del brief: il chip apre una
    // tendina PORTALATA (`task-changes-panel`), quindi da qui in giù si cerca
    // nel pannello e non nel drawer — un diff da trenta file dentro il flusso
    // spingeva sotto l'orizzonte i bottoni della decisione.
    const modifiche = drawer.getByRole("button", { name: /^Modifiche/ });
    await expect(modifiche).toBeVisible({ timeout: 15000 });
    await modifiche.click();
    const pannello = page.getByTestId("task-changes-panel");
    await expect(pannello).toBeVisible({ timeout: 10000 });

    // La riga aggiunta "sei" è la 6 del file NUOVO: l'aggancio deve dirlo.
    // (`TRE` è la 3; sono numeri del file, non indici nel patch.)
    const commenta = pannello.getByRole("button", { name: "Commenta conta.txt:6", exact: true });
    await expect(commenta).toBeVisible({ timeout: 10000 });
    await commenta.click();

    await pannello.getByPlaceholder("Cosa non va in questa riga…").fill("Questa riga non serve.");
    await pannello.getByRole("button", { name: "Aggiungi" }).click();

    // La nota resta in sospeso e si vede: nel diff e nella barra.
    await expect(pannello.getByText("Questa riga non serve.")).toBeVisible();
    await expect(pannello.getByText("1 commento sul diff, non ancora inviati")).toBeVisible();

    await pannello.getByRole("button", { name: "Invia all'agente" }).click();

    // Un commento solo, con l'ancora esatta e il codice citato.
    await expect.poll(async () => {
      const res = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
      if (!res.ok()) return [];
      const got = (await res.json()) as { comments?: { author: string; content: string }[] };
      return (got.comments ?? []).map((c) => c.content);
    }, { timeout: 10000 }).toHaveLength(1);

    const res = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
    const got = (await res.json()) as { comments: { content: string }[] };
    const body = got.comments[0].content;
    // Due punti, non un trattino lungo: `check:emdash` ha tolto il trattino da
    // ogni testo che si legge, e `formatReviewNotes` è uno di quelli. Il fatto
    // che questa riga presidia è il CONTEGGIO (un commento, un file), non il
    // segno di punteggiatura che li separa.
    expect(body).toContain("Revisione del diff: 1 commento su 1 file.");
    expect(body).toContain("**`conta.txt:6`**");
    expect(body).toContain("+sei");
    expect(body).toContain("Questa riga non serve.");

    // Spedito = niente più in sospeso: la barra sparisce e la bozza è vuota.
    await expect(page.getByText("1 commento sul diff, non ancora inviati")).toBeHidden();
  });

  test("BOARD-DIFF-02: la bozza di revisione sopravvive a un reload", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);

    await page.getByTestId("kanban-column-todo").getByText("Revisione diff E2E").click();
    const drawer = page.getByTestId("task-detail-drawer");
    const modifiche = drawer.getByRole("button", { name: /^Modifiche/ });
    await expect(modifiche).toBeVisible({ timeout: 15000 });
    await modifiche.click();
    const pannello = page.getByTestId("task-changes-panel");
    await expect(pannello).toBeVisible({ timeout: 10000 });

    const commenta = pannello.getByRole("button", { name: "Commenta conta.txt:3", exact: true });
    await expect(commenta).toBeVisible({ timeout: 10000 });
    await commenta.click();
    await pannello.getByPlaceholder("Cosa non va in questa riga…").fill("Perché maiuscolo?");
    await pannello.getByRole("button", { name: "Aggiungi" }).click();
    await expect(pannello.getByText("1 commento sul diff, non ancora inviati")).toBeVisible();

    // La bozza va sul server con un debounce: si aspetta che sia atterrata,
    // altrimenti il reload la corre contro e il test misura la corsa, non la
    // persistenza.
    await page.waitForTimeout(1200);
    await page.reload();
    await openProjectBoard(page);
    await page.getByTestId("kanban-column-todo").getByText("Revisione diff E2E").click();

    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15000 });
    // Con note in sospeso la tendina si apre da sé: il lavoro non resta nascosto.
    const back = page.getByTestId("task-changes-panel");
    await expect(back.getByText("Perché maiuscolo?")).toBeVisible({ timeout: 15000 });
    await expect(back.getByText("1 commento sul diff, non ancora inviati")).toBeVisible();

    // Pulizia: scartata, così il test seguente non eredita la bozza.
    await back.getByRole("button", { name: "Scarta" }).click();
    await expect(page.getByText("1 commento sul diff, non ancora inviati")).toBeHidden();
  });
});
