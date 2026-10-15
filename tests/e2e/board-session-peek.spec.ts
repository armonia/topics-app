import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { projectRow } from "./helpers/project-row";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { beat, didascalia } from "./helpers/evidence";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 150_000 });

const PROJECT_PATH = join(realpathSync(canonicalTmpRoot()), `e2e-board-peek-${Date.now()}`);

async function openBoard(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 20_000 });
  const projects = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projects.count()) > 0 && (await projects.getAttribute("aria-expanded")) === "false") await projects.click();
  await projectRow(page, /e2e-board-peek/).click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });
  if (!(await page.getByTestId("kanban-board").isVisible().catch(() => false))) {
    const trigger = page.getByTestId("pane-add-menu-trigger").last();
    await trigger.click();
    await page.getByTestId("pane-add-menu-kanban").click();
  }
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
}

test("D5e: la sbirciata segue l'ultimo messaggio senza aprire la sessione", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "KANBAN-96" });
  const stamp = Date.now();
  const projectName = `e2e-board-peek-${stamp}`;
  const tag = `peekd5e${stamp}`;
  const taskText = `SLOW:12:${tag}`;
  let projectId: string | null = null;
  let taskId: string | null = null;
  let uninstallCli: (() => void) | null = null;
  let originalSettings: { autoDispatch: boolean; dispatchUseWorktree: boolean } | null = null;
  /** When each peek request left, in ms: the delay before the first one is what the hover rule promises. */
  const peekRequests: number[] = [];
  page.on("request", (r) => { if (r.url().includes("/peek")) peekRequests.push(Date.now()); });

  try {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(join(PROJECT_PATH, "package.json"), JSON.stringify({ name: projectName }));
    const registered = await request.post(`${E2E_BASE}/api/projects`, { data: { name: projectName, path: PROJECT_PATH } });
    expect(registered.ok(), await registered.text()).toBeTruthy();
    projectId = ((await registered.json()) as { id: string }).id;
    uninstallCli = installSlowTurnCli();

    const settingsResponse = await request.get(`${E2E_BASE}/api/boards/${projectId}/settings`);
    expect(settingsResponse.ok(), await settingsResponse.text()).toBeTruthy();
    originalSettings = await settingsResponse.json() as { autoDispatch: boolean; dispatchUseWorktree: boolean };
    const enabled = await request.patch(`${E2E_BASE}/api/boards/${projectId}/settings`, { data: { autoDispatch: true, dispatchUseWorktree: false } });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();
    const created = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, { data: { text: taskText, status: "todo" } });
    expect(created.ok(), await created.text()).toBeTruthy();
    taskId = ((await created.json()) as { id: string }).id;

    await openBoard(page);
    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => {
      const response = await request.get(`${E2E_BASE}/api/all-boards/tasks/${taskId}`);
      return ((await response.json()) as { task: { dispatchState: string } }).task.dispatchState;
    }, { timeout: 30_000 }).toBe("working");
    // The board has been open, card working, for the whole wait above.
    expect(peekRequests, "le card chiuse non interrogano il riquadro").toHaveLength(0);

    const hoveredAt = Date.now();
    await card.hover();
    const peek = page.getByTestId("task-session-peek");
    await expect(peek).toBeVisible();
    expect(peekRequests[0]! - hoveredAt, "la richiesta parte solo dopo i 400 ms di sosta").toBeGreaterThanOrEqual(350);
    const cardBox = await card.boundingBox();
    const peekBox = await peek.boundingBox();
    expect(cardBox && peekBox && (peekBox.y >= cardBox.y + cardBox.height || peekBox.y + peekBox.height <= cardBox.y), "il riquadro resta fuori dalla card").toBeTruthy();
    await expect(peek).toContainText("al lavoro");
    await expect(peek.getByTestId("task-session-peek-line").last()).toContainText(`${tag}-01`);
    await expect.poll(async () => (await peek.locator('[data-testid="task-session-peek-line"]').allTextContents()).join(" "), {
      timeout: 15_000,
      message: "il riquadro segue i nuovi messaggi del turno",
    }).toContain(`${tag}-02`);
    expect(peekRequests.length, "il riquadro interroga la sessione solo mentre è aperto").toBeGreaterThan(0);
    await expect(card).toBeVisible();
    await didascalia(page, "La card mostra la sessione in corso senza aprirla");
    await beat(page, 900);
    await page.mouse.move(0, 0);
    // Reached with Tab, as a keyboard user does: a focus set from a script says nothing about the keyboard.
    await card.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(card).toBeFocused();
    await expect(peek).toBeVisible();
    await card.press("Escape");
    await expect(peek).toBeHidden();
  } finally {
    uninstallCli?.();
    if (originalSettings && projectId) {
      await request.patch(`${E2E_BASE}/api/boards/${projectId}/settings`, { data: originalSettings }).catch(() => {});
    }
    if (taskId && projectId) await request.delete(`${E2E_BASE}/api/boards/${projectId}/tasks/${taskId}`).catch(() => {});
    if (projectId) await request.delete(`${E2E_BASE}/api/projects/${projectId}`).catch(() => {});
    removeTmpDir(PROJECT_PATH);
  }
});
