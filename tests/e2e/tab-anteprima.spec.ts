import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { openProjectFromSidebar, projectWindow } from "./helpers/project-window";

// Spec TAB-ANTEPRIMA (10/11): opening a chat reuses the provisional tab, the tab stays (allow-italian: spec id)
// only if you interact with it; a chat started by an agent opens no tab.
hermetic(test);

const PROJECT_PATH = canonicalTmpDir("e2e-tab-anteprima");
const ids: string[] = [];

const openPreview = (page: Page, topicId: string) =>
  page.evaluate((id) => window.dispatchEvent(new CustomEvent("topics:open-topic", { detail: { topicId: id, mode: "preview" } })), topicId);

const tabs = (page: Page) => projectWindow(page).locator('[data-testid="panel-tab-bar"] [draggable="true"]');

test.describe("TAB-ANTEPRIMA", () => {
  let a = "", b = "", c = "", base = "";
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, "{}");
    base = (await createTopic(request, "Base", { projectPath: PROJECT_PATH })).id;
    a = (await createTopic(request, "Chat A", { projectPath: PROJECT_PATH })).id;
    b = (await createTopic(request, "Chat B", { projectPath: PROJECT_PATH })).id;
    c = (await createTopic(request, "Chat C", { projectPath: PROJECT_PATH })).id;
    ids.push(base, a, b, c);
  });
  test.afterAll(async ({ request }) => {
    for (const id of ids) await deleteTopic(request, id).catch(() => {});
    removeTmpDir(PROJECT_PATH);
  });
  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  });

  test("TAB-ANTEPRIMA-01: apri A, apri B: stessa tab; interagisci: resta; un agente non aggiunge tab", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-ANTEPRIMA-01" });
    await goToApp(page);
    await openProjectFromSidebar(page, /e2e-tab-anteprima/);
    await expect(projectWindow(page)).toBeVisible();
    const start = await tabs(page).count();

    await openPreview(page, a);
    await expect(tabs(page).filter({ hasText: "Chat A" })).toHaveCount(1);
    const withA = await tabs(page).count();
    expect(withA).toBeLessThanOrEqual(start + 1);
    await expect(tabs(page).filter({ hasText: "Chat A" }).locator(".italic")).toHaveCount(1);

    await openPreview(page, b);
    await expect(tabs(page).filter({ hasText: "Chat B" })).toHaveCount(1);
    await expect(tabs(page).filter({ hasText: "Chat A" })).toHaveCount(0);
    expect(await tabs(page).count()).toBe(withA);

    // Interaction: a click inside the chat pins it.
    await projectWindow(page).locator('[data-preview-tab="true"] > *').first().click({ position: { x: 40, y: 40 } });
    await expect(tabs(page).filter({ hasText: "Chat B" }).locator(".italic")).toHaveCount(0);

    await openPreview(page, c);
    await expect(tabs(page).filter({ hasText: "Chat C" })).toHaveCount(1);
    await expect(tabs(page).filter({ hasText: "Chat B" })).toHaveCount(1);
    expect(await tabs(page).count()).toBe(withA + 1);

    // An agent opens its own session in the project: no new tab.
    const root = (await createTopic(request, "Jarvis, canali (e2e)", {})).id;
    ids.push(root);
    const before = await tabs(page).count();
    const agent = (await createTopic(request, "Canale dell'agente", { projectPath: PROJECT_PATH, parentId: root })).id;
    ids.push(agent);
    // A chat created after the agent's one, opened in preview, is the barrier:
    // once its tab shows, the agent's topic event has been handled too.
    const d = (await createTopic(request, "Chat D", { projectPath: PROJECT_PATH })).id;
    ids.push(d);
    await expect.poll(async () => { await openPreview(page, d); return tabs(page).filter({ hasText: "Chat D" }).count(); }).toBe(1);
    await expect(tabs(page).filter({ hasText: "Canale dell'agente" })).toHaveCount(0);
    // At most Chat D's own tab: the agent's chat added none.
    expect(await tabs(page).count()).toBeLessThanOrEqual(before + 1);
    await projectWindow(page).locator('[data-testid="panel-tab-bar"]').first().screenshot({ path: test.info().outputPath("barra-dopo.png") });
  });
});
