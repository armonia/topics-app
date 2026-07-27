/**
 * Visual-evidence specs — these capture screenshots for the global-teardown AI
 * visual review, but they ALSO assert real behavior so they can't pass silently
 * when the feature is broken (they used to take screenshots and assert nothing —
 * the "green-but-empty" anti-pattern the audit flagged). Each screenshot is now
 * backed by a behavioral expect().
 */
import { test, expect } from '@playwright/test';
import { createTopic, deleteTopic, resetPaneStore } from './helpers/api-fixtures';
import { E2E_BASE } from "./helpers/test-server";

const BASE = E2E_BASE;

/**
 * Right edge (x + width) of the app-level sidebar, or 0 when it can't be measured.
 * On desktop the sidebar keeps a CONSTANT width and collapses by sliding off-screen
 * via translateX(-100%) (App.tsx:750-758), so the visible signal is its right edge:
 * open → ≈ width (>100); collapsed → ≈ 0 (x goes negative, right edge lands at ~0).
 */
async function sidebarRightEdge(page: import('@playwright/test').Page): Promise<number> {
  const box = await page.locator('[aria-label="Topics sidebar"]').boundingBox();
  return box ? box.x + box.width : 0;
}

test('Sidebar toggle — collapses off-screen and restores', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 15000 });

  // BEFORE: sidebar open, right edge past its real width.
  const openEdge = await sidebarRightEdge(page);
  expect(openEdge, 'sidebar should start open with a real on-screen width').toBeGreaterThan(100);
  await page.screenshot({ path: 'test-results/sidebar-BEFORE-open.png', fullPage: false });

  // The sidebar is toggled with ⌘B (useKeyboardShortcuts → toggleSidebar); there
  // is no persistent toggle button (the "Expand sidebar" button only appears
  // while collapsed). The window-level keydown handler fires regardless of focus.
  // Desktop collapse is a composited translateX(-100%), NOT a width change, so we
  // assert the sidebar slid off-screen (right edge ≈ 0), not width→0.
  await page.keyboard.press('Meta+b');
  await expect
    .poll(() => sidebarRightEdge(page), { timeout: 5000 })
    .toBeLessThan(2);
  await page.screenshot({ path: 'test-results/sidebar-AFTER-closed.png', fullPage: false });

  // Toggle back open → slides back on-screen.
  await page.keyboard.press('Meta+b');
  await expect
    .poll(() => sidebarRightEdge(page), { timeout: 5000 })
    .toBeGreaterThan(100);
  await page.screenshot({ path: 'test-results/sidebar-AFTER-reopened.png', fullPage: false });
});

test('Topic switch — activating a second tab changes the active tab', async ({ page, request }) => {
  const t1 = await createTopic(request, `Shot-Switch-A-${Date.now()}`);
  const t2 = await createTopic(request, `Shot-Switch-B-${Date.now()}`);
  try {
    await request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [t1.id, t2.id] },
      ignoreHTTPSErrors: true,
    });
    // Clear the shared pane-store so tabs from prior specs don't UNION in as a
    // 3rd tab (see resetPaneStore) — this test asserts EXACTLY 2 tabs.
    await resetPaneStore(request, [t1.id, t2.id]);
    await page.goto('/');
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: 'visible', timeout: 15000 });

    const tabs = page.locator('[role="main"] [data-testid="panel-tab-bar"] [draggable="true"]');
    await expect(tabs).toHaveCount(2, { timeout: 10000 });

    // Activate the first tab, screenshot, then switch to the second and assert
    // the active tab actually moved.
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute('data-active', /true/, { timeout: 3000 });
    await page.screenshot({ path: 'test-results/topic-BEFORE-switch.png', fullPage: false });

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('data-active', /true/, { timeout: 3000 });
    await expect(tabs.nth(0)).toHaveAttribute('data-active', /false/, { timeout: 3000 });
    await page.screenshot({ path: 'test-results/topic-AFTER-switch.png', fullPage: false });
  } finally {
    await deleteTopic(request, t1.id).catch(() => {});
    await deleteTopic(request, t2.id).catch(() => {});
  }
});

test('Page load — app shell renders the sidebar and main area', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/load-500ms.png', fullPage: false });

  // The shell must actually mount: sidebar visible + a main region present.
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: 'test-results/load-2000ms.png', fullPage: false });
});
