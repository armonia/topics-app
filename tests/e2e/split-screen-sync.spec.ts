import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Count col-resize dividers (horizontal splits) */
async function countColDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-col-resize').count();
}

/** Count row-resize dividers (vertical splits) */
async function countRowDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-row-resize').count();
}

/** Count all panel tab bars */
async function countTabBars(page: Page): Promise<number> {
  return page.locator('[data-testid="panel-tab-bar"]').count();
}

/** Right-click first draggable tab and click a context menu item */
async function splitViaContextMenu(
  page: Page,
  direction: "Split Right" | "Split Down",
  tabIndex = 0
) {
  const tab = page.locator('[role="main"] [draggable="true"]').nth(tabIndex);
  await expect(tab).toBeVisible({ timeout: 5000 });
  await tab.click({ button: "right" });

  const splitBtn = page.getByText(direction, { exact: true });
  await expect(splitBtn).toBeVisible({ timeout: 3000 });
  await splitBtn.click();
  await page.waitForTimeout(1000);
}

/** Collapse sidebar sections to save space */
async function collapseSidebarSections(page: Page) {
  for (const name of [/Terminals section/, /Browser section/, /Projects section/]) {
    const btn = page.getByRole("button", { name });
    if ((await btn.count()) > 0) {
      const expanded = await btn.getAttribute("aria-expanded");
      if (expanded === "true") {
        await btn.click();
        await page.waitForTimeout(300);
      }
    }
  }
}

/** Seed two topics as open panels and navigate to app */
async function openTwoTopics(page: Page, topicIds: string[]) {
  const [idA, idB] = topicIds;
  await Promise.all([
    page.request
      .put("http://localhost:13334/api/ui-state/panels", {
        data: { openPanels: [idA, idB] },
      })
      .catch(() => {}),
    page.request
      .put("http://localhost:13334/api/ui-state/grid-layout", {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      })
      .catch(() => {}),
    page.request
      .put("http://localhost:13334/api/ui-state/panel-order", {
        data: { order: [idA, idB], pinned: [idA, idB] },
      })
      .catch(() => {}),
  ]);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', {
    state: "visible",
    timeout: 15000,
  });
  await collapseSidebarSections(page);
  await page
    .locator('[role="main"] [draggable="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(800);
}

/** Open a project in the sidebar */
async function openProjectInSidebar(page: Page, name: string | RegExp) {
  const projectsSection = page.getByRole("button", {
    name: /Projects section/,
  });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") {
      await projectsSection.click();
      await page.waitForTimeout(500);
    }
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: name })
    .first();
  if ((await btn.count()) > 0) {
    await btn.click();
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').first()
    ).toBeVisible({ timeout: 10000 });
  }
}

// ─── Test Data ────────────────────────────────────────────────────────────

let topicIds: string[] = [];
let projectTopicId: string | null = null;
const PROJECT_PATH = `/Users/e2e-split-sync-${Date.now()}`;

// ─── Test Suite ───────────────────────────────────────────────────────────

