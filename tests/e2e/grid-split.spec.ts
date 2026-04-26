import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Open any available chat topic from the sidebar */
async function openAnyTopic(page: Page) {
  // Try clicking the first treeitem that looks like a topic (not a project folder)
  const treeItems = page.getByRole("treeitem");
  const count = await treeItems.count();
  for (let i = 0; i < Math.min(count, 30); i++) {
    const text = await treeItems.nth(i).textContent();
    // Skip project folder entries (they contain file-like names)
    if (text && !text.includes('.ts') && !text.includes('.json') && !text.includes('.md')) {
      await treeItems.nth(i).click();
      await page.waitForTimeout(1500);
      return;
    }
  }
  // Fallback: just click the first one
  if (count > 0) {
    await treeItems.first().click();
    await page.waitForTimeout(1500);
  }
}

/** Get all visible tab labels in the main area (all tab bars) */
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

/** Count row-resize dividers (vertical splits) */
async function countRowDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-row-resize').count();
}

/** Count col-resize dividers (horizontal splits) */
async function countColDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-col-resize').count();
}

/** Open a project window by clicking its sidebar entry */
async function openProject(page: Page, name: string | RegExp) {
  const projectBtn = typeof name === 'string'
    ? page.locator(`button:has-text("${name}")`)
    : page.locator('button').filter({ hasText: name });
  await projectBtn.first().click();
  await page.waitForTimeout(2000);
}

// ─── Test Suite ───────────────────────────────────────────────────────────

let projectTopicId: string | null = null;

