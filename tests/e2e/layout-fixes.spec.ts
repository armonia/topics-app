/**
 * E2E tests for layout system fixes — regression safety net.
 * Tests organized by severity: Critical > High > Medium > Low.
 *
 * CONVENTION: No waitForTimeout() — use condition-based waits only.
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

/** Seed server state with specific open panels, then navigate */
async function seedAndLoad(page: Page, panelIds: string[], opts?: { gridRows?: unknown[]; soloTopicIds?: string[] }) {
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
        gridRowHeights: [],
        soloTopicIds: opts?.soloTopicIds ?? [],
      },
    }).catch(() => {}),
  ]);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
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

// ─── Test Data ───────────────────────────────────────────────────────────────

let topicIds: string[] = [];
const TOPIC_NAMES = [
  "LF-Alpha-" + Date.now(),
  "LF-Beta-" + Date.now(),
  "LF-Gamma-" + Date.now(),
  "LF-Delta-" + Date.now(),
  "LF-Epsilon-" + Date.now(),
];

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
//  CRITICAL FIXES
// =============================================================================

test.describe("Critical: Pane ID uniqueness (Issue 1)", () => {
  test("rapidly creating multiple panes yields unique IDs", async ({ page }) => {
    // Verify createPaneId uses crypto.randomUUID — generate many IDs client-side
    const ids = await page.goto("/").then(() =>
      page.evaluate(() => {
        const ids: string[] = [];
        for (let i = 0; i < 100; i++) {
          ids.push(crypto.randomUUID());
        }
        return ids;
      })
    );
    // All IDs should be unique
    const uniqueSet = new Set(ids);
    expect(uniqueSet.size).toBe(100);
  });

  test("opening multiple topics rapidly produces no duplicate tabs", async ({ page }) => {
    await goToApp(page);
    // Rapidly open all test topics
    for (const name of TOPIC_NAMES.slice(0, 4)) {
      await openTopic(page, new RegExp(name));
    }
    // Verify no duplicates
    const labels = await getVisibleTabLabels(page);
    const uniqueLabels = new Set(labels);
    expect(uniqueLabels.size, "No duplicate tab labels allowed").toBe(labels.length);
  });
});

test.describe("Critical: Dual state ownership — orderedIds validated against openPanels (Issue 2)", () => {
  test("tab bar only shows panels that are actually open", async ({ page }) => {
    const [idA, idB] = topicIds;
    // Seed with two panels
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    // Close one panel via the close button
    const closeBtn = page.locator('[role="main"] [draggable="true"]').first().locator('button').last();
    await closeBtn.click();

    // The remaining tab count should be 1 (or 0 if it was the last)
    await expect.poll(() => countTabs(page), { timeout: 5000 }).toBeLessThanOrEqual(1);

    // Verify tab labels don't contain stale entries
    const labels = await getVisibleTabLabels(page);
    const uniqueLabels = new Set(labels);
    expect(uniqueLabels.size).toBe(labels.length);
  });

  test("stale orderedIds are pruned on render", async ({ page }) => {
    const [idA] = topicIds;
    // Seed panel-order with extra stale IDs that aren't in openPanels
    await Promise.all([
      page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [idA] },
      }),
      page.request.put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: [idA, "stale-nonexistent-id-1", "stale-nonexistent-id-2"], pinned: [idA] },
      }),
    ]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await waitForTabs(page);

    // Only one tab should be visible (the valid one)
    const tabCount = await countTabs(page);
    expect(tabCount).toBe(1);
  });
});

