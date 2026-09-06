/**
 * board-task-changes-panel.spec.ts — il pannello «Modifiche» risponde alla
 * domanda giusta, e continua a rispondere dopo il land.
 *
 * Tre stati, su un repo git VERO e un worktree vero:
 *
 *  1. Il ramo della card nasce da un ALTRO ramo (com'era prima di
 *     `worktree-base-ref.ts`, e com'è ancora per ogni ramo nato allora): porta
 *     un commit che non è suo. Il pannello deve elencare UN file — il suo — e
 *     mettere in testa il totale di quel file solo. Con `merge-base main HEAD`
 *     ne elencava due, e la card si intestava il lavoro di un'altra sessione.
 *
 *  2. Il land: merge su main e worktree potato. Qui il pannello spariva —
 *     `no_worktree`, nessun disegno — proprio quando serve di più, cioè a cose
 *     fatte. Deve restare, leggendo dal merge, e DIRE che sta leggendo da lì.
 *
 *  3. Nessun riferimento da cui ricostruire: deve dirlo. Un pannello assente e
 *     un pannello che dice «non ho potuto guardare» sono la stessa immagine per
 *     chi rivede, e sono due verdetti opposti.
 *
 * Il task resta in `todo`: in review un commento risveglia il dispatcher, e qui
 * sotto esame c'è cosa il drawer DISEGNA, non la consegna.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { canonicalTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

interface WorktreeRow { id: string; status: string; absPath: string; branchName: string }

// Canonical spelling (`/private/tmp` on macOS): the board id is hashed from the
// resolved projectPath, so a literal `/tmp` wrote the card to a board the pane
// never read — locally only, the Linux runner has a real `/tmp`.
const REPO = canonicalTmpDir("topics-e2e-changespanel");
const PROJECT_ID = boardIdForPath(REPO);
/** Il ramo dell'altra sessione: è da qui che il worktree della card nasce. */
const ALTRA = "topics/altra-sessione";

let topicId: string | null = null;
let landedTopicId: string | null = null;
let orphanTopicId: string | null = null;
let taskId: string | null = null;
let landedTaskId: string | null = null;
let orphanTaskId: string | null = null;
let worktreePath: string | null = null;
let landedPath: string | null = null;
let landedBranch: string | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /topics-e2e-changespanel/);
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

/** Apre il drawer di un task dalla colonna Todo. */
async function openTask(page: Page, title: string) {
  await page.getByTestId("kanban-column-todo").getByText(title).click();
  const drawer = page.getByTestId("task-detail-drawer");
  await expect(drawer).toBeVisible({ timeout: 10000 });
  return drawer;
}

