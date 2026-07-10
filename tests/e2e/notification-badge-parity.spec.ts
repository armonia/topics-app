/**
 * PARITY E2E: the unified notification badge must render the SAME count on the
 * tab bar tab AND the sidebar row for the same topic, and the old per-Claude
 * "phase dot" must be gone (folded into the badge). This is the cross-surface
 * contract the unification promised — existing tab-notifications.spec only
 * checks the tab bar, so this guards the sidebar half + the no-dots invariant.
 */
import { test, expect } from "@playwright/test";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";

const TS = Date.now();
const BASE = "http://localhost:13334";

let topicA: { id: string; name: string };
let topicB: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  topicA = await createTopic(request, `Parity-A-${TS}`);
  topicB = await createTopic(request, `Parity-B-${TS}`);
});

test.afterAll(async ({ request }) => {
  await deleteTopic(request, topicA.id).catch(() => {});
  await deleteTopic(request, topicB.id).catch(() => {});
});

// Titles the removed ClaudePhaseDot used — none must survive anywhere.
const LEGACY_DOT_TITLES = [
  "Awaiting your approval",
  "Claude is generating…",
  "Claude is running a tool",
  "Claude replied — waiting for you",
  "Approval timed out — still waiting on you",
  "Session error",
  "Finished a turn — click to open",
];

test.describe("Notification badge parity (tab bar ≡ sidebar)", () => {
  test("PARITY-01: unread badge shows the same count on the tab AND the sidebar row; no Claude phase dot survives", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PARITY-01" });

    const ws = await interceptWebSocket(page);

    // Open both topics; focus B so A is inactive on the tab bar AND unfocused
    // in the sidebar (both surfaces should then show A's badge).
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [topicA.id, topicB.id] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [topicA.id, topicB.id], pinned: [topicA.id, topicB.id] },
    });
    // Reset the authoritative pane channel to EXACTLY these two topics — legacy
    // openPanels is UNIONED with pane-store-v2 on hydrate, so stale panes from
    // the shared test DB otherwise leak in as extra tabs and shift the badges.
    await resetPaneStore(page.request, [topicA.id, topicB.id]).catch(() => {});
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await page.locator(`[data-pane-id="${topicA.id}"]`).waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`[data-pane-id="${topicB.id}"]`).click();

    // Seed an unread notification on the inactive topic A.
    ws.send({ type: "unread:updated", topicId: topicA.id, unreadCount: 2 });

    // (1) Tab bar tab A shows badge "2".
    const tabBadge = page
      .locator(`[data-pane-id="${topicA.id}"]`)
      .locator("span")
      .filter({ hasText: /^2$/ });
    await expect(tabBadge).toBeVisible({ timeout: 5000 });

    // (2) Sidebar row A shows the SAME badge "2" — the half that used to be missing.
    const sidebarRow = page.locator(`[role="treeitem"][aria-label="${topicA.name}"]`);
    await expect(sidebarRow).toBeVisible({ timeout: 5000 });
    const sidebarBadge = sidebarRow.locator("span").filter({ hasText: /^2$/ });
    await expect(sidebarBadge).toBeVisible({ timeout: 5000 });

    // (3) No legacy Claude phase dot anywhere on the page.
    for (const title of LEGACY_DOT_TITLES) {
      await expect(page.locator(`[title="${title}"]`)).toHaveCount(0);
    }
  });
});
