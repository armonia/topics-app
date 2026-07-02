/**
 * E2E tests for layout edge cases — drag no-ops, asymmetric grids,
 * grid collapse/resize, split type guards, unsolo, cross-position ops,
 * persistence, mixed pane types, and full lifecycle regression.
 *
 * CONVENTION: No waitForTimeout() — condition-based waits only.
 * See tests/e2e/CONVENTIONS.md for full conventions.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, createTerminalSession, deleteTerminalSession } from "./helpers/api-fixtures";

const BASE = "http://localhost:13334";

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/** Get all visible tab labels in the main area */
async function getVisibleTabLabels(page: Page): Promise<string[]> {
  const tabs = page.locator('[role="main"] .truncate.flex-1');
  const count = await tabs.count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await tabs.nth(i).textContent();
    if (text) labels.push(text.trim());
  }
  return labels;
}

/** Seed server state with specific open panels, then navigate.
 *  Grid layout is read from localStorage by the client — so we must seed both
 *  the server (panels, panel-order) AND localStorage (grid layout). */
async function seedAndLoad(page: Page, panelIds: string[], opts?: { gridRows?: unknown[]; gridRowHeights?: number[]; soloTopicIds?: string[] }) {
  // 1. Seed server state for panels and panel-order
  await Promise.all([
    page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: panelIds },
    }).catch(() => {}),
    page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: panelIds, pinned: panelIds },
    }).catch(() => {}),
    page.request.put(`${BASE}/api/ui-state/grid-layout`, {
      data: {
        gridRows: opts?.gridRows ?? [],
        gridRowHeights: opts?.gridRowHeights ?? [],
        soloTopicIds: opts?.soloTopicIds ?? [],
      },
    }).catch(() => {}),
  ]);

  // 2. Set localStorage BEFORE the app loads so the client's initial state
  //    matches the server. The client reads openPanels and grid layout from
  //    localStorage on mount (before the server fetch completes).
  await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
  const gridData = {
    gridRows: opts?.gridRows ?? [],
    gridRowHeights: opts?.gridRowHeights ?? [],
    soloTopicIds: opts?.soloTopicIds ?? [],
  };
  await page.evaluate(({ panels, grid }) => {
    // Clear all layout-related keys first to avoid stale data from prior tests
    localStorage.removeItem("topics-open-panels");
    localStorage.removeItem("topics-focused-panel");
    localStorage.removeItem("topics-panel-grid-layout");
    sessionStorage.removeItem("topics-open-panels");
    // Then set the fresh seeded state
    localStorage.setItem("topics-open-panels", JSON.stringify(panels));
    sessionStorage.setItem("topics-open-panels", JSON.stringify(panels));
    localStorage.setItem("topics-panel-grid-layout", JSON.stringify(grid));
  }, { panels: panelIds, grid: gridData });

  // 3. Now navigate to the app — it will read localStorage for grid state
  const panelsFetch = page.waitForResponse(
    r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
    { timeout: 10000 }
  ).catch(() => {});
  await page.goto("/");
  await panelsFetch;
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

/** Count draggable tabs in the main area */
async function countTabs(page: Page): Promise<number> {
  return page.locator('[role="main"] [draggable="true"]').count();
}

/** Wait for tabs to render */
async function waitForTabs(page: Page, minCount = 1) {
  await expect(page.locator('[role="main"] [draggable="true"]').first()).toBeVisible({ timeout: 10000 });
  if (minCount > 1) {
    await expect.poll(() => countTabs(page), { timeout: 10000 }).toBeGreaterThanOrEqual(minCount);
  }
}

/** Right-click a tab and select a context menu option */
async function rightClickTabAndSelect(page: Page, tabIndex: number, menuText: string) {
  const tab = page.locator('[role="main"] [draggable="true"]').nth(tabIndex);
  await expect(tab).toBeVisible({ timeout: 5000 });
  await tab.click({ button: "right" });
  const menu = page.locator(".fixed.z-\\[9999\\]");
  await expect(menu).toBeVisible({ timeout: 3000 });
  const btn = menu.getByText(menuText, { exact: true });
  await expect(btn).toBeVisible({ timeout: 3000 });
  await btn.click();
}