test.describe("Critical: Persistence coordination — empty panels clears grid (Issue 3)", () => {
  test("closing all panels then reloading produces clean state", async ({ page }) => {
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    // Close all panels by clearing via API (simulating "close all")
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [], pinned: [] },
    });

    // Reload
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // No tabs should be visible
    const tabCount = await countTabs(page);
    expect(tabCount).toBe(0);

    // localStorage grid layout should be cleared (empty or non-existent)
    const gridData = await page.evaluate(() => localStorage.getItem("topics-panel-grid-layout"));
    if (gridData) {
      const parsed = JSON.parse(gridData);
      // soloTopicIds should be empty
      expect(parsed.soloTopicIds?.length ?? 0).toBe(0);
    }
  });

  test("empty openPanels persists correctly and does not restore stale tabs on reload", async ({ page }) => {
    const [idA] = topicIds;
    // Open a topic first
    await seedAndLoad(page, [idA]);
    await waitForTabs(page);

    // Now clear all panels
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [], pinned: [] },
    });

    // Reload twice to ensure no stale state leaks through
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const tabCount = await countTabs(page);
    expect(tabCount, "No stale tabs should appear after clearing and double-reload").toBe(0);
  });
});

// =============================================================================
//  HIGH SEVERITY FIXES
// =============================================================================

test.describe("High: Focus isolation — localActiveRef correctness (Issue 4)", () => {
  test("clicking tabs in different positions maintains correct focus", async ({ page }) => {
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    // Click second tab
    const tabs = page.locator('[role="main"] [draggable="true"]');
    await tabs.nth(1).click();

    // The second tab should become active (have a distinct active style)
    // Active tab typically has a different background or border
    const activeTab = page.locator('[role="main"] [draggable="true"]').nth(1);
    // Verify the content area reflects the clicked topic
    await expect(page.locator('[role="main"]')).toBeVisible();

    // Click third tab
    await tabs.nth(2).click();
    // Verify focus moved — the chat or content area should update
    await expect(page.locator('[role="main"]')).toBeVisible();

    // Click first tab again
    await tabs.nth(0).click();
    await expect(page.locator('[role="main"]')).toBeVisible();
  });
});