test.describe.serial("Board · il pannello Modifiche", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    // 1. Repo vero. `main` porta il file di partenza.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-changespanel" }, null, 2));
    writeFileSync(`${REPO}/lista.txt`, "uno\ndue\n");
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    // 2. L'ALTRA sessione, parcheggiata sul checkout condiviso con il suo commit.
    git(REPO, ["checkout", "-q", "-b", ALTRA]);
    writeFileSync(`${REPO}/roba-di-un-altro.ts`, "export const nonMio = 1;\n");
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "lavoro di un'altra sessione"]);
    git(REPO, ["checkout", "-q", "main"]);

    const proj = await request.post(`${API}/projects`, { data: { name: `e2e-changespanel-${Date.now()}`, path: REPO } });
    expect(proj.ok()).toBe(true);
    const project = (await proj.json()) as { id: string };

    async function makeWorktree(baseRef: string): Promise<WorktreeRow> {
      const res = await request.post(`${API}/worktrees`, { data: { project_id: project.id, mode: "branch", base_ref: baseRef } });
      expect(res.status()).toBe(202);
      const created = (await res.json()) as { id: string };
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const got = await request.get(`${API}/worktrees/${created.id}`);
        if (got.ok()) {
          const row = (await got.json()) as WorktreeRow;
          if (row.status !== "pending") {
            if (row.status !== "ready") throw new Error(`worktree non pronto: ${row.status}`);
            return row;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error("worktree mai pronto");
    }

    /** Un task legato alla sua chat, com'è dopo un dispatch. */
    async function makeTask(text: string, worktreeId: string | null): Promise<{ taskId: string; topicId: string }> {
      const topic = await createTopic(request, `E2E-ChangesPanel-${text}`, { projectPath: REPO });
      if (worktreeId) expect((await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId } })).ok()).toBe(true);
      const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: { text, status: "todo" } });
      expect(res.ok()).toBe(true);
      const id = ((await res.json()) as { id: string }).id;
      expect((await request.post(`${API}/test/tasks/${id}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
      return { taskId: id, topicId: topic.id };
    }

    // 3. La card MISTA: il suo worktree nasce dal ramo dell'altra sessione, quindi
    //    il suo ramo porta anche un commit che non è suo.
    const wt = await makeWorktree(ALTRA);
    worktreePath = wt.absPath;
    writeFileSync(`${wt.absPath}/consegna.ts`, "export const mio = 1;\nexport const anche = 2;\n");
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "la consegna della card"]);
    ({ taskId, topicId } = await makeTask("Card con worktree", wt.id));

    // 4. La card PULITA, nata da main: è quella che il land fa atterrare con un
    //    `merge --no-ff` (per un ramo misto il land ricopia i commit, non fonde).
    const wtL = await makeWorktree("main");
    landedPath = wtL.absPath;
    landedBranch = wtL.branchName;
    writeFileSync(`${wtL.absPath}/atterrata.ts`, "export const uno = 1;\nexport const due = 2;\n");
    git(wtL.absPath, ["add", "-A"]);
    git(wtL.absPath, ["commit", "-q", "-m", "il lavoro che atterra"]);
    ({ taskId: landedTaskId, topicId: landedTopicId } = await makeTask("Card atterrata", wtL.id));

    // 5. La card SENZA niente da cui ricostruire: una chat, nessun worktree.
    const orphanTopic = await createTopic(request, "E2E-ChangesPanel-Orfana", { projectPath: REPO });
    orphanTopicId = orphanTopic.id;
    const orphanRes = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: { text: "Card senza worktree", status: "todo" } });
    expect(orphanRes.ok()).toBe(true);
    orphanTaskId = ((await orphanRes.json()) as { id: string }).id;
    expect((await request.post(`${API}/test/tasks/${orphanTaskId}/bind-topic`, { data: { topicId: orphanTopic.id } })).ok()).toBe(true);

    // Il contratto del server PRIMA della UI: se cade qui, il rosso dice "setup".
    const diff = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}/diff`);
    expect(diff.ok()).toBe(true);
    const bundle = (await diff.json()) as { code?: string; source?: string; stat: { path: string }[] };
    expect(bundle.code).toBeUndefined();
    expect(bundle.source).toBe("worktree");
    expect(bundle.stat.map((s) => s.path)).toEqual(["consegna.ts"]);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [taskId, landedTaskId, orphanTaskId]) if (id) await deleteTask(request, PROJECT_ID, id);
    for (const id of [topicId, landedTopicId, orphanTopicId]) if (id) await deleteTopic(request, id);
    for (const p of [worktreePath, landedPath]) if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
    rmSync(REPO, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
  });

  test("CHANGES-01: elenca i file DELLA CARD, non quelli ereditati, col totale in testa", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-43" });
    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openTask(page, "Card con worktree");

    const modifiche = drawer.getByRole("button", { name: /^Modifiche/ });
    await expect(modifiche).toBeVisible({ timeout: 15000 });
    // Un file, e il totale è quello di QUEL file: il commit ereditato non c'è.
    await expect(modifiche).toContainText("1 file");
    await expect(modifiche).toContainText("+2");
    await expect(modifiche).toContainText("−0");

    // Il chip apre una tendina PORTALATA: il diff non vive più nel flusso del
    // brief, quindi si cerca nel pannello e non dentro il drawer.
    await modifiche.click();
    const pannello = page.getByTestId("task-changes-panel");
    await expect(pannello.getByRole("button", { name: /^consegna\.ts/ })).toBeVisible({ timeout: 10000 });
    await expect(pannello.getByRole("button", { name: /roba-di-un-altro/ })).toHaveCount(0);
  });

  test("CHANGES-02: dopo il land il pannello RESTA, e dice da dove legge", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);
    let drawer = await openTask(page, "Card atterrata");
    await expect(drawer.getByRole("button", { name: /^Modifiche/ })).toBeVisible({ timeout: 15000 });

    // Il land: merge su main con il messaggio che il land scrive davvero, poi il
    // reap — worktree rimosso e ramo cancellato. Da qui in poi l'unica traccia
    // di cosa ha portato la card è quel merge.
    git(REPO, ["merge", "--no-ff", "-m", `merge task ${landedTaskId}: Card atterrata`, landedBranch!]);
    git(REPO, ["worktree", "remove", "--force", landedPath!]);
    git(REPO, ["branch", "-D", landedBranch!]);
    landedPath = null;

    // Il drawer legge il diff al montaggio: si chiude e si riapre, come farebbe
    // chiunque tornasse sulla card dopo l'atterraggio.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-detail-drawer")).toBeHidden({ timeout: 10000 });
    drawer = await openTask(page, "Card atterrata");

    const modifiche = drawer.getByRole("button", { name: /^Modifiche/ });
    await expect(modifiche).toBeVisible({ timeout: 15000 });
    await expect(modifiche).toContainText("1 file");
    await expect(modifiche).toContainText("dal merge su main");

    await modifiche.click();
    await expect(page.getByTestId("task-changes-panel").getByRole("button", { name: /^atterrata\.ts/ }))
      .toBeVisible({ timeout: 10000 });
  });

  test("CHANGES-03: senza niente da cui ricostruire lo DICE, invece di sparire", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openTask(page, "Card senza worktree");

    await expect(drawer.getByText(/Diff non ricostruibile/)).toBeVisible({ timeout: 15000 });
    // Nessuna barra apribile: non c'è niente da aprire, e non si finge il contrario.
    await expect(drawer.getByRole("button", { name: /^Modifiche/ })).toHaveCount(0);
  });
});