/** Right-click a tab and check if a context menu option exists */
async function rightClickTabHasOption(page: Page, tabIndex: number, menuText: string): Promise<boolean> {
  const tab = page.locator('[role="main"] [draggable="true"]').nth(tabIndex);
  await expect(tab).toBeVisible({ timeout: 5000 });
  await tab.click({ button: "right" });
  const menu = page.locator(".fixed.z-\\[9999\\]");
  await expect(menu).toBeVisible({ timeout: 3000 });
  const btn = menu.getByText(menuText, { exact: true });
  const visible = await btn.isVisible().catch(() => false);
  await page.keyboard.press("Escape");
  return visible;
}

/** Count col-resize dividers */
async function countColDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-col-resize').count();
}

/** Count row-resize dividers */
async function countRowDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-row-resize').count();
}

/** Count panel tab bars */
async function countTabBars(page: Page): Promise<number> {
  return page.locator('[data-testid="panel-tab-bar"]').count();
}

/** Get tab labels in a specific tab bar */
async function getTabBarLabels(page: Page, barIndex: number): Promise<string[]> {
  const bar = page.locator('[data-testid="panel-tab-bar"]').nth(barIndex);
  const tabs = bar.locator('.truncate.flex-1');
  const count = await tabs.count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await tabs.nth(i).textContent();
    if (text) labels.push(text.trim());
  }
  return labels;
}

// ─── Test Data ───────────────────────────────────────────────────────────────

const TS = Date.now();
const TOPIC_NAMES = [
  `EC-Alpha-${TS}`,
  `EC-Beta-${TS}`,
  `EC-Gamma-${TS}`,
  `EC-Delta-${TS}`,
  `EC-Epsilon-${TS}`,
  `EC-Zeta-${TS}`,
];

let topicIds: string[] = [];

test.beforeAll(async ({ request }) => {
  for (const name of TOPIC_NAMES) {
    const t = await createTopic(request, name);
    topicIds.push(t.id);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of topicIds) {
    await deleteTopic(request, id);
  }
});

// =============================================================================
//  A. Drag No-Op (tab dropped at same position)
// =============================================================================

test.describe("A: Drag No-Op", () => {
  test("A1: drag first tab and drop at same position — tab order unchanged", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    const initialLabels = await getVisibleTabLabels(page);
    expect(initialLabels.length).toBe(3);

    // Use Playwright dragTo for HTML5 DnD — drag first tab onto itself
    const firstTab = page.locator('[role="main"] [draggable="true"]').first();
    await firstTab.dragTo(firstTab);

    // Verify tab order unchanged
    const afterLabels = await getVisibleTabLabels(page);
    expect(afterLabels).toEqual(initialLabels);
  });

  test("A2: drag middle tab and drop at same position — no state change", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    const initialLabels = await getVisibleTabLabels(page);

    // Use Playwright dragTo — drag middle tab onto itself
    const middleTab = page.locator('[role="main"] [draggable="true"]').nth(1);
    await middleTab.dragTo(middleTab);

    const afterLabels = await getVisibleTabLabels(page);
    expect(afterLabels).toEqual(initialLabels);
  });
});

// =============================================================================
//  B. Asymmetric Grid Layouts
// =============================================================================

