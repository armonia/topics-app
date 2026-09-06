/**
 * board-card-landing-receipt.spec.ts - the land's RECEIPT reaches the card.
 *
 * `POST …/land` answers `202`: the merge is QUEUED, not done, and the card
 * deliberately does not move until main confirms it. The drawer kept that
 * receipt and drew a band from it; the card did `await boardApi.land(...)` and
 * threw it away. So from the board, the surface people actually press, "queued
 * behind two merges", "refused" and "landed" all looked the same: like nothing.
 * A burst of lands looked entirely successful while it was not.
 *
 * The land itself is MOCKED here, and that is the point of the spec: what is
 * under test is the client keeping the ticket and drawing it, not git. The
 * response is the one the server really sends (`202` + `landing`), pinned in
 * `shared/board.ts`.
 *
 * @covers LAND-05
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { canonicalTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const REPO = canonicalTmpDir("e2e-land-ricevuta");

const PROJECT_ID = boardIdForPath(REPO);

const T_BRANCH = "Rifare la scheda prodotto";

/** Two merges ahead: the number is on screen, so a queue of one is not a queue. */
const AHEAD = 2;

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
}

interface WorktreeRow { id: string; status: string; absPath: string }

let topicId: string | null = null;
let worktreePath: string | null = null;
const createdTasks: string[] = [];
let taskId = "";

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
  const btn = projectRow(page, /e2e-land-ricevuta/);
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
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Board · la ricevuta del land arriva sulla card", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    // A real repo and a real worktree: without a delivered BRANCH the card
    // draws other choices and «Landa su main» is not there to press.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-land-ricevuta" }, null, 2));
    writeFileSync(`${REPO}/scheda.txt`, "prima\n");
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    const projectRes = await request.post(`${API}/projects`, { data: { name: `e2e-land-ricevuta-${Date.now()}`, path: REPO } });
    expect(projectRes.ok()).toBe(true);
    const project = (await projectRes.json()) as { id: string };

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
    if (!wt || wt.status !== "ready") throw new Error(`worktree not ready: ${wt?.status}`);
    worktreePath = wt.absPath;

    writeFileSync(`${wt.absPath}/scheda.txt`, "dopo\n");
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "scheda: rifatta"]);

    const topic = await createTopic(request, "E2E-LandRicevuta", { projectPath: REPO });
    topicId = topic.id;
    expect((await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId: wt.id } })).ok()).toBe(true);

    taskId = await createTask(request, { text: T_BRANCH, status: "todo" });
    expect((await request.post(`${API}/test/tasks/${taskId}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
    expect((await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { status: "review" } })).ok()).toBe(true);
    // If this falls, the red is about the SETUP: with no branch the card would
    // show another state's choices and the spec would measure something else.
    const branchRead = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
    expect(((await branchRead.json()) as { task: { deliveryBranch: string | null } }).task.deliveryBranch).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    if (worktreePath && existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    rmSync(REPO, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
  });

  test("LAND-RICEVUTA-01: «Landa su main» dalla card mostra la banda «in coda»", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "LAND-05" });
    await resetProjectPanes(request, REPO);
    await seedProjectPane(request, REPO);

    // The queue is mocked, git is not touched: the ticket is the contract
    // (`LandingTicket`), and the response shape is the server's real one.
    const ticket = {
      taskId,
      phase: "queued",
      ahead: AHEAD,
      queuedAt: new Date().toISOString(),
      settledAt: null,
      error: null,
      outcome: null,
      reason: null,
    };
    let landCalls = 0;
    const mockLand = async (p: Page) => {
      await p.route(`**/api/boards/*/tasks/${taskId}/land`, async (route) => {
        if (route.request().method() === "POST") {
          landCalls += 1;
          await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: taskId, landing: ticket }) });
          return;
        }
        // The `GET` counterpart: the band is followed every 2s, and while the
        // queue does not move it must keep saying the same thing.
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ landing: ticket, pending: AHEAD }) });
      });
    };

    await clipDiConsegna({
      nome: "board-card-landing-receipt",
      // 1280x680 = 0.531 ratio: above 0.70 the card crops the clip from the
      // bottom instead of scaling it down. `locale` because the assertions are
      // in Italian and the app answers in English without it.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      // OUT OF FRAME: opening the project and mounting the board is stage work,
      // not the scene. The layout stays written on the server, so the scene's
      // page finds it already open.
      prologo: async (p) => {
        await p.goto("/");
        await openProjectBoard(p);
        await expect(p.locator(`[data-task-card="${taskId}"]`)).toBeVisible({ timeout: 15000 });
      },
      scena: async (page) => {
        await mockLand(page);
        await page.goto("/");
        const card = page.locator(`[data-task-card="${taskId}"]`);
        await expect(card).toBeVisible({ timeout: 20000 });
        // `toBeVisible` does not scroll: for Playwright a card outside the
        // horizontal scroll is visible all the same, and the clip would open on
        // Backlog with the card off frame.
        await card.scrollIntoViewIfNeeded();

        // FIRST STATE: no band. The card says nothing about any landing,
        // because none has been asked for.
        await expect(card.getByTestId("card-landing")).toHaveCount(0);
        await didascalia(page, "Card in review col ramo consegnato");
        await beat(page, 1400);

        await didascalia(page, "Un click su «Landa su main»");
        await beat(page, 1000);
        await card.getByTestId("task-choice-land").click();

        // SECOND STATE: the receipt, on the card that took the click. The words
        // come from the i18n table, so what is pinned here is the queue's FACT:
        // the state and how many merges are ahead.
        const banda = card.getByTestId("card-landing");
        await expect(banda).toBeVisible({ timeout: 10000 });
        await expect(banda).toContainText("in coda");
        await expect(banda).toContainText(String(AHEAD));
        expect(landCalls).toBe(1);
        await didascalia(page, "La ricevuta: in coda dietro 2 fusioni");
        await beat(page, 1800);

        // And the card has NOT moved: the merge is queued, not done. Closing it
        // here would be the 13/08 fault (cards in `done` with the branch never
        // merged) written the other way round.
        await expect(page.getByTestId("kanban-column-body-review").locator(`[data-task-card="${taskId}"]`))
          .toBeVisible();
      },
    });
  });
});
