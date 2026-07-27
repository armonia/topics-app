/**
 * Tab persistence E2E tests
 *
 * Verifies that topic tabs survive page reloads and that
 * archived topics are still cleaned up correctly.
 */
import { test, expect } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";

const BASE = "http://localhost:13334";
const TS = Date.now();

let topicA: { id: string; name: string };
let topicB: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  topicA = await createTopic(request, `Persist-A-${TS}`);
  topicB = await createTopic(request, `Persist-B-${TS}`);
});

test.afterAll(async ({ request }) => {
  await deleteTopic(request, topicA.id).catch(() => {});
  await deleteTopic(request, topicB.id).catch(() => {});
});

/** Set up panels via API and navigate */
async function goWithPanels(page: import("@playwright/test").Page, panels: string[]) {
  await page.request.put(`${BASE}/api/ui-state/panels`, {
    data: { openPanels: panels },
  });
  // Since Phase 30 the client hydrates tabs from the pane-store snapshot and
  // UNIONS it with openPanels, so stale panes accumulated in the shared test DB
  // (this serial suite runs one DB the whole way through) leak in as extra/ghost
  // tabs — and a low inner lastSeq lets them outrank this seed. Reset the
  // AUTHORITATIVE pane channel to EXACTLY these panels so the reload renders a
  // deterministic tab set.
  await resetPaneStore(page.request, panels);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

test.describe("Tab Persistence", () => {
  test("topic tab survives page reload", async ({ page }) => {
    // Open topicA as a tab
    await goWithPanels(page, [topicA.id]);

    // Verify tab is visible
    const tab = page.locator(`[data-pane-id="${topicA.id}"]`);
    await expect(tab).toBeVisible({ timeout: 10000 });

    // Reload the page
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // Tab must still be present after reload
    const tabAfter = page.locator(`[data-pane-id="${topicA.id}"]`);
    await expect(tabAfter).toBeVisible({ timeout: 10000 });
  });

  test("multiple topic tabs survive reload", async ({ page }) => {
    await goWithPanels(page, [topicA.id, topicB.id]);

    // Both tabs visible
    await expect(page.locator(`[data-pane-id="${topicA.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-pane-id="${topicB.id}"]`)).toBeVisible({ timeout: 10000 });

    // Reload
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // Both must survive
    await expect(page.locator(`[data-pane-id="${topicA.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-pane-id="${topicB.id}"]`)).toBeVisible({ timeout: 10000 });
  });

  test("archived topic tab is cleaned up after reload", async ({ page, request }) => {
    // Open topicB, then archive it
    await goWithPanels(page, [topicA.id, topicB.id]);
    await expect(page.locator(`[data-pane-id="${topicB.id}"]`)).toBeVisible({ timeout: 10000 });

    // Archive topicB via DELETE (server archives on DELETE)
    await request.delete(`${BASE}/api/topics/${topicB.id}`, {
      data: { archived: true },
      ignoreHTTPSErrors: true,
    });

    // Reload — validation should remove the archived topic's tab
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // topicA should survive, topicB should be gone
    await expect(page.locator(`[data-pane-id="${topicA.id}"]`)).toBeVisible({ timeout: 10000 });
    // Wait for validation to clean up
    await expect(page.locator(`[data-pane-id="${topicB.id}"]`)).not.toBeVisible({ timeout: 10000 });

    // Unarchive for cleanup
    await request.delete(`${BASE}/api/topics/${topicB.id}`, {
      data: { archived: false },
      ignoreHTTPSErrors: true,
    });
  });
});