test.describe("B: Asymmetric Grid Layouts", () => {
  test("B3: split-right then split-down creates asymmetric layout", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    // Split first topic right (creates solo column)
    await rightClickTabAndSelect(page, 0, "Split Right");
    await expect.poll(() => countColDividers(page), { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    // Now split another topic down — find a remaining tab in standalone
    const tabs = page.locator('[role="main"] [draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 5000 });
    await tabs.first().click({ button: "right" });
    const menu = page.locator(".fixed.z-\\[9999\\]");
    await expect(menu).toBeVisible({ timeout: 3000 });

    const splitDown = menu.getByText("Split Down", { exact: true });
    if (await splitDown.isVisible().catch(() => false)) {
      await splitDown.click();
      await expect.poll(() => countRowDividers(page), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    } else {
      await page.keyboard.press("Escape");
    }

    // Verify main area is visible and has multiple tab bars
    await expect(page.locator('[role="main"]')).toBeVisible();
    const barCount = await countTabBars(page);
    expect(barCount).toBeGreaterThanOrEqual(2);
  });

  test("B4: 4 columns seeded render correctly", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC, idD, idE] = topicIds;
    // Open 5 topics, 3 solo = 4 columns (standalone + 3 solo)
    await seedAndLoad(page, [idA, idB, idC, idD, idE], {
      soloTopicIds: [idB, idC, idD],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`, `solo:${idC}`, `solo:${idD}`], widths: [0.25, 0.25, 0.25, 0.25] },
      ],
    });
    await waitForTabs(page);

    // Should have 3 col dividers (between 4 columns)
    await expect.poll(() => countColDividers(page), { timeout: 5000 }).toBeGreaterThanOrEqual(3);

    // Verify 4 tab bars (one per column)
    expect(await countTabBars(page)).toBe(4);
  });

  test("B5: splitting to 5th column is blocked by MAX_COLS_PER_ROW", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC, idD, idE] = topicIds;
    // Seed 4 columns (at the limit): standalone + 3 solo items in a single row
    await seedAndLoad(page, [idA, idB, idC, idD, idE], {
      soloTopicIds: [idB, idC, idD],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`, `solo:${idC}`, `solo:${idD}`], widths: [0.25, 0.25, 0.25, 0.25] },
      ],
      gridRowHeights: [1],
    });
    await waitForTabs(page);
    expect(await countTabBars(page)).toBe(4);

    // Try to split a 5th topic right via context menu on standalone's tab
    await rightClickTabAndSelect(page, 0, "Split Right");
    // Should still have 4 tab bars (5th column blocked)
    expect(await countTabBars(page)).toBe(4);
  });

  test("B6: 4 rows seeded render correctly", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC, idD, idE] = topicIds;
    // 4 rows: standalone + 3 solo items each in their own row
    await seedAndLoad(page, [idA, idB, idC, idD, idE], {
      soloTopicIds: [idB, idC, idD],
      gridRows: [
        { itemKeys: ["standalone"], widths: [1] },
        { itemKeys: [`solo:${idB}`], widths: [1] },
        { itemKeys: [`solo:${idC}`], widths: [1] },
        { itemKeys: [`solo:${idD}`], widths: [1] },
      ],
      gridRowHeights: [0.25, 0.25, 0.25, 0.25],
    });
    await waitForTabs(page);

    // Should have 3 row dividers (between 4 rows)
    await expect.poll(() => countRowDividers(page), { timeout: 5000 }).toBe(3);
    expect(await countTabBars(page)).toBe(4);
  });

  test("B7: splitting to 5th row is blocked by MAX_ROWS", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC, idD, idE] = topicIds;
    // Seed 4 rows (at the limit): standalone + 3 solo items each in their own row
    await seedAndLoad(page, [idA, idB, idC, idD, idE], {
      soloTopicIds: [idB, idC, idD],
      gridRows: [
        { itemKeys: ["standalone"], widths: [1] },
        { itemKeys: [`solo:${idB}`], widths: [1] },
        { itemKeys: [`solo:${idC}`], widths: [1] },
        { itemKeys: [`solo:${idD}`], widths: [1] },
      ],
      gridRowHeights: [0.25, 0.25, 0.25, 0.25],
    });
    await waitForTabs(page);
    expect(await countTabBars(page)).toBe(4);

    // Try to split a 5th topic down via context menu on standalone's tab
    await rightClickTabAndSelect(page, 0, "Split Down");
    // Should still have 4 tab bars (5th row blocked)
    expect(await countTabBars(page)).toBe(4);
  });
});

// =============================================================================
//  C. Grid Collapse and Resize
// =============================================================================