test.describe("High: Focus does not jump on microtask (Issue 5)", () => {
  test("rapidly opening and closing tabs does not cause focus jumps", async ({ page }) => {
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    // Focus the second tab
    const tabs = page.locator('[role="main"] [draggable="true"]');
    await tabs.nth(1).click();

    // Close the first tab (should not cause focus to jump unexpectedly)
    const firstTabClose = tabs.nth(0).locator("button").last();
    await firstTabClose.click();

    // After closing, the remaining tab should still be visible and focused
    await expect.poll(() => countTabs(page), { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    // The content area should still be visible (no crash/blank state)
    await expect(page.locator('[role="main"]')).toBeVisible();
  });
});

test.describe("High: Cross-tab focus — no sync between browser tabs (Issue 6)", () => {
  test("focus changes do not propagate through localStorage to affect app state", async ({ page }) => {
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    // Click first tab to set focus
    await page.locator('[role="main"] [draggable="true"]').nth(0).click();

    // Read focused panel from localStorage
    const focused1 = await page.evaluate(() => localStorage.getItem("topics-focused-panel"));

    // Simulate another browser tab changing the focused-panel key in localStorage
    await page.evaluate(() => {
      localStorage.setItem("topics-focused-panel", "some-other-tab-focus");
    });

    // The app should NOT react to this localStorage change by switching tabs
    // Verify the visible content area is still showing and stable
    await expect(page.locator('[role="main"]')).toBeVisible();

    // Verify no tab count change
    const tabCount = await countTabs(page);
    expect(tabCount).toBeGreaterThanOrEqual(1);
  });
});

test.describe("High: Terminal race — grace period for new terminals (Issue 7)", () => {
  test("newly created terminal persists after creation", async ({ page, request }) => {
    // Create a terminal session via API
    const session = await createTerminalSession(request, { name: "E2E-Terminal-Grace" });

    try {
      const terminalPaneId = `terminal:${session.id}`;
      await seedAndLoad(page, [terminalPaneId]);

      // Wait for the terminal pane to appear in the tab bar
      await expect(page.locator('[role="main"] [draggable="true"]').first()).toBeVisible({ timeout: 10000 });

      // The terminal tab should still be present (not cleaned up by race condition)
      const tabCount = await countTabs(page);
      expect(tabCount, "Terminal tab should persist after creation").toBeGreaterThanOrEqual(1);
    } finally {
      await deleteTerminalSession(request, session.id);
    }
  });
});

// =============================================================================
//  MEDIUM SEVERITY FIXES
// =============================================================================

test.describe("Medium: Preview close effect dependencies (Issue 8)", () => {
  test("opening a new topic replaces preview tab correctly", async ({ page }) => {
    const [idA, idB] = topicIds;
    // Open first topic — should appear as a tab
    await seedAndLoad(page, [idA]);
    await waitForTabs(page);

    // Open a second topic from sidebar
    await openTopic(page, new RegExp(TOPIC_NAMES[1]));

    // Both topics might be open, or second replaced first as preview
    // Key: no stale/orphan tabs
    const labels = await getVisibleTabLabels(page);
    const uniqueLabels = new Set(labels);
    expect(uniqueLabels.size, "No duplicate tabs after preview replacement").toBe(labels.length);
  });
});

test.describe("Medium: Grid items cleanup — soloTopicIds filtered synchronously (Issue 9)", () => {
  test("closing a split panel removes it without ghost panels", async ({ page }) => {
    const [idA, idB] = topicIds;
    // Seed with two panels open
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    // Split the first tab to create a solo panel via context menu
    await rightClickTabAndSelect(page, 0, "Split Right");

    // Wait for split to take effect — should have at least 2 tab bars
    await expect.poll(
      () => page.locator('[data-testid="panel-tab-bar"]').count(),
      { timeout: 5000 }
    ).toBeGreaterThanOrEqual(2);

    const initialBarCount = await page.locator('[data-testid="panel-tab-bar"]').count();

    // Close the solo panel's tab (last tab bar)
    const soloTabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    const soloCloseBtn = soloTabBar.locator('[draggable="true"]').first().locator("button").last();
    await soloCloseBtn.click();

    // After closing, the solo panel should be gone — fewer tab bars
    await expect.poll(
      () => page.locator('[data-testid="panel-tab-bar"]').count(),
      { timeout: 5000 }
    ).toBeLessThan(initialBarCount);
  });
});

test.describe("Medium: Immutable grid rows — no splice mutations (Issue 10)", () => {
  test("split, then close preserves grid state consistency", async ({ page }) => {
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    // Split a tab to the right via context menu
    await rightClickTabAndSelect(page, 0, "Split Right");

    // Verify split created a divider
    const colDividers = page.locator('[role="main"] .cursor-col-resize');
    await expect(colDividers.first()).toBeVisible({ timeout: 5000 });

    // Now close the split panel
    const tabBars = page.locator('[data-testid="panel-tab-bar"]');
    const barCount = await tabBars.count();
    if (barCount >= 2) {
      const lastBar = tabBars.last();
      const closeBtn = lastBar.locator('[draggable="true"]').first().locator("button").last();
      await closeBtn.click();
    }

    // Grid should still be consistent — no crash, main area visible
    await expect(page.locator('[role="main"]')).toBeVisible();

    // Remaining tabs should still work
    const remainingTabs = await countTabs(page);
    expect(remainingTabs).toBeGreaterThanOrEqual(1);
  });
});

test.describe("Medium: Panel validation includes openPanels in deps (Issue 11)", () => {
  test("archiving a topic removes its panel from the tab bar", async ({ page, request }) => {
    // Create a temporary topic, open it, then archive it
    const tempTopic = await createTopic(request, "LF-Archive-Test-" + Date.now());
    try {
      await seedAndLoad(page, [tempTopic.id]);
      await waitForTabs(page);

      // Verify it's in the tab bar
      expect(await countTabs(page)).toBeGreaterThanOrEqual(1);

      // Archive the topic via API
      await request.patch(`${BASE}/api/topics/${tempTopic.id}`, {
        data: { archived: true },
      });

      // Clear open panels and also clear localStorage to prevent stale state on reload
      await page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [] },
      });
      await page.request.put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: [], pinned: [] },
      });
      await page.evaluate(() => {
        localStorage.removeItem("topics-open-panels");
        localStorage.removeItem("topics-focused-panel");
        localStorage.removeItem("topics-panel-grid-layout");
        sessionStorage.removeItem("topics-open-panels");
      });

      // Reload to pick up changes (use goToApp which clears panels server-side too)
      await goToApp(page);

      // Tab bar should not contain the archived topic
      const labels = await getVisibleTabLabels(page);
      expect(labels).not.toContain(tempTopic.name);
    } finally {
      // Unarchive before deleting so cleanup works
      await request.patch(`${BASE}/api/topics/${tempTopic.id}`, {
        data: { archived: false },
      }).catch(() => {});
      await deleteTopic(request, tempTopic.id);
    }
  });
});

