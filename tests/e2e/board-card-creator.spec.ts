/**
 * Who opened a card is on the card, and an agent's card must be able to finish
 * by itself (card 841c6eac). Real server paths: an incomplete agent card is
 * refused with the list of what is missing, a complete one shows its creator,
 * and the "Mine" filter keeps only the person's cards.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";

hermetic(test);

const PROJECT_PATH = canonicalTmpDir("e2e-creator");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const ENFORCE = { "X-Topics-Enforce-Card-Contract": "1" };
let topicId: string | null = null;
const created: string[] = [];

async function openBoard(page: Page) {
  const section = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") await section.click();
  await projectRow(page, /e2e-creator/).click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) break;
    await page.keyboard.press("Escape");
  }
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("who opened the card", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-creator" }));
    topicId = (await createTopic(request, "E2E-Creator", { projectPath: PROJECT_PATH })).id;
  });
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    removeTmpDir(PROJECT_PATH);
  });
  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("an agent card without context is refused; a complete one shows its creator; Mine filters", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
    const url = `${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`;

    const thin = await request.post(url, { headers: ENFORCE, data: { text: "thin agent card", createdBy: "agent:jarvis" } });
    expect(thin.status()).toBe(400);
    const refusal = (await thin.json()) as { code: string; missing: string[] };
    expect(refusal.code).toBe("agent_card_incomplete");
    expect(refusal.missing.length).toBeGreaterThanOrEqual(3);

    const agent = await request.post(url, {
      headers: ENFORCE,
      data: {
        text: "Card from an agent", createdBy: "agent:jarvis", source: "discord channel",
        description: "A complete card with enough context to be finished without asking.", bar: "bun test exits 0",
      },
    });
    expect(agent.status()).toBe(201);
    created.push(((await agent.json()) as { id: string }).id);
    const mine = await request.post(url, { headers: { "X-Topics-Action-Origin": "interface" }, data: { text: "Card from the person" } });
    created.push(((await mine.json()) as { id: string }).id);

    await page.goto("/");
    await openBoard(page);
    const chips = page.getByTestId("card-created-by");
    await expect(chips.filter({ hasText: /jarvis/ })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-creator="human"]')).toBeVisible();

    await page.getByTestId("filter-creator").click();
    await expect(page.getByText("Card from the person")).toBeVisible();
    await expect(page.getByText("Card from an agent")).toHaveCount(0);
  });
});