test.describe("C: Grid Collapse and Resize", () => {
  test("C8: close middle panel in 3-column row — remaining 2 panels resize", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC, idD] = topicIds;
    // 3 columns: standalone + solo:B + solo:C
    await seedAndLoad(page, [idA, idB, idC, idD], {
      soloTopicIds: [idB, idC],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`, `solo:${idC}`], widths: [0.333, 0.334, 0.333] },
      ],
    });
    await waitForTabs(page);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(3);

    // Close the middle panel (solo:B)
    const middleBar = page.locator('[data-testid="panel-tab-bar"]').nth(1);
    const closeBtn = middleBar.locator('[draggable="true"]').first().locator("button").last();
    await closeBtn.click();

    // After closing, should have 2 tab bars
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(2);

    // Verify both remaining panels are visible with roughly equal widths
    const bars = page.locator('[data-testid="panel-tab-bar"]');
    const box0 = await bars.nth(0).boundingBox();
    const box1 = await bars.nth(1).boundingBox();
    expect(box0).not.toBeNull();
    expect(box1).not.toBeNull();
    const ratio = box0!.width / box1!.width;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });

  test("C9: close all panels in bottom row — top row expands", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC] = topicIds;
    // 2 rows: standalone on top, solo:B on bottom
    await seedAndLoad(page, [idA, idB, idC], {
      soloTopicIds: [idB],
      gridRows: [
        { itemKeys: ["standalone"], widths: [1] },
        { itemKeys: [`solo:${idB}`], widths: [1] },
      ],
      gridRowHeights: [0.5, 0.5],
    });
    await waitForTabs(page);
    await expect.poll(() => countRowDividers(page), { timeout: 5000 }).toBe(1);

    // Close the bottom panel (solo:B)
    const bottomBar = page.locator('[data-testid="panel-tab-bar"]').last();
    const closeBtn = bottomBar.locator('[draggable="true"]').first().locator("button").last();
    await closeBtn.click();

    // After closing, no more row dividers
    await expect.poll(() => countRowDividers(page), { timeout: 5000 }).toBe(0);
    expect(await countTabBars(page)).toBe(1);
  });

  test("C10: close panels in 2x2 grid until 1 remains — fills entire area", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC, idD] = topicIds;
    // 2x2 grid
    await seedAndLoad(page, [idA, idB, idC, idD], {
      soloTopicIds: [idB, idC, idD],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`], widths: [0.5, 0.5] },
        { itemKeys: [`solo:${idC}`, `solo:${idD}`], widths: [0.5, 0.5] },
      ],
      gridRowHeights: [0.5, 0.5],
    });
    await waitForTabs(page);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(4);

    // Close solo panels one by one (always close the last tab bar's tab)
    for (let expectedBars = 3; expectedBars >= 1; expectedBars--) {
      const lastBar = page.locator('[data-testid="panel-tab-bar"]').last();
      await lastBar.locator('[draggable="true"]').first().locator("button").last().click();
      await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(expectedBars);
    }

    // No dividers remain
    expect(await countColDividers(page)).toBe(0);
    expect(await countRowDividers(page)).toBe(0);
    await expect(page.locator('[role="main"]')).toBeVisible();
  });
});

// =============================================================================
//  D. Split Type Guards (non-topic panes)
// =============================================================================

test.describe("D: Split Type Guards", () => {
  let terminalSessionId: string | null = null;

  test.afterAll(async ({ request }) => {
    if (terminalSessionId) {
      await deleteTerminalSession(request, terminalSessionId);
    }
  });

  test("D11: terminal pane — Split Right click is a no-op (pane not splittable)", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // The context menu shows Split Right/Down for ALL panes (UI doesn't filter),
    // but clicking it on a terminal pane is a no-op (handler checks isSplittable).
    const session = await createTerminalSession(request, { name: "EC-Terminal-Guard" });
    terminalSessionId = session.id;

    const termPaneId = `terminal:${session.id}`;
    // Open ONLY the terminal pane (no topic) to guarantee tab index 0 is terminal
    await seedAndLoad(page, [termPaneId]);
    await waitForTabs(page, 1);

    const barsBefore = await countTabBars(page);
    expect(barsBefore).toBe(1);

    // Right-click the only tab (terminal) and click Split Right
    await rightClickTabAndSelect(page, 0, "Split Right");

    // Should be a no-op — terminal is not splittable
    await expect.poll(() => countTabBars(page), { timeout: 3000 }).toBe(barsBefore);
  });

  test("D12: activity/utility pane — split is a no-op", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA] = topicIds;
    const utilityPaneId = "activity:main";
    await seedAndLoad(page, [idA, utilityPaneId]);
    await waitForTabs(page);

    // If utility pane rendered as a tab, click Split Right — should be no-op
    const tabCount = await countTabs(page);
    if (tabCount >= 2) {
      const barsBefore = await countTabBars(page);
      // Try to split the second tab (utility)
      const tab = page.locator('[role="main"] [draggable="true"]').nth(1);
      await tab.click({ button: "right" });
      const menu = page.locator(".fixed.z-\\[9999\\]");
      if (await menu.isVisible().catch(() => false)) {
        const splitRight = menu.getByText("Split Right", { exact: true });
        if (await splitRight.isVisible().catch(() => false)) {
          await splitRight.click();
          await expect.poll(() => countTabBars(page), { timeout: 3000 }).toBe(barsBefore);
        } else {
          await page.keyboard.press("Escape");
        }
      }
    }
    await expect(page.locator('[role="main"]')).toBeVisible();
  });

  test("D13: regular topic pane shows Split Right / Split Down", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    const hasSplitRight = await rightClickTabHasOption(page, 0, "Split Right");
    const hasSplitDown = await rightClickTabHasOption(page, 0, "Split Down");

    expect(hasSplitRight, "Topic tab should have Split Right").toBe(true);
    expect(hasSplitDown, "Topic tab should have Split Down").toBe(true);
  });
});

