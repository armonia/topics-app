/**
 * board-text-never-lands.spec.ts — a sentence typed on a review card never
 * merges the branch.
 *
 * THE INCIDENT THIS EXISTS FOR. Task b673a253 was in review with a delivered
 * branch. Someone typed feedback in the card's free field and pressed Enter.
 * Enter ran `taskChoices(task)[0]`, and on a delivered card with a branch the
 * first choice is «Landa su main»: the branch was merged into main (commit
 * 8b97e432) and the task closed itself. The sentence — the whole point of the
 * gesture — was filed as a quiet comment next to the merge it had caused.
 *
 * A verdict has no room for words. `land` and `accept` take no comment, their
 * buttons have no field: running one because text exists throws the text away
 * AND decides something irreversible. So Enter now runs the choice the SENTENCE
 * belongs to (`choiceForText`), which on this shape is «Rimanda indietro».
 *
 * WHAT MAKES THIS TEST WORTH ITS MINUTE: it does not ask the UI whether it
 * landed. It asks GIT. The repo is real, the branch is real and carries a
 * commit main does not have, and after Enter main must still be exactly where
 * it was. A UI assertion would have passed against the buggy build too — the
 * card also left the review column back then, only through the wrong door.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const REPO = `/tmp/e2e-non-landa-${Date.now()}`;

const PROJECT_ID = boardIdForPath(REPO);

const T_RAMO = "Rifare la scheda prodotto";
const FEEDBACK = "manca il caso B, il video non lo mostra";

/**
 * Identity via `-c`, never from the machine: without it `git commit` dies with
 * «Please tell me who you are» on CI and never on the laptop where the spec was
 * written. `commit.gpgsign=false` covers the other side — a signing setup hangs
 * on a passphrase nobody can see.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();
}

interface WorktreeRow { id: string; status: string; absPath: string }

let topicId: string | null = null;
let worktreePath: string | null = null;
let taskId = "";
let branch = "";
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
  const btn = projectRow(page, /e2e-non-landa/);
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

test.describe("Una frase scritta su una card in review non fonde il ramo", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-non-landa" }, null, 2));
    writeFileSync(`${REPO}/scheda.txt`, "prima\n");
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    const proj = await request.post(`${API}/projects`, { data: { name: `e2e-non-landa-${Date.now()}`, path: REPO } });
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

    // The agent's "work", committed on its own branch. The fixture file says
    // something main does not say: that difference is what a merge would carry
    // over, so it is also the sharpest way to detect one.
    writeFileSync(`${wt.absPath}/scheda.txt`, "dopo\n");
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "scheda: rifatta"]);
    branch = git(wt.absPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

    const topic = await createTopic(request, "E2E-NonLanda", { projectPath: REPO });
    topicId = topic.id;
    expect((await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId: wt.id } })).ok()).toBe(true);

    taskId = await createTask(request, { text: T_RAMO, status: "todo" });
    expect((await request.post(`${API}/test/tasks/${taskId}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
    expect((await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { status: "review" } })).ok()).toBe(true);
    // If this one falls, the red is about the SETUP: with no branch the card
    // draws another shape's choices and the test measures something else.
    const ramo = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
    expect(((await ramo.json()) as { task: { deliveryBranch: string | null } }).task.deliveryBranch).toBeTruthy();
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

  test("Invio manda indietro all'agente e main resta dov'era", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-45" });
    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // (0) PRECONDITION, so the negative below is not vacuous: this IS the shape
    //     where the incident happened — «Landa su main» is on screen and it is
    //     the first choice — and the branch really carries a commit main lacks.
    await expect(card.getByTestId("task-choice-land")).toHaveText("Landa su main");
    const inRamo = git(REPO, ["rev-list", "--count", `main..${branch}`]).trim();
    expect(inRamo).toBe("1");

    // (1) THE SEND BUTTON NAMES THE DOOR THE TEXT GOES THROUGH. It used to name
    //     the first choice, so it promised «Landa su main» and the keyboard did
    //     exactly that. Keyboard and click must agree, and they must agree on
    //     the gesture that carries words.
    const send = card.getByTestId("card-reply-send");
    await expect(send).toHaveAttribute("aria-label", /Rimanda indietro/);
    await expect(send).not.toHaveAttribute("aria-label", /Landa/);

    // (2) The gesture that caused the incident: type feedback, press Enter.
    const field = card.locator("input").first();
    await field.fill(FEEDBACK);
    await field.press("Enter");

    // (3) The card goes BACK TO THE AGENT, not to done: `send-back` is a reject,
    //     and the server puts the task back in progress and resumes the tab.
    await expect(page.getByTestId("kanban-column-body-in_progress").locator(`[data-task-card="${taskId}"]`))
      .toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("kanban-column-body-done").locator(`[data-task-card="${taskId}"]`))
      .toHaveCount(0);

    // (4) AND THE PROOF THAT DOES NOT COME FROM THE UI. Main is untouched: same
    //     single commit, same file content. Had Enter landed, the file would
    //     carry the branch's line and main would have two commits plus a merge.
    expect(git(REPO, ["rev-list", "--count", "main"]).trim()).toBe("1");
    expect(readFileSync(`${REPO}/scheda.txt`, "utf8")).toBe("prima\n");
    expect(git(REPO, ["rev-list", "--count", `main..${branch}`]).trim()).toBe("1");
  });
});
