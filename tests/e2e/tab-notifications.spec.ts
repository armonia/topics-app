/**
 * TAB-BADGE E2E tests: Tab notification badges
 *
 * Tests the unified notification badge system on pane tabs.
 * Uses WebSocket interception to inject events and verify badge rendering.
 */
import { test, expect } from "@playwright/test";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

const TS = Date.now();
const BASE = "http://localhost:13334";

let topicA: { id: string; name: string };
let topicB: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  topicA = await createTopic(request, `Badge-A-${TS}`);
  topicB = await createTopic(request, `Badge-B-${TS}`);
});

test.afterAll(async ({ request }) => {
  await deleteTopic(request, topicA.id).catch(() => {});
  await deleteTopic(request, topicB.id).catch(() => {});
});

/** Navigate with both topics pre-opened as panels, B focused */
async function goWithTwoTabs(page: import("@playwright/test").Page) {
  await page.request.put(`${BASE}/api/ui-state/panels`, {
    data: { openPanels: [topicA.id, topicB.id] },
  });
  await page.request.put(`${BASE}/api/ui-state/panel-order`, {
    data: { order: [topicA.id, topicB.id], pinned: [topicA.id, topicB.id] },
  });
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', {
    state: "visible",
    timeout: 15000,
  });
  // Wait for both tabs to render
  await page.locator(`[data-pane-id="${topicA.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`[data-pane-id="${topicB.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  // Click B to make it active (A becomes inactive)
  await page.locator(`[data-pane-id="${topicB.id}"]`).click();
}

/** Navigate with one topic pre-opened */
async function goWithOneTab(page: import("@playwright/test").Page) {
  await page.request.put(`${BASE}/api/ui-state/panels`, {
    data: { openPanels: [topicA.id] },
  });
  await page.request.put(`${BASE}/api/ui-state/panel-order`, {
    data: { order: [topicA.id], pinned: [topicA.id] },
  });
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', {
    state: "visible",
    timeout: 15000,
  });
  await page.locator(`[data-pane-id="${topicA.id}"]`).waitFor({ state: "visible", timeout: 10000 });
}

test.describe("Tab Notification Badges", () => {
  test("TAB-BADGE-01: badge appears on inactive chat tab for unread messages", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-01" });

    const ws = await interceptWebSocket(page);
    await goWithTwoTabs(page);

    // Inject unread for topic A (the inactive one)
    ws.send({
      type: "unread:updated",
      topicId: topicA.id,
      unreadCount: 3,
    });

    // Badge should appear on topic A's tab
    const tabA = page.locator(`[data-pane-id="${topicA.id}"]`);
    const badge = tabA.locator("span").filter({ hasText: /^3$/ });
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test("TAB-BADGE-02: badge clears when tab is activated", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-02" });

    const ws = await interceptWebSocket(page);
    await goWithTwoTabs(page);

    // Inject unread for topic A
    ws.send({
      type: "unread:updated",
      topicId: topicA.id,
      unreadCount: 5,
    });

    const tabA = page.locator(`[data-pane-id="${topicA.id}"]`);
    const badge = tabA.locator("span").filter({ hasText: /^5$/ });
    await expect(badge).toBeVisible({ timeout: 5000 });

    // Click tab A to activate it
    await tabA.click();

    // Server clears unread on focus
    ws.send({
      type: "unread:updated",
      topicId: topicA.id,
      unreadCount: 0,
    });

    // Badge should disappear
    await expect(badge).not.toBeVisible({ timeout: 5000 });
  });

  test("TAB-BADGE-07: no badge on active tab", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-07" });

    const ws = await interceptWebSocket(page);
    await goWithOneTab(page);

    // Inject unread for the ACTIVE tab
    ws.send({
      type: "unread:updated",
      topicId: topicA.id,
      unreadCount: 2,
    });

    // Wait briefly for potential render
    await page.waitForTimeout(1000);

    // Badge should NOT appear — tab is active, getBadgeCount returns 0
    const tabA = page.locator(`[data-pane-id="${topicA.id}"]`);
    const badge = tabA.locator("span.rounded-full.bg-primary");
    await expect(badge).toHaveCount(0, { timeout: 2000 });
  });

  test("TAB-BADGE-09: badge styling is pill-shaped and non-intrusive", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-09" });

    const ws = await interceptWebSocket(page);
    await goWithTwoTabs(page);

    // Inject unread for topic A
    ws.send({
      type: "unread:updated",
      topicId: topicA.id,
      unreadCount: 42,
    });

    const tabA = page.locator(`[data-pane-id="${topicA.id}"]`);
    const badge = tabA.locator("span").filter({ hasText: /^42$/ });
    await expect(badge).toBeVisible({ timeout: 5000 });

    // Verify badge has a background color (not transparent)
    const bgColor = await badge.evaluate(
      (el) => getComputedStyle(el).backgroundColor
    );
    expect(bgColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(bgColor).not.toBe("transparent");

    // Tab should maintain fixed width (no layout shift)
    const tabWidth = await tabA.evaluate(
      (el) => el.getBoundingClientRect().width
    );
    expect(tabWidth).toBe(150);
  });

  test("TAB-BADGE-08: multiple panes show independent badges", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-08" });

    const ws = await interceptWebSocket(page);
    await goWithTwoTabs(page);

    // B is active, inject unread for A (inactive)
    ws.send({ type: "unread:updated", topicId: topicA.id, unreadCount: 2 });

    const tabA = page.locator(`[data-pane-id="${topicA.id}"]`);
    const badgeA = tabA.locator("span").filter({ hasText: /^2$/ });
    await expect(badgeA).toBeVisible({ timeout: 5000 });

    // Switch to A (makes B inactive), then inject unread for B
    await tabA.click();
    ws.send({ type: "unread:updated", topicId: topicA.id, unreadCount: 0 });
    ws.send({ type: "unread:updated", topicId: topicB.id, unreadCount: 7 });

    // B should show badge
    const tabB = page.locator(`[data-pane-id="${topicB.id}"]`);
    const badgeB = tabB.locator("span").filter({ hasText: /^7$/ });
    await expect(badgeB).toBeVisible({ timeout: 5000 });

    // A should have no badge (it's active)
    const badgeANow = tabA.locator("span.rounded-full.bg-primary");
    await expect(badgeANow).toHaveCount(0);
  });
});
