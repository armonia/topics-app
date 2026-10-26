/**
 * board-cloud-card.spec.ts — a card that runs on «Cloud Claude» goes from todo
 * to review without a single agent process on this Mac.
 *
 * The cloud is a machine like a paired node: chosen in the card's "where it
 * runs" picker, read in the column as «su Cloud Claude», driven by the same
 * remote lane. What differs is the far end: a Claude Code cloud session, which
 * clones from origin, pushes its branch there and ends with a `result`. Here
 * that session is a fake (`helpers/fake-claude-cloud.ts`) that does the same
 * push on a local bare origin, so the bundle, the planted branch and the move
 * to review are the production path.
 *
 * The bar: the branch the session pushed is in THIS checkout, with the file it
 * wrote, and the card says where the session lives.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectRow } from "./helpers/project-row";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { beat, didascalia } from "./helpers/evidence";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { startFakeClaudeCloud, type FakeClaudeCloud } from "./helpers/fake-claude-cloud";

hermetic(test);
// The video IS the proof of the bar: it is kept even when the test passes.
test.use({ video: "on" });
test.describe.configure({ timeout: 150_000 });

const BASE = E2E_BASE;
const STAMP = Date.now();
const ROOT = join(realpathSync(canonicalTmpRoot()), `e2e-cloud-${STAMP}`);
const ORIGIN = join(ROOT, "origin.git");
const PROJECT_PATH = join(ROOT, "e2e-cloud-progetto");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const CARD_TEXT = "Aggiungi il file CIAO.md con un saluto";
const SUMMARY = "Aggiunto CIAO.md con il saluto, verificato con cat.";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

type TaskRow = { task: { status: string; machineId: string | null; dispatchState: string | null }; comments: Array<{ content: string; author: string }> };

async function readTask(request: any, id: string): Promise<TaskRow> {
  const res = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`);
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

async function openProjectBoard(page: Page) {
  const section = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") await section.click();
  const row = projectRow(page, /e2e-cloud-progetto/);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
  const board = page.getByTestId("kanban-board");
  if (await board.first().isVisible({ timeout: 3000 }).catch(() => false)) return;
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      await item.click();
      await expect(board).toBeVisible({ timeout: 10000 });
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("nessun menu + con la voce Board");
}

test("una card su «Cloud Claude» gira nel cloud e torna in review col suo ramo", async ({ page, request }) => {
  let cloud: FakeClaudeCloud | null = null;
  let topicId: string | null = null;
  let taskId: string | null = null;
  let cloudMachineId: string | null = null;
  let original: { autoDispatch: boolean; dispatchUseWorktree: boolean } | null = null;
  try {
    // The project: a checkout with an origin, like a GitHub repo.
    mkdirSync(ROOT, { recursive: true });
    git(ROOT, ["init", "--bare", "-q", "-b", "main", ORIGIN]);
    git(ROOT, ["clone", "-q", ORIGIN, PROJECT_PATH]);
    writeFileSync(join(PROJECT_PATH, "package.json"), JSON.stringify({ name: "e2e-cloud" }));
    git(PROJECT_PATH, ["add", "."]);
    git(PROJECT_PATH, ["commit", "-q", "-m", "base"]);
    git(PROJECT_PATH, ["push", "-q", "origin", "main"]);

    cloud = await startFakeClaudeCloud({ originPath: ORIGIN, file: { path: "CIAO.md", content: "ciao dal cloud\n" }, summary: SUMMARY, workMs: 4000 });
    const armed = await request.post(`${BASE}/api/test/claude-cloud`, { data: { apiBase: cloud.baseUrl } });
    expect(armed.ok(), await armed.text()).toBe(true);
    cloudMachineId = ((await armed.json()) as { machine: { id: string } }).machine.id;

    const registered = await request.post(`${BASE}/api/projects`, { data: { name: "e2e-cloud-progetto", path: PROJECT_PATH } });
    expect(registered.ok(), await registered.text()).toBe(true);
    topicId = (await createTopic(request, `E2E-Cloud-${STAMP}`, { projectPath: PROJECT_PATH })).id;
    const settings = await request.get(`${BASE}/api/boards/${PROJECT_ID}/settings`);
    original = await settings.json();
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);

    // The card starts out idle: choosing the place is a person's job, in the card's panel.
    const created = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text: CARD_TEXT, status: "backlog" } });
    expect(created.ok(), await created.text()).toBe(true);
    taskId = ((await created.json()) as { id: string }).id;

    await page.goto("/");
    await openProjectBoard(page);
    const cardEl = page.locator(`[data-task-card="${taskId}"]`);
    await expect(cardEl).toBeVisible({ timeout: 15000 });
    await didascalia(page, "Una card nuova: per ora girerebbe qui, su questo Mac");
    await beat(page, 1800);

    await cardEl.getByText(CARD_TEXT).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await drawer.getByTestId("task-details-toggle").click();
    const chip = drawer.getByTestId("task-node-chip");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();
    const option = page.getByRole("option", { name: /Cloud Claude/ });
    await expect(option).toBeVisible({ timeout: 5000 });
    await didascalia(page, "«Dove gira»: fra le macchine c'è Cloud Claude");
    await beat(page, 2000);
    await option.click();
    await expect(chip).toContainText("Cloud Claude", { timeout: 10000 });
    await expect.poll(async () => (await readTask(request, taskId!)).task.machineId, { timeout: 10000 }).toBe(cloudMachineId);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden({ timeout: 5000 });
    await expect(cardEl.getByTestId("card-node-chip")).toContainText("su Cloud Claude", { timeout: 10000 });
    await didascalia(page, "Dalla colonna: «su Cloud Claude»");
    await beat(page, 1800);

    // The go: queued and dispatcher on.
    const go = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/settings`, { data: { autoDispatch: true, dispatchUseWorktree: false } });
    expect(go.ok(), await go.text()).toBe(true);
    const queued = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { status: "todo" } });
    expect(queued.ok(), await queued.text()).toBe(true);

    await expect.poll(() => cloud!.sessions.length, { timeout: 45000, message: "il dispatcher ha aperto la sessione cloud" }).toBe(1);
    const session = cloud.sessions[0]!;
    expect(session.branch).toMatch(new RegExp(`^claude/card-${taskId.slice(0, 8)}-`));
    expect(session.prompt).toContain(CARD_TEXT);
    await expect.poll(async () => (await readTask(request, taskId!)).task.dispatchState, { timeout: 20000 }).toBe("working");
    await didascalia(page, "La sessione lavora nel cloud: su questo Mac nessun agente");
    await beat(page, 2000);

    await expect.poll(async () => (await readTask(request, taskId!)).task.status, { timeout: 60000, message: "la card è tornata in review" }).toBe("review");
    const done = await readTask(request, taskId);
    const delivery = done.comments.find((c) => c.content.includes(`https://claude.ai/code/${session.id}`));
    expect(delivery?.content).toContain(SUMMARY);

    // The real proof: the session's branch is in THIS checkout, with the file it wrote.
    expect(git(PROJECT_PATH, ["show", `${session.branch}:CIAO.md`])).toBe("ciao dal cloud");

    await cardEl.getByText(CARD_TEXT).click();
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer).toContainText(SUMMARY, { timeout: 15000 });
    await didascalia(page, "In review, col riassunto della sessione e il suo ramo già qui");
    await beat(page, 2600);
  } finally {
    if (original) await request.patch(`${BASE}/api/boards/${PROJECT_ID}/settings`, { data: original }).catch(() => {});
    if (taskId) {
      await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { machineId: null } }).catch(() => {});
      await deleteTask(request, PROJECT_ID, taskId).catch(() => {});
    }
    await request.post(`${BASE}/api/test/claude-cloud`, { data: { apiBase: null } }).catch(() => {});
    if (cloudMachineId) await request.delete(`${BASE}/api/machines/${cloudMachineId}`).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    await cloud?.close();
    removeTmpDir(ROOT);
  }
});
