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
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const TS = Date.now();
const BASE = E2E_BASE;

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
    await resetPaneStore(page.request, [topicA.id, topicB.id]);
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

  /**
   * The other half of the contract, and the one that was broken: panes that are
   * neither a chat nor a terminal. Their badge lives in `extraCounts` inside the
   * TabNotification provider — `getBadgeCount` reads it for the TAB (pinned by
   * tab-notifications.spec.ts TAB-BADGE-10/11), but `buildSidebarItems`
   * hard-coded 0 and the utility row rendered no badge component at all. So an
   * agents pane could light up its tab and stay silent in the sidebar: "vedo le
   * notifiche nella tabbar ma non nella sidebar".
   */
  test("PARITY-02: an agents pane badges on BOTH surfaces, not just the tab", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PARITY-02" });

    const ws = await interceptWebSocket(page);

    const AGENTS = "__agents__";
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [topicA.id, AGENTS] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [topicA.id, AGENTS], pinned: [topicA.id, AGENTS] },
    });
    await resetPaneStore(page.request, [topicA.id, AGENTS]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await page.locator(`[data-pane-id="${AGENTS}"]`).waitFor({ state: "visible", timeout: 10000 });
    // Focus the CHAT so the agents pane is inactive on both surfaces — a focused
    // pane suppresses its badge by design, on the tab and on the row alike.
    await page.locator(`[data-pane-id="${topicA.id}"]`).click();

    ws.send({ type: "agent:nudge", projectId: "p1", agentId: "a1" });

    // (1) The tab lights up — the half that already worked.
    const tabBadge = page.locator(`[data-pane-id="${AGENTS}"]`).locator("span.rounded-full.bg-primary");
    await expect(tabBadge).toBeVisible({ timeout: 5000 });

    // (2) The sidebar row lights up too — the half that was missing.
    const sidebarRow = page.locator('[data-testid="sidebar-utility-agents"]');
    await expect(sidebarRow).toBeVisible({ timeout: 5000 });
    await expect(sidebarRow.locator("span.rounded-full.bg-primary")).toBeVisible({ timeout: 5000 });
  });
});