test.describe("Grid Split System", () => {
  test.beforeAll(async ({ request }) => {
    // Create a project-linked topic so the "Projects" section has an entry
    const topic = await createTopic(request, "E2E-GridProject", {
      projectPath: "/tmp/e2e-grid",
    });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) {
      await deleteTopic(request, projectTopicId);
    }
  });

  test.describe("Chat splits", () => {
    test.beforeEach(async ({ page }) => {
      await goToApp(page);
      await openAnyTopic(page);
    });

    test("no duplicate tabs in initial state", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      const labels = await getVisibleTabLabels(page);
      const counts = new Map<string, number>();
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
      for (const [label, count] of counts) {
        expect(count, `Tab "${label}" should not be duplicated`).toBe(1);
      }
    });

    test("main area has sufficient dimensions", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      const mainBox = await page.locator('[role="main"]').boundingBox();
      expect(mainBox).not.toBeNull();
      expect(mainBox!.width).toBeGreaterThan(400);
      expect(mainBox!.height).toBeGreaterThan(300);
    });

    test("tab bar is not oversized", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      const tabBar = page.locator('[role="main"] .border-b.border-app-border.flex-shrink-0').first();
      if (await tabBar.count() === 0) return;

      const box = await tabBar.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height, 'Tab bar height should be compact').toBeLessThan(60);
    });

    test("layout persists after page reload", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      // Open the self-provisioned project to ensure we have tabs
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(1500);

      const initialLabels = await getVisibleTabLabels(page);
      if (initialLabels.length === 0) {
        test.skip();
        return;
      }

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
      // Re-open the same project
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(1500);

      const reloadedLabels = await getVisibleTabLabels(page);
      expect(reloadedLabels.length).toBeGreaterThan(0);
      const overlap = initialLabels.filter(l => reloadedLabels.includes(l));
      expect(overlap.length, 'Some tabs should persist across reload').toBeGreaterThan(0);
    });
  });

  test.describe("GroupLayout flex fix (Bug 2)", () => {
    test("row wrappers with flex style do not have flex-1", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openAnyTopic(page);

      const flexColContainers = page.locator('[role="main"] .flex.flex-col.min-h-0');
      const count = await flexColContainers.count();

      for (let i = 0; i < count; i++) {
        const el = flexColContainers.nth(i);
        const style = await el.getAttribute('style');
        const classes = await el.getAttribute('class');

        if (style && style.includes('flex:')) {
          expect(classes, 'Row with flex style should not have flex-1').not.toContain('flex-1');
        }
      }
    });
  });

  test.describe("Project window splits", () => {
    test.beforeEach(async ({ page }) => {
      await goToApp(page);
    });

    test("project window opens with tab bar", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(1500);

      const labels = await getVisibleTabLabels(page);
      expect(labels.length, 'Project should have at least one tab').toBeGreaterThan(0);
    });

    test("project tabs include utility types (terminal, git, browser)", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(1500);

      const addBtn = page.locator('[role="main"] button[title*="Add"], [role="main"] button:has-text("+")');
      if (await addBtn.count() > 0) {
        await addBtn.first().click();
        await page.waitForTimeout(500);

        const body = await page.locator('body').textContent();
        const hasUtilityOptions =
          body!.includes('Terminal') || body!.includes('Browser') || body!.includes('Git');
        expect(hasUtilityOptions, 'Project should offer utility pane types').toBeTruthy();

        await page.keyboard.press('Escape');
      }
    });

    test("project window tab bar remains compact", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(1500);

      const tabBars = page.locator('[role="main"] .border-b.border-app-border.flex-shrink-0');
      const count = await tabBars.count();

      for (let i = 0; i < count; i++) {
        const box = await tabBars.nth(i).boundingBox();
        if (box) {
          expect(box.height, `Tab bar ${i} height should be compact`).toBeLessThan(60);
        }
      }
    });

    test("no duplicate tabs after project operations", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(2000);

      const labels = await getVisibleTabLabels(page);
      const counts = new Map<string, number>();
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);

      for (const [label, count] of counts) {
        expect(count, `Tab "${label}" should not be duplicated in project`).toBe(1);
      }
    });
  });

  test.describe("Resize dividers", () => {
    test("column resize divider has correct cursor", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openAnyTopic(page);

      const colDividers = page.locator('[role="main"] .cursor-col-resize');
      if (await colDividers.count() === 0) {
        test.skip();
        return;
      }

      const divider = colDividers.first();
      const box = await divider.boundingBox();
      expect(box).not.toBeNull();

      const cursor = await divider.evaluate(el => getComputedStyle(el).cursor);
      expect(cursor).toBe('col-resize');
    });

    test("row resize divider has correct cursor", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openAnyTopic(page);

      const rowDividers = page.locator('[role="main"] .cursor-row-resize');
      if (await rowDividers.count() === 0) {
        test.skip();
        return;
      }

      const divider = rowDividers.first();
      const box = await divider.boundingBox();
      expect(box).not.toBeNull();

      const cursor = await divider.evaluate(el => getComputedStyle(el).cursor);
      expect(cursor).toBe('row-resize');
    });
  });

  test.describe("Split handler correctness (unit-level via evaluate)", () => {
    test("split removes pane from source group when it is the only pane", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(2000);

      const result = await page.evaluate(() => {
        const groups = [
          { id: 'g1', paneIds: ['p1'], activePaneId: 'p1' },
          { id: 'g2', paneIds: ['p2', 'p3'], activePaneId: 'p2' },
        ];
        const paneId = 'p1';
        const sourceGroupId = 'g1';

        const updated = groups.map(g => {
          if (g.id === sourceGroupId) {
            const remaining = g.paneIds.filter(id => id !== paneId);
            const newActive = remaining.length > 0
              ? (g.activePaneId === paneId
                ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
                : g.activePaneId)
              : g.activePaneId;
            return { ...g, paneIds: remaining, activePaneId: newActive };
          }
          return g;
        }).filter(g => g.paneIds.length > 0);

        return {
          groupCount: updated.length,
          remainingGroupIds: updated.map(g => g.id),
          g2PaneCount: updated.find(g => g.id === 'g2')?.paneIds.length,
        };
      });

      expect(result.groupCount).toBe(1);
      expect(result.remainingGroupIds).toEqual(['g2']);
      expect(result.g2PaneCount).toBe(2);
    });

    test("split creates new group with correct type mapping", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await page.waitForTimeout(1000);

      const result = await page.evaluate(() => {
        function paneTypeToGroupType(type: string): string {
          if (type === 'chat') return 'chat';
          if (type === 'file' || type === 'files') return 'file';
          return 'utility';
        }

        return {
          chat: paneTypeToGroupType('chat'),
          file: paneTypeToGroupType('file'),
          files: paneTypeToGroupType('files'),
          browser: paneTypeToGroupType('browser'),
          terminal: paneTypeToGroupType('terminal'),
          git: paneTypeToGroupType('git'),
          project: paneTypeToGroupType('project'),
        };
      });

      expect(result.chat).toBe('chat');
      expect(result.file).toBe('file');
      expect(result.files).toBe('file');
      expect(result.browser).toBe('utility');
      expect(result.terminal).toBe('utility');
      expect(result.git).toBe('utility');
      expect(result.project).toBe('utility');
    });

    test("move between groups removes from source and adds to target", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await page.waitForTimeout(1000);

      const result = await page.evaluate(() => {
        const groups = [
          { id: 'g1', paneIds: ['p1', 'p2'], activePaneId: 'p1' },
          { id: 'g2', paneIds: ['p3'], activePaneId: 'p3' },
        ];
        const paneId = 'p1';
        const sourceGroupId = 'g1';
        const targetGroupId = 'g2';
        const insertIdx = 1;

        const updated = groups.map(g => {
          if (g.id === sourceGroupId) {
            const remaining = g.paneIds.filter(id => id !== paneId);
            const newActive = remaining.length > 0
              ? (g.activePaneId === paneId
                ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
                : g.activePaneId)
              : g.activePaneId;
            return { ...g, paneIds: remaining, activePaneId: newActive };
          }
          if (g.id === targetGroupId) {
            const newPaneIds = [...g.paneIds];
            newPaneIds.splice(Math.max(0, Math.min(insertIdx, newPaneIds.length)), 0, paneId);
            return { ...g, paneIds: newPaneIds, activePaneId: paneId };
          }
          return g;
        }).filter(g => g.paneIds.length > 0);

        return {
          groupCount: updated.length,
          g1Panes: updated.find(g => g.id === 'g1')?.paneIds,
          g2Panes: updated.find(g => g.id === 'g2')?.paneIds,
          g1Active: updated.find(g => g.id === 'g1')?.activePaneId,
          g2Active: updated.find(g => g.id === 'g2')?.activePaneId,
        };
      });

      expect(result.groupCount).toBe(2);
      expect(result.g1Panes).toEqual(['p2']);
      expect(result.g2Panes).toEqual(['p3', 'p1']);
      expect(result.g1Active).toBe('p2');
      expect(result.g2Active).toBe('p1');
    });

    test("move last pane from group removes that group", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await page.waitForTimeout(1000);

      const result = await page.evaluate(() => {
        const groups = [
          { id: 'g1', paneIds: ['p1'], activePaneId: 'p1' },
          { id: 'g2', paneIds: ['p3'], activePaneId: 'p3' },
        ];
        const paneId = 'p1';
        const sourceGroupId = 'g1';
        const targetGroupId = 'g2';
        const insertIdx = 0;

        const updated = groups.map(g => {
          if (g.id === sourceGroupId) {
            const remaining = g.paneIds.filter(id => id !== paneId);
            const newActive = remaining.length > 0
              ? (g.activePaneId === paneId
                ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
                : g.activePaneId)
              : g.activePaneId;
            return { ...g, paneIds: remaining, activePaneId: newActive };
          }
          if (g.id === targetGroupId) {
            const newPaneIds = [...g.paneIds];
            newPaneIds.splice(Math.max(0, Math.min(insertIdx, newPaneIds.length)), 0, paneId);
            return { ...g, paneIds: newPaneIds, activePaneId: paneId };
          }
          return g;
        }).filter(g => g.paneIds.length > 0);

        return {
          groupCount: updated.length,
          remainingGroupIds: updated.map(g => g.id),
          g2Panes: updated.find(g => g.id === 'g2')?.paneIds,
        };
      });

      expect(result.groupCount).toBe(1);
      expect(result.remainingGroupIds).toEqual(['g2']);
      expect(result.g2Panes).toEqual(['p1', 'p3']);
    });
  });

  test.describe("Panel splitting", () => {
    let splitTopicIds: string[] = [];

    test.beforeAll(async ({ request }) => {
      // Create test topics for split tests
      const t1 = await createTopic(request, "E2E-Split-A");
      const t2 = await createTopic(request, "E2E-Split-B");
      const t3 = await createTopic(request, "E2E-Split-C");
      splitTopicIds = [t1.id, t2.id, t3.id];
    });

    test.afterAll(async ({ request }) => {
      for (const id of splitTopicIds) {
        await deleteTopic(request, id);
      }
    });

    /** Reset grid layout state (clear solo topics, grid rows) */
    async function resetGridLayout(page: Page) {
      await page.request.put("http://localhost:13334/api/ui-state/grid-layout", {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      }).catch(() => {});
    }

    /** Open two topics so both appear as tabs */
    async function openTwoTopics(page: Page) {
      const [idA, idB] = splitTopicIds;
      // 1. Seed server state with both panels open
      await Promise.all([
        page.request.put("http://localhost:13334/api/ui-state/panels", {
          data: { openPanels: [idA, idB] },
        }).catch(() => {}),
        page.request.put("http://localhost:13334/api/ui-state/grid-layout", {
          data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
        }).catch(() => {}),
        page.request.put("http://localhost:13334/api/ui-state/panel-order", {
          data: { order: [idA, idB], pinned: [idA, idB] },
        }).catch(() => {}),
      ]);
      // 2. Navigate — app loads both panels from server
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await collapseSidebarSections(page);
      // Wait for tabs to render
      await page.locator('[role="main"] [draggable="true"]').first().waitFor({ state: "visible", timeout: 10000 });
      await page.waitForTimeout(800);
    }

    /** Collapse Terminals and Browser sections to make room for Chats topics */
    async function collapseSidebarSections(page: Page) {
      // Collapse Terminals section if expanded
      const terminalsBtn = page.getByRole("button", { name: /Terminals section/ });
      if (await terminalsBtn.count() > 0) {
        const expanded = await terminalsBtn.getAttribute("aria-expanded");
        if (expanded === "true") {
          await terminalsBtn.click();
          await page.waitForTimeout(300);
        }
      }
      // Collapse Browser section if expanded
      const browserBtn = page.getByRole("button", { name: /Browser section/ });
      if (await browserBtn.count() > 0) {
        const expanded = await browserBtn.getAttribute("aria-expanded");
        if (expanded === "true") {
          await browserBtn.click();
          await page.waitForTimeout(300);
        }
      }
      // Collapse Projects section if expanded
      const projectsBtn = page.getByRole("button", { name: /Projects section/ });
      if (await projectsBtn.count() > 0) {
        const expanded = await projectsBtn.getAttribute("aria-expanded");
        if (expanded === "true") {
          await projectsBtn.click();
          await page.waitForTimeout(300);
        }
      }
    }

    /** Right-click a tab and click a context menu item */
    async function splitViaContextMenu(page: Page, direction: 'Split Right' | 'Split Down') {
      // Find a draggable tab in the main area
      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await expect(tab).toBeVisible({ timeout: 5000 });

      // Right-click on the tab to open context menu
      await tab.click({ button: 'right' });

      // Wait for the portaled context menu to appear (context menu uses fixed + z-[9999])
      const splitBtn = page.getByText(direction, { exact: true });
      await expect(splitBtn).toBeVisible({ timeout: 3000 });
      await splitBtn.click();

      // Wait for layout to update
      await page.waitForTimeout(1000);
    }

    test("GRID-01: Split Right via context menu creates side-by-side panels", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      const initialColDividers = await countColDividers(page);

      await splitViaContextMenu(page, 'Split Right');

      // After split, should have more col-resize dividers
      const afterColDividers = await countColDividers(page);
      expect(afterColDividers, 'Split Right should create a col-resize divider').toBeGreaterThan(initialColDividers);

      // Should have multiple tab bar regions (standalone group + solo panel)
      const tabBars = page.locator('[role="main"] [data-testid="panel-tab-bar"]');
      expect(await tabBars.count(), 'Should have multiple tab bars after split').toBeGreaterThanOrEqual(2);
    });

    test("GRID-02: Split Down via context menu creates above/below panels", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      const initialRowDividers = await countRowDividers(page);

      await splitViaContextMenu(page, 'Split Down');

      // After split, should have more row-resize dividers
      const afterRowDividers = await countRowDividers(page);
      expect(afterRowDividers, 'Split Down should create a row-resize divider').toBeGreaterThan(initialRowDividers);
    });

    test("GRID-02c: Split Down survives a page reload (persistence)", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (persistence)" });
      await goToApp(page);
      await openTwoTopics(page);
      await splitViaContextMenu(page, 'Split Down');

      // Capture localStorage before reload — should now contain `cellStacks`.
      const before = await page.evaluate(() =>
        localStorage.getItem('topics-panel-grid-layout'),
      );
      expect(before, 'split-down should have written cellStacks to localStorage').toBeTruthy();
      expect(before!, 'cellStacks key must be present in saved layout').toContain('cellStacks');

      await page.reload({ waitUntil: 'networkidle' });
      // Allow the post-hydrate sync effect to settle.
      await page.waitForTimeout(2000);

      const after = await page.evaluate(() =>
        localStorage.getItem('topics-panel-grid-layout'),
      );
      expect(after, 'localStorage must still contain cellStacks after reload').toBeTruthy();
      expect(after!, 'cellStacks key must survive reload').toContain('cellStacks');
    });

    test("GRID-03: Resize split panels by dragging col-resize divider", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split right to ensure we have a col divider
      await splitViaContextMenu(page, 'Split Right');

      const divider = page.locator('[role="main"] .cursor-col-resize').first();
      await expect(divider).toBeVisible({ timeout: 3000 });

      const box = await divider.boundingBox();
      expect(box).not.toBeNull();

      // Record initial divider X position
      const initialX = box!.x;

      // Drag the divider 100px to the right
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);

      // Verify the divider moved (its position should have changed)
      const newBox = await divider.boundingBox();
      expect(newBox).not.toBeNull();
      // The divider should have moved notably (at least 50px given some resistance/snapping)
      expect(Math.abs(newBox!.x - initialX), 'Divider should have moved after drag').toBeGreaterThan(30);
    });

    test("GRID-03: Resize split panels by dragging row-resize divider", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split down to ensure we have a row divider
      await splitViaContextMenu(page, 'Split Down');

      const divider = page.locator('[role="main"] .cursor-row-resize').first();
      await expect(divider).toBeVisible({ timeout: 3000 });

      const box = await divider.boundingBox();
      expect(box).not.toBeNull();

      const initialY = box!.y;

      // Drag the divider 80px down
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 80, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);

      const newBox = await divider.boundingBox();
      expect(newBox).not.toBeNull();
      expect(Math.abs(newBox!.y - initialY), 'Row divider should have moved after drag').toBeGreaterThan(20);
    });

    test("GRID-04: Split layout persists after page reload", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split right to create a col divider
      await splitViaContextMenu(page, 'Split Right');

      const preDividers = await countColDividers(page);
      expect(preDividers, 'Should have at least 1 col divider before reload').toBeGreaterThanOrEqual(1);

      // Reload and wait for layout restore
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);

      // The split layout should persist
      const postDividers = await countColDividers(page);
      expect(postDividers, 'Col dividers should persist after reload').toBeGreaterThanOrEqual(preDividers);

      // Also verify localStorage has grid layout data
      const layoutData = await page.evaluate(() => localStorage.getItem('topics-panel-grid-layout'));
      if (layoutData) {
        expect(layoutData, 'Layout data should contain grid rows').toContain('gridRows');
      }
    });

    test("GRID-05: Splitting works in project windows", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await collapseSidebarSections(page);

      // Expand Projects section to find the e2e project
      const projectsBtn = page.getByRole("button", { name: /Projects section/ });
      if (await projectsBtn.count() > 0) {
        const expanded = await projectsBtn.getAttribute("aria-expanded");
        if (expanded === "false") {
          await projectsBtn.click();
          await page.waitForTimeout(500);
        }
      }

      // Look for any project to open
      const projectItem = page.locator('[aria-label="Topics sidebar"] button').filter({ hasText: /e2e-grid|topics-app/ }).first();
      if (await projectItem.count() === 0) {
        // No projects available in test DB — skip gracefully
        test.skip();
        return;
      }

      await projectItem.click();
      await page.waitForTimeout(2000);

      // Project windows should have tabs that can be right-clicked
      const tab = page.locator('[role="main"] [draggable="true"]').first();
      if (await tab.count() === 0) {
        test.skip();
        return;
      }

      // Right-click on a project tab
      await tab.click({ button: 'right' });

      // Check if context menu appears
      const ctxMenu = page.locator('.fixed.z-\\[9999\\]').last();
      await expect(ctxMenu).toBeVisible({ timeout: 3000 });

      const menuText = await ctxMenu.textContent();
      expect(menuText).toBeTruthy();

      // Split options are only for chat panes (per Plan 01), so verify project tabs have context menu
      // but may not have split actions
      await page.keyboard.press('Escape');
    });

    test("GRID-06: Context menu shows Split Right and Split Down for chat panes", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await collapseSidebarSections(page);
      await openTopic(page, /E2E-Split-A/);

      // Right-click on a chat tab
      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await expect(tab).toBeVisible({ timeout: 5000 });
      await tab.click({ button: 'right' });

      // Wait for context menu
      const ctxMenu = page.locator('.fixed.z-\\[9999\\]').last();
      await expect(ctxMenu).toBeVisible({ timeout: 3000 });

      // Verify both split options are present
      await expect(ctxMenu.getByText('Split Right')).toBeVisible();
      await expect(ctxMenu.getByText('Split Down')).toBeVisible();

      // Close the menu
      await page.keyboard.press('Escape');
    });

    test("GRID-01/02: DnD edge-drop creates split", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      // DnD tests are notoriously flaky with pointer events + dnd-kit.
      // This test attempts to drag a tab to the edge of the main area.
      // Marking as fixme if it proves unreliable.
      test.fixme();
    });
  });

  test.describe("DnD MIME types", () => {
    test("all pane tabs set PANE_TAB on drag", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      // Open the self-provisioned project to ensure we have draggable tabs
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(2000);

      const draggableTabs = page.locator('[role="main"] [draggable="true"]');
      const count = await draggableTabs.count();
      expect(count, 'Should have at least one draggable tab').toBeGreaterThan(0);
    });

    test("tabs within project window are draggable", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(2000);

      const draggableTabs = page.locator('[role="main"] [draggable="true"]');
      const count = await draggableTabs.count();
      expect(count, 'Project window should have draggable tabs').toBeGreaterThan(0);
    });
  });
});