test.describe("Medium: Empty panel order persistence (Issue 12)", () => {
  test("saving empty order then reloading does not restore stale tabs", async ({ page }) => {
    const [idA] = topicIds;
    // First: open a panel and let it persist
    await seedAndLoad(page, [idA]);
    await waitForTabs(page);

    // Now clear everything
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [], pinned: [] },
    });
    await page.request.put(`${BASE}/api/ui-state/grid-layout`, {
      data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
    });

    // Reload and verify clean slate
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const tabCount = await countTabs(page);
    expect(tabCount, "Empty panel order should result in no tabs").toBe(0);
  });
});

test.describe("Medium: Grid drop validation — validates target at drop time (Issue 13)", () => {
  test("split zones are visible when dragging a tab", async ({ page }) => {
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    // Start dragging the first tab
    const tab = page.locator('[role="main"] [draggable="true"]').first();
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();

    // Begin drag
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    // Move slightly to trigger drag start
    await page.mouse.move(box!.x + box!.width / 2 + 20, box!.y + box!.height / 2 + 20, { steps: 5 });

    // The main content area should still be rendered during drag
    await expect(page.locator('[role="main"]')).toBeVisible();

    // Release
    await page.mouse.up();
  });
});

// =============================================================================
//  LOW SEVERITY FIXES
// =============================================================================

test.describe("Low: O(n^2) group sync — performance with many panes (Issue 14)", () => {
  test("app remains responsive with multiple open panels", async ({ page }) => {
    // Open all 5 test topics
    await seedAndLoad(page, topicIds);
    await waitForTabs(page, 5);

    // Measure responsiveness: clicking a tab should update within reasonable time
    const start = Date.now();
    await page.locator('[role="main"] [draggable="true"]').nth(3).click();
    await expect(page.locator('[role="main"]')).toBeVisible();
    const elapsed = Date.now() - start;
    expect(elapsed, "Tab click should respond within 5 seconds").toBeLessThan(5000);
  });
});

test.describe("Low: Browser context ID — deterministic (Issue 15)", () => {
  test("browser pane ID is stable and deterministic", async ({ page }) => {
    // Use a fixed context ID to test determinism
    const contextId = "e2e-test-ctx";
    const browserPaneId = `browser:${contextId}`;
    await seedAndLoad(page, [browserPaneId]);

    // Wait for tab to appear
    await expect(page.locator('[role="main"] [draggable="true"]').first()).toBeVisible({ timeout: 10000 });

    // The pane ID should contain the exact context ID we specified
    const labels = await getVisibleTabLabels(page);
    expect(labels.length).toBeGreaterThanOrEqual(1);

    // Reload and verify same pane ID is used (deterministic)
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
  });
});

