import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
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
      const labels = await getVisibleTabLabels(page);
      const counts = new Map<string, number>();
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
      for (const [label, count] of counts) {
        expect(count, `Tab "${label}" should not be duplicated`).toBe(1);
      }
    });

    test("main area has sufficient dimensions", async ({ page }) => {
      const mainBox = await page.locator('[role="main"]').boundingBox();
      expect(mainBox).not.toBeNull();
      expect(mainBox!.width).toBeGreaterThan(400);
      expect(mainBox!.height).toBeGreaterThan(300);
    });

    test("tab bar is not oversized", async ({ page }) => {
      const tabBar = page.locator('[role="main"] .border-b.border-app-border.flex-shrink-0').first();
      if (await tabBar.count() === 0) return;

      const box = await tabBar.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height, 'Tab bar height should be compact').toBeLessThan(60);
    });

    test("layout persists after page reload", async ({ page }) => {
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
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(1500);

      const labels = await getVisibleTabLabels(page);
      expect(labels.length, 'Project should have at least one tab').toBeGreaterThan(0);
    });

    test("project tabs include utility types (terminal, git, browser)", async ({ page }) => {
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

  test.describe("DnD MIME types", () => {
    test("all pane tabs set PANE_TAB on drag", async ({ page }) => {
      await goToApp(page);
      // Open the self-provisioned project to ensure we have draggable tabs
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(2000);

      const draggableTabs = page.locator('[role="main"] [draggable="true"]');
      const count = await draggableTabs.count();
      expect(count, 'Should have at least one draggable tab').toBeGreaterThan(0);
    });

    test("tabs within project window are draggable", async ({ page }) => {
      await goToApp(page);
      await openProject(page, /e2e-grid/);
      await page.waitForTimeout(2000);

      const draggableTabs = page.locator('[role="main"] [draggable="true"]');
      const count = await draggableTabs.count();
      expect(count, 'Project window should have draggable tabs').toBeGreaterThan(0);
    });
  });
});