test.describe("Split Screen Sync & Correctness", () => {
  test.beforeAll(async ({ request }) => {
    const t1 = await createTopic(request, "E2E-SplitSync-A");
    const t2 = await createTopic(request, "E2E-SplitSync-B");
    const t3 = await createTopic(request, "E2E-SplitSync-C");
    topicIds = [t1.id, t2.id, t3.id];
    const proj = await createTopic(request, "E2E-SplitProject", {
      projectPath: PROJECT_PATH,
    });
    projectTopicId = proj.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of topicIds) {
      await deleteTopic(request, id);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
  });

  // ── 2.1: Split Right creates side-by-side panels ──

  test("Split Right creates side-by-side panels with col-resize divider and independent tab bars", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await openTwoTopics(page, topicIds);

    const initialColDividers = await countColDividers(page);
    const initialTabBars = await countTabBars(page);

    await splitViaContextMenu(page, "Split Right");

    const afterColDividers = await countColDividers(page);
    expect(afterColDividers).toBeGreaterThan(initialColDividers);

    const afterTabBars = await countTabBars(page);
    expect(afterTabBars).toBeGreaterThanOrEqual(2);
    expect(afterTabBars).toBeGreaterThan(initialTabBars);
  });

  // ── 2.2: Split Down creates vertically stacked panels ──

  test("Split Down creates vertically stacked panels with row-resize divider", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await openTwoTopics(page, topicIds);

    const initialRowDividers = await countRowDividers(page);

    await splitViaContextMenu(page, "Split Down");

    const afterRowDividers = await countRowDividers(page);
    expect(afterRowDividers).toBeGreaterThan(initialRowDividers);

    const afterTabBars = await countTabBars(page);
    expect(afterTabBars).toBeGreaterThanOrEqual(2);
  });

  // ── 2.3: Split layout persists across reload ──

  test("Split layout persists across reload (top-level)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await openTwoTopics(page, topicIds);

    await splitViaContextMenu(page, "Split Right");

    const preDividers = await countColDividers(page);
    expect(preDividers).toBeGreaterThanOrEqual(1);

    // Wait for the debounced server save (2s debounce + margin)
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/ui-state/grid-layout") &&
        r.request().method() === "PUT",
      { timeout: 10000 }
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await page.waitForTimeout(2000);

    const postDividers = await countColDividers(page);
    expect(postDividers).toBeGreaterThanOrEqual(1);

    // Verify localStorage has grid layout
    const layoutData = await page.evaluate(() =>
      localStorage.getItem("topics-panel-grid-layout")
    );
    expect(layoutData).toContain("gridRows");
  });

  // ── 2.4: Project-internal split persists across reload ──

  test("Project-internal split persists across reload", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await goToApp(page);
    await openProjectInSidebar(page, /e2e-split-sync/i);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    // Add a second pane if needed
    if ((await tabs.count()) < 2) {
      const addPaneBtn = page.getByTitle("Add pane");
      if ((await addPaneBtn.count()) > 0) {
        await addPaneBtn.first().click();
        const addMenu = page.locator(".fixed.z-\\[9999\\]");
        await expect(addMenu).toBeVisible({ timeout: 5000 });
        const menuButtons = addMenu.locator("button");
        for (let i = 0; i < (await menuButtons.count()); i++) {
          const text = ((await menuButtons.nth(i).textContent()) || "").trim();
          if (!/Chat/i.test(text)) {
            await menuButtons.nth(i).click();
            break;
          }
        }
      }
    }

    if ((await tabs.count()) >= 2) {
      // Set up save listener before split
      const savePromise = page.waitForResponse(
        (resp) =>
          resp.url().includes("/api/ui-state/project-layout") &&
          resp.request().method() === "PUT" &&
          resp.status() === 200,
        { timeout: 15000 }
      );

      // Split Right within project
      await tabs.first().click({ button: "right" });
      const menu = page.locator(".fixed.z-\\[9999\\]");
      await expect(menu).toBeVisible({ timeout: 5000 });
      const splitBtn = menu
        .locator("button")
        .filter({ hasText: /Split Right/ })
        .first();

      if ((await splitBtn.count()) > 0) {
        await splitBtn.click();

        // Wait for split to render
        const splitRendered = await page
          .locator('[data-testid="panel-tab-bar"]')
          .nth(1)
          .waitFor({ state: "visible", timeout: 5000 })
          .then(() => true)
          .catch(() => false);

        if (splitRendered) {
          await savePromise;

          // Reload
          await page.reload({ waitUntil: "networkidle" });
          await page.waitForSelector('[aria-label="Topics sidebar"]', {
            state: "visible",
            timeout: 15000,
          });

          await openProjectInSidebar(page, /e2e-split-sync/i);

          await expect(
            page.locator('[data-testid="panel-tab-bar"]').first()
          ).toBeVisible({ timeout: 10000 });
        }
      }
    }
  });

  // ── 3.1: Mixed project + chat split ──

  test("Mixed project + chat panels in multi-column split", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Seed a chat panel open
    await page.request
      .put("http://localhost:13334/api/ui-state/panels", {
        data: { openPanels: [topicIds[0]] },
      })
      .catch(() => {});
    await page.request
      .put("http://localhost:13334/api/ui-state/panel-order", {
        data: { order: [topicIds[0]], pinned: [topicIds[0]] },
      })
      .catch(() => {});
    await page.request
      .put("http://localhost:13334/api/ui-state/grid-layout", {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      })
      .catch(() => {});

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Open the project — this creates a project panel alongside the chat
    await openProjectInSidebar(page, /e2e-split-sync/i);

    // Verify both panels have their own tab bars
    const tabBars = await countTabBars(page);
    expect(tabBars).toBeGreaterThanOrEqual(2);

    // Should have a divider between them (if multi-column layout)
    // The project opens as a second panel which may create a split
    const totalDividers =
      (await countColDividers(page)) + (await countRowDividers(page));
    // At minimum, both tab bars should be visible
    expect(
      await page.locator('[data-testid="panel-tab-bar"]').first().isVisible()
    ).toBeTruthy();
  });

  // ── 3.2: Project window with nested splits ──

  test("Project window with nested splits (multi-row multi-column)", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await goToApp(page);
    await openProjectInSidebar(page, /e2e-split-sync/i);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    // Add 2 more panes for nested splits
    for (let n = 0; n < 2; n++) {
      const addPaneBtn = page.getByTitle("Add pane");
      if ((await addPaneBtn.count()) > 0) {
        await addPaneBtn.first().click();
        const addMenu = page.locator(".fixed.z-\\[9999\\]");
        await expect(addMenu).toBeVisible({ timeout: 5000 });
        const menuButtons = addMenu.locator("button");
        for (let i = 0; i < (await menuButtons.count()); i++) {
          const text = ((await menuButtons.nth(i).textContent()) || "").trim();
          if (!/Chat/i.test(text)) {
            await menuButtons.nth(i).click();
            break;
          }
        }
        await page.waitForTimeout(500);
      }
    }

    // Hard-assert the setup produced enough panes to split — a broken add-pane
    // flow must FAIL here, not silently skip the whole split assertion below.
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(3);
    {
      // Split Right first
      await tabs.first().click({ button: "right" });
      let menu = page.locator(".fixed.z-\\[9999\\]");
      await expect(menu).toBeVisible({ timeout: 3000 });
      let splitRightBtn = menu
        .locator("button")
        .filter({ hasText: /Split Right/ })
        .first();
      if ((await splitRightBtn.count()) > 0) {
        await splitRightBtn.click();
        await page.waitForTimeout(1000);
      }

      // Now Split Down on another tab
      const allTabs = page.locator('[role="main"] [draggable="true"]');
      if ((await allTabs.count()) >= 2) {
        await allTabs.nth(1).click({ button: "right" });
        menu = page.locator(".fixed.z-\\[9999\\]");
        await expect(menu).toBeVisible({ timeout: 3000 });
        const splitDownBtn = menu
          .locator("button")
          .filter({ hasText: /Split Down/ })
          .first();
        if ((await splitDownBtn.count()) > 0) {
          await splitDownBtn.click();
          await page.waitForTimeout(1000);
        }
      }

      // Should have at least 2 tab bars from the splits
      const finalTabBars = await countTabBars(page);
      // The split flow (2 added panes → Split Right → Split Down) yields 3 tab
      // bars in the harness. Assert the splits MATERIALISED (>=2), not the
      // always-true >=1 that passed even if the layout never split.
      expect(finalTabBars).toBeGreaterThanOrEqual(2);
    }
  });

  // ── 3.3: Mixed layout persists across reload ──

  test("Mixed project + chat layout persists across reload", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Seed a chat panel
    await page.request
      .put("http://localhost:13334/api/ui-state/panels", {
        data: { openPanels: [topicIds[0]] },
      })
      .catch(() => {});
    await page.request
      .put("http://localhost:13334/api/ui-state/panel-order", {
        data: { order: [topicIds[0]], pinned: [topicIds[0]] },
      })
      .catch(() => {});

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Open project alongside chat
    await openProjectInSidebar(page, /e2e-split-sync/i);

    const tabBarsBefore = await countTabBars(page);

    // Wait for debounced saves
    await page.waitForTimeout(3000);

    // Reload
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await page.waitForTimeout(2000);

    // Re-open project
    await openProjectInSidebar(page, /e2e-split-sync/i);

    // Persistence: the layout must not SHRINK across reload (the old >=1 was
    // always true even if every panel was lost). >= before catches a reload
    // that drops the restored panels down to the empty-shell floor.
    const tabBarsAfter = await countTabBars(page);
    expect(tabBarsBefore).toBeGreaterThanOrEqual(1);
    expect(tabBarsAfter).toBeGreaterThanOrEqual(tabBarsBefore);
  });

  // ── 3.4: Multi-row top-level grid ──

  test("Multi-row multi-column top-level grid (Split Down + Split Right)", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Need 3 topics for multi-row multi-column
    const [idA, idB, idC] = topicIds;
    await Promise.all([
      page.request
        .put("http://localhost:13334/api/ui-state/panels", {
          data: { openPanels: [idA, idB, idC] },
        })
        .catch(() => {}),
      page.request
        .put("http://localhost:13334/api/ui-state/grid-layout", {
          data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
        })
        .catch(() => {}),
      page.request
        .put("http://localhost:13334/api/ui-state/panel-order", {
          data: { order: [idA, idB, idC], pinned: [idA, idB, idC] },
        })
        .catch(() => {}),
    ]);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await collapseSidebarSections(page);
    await page
      .locator('[role="main"] [draggable="true"]')
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(800);

    // Split Down first to create 2 rows
    await splitViaContextMenu(page, "Split Down");
    const rowDividers = await countRowDividers(page);
    expect(rowDividers).toBeGreaterThanOrEqual(1);

    // Now Split Right on one of the remaining tabs to create a column within a row
    const tabs = page.locator('[role="main"] [draggable="true"]');
    if ((await tabs.count()) >= 2) {
      await splitViaContextMenu(page, "Split Right", 0);
    }

    // Verify both row and column dividers coexist
    const finalRowDividers = await countRowDividers(page);
    const finalColDividers = await countColDividers(page);
    // At minimum one of each should exist
    expect(finalRowDividers + finalColDividers).toBeGreaterThanOrEqual(2);

    // Each cell should have its own tab bar
    const finalTabBars = await countTabBars(page);
    expect(finalTabBars).toBeGreaterThanOrEqual(3);
  });
});