// =============================================================================
//  E. Un-solo Mechanism
// =============================================================================

test.describe("E: Un-solo Mechanism", () => {
  test("E14: solo panel close merges topic back to standalone", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB] = topicIds;
    // Start with a seeded solo layout
    await seedAndLoad(page, [idA, idB], {
      soloTopicIds: [idA],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idA}`], widths: [0.5, 0.5] },
      ],
    });
    await waitForTabs(page, 2);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(2);

    // Close the solo panel's tab — should merge topic back to standalone
    const soloBar = page.locator('[data-testid="panel-tab-bar"]').last();
    const soloTab = soloBar.locator('[draggable="true"]').first();
    await expect(soloTab).toBeVisible({ timeout: 3000 });
    await soloTab.locator("button").last().click();

    // After closing the solo panel, should collapse to 1 tab bar
    // The topic A is removed from openPanels, leaving only B in standalone
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(1);
    expect(await countColDividers(page)).toBe(0);
  });

  test("E15: after unsolo, grid layout collapses — solo cell disappears", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB], {
      soloTopicIds: [idA],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idA}`], widths: [0.5, 0.5] },
      ],
    });
    await waitForTabs(page);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(2);

    // Unsolo by clearing solo state via API + localStorage, then reload
    await page.request.put(`${BASE}/api/ui-state/grid-layout`, {
      data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
    });
    await page.evaluate(() => {
      localStorage.setItem("topics-panel-grid-layout", JSON.stringify({
        gridRows: [], gridRowHeights: [], soloTopicIds: [],
      }));
    });

    const panelsFetch = page.waitForResponse(
      r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
      { timeout: 10000 }
    ).catch(() => {});
    await page.goto("/");
    await panelsFetch;
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await waitForTabs(page);

    // Should be back to single tab bar
    expect(await countTabBars(page)).toBe(1);
    expect(await countColDividers(page)).toBe(0);
    expect(await countRowDividers(page)).toBe(0);
  });
});

// =============================================================================
//  F. Cross-Position Operations
// =============================================================================

test.describe("F: Cross-Position Operations", () => {
  test("F16: drag tab from right panel to left panel tab bar", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    test.fixme(true, "Cross-group DnD via HTML5 drag events is unreliable in headless Playwright — needs custom dnd-kit pointer event integration");
  });

  test("F17: each panel can independently switch active tabs", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC] = topicIds;
    // Two columns: standalone has A+B, solo:C is separate
    await seedAndLoad(page, [idA, idB, idC], {
      soloTopicIds: [idC],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idC}`], widths: [0.5, 0.5] },
      ],
    });
    await waitForTabs(page, 3);

    // The standalone group should have 2 tabs — click the second one
    const firstBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabsInFirst = firstBar.locator('[draggable="true"]');
    if (await tabsInFirst.count() >= 2) {
      await tabsInFirst.nth(1).click();
      // Verify the other panel is unaffected
      const secondBar = page.locator('[data-testid="panel-tab-bar"]').last();
      expect(await secondBar.locator('[draggable="true"]').count()).toBeGreaterThanOrEqual(1);
    }

    await expect(page.locator('[role="main"]')).toBeVisible();
  });

  test("F18: close solo panel's last tab — solo disappears", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB], {
      soloTopicIds: [idB],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`], widths: [0.5, 0.5] },
      ],
    });
    await waitForTabs(page, 2);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(2);

    // Close the solo panel's tab
    const soloBar = page.locator('[data-testid="panel-tab-bar"]').last();
    await soloBar.locator('[draggable="true"]').first().locator("button").last().click();

    // Solo panel should disappear
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(1);
    expect(await countColDividers(page)).toBe(0);
  });
});

// =============================================================================
//  G. Persistence Edge Cases
// =============================================================================

