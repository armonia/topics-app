import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

test.describe("Chat scroll behavior", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `scroll-test-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;

    // Seed with enough messages to make the chat scrollable
    for (let i = 0; i < 20; i++) {
      await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
        data: { content: `Seed message ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Lo scroller virtualizzato viene preso con `.first()`: con le pane dei file
  // precedenti ancora aperte (pane-store unico per la suite seriale) il primo
  // scroller può essere quello di UN'ALTRA chat. Reset al topic seminato qui.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("auto-scrolls to bottom when new message arrives and user is at bottom", async ({ page, request }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await scroller.waitFor({ state: "visible", timeout: 15000 });

    // 150px tolerance matches the app's own at-bottom threshold
    // (AT_BOTTOM_TOLERANCE_PX in client/src/components/Chat/scrollAuthority.ts);
    // the redesign lands ~1 short message short of a tight 60px window.
    const atBottom = () =>
      scroller.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 150);

    // POLL, don't sleep-then-sample. This assertion used to run once after a
    // fixed waitForTimeout(2000) and failed 3 runs out of 4 on a warm machine:
    // Virtuoso's initial bottom-anchor lands whenever the list finishes
    // measuring, which is not on anybody's clock. Same reason the second
    // assertion polls instead of sleeping — auto-scroll is a race with the
    // WS frame, and the fixed wait was betting on it.
    await expect.poll(atBottom, { timeout: 15000 }).toBe(true);

    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `New message at ${Date.now()}` },
      ignoreHTTPSErrors: true,
    });

    // The list must END UP at the bottom; it may leave it for a frame while the
    // new row is measured. Polling asserts the settled state, which is the
    // behaviour under test.
    await expect.poll(atBottom, { timeout: 15000 }).toBe(true);
  });

  test("does NOT auto-scroll when user has scrolled up", async ({ page, request }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    await page.waitForTimeout(2000);

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    if (await scroller.count() === 0) {
      test.skip(true, "Virtuoso scroller not found");
      return;
    }

    // Scroll up by pressing Home key
    await scroller.click();
    await page.keyboard.press("Home");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Home");
    await page.waitForTimeout(1500);

    // Record scroll position
    const scrollBefore = await scroller.evaluate((el) => el.scrollTop);

    // Add a new message
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `Message while scrolled up ${Date.now()}` },
      ignoreHTTPSErrors: true,
    });

    await page.waitForTimeout(2000);

    // Scroll position should not have changed significantly (stayed up)
    const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(100);
  });

  test("scroll-to-bottom button appears when scrolled up and works on click", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    await page.waitForTimeout(2000);

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    if (await scroller.count() === 0) {
      test.skip(true, "Virtuoso scroller not found");
      return;
    }

    const scrollBtn = page.getByRole("button", { name: "Scroll to bottom" });

    // Scroll up by pressing Home key while focused on the scroller
    // This triggers native scroll that Virtuoso's IntersectionObserver detects
    await scroller.click();
    await page.keyboard.press("Home");
    await page.waitForTimeout(1000);
    // Repeat to ensure we're really at top (Virtuoso virtualizes content)
    await page.keyboard.press("Home");
    await page.waitForTimeout(1500);

    // Scroll-to-bottom button should appear
    await expect(scrollBtn).toBeVisible({ timeout: 8000 });

    // Click it
    await scrollBtn.click();

    // Wait for smooth scroll animation to settle
    await page.waitForTimeout(1500);

    // Should be at the true bottom (within 60px tolerance for Virtuoso padding)
    const atBottom = await scroller.evaluate((el) => {
      return Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 60;
    });
    expect(atBottom).toBe(true);

    // Button should disappear
    await expect(scrollBtn).not.toBeVisible({ timeout: 5000 });
  });

  test("scroll-to-bottom button reaches true bottom and stays there", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    await page.waitForTimeout(2000);

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    if (await scroller.count() === 0) {
      test.skip(true, "Virtuoso scroller not found");
      return;
    }

    const scrollBtn = page.getByRole("button", { name: "Scroll to bottom" });

    // Scroll up by pressing Home key
    await scroller.click();
    await page.keyboard.press("Home");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Home");
    await page.waitForTimeout(1500);

    await expect(scrollBtn).toBeVisible({ timeout: 8000 });

    // Click scroll-to-bottom
    await scrollBtn.click();

    // Wait for animation (400ms smooth + 600ms guard settle)
    await page.waitForTimeout(1500);

    // Take multiple measurements over 2 seconds to confirm no bounce-back
    const measurements: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(500);
      const isBottom = await scroller.evaluate((el) => {
        return Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 60;
      });
      measurements.push(isBottom);
    }

    // ALL measurements should report at-bottom (no drift/bounce)
    expect(measurements.every(m => m)).toBe(true);

    // Scroll-to-bottom button should remain hidden (no re-appearance from bounce)
    await expect(scrollBtn).not.toBeVisible({ timeout: 2000 });
  });
});
