/**
 * TAB-BADGE E2E tests: Tab notification badges
 *
 * Tests the unified notification badge system on pane tabs.
 * Uses WebSocket interception to inject events and verify badge rendering.
 */
import { test, expect } from "@playwright/test";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { createTopic, deleteTopic, resetPaneStore, seedPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

const TS = Date.now();
const BASE = E2E_BASE;

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

// I test qui ragionano su QUALI tab sono aperti e quale è attivo (A inattivo →
// badge, B focalizzato → niente badge). I due helper qui sotto seminano la
// chiave legacy `openPanels`, che però il client NON legge più: i tab di A e B
// arrivano dal pane-store (li apre createTopic), e quello è UNO solo per tutta
// la suite seriale — le pane lasciate dai file precedenti restano lì. Reset ad
// A e B soltanto: né più (una `__agents__` superstite renderebbe ambiguo il
// locator di TAB-BADGE-10/11) né meno (i tab servono).
test.beforeEach(async ({ request }) => {
  await resetPaneStore(request, [topicA.id, topicB.id]);
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

  // @nightly: pre-existing CI-Linux flake — timing-sensitive negative assertion
  // (waitForTimeout then expect count 0). Off the PR gate until made
  // deterministic. TODO(e2e-isolation).
  test("TAB-BADGE-07: no badge on active tab @nightly", async ({ page }) => {
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

  /** Seed an extra non-chat pane (e.g. agents/board) into BOTH the legacy
   *  openPanels endpoint AND the pane-store-v2 snapshot, so the renderer
   *  picks it up regardless of which path App.tsx hydrates from. Idempotent. */
  async function seedExtraPane(
    request: import("@playwright/test").APIRequestContext,
    paneId: string,
    type: string,
    chatIds: readonly string[],
  ): Promise<void> {
    // Legacy openPanels — overwrite with the full set in stable order.
    await request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [...chatIds, paneId] },
      ignoreHTTPSErrors: true,
    });
    await request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [...chatIds, paneId], pinned: [...chatIds, paneId] },
      ignoreHTTPSErrors: true,
    });

    // pane-store-v2 — read-modify-write so we don't clobber per-pane metadata
    // seeded by earlier helpers (chat panes already wired up). seedPaneStore
    // re-runs this builder per attempt, so each retry amends a FRESH read and
    // supplies the lastSeq the client's LWW gate needs.
    type Snapshot = {
      panes: Record<string, unknown>;
      groups: Record<string, { id: string; paneIds: string[]; splitRatio: number; splitAxis: string }>;
      projects: Record<string, unknown>;
      groupOrder: string[];
      closedStack: unknown[];
    };
    await seedPaneStore(request, async () => {
      let snapshot: Snapshot = {
        panes: {},
        groups: { "group:default": { id: "group:default", paneIds: [], splitRatio: 1, splitAxis: "horizontal" } },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
      };
      const cur = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
      if (cur.ok()) {
        const body = (await cur.json()) as { value?: Snapshot };
        if (body?.value && typeof body.value === "object" && "groups" in body.value) snapshot = body.value;
      }
      snapshot.panes[paneId] = { id: paneId, type, title: type };
      const g = snapshot.groups["group:default"];
      if (g && !g.paneIds.includes(paneId)) g.paneIds.push(paneId);
      return snapshot;
    });
  }

  /** Variant of goWithTwoTabs that also pre-seeds an extra non-chat pane and
   *  navigates with everything in place. Topic B ends up focused (matching
   *  the existing harness convention), the extra pane is inactive — perfect
   *  for asserting badge visibility on it. */
  async function goWithTwoTabsPlusExtra(
    page: import("@playwright/test").Page,
    extraPaneId: string,
    extraPaneType: string,
  ) {
    await seedExtraPane(page.request, extraPaneId, extraPaneType, [topicA.id, topicB.id]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.locator(`[data-pane-id="${topicA.id}"]`).waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`[data-pane-id="${topicB.id}"]`).waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`[data-pane-id="${extraPaneId}"]`).waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`[data-pane-id="${topicB.id}"]`).click();
  }

  test("TAB-BADGE-10: agents pane badges on agent:nudge", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-10" });
    const ws = await interceptWebSocket(page);
    await goWithTwoTabsPlusExtra(page, "__agents__", "agents");

    // B is focused; agents pane is inactive → should badge.
    // useTabNotifications handles agent:nudge; approval:created only drives a browser push.
    ws.send({ type: "agent:nudge", projectId: "p1", agentId: "a1" });

    const agentsTab = page.locator(`[data-pane-id="__agents__"]`);
    const badge = agentsTab.locator("span.rounded-full.bg-primary");
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test("TAB-BADGE-11: agents pane badges on agent:escalation (worker needs help)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-11" });
    const ws = await interceptWebSocket(page);
    await goWithTwoTabsPlusExtra(page, "__agents__", "agents");

    ws.send({
      type: "agent:escalation",
      agentId: "ag1",
      agentName: "Builder",
      message: "Stuck on migration",
      taskId: null,
      projectId: "p1",
      timestamp: Date.now(),
    });

    const agentsTab = page.locator(`[data-pane-id="__agents__"]`);
    const badge = agentsTab.locator("span.rounded-full.bg-primary");
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test("TAB-BADGE-12: agent:escalation does NOT badge unrelated chat tabs", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-12" });
    const ws = await interceptWebSocket(page);
    await goWithTwoTabs(page); // chats only, no agents pane

    ws.send({
      type: "agent:escalation",
      agentId: "ag1",
      agentName: "Builder",
      message: "Stuck",
      taskId: null,
      projectId: "p1",
      timestamp: Date.now(),
    });

    // Inactive chat A should NOT badge from an escalation event
    await page.waitForTimeout(500);
    const tabA = page.locator(`[data-pane-id="${topicA.id}"]`);
    const badge = tabA.locator("span.rounded-full.bg-primary");
    await expect(badge).toHaveCount(0);
  });
});