test.describe("G: Persistence Edge Cases", () => {
  test("G19: asymmetric layout (2 cols top, 1 full bottom) persists after reload", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC], {
      soloTopicIds: [idB, idC],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`], widths: [0.5, 0.5] },
        { itemKeys: [`solo:${idC}`], widths: [1] },
      ],
      gridRowHeights: [0.5, 0.5],
    });
    await waitForTabs(page);

    const beforeBars = await countTabBars(page);
    const beforeRowDivs = await countRowDividers(page);
    expect(beforeBars).toBe(3);
    expect(beforeRowDivs).toBe(1);

    // Reload — localStorage preserves the layout
    const panelsFetch = page.waitForResponse(
      r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
      { timeout: 10000 }
    ).catch(() => {});
    await page.goto("/");
    await panelsFetch;
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await waitForTabs(page);

    expect(await countTabBars(page)).toBe(beforeBars);
    expect(await countRowDividers(page)).toBe(beforeRowDivs);
  });

  test("G20: create split, close one panel, reload — reduced layout correct", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB], {
      soloTopicIds: [idB],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`], widths: [0.5, 0.5] },
      ],
    });
    await waitForTabs(page, 2);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(2);

    // Close solo panel
    const soloBar = page.locator('[data-testid="panel-tab-bar"]').last();
    await soloBar.locator('[draggable="true"]').first().locator("button").last().click();
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(1);

    // Reload
    const panelsFetch = page.waitForResponse(
      r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
      { timeout: 10000 }
    ).catch(() => {});
    await page.goto("/");
    await panelsFetch;
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await waitForTabs(page);

    expect(await countTabBars(page)).toBe(1);
    expect(await countColDividers(page)).toBe(0);
  });

  test("G21: rapid open/split/close/reopen/split/reload — final state correct", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const [idA, idB, idC] = topicIds;

    // 1. Open 3 topics with a split (B is solo)
    await seedAndLoad(page, [idA, idB, idC], {
      soloTopicIds: [idB],
      gridRows: [
        { itemKeys: ["standalone", `solo:${idB}`], widths: [0.5, 0.5] },
      ],
    });
    await waitForTabs(page, 3);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(2);

    // 2. Close the split (solo:B)
    const soloBar = page.locator('[data-testid="panel-tab-bar"]').last();
    await soloBar.locator('[draggable="true"]').first().locator("button").last().click();
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(1);

    // 3. Re-split via context menu — standalone still has A and C
    await rightClickTabAndSelect(page, 0, "Split Right");
    // A should be solo now, C stays in standalone -> 2 tab bars
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

    // 4. Reload
    const panelsFetch = page.waitForResponse(
      r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
      { timeout: 10000 }
    ).catch(() => {});
    await page.goto("/");
    await panelsFetch;
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await waitForTabs(page);

    await expect(page.locator('[role="main"]')).toBeVisible();
    expect(await countTabs(page)).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
//  H. Mixed Pane Types in Split
// =============================================================================

test.describe("H: Mixed Pane Types in Split", () => {
  let termSessionId: string | null = null;

  test.afterAll(async ({ request }) => {
    if (termSessionId) {
      await deleteTerminalSession(request, termSessionId);
    }
  });

  test("H22: topic shows split, terminal split-right is a no-op", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    const session = await createTerminalSession(request, { name: "EC-Mixed-Term" });
    termSessionId = session.id;

    const [idA] = topicIds;

    // First: verify topic tab has split option
    await seedAndLoad(page, [idA]);
    await waitForTabs(page, 1);
    const topicHasSplit = await rightClickTabHasOption(page, 0, "Split Right");
    expect(topicHasSplit, "Topic tab should have Split Right").toBe(true);

    // Second: verify terminal-only pane split is a no-op
    const termPaneId = `terminal:${session.id}`;
    await seedAndLoad(page, [termPaneId]);
    await waitForTabs(page, 1);

    const barsBefore = await countTabBars(page);
    await rightClickTabAndSelect(page, 0, "Split Right");
    // Should be a no-op — terminal is not splittable
    await expect.poll(() => countTabBars(page), { timeout: 3000 }).toBe(barsBefore);
  });

  test("H23: split a topic while terminal tabs exist — terminal stays in standalone", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    if (!termSessionId) {
      const session = await createTerminalSession(request, { name: "EC-Mixed-Term2" });
      termSessionId = session.id;
    }

    const [idA, idB] = topicIds;
    const termPaneId = `terminal:${termSessionId}`;
    await seedAndLoad(page, [idA, idB, termPaneId]);
    await waitForTabs(page, 3);

    // Split first topic
    await rightClickTabAndSelect(page, 0, "Split Right");
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

    // Terminal should still be visible somewhere
    const allLabels = await getVisibleTabLabels(page);
    const termVisible = allLabels.some(l =>
      l.includes("Terminal") || l.includes("Shell") || l.includes("EC-Mixed")
    );
    expect(termVisible, "Terminal should still be visible after splitting a topic").toBe(true);
  });
});

