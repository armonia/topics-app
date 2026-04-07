/**
 * Shared E2E test helpers.
 * CONVENTION: No waitForTimeout() or networkidle usage.
 * Use condition-based waits: waitForSelector, toBeVisible(), waitFor().
 * See tests/e2e/helpers/ for domain-specific utilities.
 */
import { type Page } from "@playwright/test";

/** Navigate to Topics app and wait for sidebar to load */
export async function goToApp(page: Page) {
  // Reset open panels and panel order via API before loading to prevent stale tab accumulation
  await Promise.all([
    page.request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [] },
    }).catch(() => {}),
    page.request.put("http://localhost:13334/api/ui-state/panel-order", {
      data: { order: [], pinned: [] },
    }).catch(() => {}),
  ]);
  // Wait for the panels fetch to complete during page load to prevent race conditions
  // where clicking a topic is overwritten by the server's empty panels response
  const panelsFetchPromise = page.waitForResponse(
    (r) => r.url().includes("/api/ui-state/panels") && r.status() === 200,
    { timeout: 10000 }
  ).catch(() => {});
  await page.goto("/");
  await panelsFetchPromise;
  // Wait for sidebar navigation to appear
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

/** Open a specific chat topic by name */
export async function openTopic(page: Page, name: string | RegExp) {
  const item = page.getByRole("treeitem", { name });

  // In the unified timeline sidebar, topics are directly visible (no section to expand)
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  // Wait for main content area to reflect the opened topic
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Single-click a topic in the sidebar (opens as preview/transient tab) */
export async function openTopicByClick(page: Page, name: string | RegExp) {
  const item = page.getByRole("treeitem", { name });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Double-click a topic in the sidebar (opens and pins the tab) */
export async function openTopicByDoubleClick(page: Page, name: string | RegExp) {
  const item = page.getByRole("treeitem", { name });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.dblclick();
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Open the default test chat (Web Search Test) and wait for textarea */
export async function openTestChat(page: Page) {
  await openTopic(page, /Web Search Test/);
  const textarea = page.getByRole("textbox", { name: /Message input/ });
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  return textarea;
}
