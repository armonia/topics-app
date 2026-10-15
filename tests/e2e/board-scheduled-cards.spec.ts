/**
 * A recurrence created from the board menu creates its card when the injected clock reaches it,
 * and the menu shows the next run and the last outcome.
 *
 * @covers KANBAN-95
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/layout.fixture";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { mkdirSync, writeFileSync } from "node:fs";

hermetic(test);
test.use({ video: "on" });

const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-scheduled-cards-${Date.now()}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
let topicId: string | null = null;

async function openBoard(page: import("@playwright/test").Page) {
  await page.goto("/");
  const projects = page.getByRole("button", { name: /sezione Progetti/ });
  if (await projects.count()) if (await projects.getAttribute("aria-expanded") === "false") await projects.click();
  await projectRow(page, /e2e-scheduled-cards/).click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const boardItem = page.getByTestId("pane-add-menu-kanban");
  for (let i = await triggers.count() - 1; i >= 0; i--) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible().catch(() => false))) continue;
    await trigger.click();
    if (await boardItem.isVisible().catch(() => false)) { await boardItem.click(); break; }
    await page.keyboard.press("Escape");
  }
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("card a calendario", () => {
  test.describe.configure({ timeout: 90000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-scheduled-cards" }));
    topicId = (await createTopic(request, "E2E-Card-a-calendario", { projectPath: PROJECT_PATH })).id;
  });

  test.afterAll(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/test/scheduled-cards/advance`, { data: { now: null } }).catch(() => {});
    if (topicId) await deleteTopic(request, topicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("una ricorrenza crea una card e mostra prossima data ed esito", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-95" });
    const clock = await request.post(`${E2E_BASE}/api/test/scheduled-cards/advance`, { data: { now: "2026-10-19T06:00:00.000Z" } });
    expect(clock.ok()).toBe(true);
    await openBoard(page);
    await page.getByTestId("scheduled-cards-open").click();
    const menu = page.getByTestId("scheduled-cards-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("textbox", { name: "Testo della card" }).fill("Controlla il deploy ogni lunedì");
    // The default is the browser zone, UTC on the CI runner: this proof is about Rome, so it says so.
    await menu.getByRole("textbox", { name: "Fuso orario IANA" }).fill("Europe/Rome");
    await menu.getByRole("button", { name: "Crea ricorrenza" }).click();
    await expect(menu.getByTestId("scheduled-card-row")).toContainText("Controlla il deploy ogni lunedì");
    await expect(menu.getByTestId("scheduled-card-row")).toContainText("19/10/2026");

    const tick = await request.post(`${E2E_BASE}/api/test/scheduled-cards/advance`, { data: { now: "2026-10-19T07:00:00.000Z" } });
    expect((await tick.json()).created).toHaveLength(1);
    await expect(menu.getByTestId("scheduled-card-row")).toContainText("card creata");
    // On the board too, not only in the API: the menu covers the columns, so it closes first.
    await page.getByTestId("scheduled-cards-open").click();
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("kanban-column-backlog").locator("[data-task-card]", { hasText: "Controlla il deploy ogni lunedì" }))
      .toBeVisible({ timeout: 10000 });
    const response = await request.get(`${E2E_BASE}/api/boards/${encodeURIComponent(PROJECT_ID)}/tasks`);
    expect(response.ok()).toBe(true);
    expect(JSON.stringify(await response.json())).toContain("Controlla il deploy ogni lunedì");
  });
});