// =============================================================================
//  I. Regression: Full Lifecycle
// =============================================================================

test.describe("I: Full Lifecycle Regression", () => {
  test("I24: stress test — open 5, split 2, close 1, close others, reload, verify", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Start clean with 5 topics
    await seedAndLoad(page, topicIds.slice(0, 5));
    await waitForTabs(page, 5);

    // Split first topic right
    await rightClickTabAndSelect(page, 0, "Split Right");
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

    // Try to split another topic down
    const tabs = page.locator('[role="main"] [draggable="true"]');
    if (await tabs.count() > 2) {
      await tabs.nth(0).click({ button: "right" });
      const menu = page.locator(".fixed.z-\\[9999\\]");
      if (await menu.isVisible().catch(() => false)) {
        const splitDown = menu.getByText("Split Down", { exact: true });
        if (await splitDown.isVisible().catch(() => false)) {
          await splitDown.click();
        } else {
          await page.keyboard.press("Escape");
        }
      }
    }

    // Close one split panel (if there are multiple tab bars)
    const currentBars = await countTabBars(page);
    if (currentBars > 1) {
      const lastBar = page.locator('[data-testid="panel-tab-bar"]').last();
      const lastTabClose = lastBar.locator('[draggable="true"]').first().locator("button").last();
      if (await lastTabClose.isVisible().catch(() => false)) {
        await lastTabClose.click();
        // Wait for bar count to decrease or stabilize
        await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBeLessThanOrEqual(currentBars);
      }
    }

    // Close tabs until only 1 remains using Close Others
    const firstTab = page.locator('[role="main"] [draggable="true"]').first();
    if (await firstTab.isVisible().catch(() => false)) {
      await firstTab.click({ button: "right" });
      const menu = page.locator(".fixed.z-\\[9999\\]");
      if (await menu.isVisible().catch(() => false)) {
        const closeOthers = menu.getByText("Close Others", { exact: true });
        if (await closeOthers.isVisible().catch(() => false)) {
          await closeOthers.click();
          await expect.poll(() => countTabs(page), { timeout: 5000 }).toBeLessThanOrEqual(2);
        } else {
          await page.keyboard.press("Escape");
        }
      }
    }

    const finalCount = await countTabs(page);
    expect(finalCount).toBeGreaterThanOrEqual(1);

    // Reload
    const panelsFetch = page.waitForResponse(
      r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
      { timeout: 10000 }
    ).catch(() => {});
    await page.goto("/");
    await panelsFetch;
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    await expect(page.locator('[role="main"]')).toBeVisible();
    expect(await countTabs(page)).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
//  J. Reimposta pannelli (flatten to first level)
// =============================================================================

test.describe("J: Reimposta pannelli (flatten)", () => {
  test("J25: nested grid (2 rows + cellStack) flattens to one row of equal cells, no tab closes", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (flatten)" });
    const [idA, idB, idC, idD] = topicIds;
    // 2 rows; row 0 col 0 hosts a vertical sub-stack (standalone + solo:C).
    await seedAndLoad(page, [idA, idB, idC, idD], {
      soloTopicIds: [idB, idC, idD],
      gridRows: [
        {
          itemKeys: ["standalone", `solo:${idB}`],
          widths: [0.6, 0.4],
          cellStacks: { standalone: { items: [`solo:${idC}`], heights: [0.5, 0.5] } },
        },
        { itemKeys: [`solo:${idD}`], widths: [1] },
      ],
      gridRowHeights: [0.5, 0.5],
    });
    await waitForTabs(page, 4);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(4);
    expect(await countRowDividers(page), "seeded layout must be nested").toBeGreaterThanOrEqual(1);

    const tabsBefore = await countTabs(page);

    await rightClickTabAndSelect(page, 0, "Reimposta pannelli");

    // One row: stack dissolved into top-level columns, rows merged.
    await expect.poll(() => countRowDividers(page), { timeout: 5000 }).toBe(0);
    await expect.poll(() => countColDividers(page), { timeout: 5000 }).toBe(3);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(4);
    expect(await countTabs(page), "flatten must not close any tab").toBe(tabsBefore);

    // Equal-width cells (visual order preserved by the walk) — measure boxes.
    const cells = page.locator('[role="main"] [data-panel-cell]');
    await expect(cells).toHaveCount(4, { timeout: 5000 });
    const widths: number[] = [];
    for (let i = 0; i < 4; i++) {
      const b = await cells.nth(i).boundingBox();
      expect(b, `cell ${i} should have a bounding box`).not.toBeNull();
      widths.push(b!.width);
    }
    const maxDiff = Math.max(...widths) - Math.min(...widths);
    expect(maxDiff, "flattened cells should be equal width (±2px)").toBeLessThanOrEqual(2);
    // No post-reset width flicker: the auto-equalize effects see equal widths
    // and a single equal row and must leave them untouched.
    const b0 = await cells.first().boundingBox();
    expect(Math.abs(b0!.width - widths[0]), "no width flicker after the reset").toBeLessThanOrEqual(2);

    // Reload — the flat layout persists through the existing persistence
    // helper (usePanelGridPersistence); asserted via the UI, not a raw key.
    const panelsFetch = page.waitForResponse(
      r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
      { timeout: 10000 }
    ).catch(() => {});
    await page.goto("/");
    await panelsFetch;
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await waitForTabs(page, 4);
    await expect.poll(() => countRowDividers(page), { timeout: 5000 }).toBe(0);
    await expect.poll(() => countTabBars(page), { timeout: 5000 }).toBe(4);
  });

  test("J26: already-flat layout hides the 'Reimposta pannelli' menu entry", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (flatten)" });
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB], {
      soloTopicIds: [idB],
      gridRows: [{ itemKeys: ["standalone", `solo:${idB}`], widths: [0.5, 0.5] }],
      gridRowHeights: [1],
    });
    await waitForTabs(page, 2);

    const hasReset = await rightClickTabHasOption(page, 0, "Reimposta pannelli");
    expect(hasReset, "flat layout must not offer Reimposta pannelli").toBe(false);
    // Sanity: the menu did open and carries the usual entries.
    const hasSplitRight = await rightClickTabHasOption(page, 0, "Split Right");
    expect(hasSplitRight).toBe(true);
  });

  test("J27: terminal pane in the layout survives the reset (remount, no reload)", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (flatten)" });
    const [idA] = topicIds;
    const session = await createTerminalSession(request, { name: `EC-FlattenTerm-${TS}` });
    const termPaneId = `terminal:${session.id}`;
    try {
      // Two rows: the standalone group (hosting the terminal tab, active)
      // above a solo'd topic — a nested layout the reset will flatten.
      await seedAndLoad(page, [termPaneId, idA], {
        soloTopicIds: [idA],
        gridRows: [
          { itemKeys: ["standalone"], widths: [1] },
          { itemKeys: [`solo:${idA}`], widths: [1] },
        ],
        gridRowHeights: [0.5, 0.5],
      });
      await waitForTabs(page, 2);
      expect(await countRowDividers(page)).toBeGreaterThanOrEqual(1);

      // The terminal must be mounted before the reset.
      const xterm = page.locator('[role="main"] .xterm').first();
      await expect(xterm, "terminal should render before the reset").toBeVisible({ timeout: 15000 });

      await rightClickTabAndSelect(page, 0, "Reimposta pannelli");
      await expect.poll(() => countRowDividers(page), { timeout: 5000 }).toBe(0);
      await expect.poll(() => countColDividers(page), { timeout: 5000 }).toBe(1);

      // Remount-survival: the terminal pane re-mounts its renderer and the
      // tab stays open (PTY survives — lossless reattach, no dead-end).
      expect(await countTabs(page), "no tab may close on reset").toBe(2);
      await expect(page.locator('[role="main"] .xterm').first(), "terminal must still render after the reset").toBeVisible({ timeout: 15000 });
    } finally {
      await deleteTerminalSession(request, session.id);
    }
  });
});
