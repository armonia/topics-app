import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectPanesKey } from "../../shared/project-keys";
import { addPaneInProject, openProjectFromSidebar, projectWindow } from "./helpers/project-window";
import { randomUUID } from "crypto";

// Its own file and its own project, because the test archives the project:
// in project-tabs.spec.ts it would change the project every other test uses.
hermetic(test);

let projectTopicId: string | null = null;
const PROJECT_PATH = canonicalTmpDir("e2e-project-archive");

test.describe("Project archive", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-project-archive" }, null, 2));
    const topic = await createTopic(request, "E2E-ProjectArchive", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    // Same surface as project-tabs.spec.ts: only this project's tab is open.
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  const openTestProject = (page: import("@playwright/test").Page) =>
    openProjectFromSidebar(page, /e2e-project-archive/);

  // Archiving a project forgets its layout, so un-archiving starts clean. The
  // page memory of session-only panes (the background preview of
  // PROJECT-TABS-MOBILE-01b) is part of that layout, and the archived window,
  // still mounted for a few commits after the forget, used to save it back:
  // archived, restored and reopened in the same page, the project brought back
  // its Git preview.
  test("PROJECT-TABS-02d: an archived project reopens without its background preview tab", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PROJECT-TABS-02" });
    const panesKey = projectPanesKey(PROJECT_PATH);
    const gitPaneId = `git:${randomUUID()}`;
    const seeded = await page.request.put(`/api/ui-state/${panesKey}`, {
      data: {
        nonChatPanes: [{ id: gitPaneId, type: "git", title: "Git", preview: true }],
        openChatTopicIds: [],
      },
    });
    expect(seeded.ok()).toBe(true);
    // A second tab in the project's group: closing the project then re-renders
    // the group while the window is still mounted, and that render is the one
    // that ran the save effect again after the forget. Alone in its group, the
    // window unmounts in the same commit and the defect does not show.
    const side = await createTopic(page.request, "E2E-ProjectTabs-Side");

    await goToApp(page);
    await openTestProject(page);
    const projectWin = projectWindow(page);
    await expect(projectWin.locator(`[data-pane-id="${gitPaneId}"]`)).toHaveCount(1, { timeout: 10000 });
    // A browser next to it takes the active slot: the Git tab is now a
    // background preview, open but kept out of the snapshot.
    await addPaneInProject(page, "pane-add-menu-browser");
    await expect(projectWin.locator('[data-pane-id^="browser:"]').first()).toBeAttached({ timeout: 10000 });
    await expect
      .poll(() => page.evaluate(({ key, id }) => {
        const raw = localStorage.getItem(key);
        const panes: { id: string }[] = raw ? (JSON.parse(raw).nonChatPanes ?? []) : [];
        return panes.some((p) => p.id === id);
      }, { key: panesKey, id: gitPaneId }), { timeout: 10000 })
      .toBe(false);
    // Nor on the server, or the reopen would take it back from there and this
    // would measure the server snapshot instead of the page memory.
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/ui-state/${panesKey}`);
        const body = (await res.json()) as { value?: { nonChatPanes?: { id: string }[] } };
        return (body.value?.nonChatPanes ?? []).some((p) => p.id === gitPaneId);
      }, { timeout: 10000 })
      .toBe(false);

    // Archive from the sidebar row menu. The commit is deferred by the pending
    // countdown, so the wait is on the request it ends with.
    const archived = page.waitForResponse(
      (r) => r.url().includes("/api/topics/bulk-archive") && r.request().method() === "POST",
      { timeout: 15000 },
    );
    const row = page
      .locator('[aria-label="Topics sidebar"] button')
      .filter({ hasText: /e2e-project-archive/ })
      .first();
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Archivia il progetto" }).click();
    expect((await archived).ok()).toBe(true);
    await expect(page.locator('[data-testid="project-window"]')).toHaveCount(0, { timeout: 10000 });

    const restored = await page.request.post("/api/topics/bulk-archive", {
      data: { projectPath: PROJECT_PATH, archived: false },
    });
    expect(restored.ok()).toBe(true);

    // Same page, no reload: the page memory is still there to be read.
    await openTestProject(page);
    const reopened = projectWindow(page);
    await expect(reopened.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
    await expect(reopened.locator(`[data-pane-id="${gitPaneId}"]`)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key) ?? "", panesKey))
      .not.toContain(gitPaneId);
    await deleteTopic(page.request, side.id);
  });
});
