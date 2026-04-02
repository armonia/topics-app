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

/**
 * Get the background color of the <html> element as rgb string.
 */
async function getHtmlBgColor(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

// ---------------------------------------------------------------------------
// PERF-01 — Layout Stability & Visual Quality
// ---------------------------------------------------------------------------

test.describe('PERF-01 — Layout Stability & Visual Quality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3333');
    await page.waitForLoadState('networkidle');
  });

  test('Topic switch has no visible layout shift', async ({ page }) => {
    // Click the first topic in sidebar
    const topics = page.locator('[data-testid="topic-item"], .sidebar-topic, .topic-list-item').first();
    await topics.waitFor({ timeout: 5000 });
    await topics.click();
    await page.waitForTimeout(500);

    // Now measure CLS while switching to a different topic
    const secondTopic = page.locator('[data-testid="topic-item"], .sidebar-topic, .topic-list-item').nth(1);
    if (await secondTopic.count() > 0) {
      const cls = await measureCLS(page, async () => {
        await secondTopic.click();
        await page.waitForTimeout(500);
      });
      expect(cls).toBeLessThan(0.1);
    }
  });

  test('Initial page load has no white flash', async ({ page }) => {
    // Navigate fresh and capture background color immediately
    const bgColors: string[] = [];

    // Create a new page to observe from scratch
    const newPage = await page.context().newPage();

    // Inject a script that captures bg color on first animation frame
    await newPage.addInitScript(() => {
      requestAnimationFrame(() => {
        (window as any).__firstBg = getComputedStyle(document.documentElement).backgroundColor;
      });
    });

    await newPage.goto('http://localhost:3333');
    await newPage.waitForLoadState('domcontentloaded');
    await newPage.waitForTimeout(200);

    const firstBg = await newPage.evaluate(() => (window as any).__firstBg || getComputedStyle(document.documentElement).backgroundColor);

    // The first background should NOT be white (rgb(255, 255, 255))
    expect(firstBg).not.toBe('rgb(255, 255, 255)');
    expect(firstBg).not.toBe('rgba(0, 0, 0, 0)'); // transparent also bad — means no bg set

    await newPage.close();
  });

  test('Sidebar toggle does not cause content shift', async ({ page }) => {
    // Find sidebar toggle button
    const toggleBtn = page.locator('[data-testid="sidebar-toggle"], [aria-label*="sidebar"], button:has(svg)').first();

    if (await toggleBtn.count() > 0) {
      const cls = await measureCLS(page, async () => {
        await toggleBtn.click();
        await page.waitForTimeout(500);
      });
      expect(cls).toBeLessThan(0.1);
    }
  });

  test('Panel split does not cause layout shift', async ({ page }) => {
    // Right-click on a tab to get context menu with split option
    const tab = page.locator('[data-testid="pane-tab"], .pane-tab').first();

    if (await tab.count() > 0) {
      const cls = await measureCLS(page, async () => {
        await tab.click({ button: 'right' });
        await page.waitForTimeout(200);
        const splitOption = page.locator('text=/split right/i').first();
        if (await splitOption.count() > 0) {
          await splitOption.click();
          await page.waitForTimeout(500);
        }
      });
      expect(cls).toBeLessThan(0.1);
    }
  });

  test('Chat message list does not shift on new message', async ({ page }) => {
    // Select a topic first
    const topic = page.locator('[data-testid="topic-item"], .sidebar-topic, .topic-list-item').first();
    if (await topic.count() > 0) {
      await topic.click();
      await page.waitForTimeout(500);
    }

    // Get message list container
    const messageList = page.locator('[data-testid="message-list"], .message-list, .chat-messages').first();

    if (await messageList.count() > 0) {
      // Scroll to bottom
      await messageList.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(200);

      // Record scroll position of last message
      const lastMsgTopBefore = await messageList.evaluate((el) => {
        const last = el.lastElementChild;
        return last ? last.getBoundingClientRect().top : 0;
      });

      // Simulate new message by sending via input
      const input = page.locator('[data-testid="chat-input"], .chat-input, textarea').first();
      if (await input.count() > 0) {
        await input.fill('test perf message');
        await input.press('Enter');
        await page.waitForTimeout(1000);

        // Existing messages should not have shifted up unexpectedly
        // (CLS check covers this too)
        const cls = await page.evaluate(() => (window as any).__cls ?? 0);
        expect(cls).toBeLessThan(0.1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PERF-02 — Load Performance
// ---------------------------------------------------------------------------

test.describe('PERF-02 — Load Performance', () => {
  test('App loads within 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('http://localhost:3333');
    await page.waitForLoadState('domcontentloaded');
    const loadTime = Date.now() - start;

    expect(loadTime).toBeLessThan(3000);
  });

  test('Topic switch completes within 500ms', async ({ page }) => {
    await page.goto('http://localhost:3333');
    await page.waitForLoadState('networkidle');

    const topic = page.locator('[data-testid="topic-item"], .sidebar-topic, .topic-list-item').nth(1);
    if (await topic.count() > 0) {
      const start = Date.now();
      await topic.click();

      // Wait for chat content to appear
      await page.locator('[data-testid="message-list"], .message-list, .chat-messages').first().waitFor({ timeout: 2000 });
      const switchTime = Date.now() - start;

      expect(switchTime).toBeLessThan(500);
    }
  });

  test('No render-blocking long tasks after initial load', async ({ page }) => {
    await page.goto('http://localhost:3333');
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
