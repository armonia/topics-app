import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { E2E_BASE } from "./helpers/test-server";
import { restartTestServer } from "./helpers/restart-test-server";
import { beat, didascalia } from "./helpers/evidence";
import { projectRow } from "./helpers/project-row";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 180_000 });

const PROJECT_PATH = join(canonicalTmpRoot(), `e2e-worktree-ready-${Date.now()}`);
const BOARD_ID = projectIdForPath(PROJECT_PATH);

type BoardSettings = { autoDispatch: boolean; dispatchUseWorktree: boolean };
type TaskSnapshot = { task: { status: string; dispatchState: string | null }; comments: Array<{ content: string }> };
type WorktreeRow = { id: string; absPath: string; status: string; port: number };

async function readTask(request: import("@playwright/test").APIRequestContext, id: string): Promise<TaskSnapshot> {
  const response = await request.get(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<TaskSnapshot>;
}

async function openBoard(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 20_000 });
  const projects = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projects.count()) && (await projects.getAttribute("aria-expanded")) === "false") await projects.click();
  await projectRow(page, new RegExp(name)).click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });
  if (!(await page.getByTestId("kanban-board").isVisible().catch(() => false))) {
    const triggers = page.getByTestId("pane-add-menu-trigger");
    let opened = false;
    for (let index = (await triggers.count()) - 1; index >= 0; index--) {
      const trigger = triggers.nth(index);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      await trigger.click();
      const item = page.getByTestId("pane-add-menu-kanban");
      if (await item.isVisible().catch(() => false)) { await item.click(); opened = true; break; }
      await page.keyboard.press("Escape");
    }
    if (!opened) throw new Error("nessun menu + con la voce Board");
  }
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
}

test("a card gets its .env and its setup, and two worktrees keep distinct ports across a restart", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "WORKTREE-15" });
  const stamp = Date.now();
  const projectName = `e2e-worktree-ready-${stamp}`;
  const taskIds: string[] = [];
  const worktreeIds: string[] = [];
  let projectStoreId: string | null = null;
  let removeCli: (() => void) | null = null;
  let originalSettings: BoardSettings | null = null;

  try {
    mkdirSync(PROJECT_PATH, { recursive: true });
    mkdirSync(join(PROJECT_PATH, ".topics"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: PROJECT_PATH });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: PROJECT_PATH });
    execFileSync("git", ["config", "user.name", "Topics E2E"], { cwd: PROJECT_PATH });
    writeFileSync(join(PROJECT_PATH, "README.md"), "# e2e\n");
    writeFileSync(join(PROJECT_PATH, ".gitignore"), ".env\nsetup.port\n");
    writeFileSync(join(PROJECT_PATH, ".worktreeinclude"), ".env\n");
    writeFileSync(join(PROJECT_PATH, ".env"), "E2E_KEY=local-only\n");
    writeFileSync(join(PROJECT_PATH, ".topics", "worktree.json"), JSON.stringify({
      setup: { command: "/bin/sh", args: ["-c", "test -f .env && printf '%s' \"$TOPICS_PORT\" > setup.port && echo setup-ok"], timeoutMs: 10_000 },
      run: { command: "/bin/sh", args: ["-c", "printf '%s' \"$TOPICS_PORT\" > run.port" ] },
      archive: { command: "/bin/sh", args: ["-c", "echo archived" ] },
    }, null, 2));
    execFileSync("git", ["add", "README.md", ".gitignore", ".worktreeinclude", ".topics/worktree.json"], { cwd: PROJECT_PATH });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: PROJECT_PATH });

    const projectResponse = await request.post(`${E2E_BASE}/api/projects`, { data: { name: projectName, path: PROJECT_PATH } });
    expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
    projectStoreId = ((await projectResponse.json()) as { id: string }).id;
    const settingsResponse = await request.get(`${E2E_BASE}/api/boards/${BOARD_ID}/settings`);
    expect(settingsResponse.ok(), await settingsResponse.text()).toBeTruthy();
    originalSettings = await settingsResponse.json() as BoardSettings;
    const enabled = await request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/settings`, {
      data: { autoDispatch: true, dispatchUseWorktree: true },
    });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();
    removeCli = installSlowTurnCli();

    for (const title of [`Card setup A ${stamp}`, `Card setup B ${stamp}`]) {
      const created = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text: title, status: "todo" } });
      expect(created.ok(), await created.text()).toBeTruthy();
      taskIds.push(((await created.json()) as { id: string }).id);
    }

    await openBoard(page, projectName);
    for (const id of taskIds) {
      await expect.poll(async () => (await readTask(request, id)).comments.some((comment) => comment.content.includes("Setup riuscito") && comment.content.includes("setup-ok")), {
        timeout: 60_000,
        message: "il setup della worktree risulta nel thread della card",
      }).toBe(true);
      await expect(page.locator(`[data-task-card="${id}"]`)).toBeVisible({ timeout: 20_000 });
    }
    const listing = await request.get(`${E2E_BASE}/api/worktrees?project_id=${projectStoreId}`);
    expect(listing.ok()).toBeTruthy();
    const worktrees = ((await listing.json()) as { worktrees: WorktreeRow[] }).worktrees.filter((worktree) => worktree.status === "ready");
    expect(worktrees).toHaveLength(2);
    worktreeIds.push(...worktrees.map((worktree) => worktree.id));
    expect(worktrees[0].port).not.toBe(worktrees[1].port);
    for (const worktree of worktrees) {
      expect(existsSync(join(worktree.absPath, ".env"))).toBe(true);
      expect(readFileSync(join(worktree.absPath, "setup.port"), "utf8")).toBe(String(worktree.port));
      const run = await request.post(`${E2E_BASE}/api/scripts/run`, {
        data: { projectPath: worktree.absPath, scriptName: ".topics/worktree.json#run", tty: false },
      });
      expect(run.ok(), await run.text()).toBeTruthy();
      await expect.poll(() => existsSync(join(worktree.absPath, "run.port")), { timeout: 10_000 }).toBe(true);
      expect(readFileSync(join(worktree.absPath, "run.port"), "utf8")).toBe(String(worktree.port));
    }
    await didascalia(page, "Le due card hanno ricevuto configurazione e porte proprie");
    await beat(page, 800);

    await restartTestServer();
    const afterRestart = await request.get(`${E2E_BASE}/api/worktrees?project_id=${projectStoreId}`);
    expect(afterRestart.ok()).toBeTruthy();
    const reloaded = ((await afterRestart.json()) as { worktrees: WorktreeRow[] }).worktrees;
    for (const original of worktrees) {
      expect(reloaded.find((item) => item.id === original.id)?.port).toBe(original.port);
    }
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    await beat(page, 800);
  } finally {
    if (originalSettings) await request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/settings`, {
      data: { autoDispatch: originalSettings.autoDispatch, dispatchUseWorktree: originalSettings.dispatchUseWorktree },
    }).catch(() => {});
    removeCli?.();
    for (const id of worktreeIds) await request.delete(`${E2E_BASE}/api/worktrees/${id}`).catch(() => {});
    for (const id of taskIds) await request.delete(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${id}`).catch(() => {});
    if (projectStoreId) await request.delete(`${E2E_BASE}/api/projects/${projectStoreId}`).catch(() => {});
    removeTmpDir(PROJECT_PATH);
  }
});