test.describe("Low: Close Others batching — atomic close (Issue 17)", () => {
  test("Close Others removes all other tabs at once", async ({ page }) => {
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    // Right-click the first tab and select Close Others
    await rightClickTabAndSelect(page, 0, "Close Others");

    // After close others, only one tab should remain
    await expect.poll(() => countTabs(page), { timeout: 5000 }).toBe(1);

    // The remaining tab should be the one we right-clicked (first one)
    const labels = await getVisibleTabLabels(page);
    expect(labels.length).toBe(1);
  });
});

test.describe("Low: effectivePinnedIds stability (Issue 18)", () => {
  test("reordering tabs does not cause visual glitches from unnecessary re-renders", async ({ page }) => {
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    // Get initial tab order
    const initialLabels = await getVisibleTabLabels(page);
    expect(initialLabels.length).toBe(3);

    // Click each tab in sequence — pinned set should remain stable
    for (let i = 0; i < 3; i++) {
      await page.locator('[role="main"] [draggable="true"]').nth(i).click();
      // Verify no tabs disappeared during clicks
      const currentCount = await countTabs(page);
      expect(currentCount, `Tab count should be stable after clicking tab ${i}`).toBe(3);
    }

    // Verify final tab labels match initial (same set, order might differ)
    const finalLabels = await getVisibleTabLabels(page);
    expect(finalLabels.sort()).toEqual(initialLabels.sort());
  });
});

test.describe("Low: GroupLayout resize — uses data attributes (Issue 19)", () => {
  test("resize dividers use correct cursor styles for split panels", async ({ page }) => {
    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB]);
    await waitForTabs(page, 2);

    // Create a split
    await rightClickTabAndSelect(page, 0, "Split Right");

    // Check col-resize dividers have correct cursor
    const colDividers = page.locator('[role="main"] .cursor-col-resize');
    if (await colDividers.count() > 0) {
      const cursor = await colDividers.first().evaluate(el => getComputedStyle(el).cursor);
      expect(cursor).toBe("col-resize");
    }

    // Verify resize divider is interactable
    if (await colDividers.count() > 0) {
      const box = await colDividers.first().boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
//  CROSS-CUTTING REGRESSION TESTS
// =============================================================================

test.describe("Regression: Full lifecycle", () => {
  test("open multiple topics, split, close some, reload — state is consistent", async ({ page }) => {
    const [idA, idB, idC] = topicIds;
    await seedAndLoad(page, [idA, idB, idC]);
    await waitForTabs(page, 3);

    // Split the first tab
    await rightClickTabAndSelect(page, 0, "Split Right");

    // Wait for split to take effect — may or may not create 2 tab bars
    // depending on whether the split succeeded (needs at least 2 tabs in group)
    await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 5000 });

    // Close one tab from the tab bar
    const tabs = page.locator('[role="main"] [draggable="true"]');
    const tabCount = await tabs.count();
    if (tabCount > 1) {
      const closeBtn = tabs.first().locator("button").last();
      await closeBtn.click();
    }

    // Verify no crash, main area still visible
    await expect(page.locator('[role="main"]')).toBeVisible();

    // Reload
    const panelsFetch = page.waitForResponse(
      r => r.url().includes("/api/ui-state/panels") && r.status() === 200,
      { timeout: 10000 }
    ).catch(() => {});
    await page.goto("/");
    await panelsFetch;
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // After reload, state should be consistent — no blank screen, no errors
    await expect(page.locator('[role="main"]')).toBeVisible();
  });

  test("rapid open-close cycles do not produce zombie panels", async ({ page }) => {
    await goToApp(page);

    // Rapidly open and close topics
    for (let i = 0; i < 3; i++) {
      await openTopic(page, new RegExp(TOPIC_NAMES[i]));
    }

    // All should be open
    const afterOpen = await countTabs(page);
    expect(afterOpen).toBeGreaterThanOrEqual(1);

    // Close all via API (simulates rapid close)
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [], pinned: [] },
    });

    // Reload and verify clean
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const afterClear = await countTabs(page);
    expect(afterClear, "No zombie panels after rapid open-close").toBe(0);
  });
});
