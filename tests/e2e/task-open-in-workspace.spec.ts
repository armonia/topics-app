/**
 * task-open-in-workspace.spec.ts — E2E for "Apri nel workspace".
 *
 * Il risultato di un task si apre come TAB del browser di Topics nella finestra
 * del progetto (non nel browser esterno del OS). Il bottone del drawer dispatcha
 * `topics:open-project` (apre/porta in primo piano la finestra) + `browser:open-
 * and-navigate` (che la useProjectLayout traduce in un pane RemoteBrowserPanel).
 *
 * Assert deterministico: al click, i due eventi partono con il detail giusto
 * (projectPath del task, url = output_url, contextId presente). L'apertura del
 * pane è comportamento Topics già esistente (stesso path di `/browser`); il video
 * registrato dalla suite mostra il pane che compare nel workspace.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";

const BASE = "http://localhost:13334";
const PROJECT_PATH = `/tmp/e2e-wsopen-${Date.now()}`;

/** BYTE-IDENTICAL to server/services/tasks.ts:projectIdForPath (parity-tested there). */
function boardIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, "").split("/");
  const dirName = parts[parts.length - 1] || "project";
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
}
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string },
): Promise<{ id: string; status: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string; status: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

/** Open the e2e project window by clicking its sidebar row (project-tabs pattern). */
async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /Projects section/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: /e2e-wsopen/ })
    .first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
}

/** Open the project board pane via the project window's "+" menu. */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  for (let i = count - 1; i >= 0; i--) {
    await triggers.nth(i).click();
    const found = await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
    if (found) break;
    await page.keyboard.press("Escape");
    if (i === 0) throw new Error("no + menu with a Board (kanban) entry found");
  }
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Apri nel workspace", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-wsopen" }, null, 2));
    const topic = await createTopic(request, "E2E-WSOpen", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []).catch(() => {});
    await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  });

  test("WSOPEN-01: il bottone apre l'output come tab nel workspace del progetto", async ({ page }) => {
    const text = `Task con output ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    // A reachable local URL so, if a pane opens, it loads a real page (the test
    // server itself) instead of erroring on a dead port.
    const outputUrl = `${BASE}/`;
    const patch = await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, { data: { outputUrl } });
    expect(patch.ok()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);

    // Open the drawer from the card.
    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    const openBtn = drawer.getByTestId("task-open-in-workspace");
    await expect(openBtn).toBeVisible();

    // Capture the workspace-open events the button dispatches.
    await page.evaluate(() => {
      (window as unknown as { __wsOpen: unknown[] }).__wsOpen = [];
      const rec = (type: string) => (e: Event) =>
        (window as unknown as { __wsOpen: unknown[] }).__wsOpen.push({ type, detail: (e as CustomEvent).detail });
      window.addEventListener("topics:open-project", rec("open-project"));
      window.addEventListener("browser:open-and-navigate", rec("open-and-navigate"));
    });

    await openBtn.click();

    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __wsOpen: unknown[] }).__wsOpen.length), { timeout: 5000 })
      .toBeGreaterThanOrEqual(2);

    const evts = (await page.evaluate(() => (window as unknown as { __wsOpen: unknown[] }).__wsOpen)) as {
      type: string;
      detail: { projectPath?: string; url?: string; contextId?: string };
    }[];

    const nav = evts.find((e) => e.type === "open-and-navigate");
    expect(nav, "browser:open-and-navigate deve partire").toBeTruthy();
    expect(nav!.detail.url).toBe(outputUrl);
    expect(nav!.detail.projectPath).toBe(PROJECT_PATH);
    expect(typeof nav!.detail.contextId).toBe("string");
    expect(nav!.detail.contextId!.length).toBeGreaterThan(0);

    const openProj = evts.find((e) => e.type === "open-project");
    expect(openProj, "topics:open-project deve partire").toBeTruthy();
    expect(openProj!.detail.projectPath).toBe(PROJECT_PATH);
  });
});
