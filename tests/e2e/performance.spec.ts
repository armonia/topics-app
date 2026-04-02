import { test, expect, Page } from '@playwright/test';

/**
 * Measure Cumulative Layout Shift during an action.
 */
async function measureCLS(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry as any).hadRecentInput) {
          (window as any).__cls += (entry as any).value;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await action();
  await page.waitForTimeout(1000);
  return page.evaluate(() => (window as any).__cls);
}

// ---------------------------------------------------------------------------
// PERF-01 — Layout Stability & Visual Quality
// ---------------------------------------------------------------------------

test.describe('PERF-01 — Layout Stability & Visual Quality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Topic switch has no visible layout shift', async ({ page }) => {
    // Click the first topic in sidebar (uses role="treeitem" like other E2E tests)
    const topics = page.getByRole('treeitem');
    await topics.first().waitFor({ timeout: 5000 });
    await topics.first().click();
    await page.waitForTimeout(500);

    // Now measure CLS while switching to a different topic
    const count = await topics.count();
    if (count > 1) {
      const cls = await measureCLS(page, async () => {
        await topics.nth(1).click();
        await page.waitForTimeout(500);
      });
      expect(cls).toBeLessThan(0.1);
    }
  });

  test('Initial page load has no white flash', async ({ page }) => {
    // Create a new page to observe from scratch
    const newPage = await page.context().newPage();

    // Inject a script that captures bg color on first animation frame
    await newPage.addInitScript(() => {
      requestAnimationFrame(() => {
        (window as any).__firstBg = getComputedStyle(document.documentElement).backgroundColor;
      });
    });

    await newPage.goto('/');
    await newPage.waitForLoadState('domcontentloaded');
    await newPage.waitForTimeout(200);

    const firstBg = await newPage.evaluate(() => (window as any).__firstBg || getComputedStyle(document.documentElement).backgroundColor);

    // The first background should NOT be white (rgb(255, 255, 255))
    expect(firstBg).not.toBe('rgb(255, 255, 255)');
    expect(firstBg).not.toBe('rgba(0, 0, 0, 0)'); // transparent also bad — means no bg set

    await newPage.close();
  });

  test('Sidebar toggle does not cause content shift', async ({ page }) => {
    // Use the same selector as layout.fixture.ts: getByTitle("Toggle sidebar")
    const toggleBtn = page.getByTitle('Toggle sidebar');

    if (await toggleBtn.count() > 0) {
      const cls = await measureCLS(page, async () => {
        await toggleBtn.click();
        await page.waitForTimeout(500);
      });
      expect(cls).toBeLessThan(0.1);
    }
  });

  test('Panel split does not cause layout shift', async ({ page }) => {
    // Open a topic first so we have a tab bar
    const topics = page.getByRole('treeitem');
    if (await topics.count() > 0) {
      await topics.first().click();
      await page.waitForTimeout(500);
    }

    // Right-click on a tab to get split context menu (same pattern as grid-split.spec.ts)
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    if (await tabBar.count() > 0) {
      const tab = tabBar.locator('[draggable="true"]').first();
      if (await tab.count() > 0) {
        const cls = await measureCLS(page, async () => {
          await tab.click({ button: 'right' });
          await page.waitForTimeout(200);
          const splitOption = page.getByText('Split Right', { exact: true });
          if (await splitOption.count() > 0) {
            await splitOption.click();
            await page.waitForTimeout(500);
          }
        });
        expect(cls).toBeLessThan(0.1);
      }
    }
  });

  test('Chat message list does not shift on new message', async ({ page }) => {
    // Select a topic first
    const topics = page.getByRole('treeitem');
    if (await topics.count() > 0) {
      await topics.first().click();
      await page.waitForTimeout(500);
    }

    // Get message area (role="main" as used in chat.spec.ts)
    const mainArea = page.locator('[role="main"]');
    await mainArea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    // Type a message using the same input selector as chat.spec.ts
    const input = page.getByRole('textbox', { name: /Message input/ });
    if (await input.count() > 0) {
      // Set up CLS measurement before sending
      await page.evaluate(() => {
        (window as any).__cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!(entry as any).hadRecentInput) {
              (window as any).__cls += (entry as any).value;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });

      await input.fill('test perf message');
      await input.press('Enter');
      await page.waitForTimeout(1000);

      const cls = await page.evaluate(() => (window as any).__cls ?? 0);
      expect(cls).toBeLessThan(0.1);
    }
  });
});

// ---------------------------------------------------------------------------
// PERF-02 — Load Performance
// ---------------------------------------------------------------------------

test.describe('PERF-02 — Load Performance', () => {
  test('App loads within 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const loadTime = Date.now() - start;

    expect(loadTime).toBeLessThan(3000);
  });

  test('Topic switch completes within 500ms', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const topics = page.getByRole('treeitem');
    const count = await topics.count();
    if (count > 1) {
      // Click first topic to be in a chat
      await topics.first().click();
      await page.waitForTimeout(300);

      const start = Date.now();
      await topics.nth(1).click();

      // Wait for main content area to update
      await page.locator('[role="main"]').waitFor({ state: 'visible', timeout: 2000 });
      const switchTime = Date.now() - start;

      expect(switchTime).toBeLessThan(500);
    }
  });

  test('No render-blocking long tasks after initial load', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Start observing long tasks
    const longTasks = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let count = 0;
        const observer = new PerformanceObserver((list) => {
          count += list.getEntries().length;
        });
        observer.observe({ type: 'longtask', buffered: false });

        // Simulate normal interaction for 2 seconds
        setTimeout(() => {
          observer.disconnect();
          resolve(count);
        }, 2000);
      });
    });

    // Should have zero or very few long tasks during idle
    expect(longTasks).toBeLessThanOrEqual(1);
  });
});
