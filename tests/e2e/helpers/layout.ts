/**
 * Layout / tab-bar test helpers shared across grid-split, layout-edge-cases,
 * regression-fixes, and split-screen-sync specs.
 *
 * Extracted from four near-identical copies (see git history) — keep this
 * the single source for these three so future specs don't re-fork them.
 */
import { type Page, expect } from "@playwright/test";

/** Count column-resize (horizontal split) dividers in the main content area. */
export async function countColDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-col-resize').count();
}

/** Get the text of every visible tab label across all tab bars in the main area. */
export async function getVisibleTabLabels(page: Page): Promise<string[]> {
  const tabs = page.locator('[role="main"] .truncate.flex-1');
  const count = await tabs.count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await tabs.nth(i).textContent();
    if (text) labels.push(text.trim());
  }
  return labels;
}

/**
 * Right-click the tab at `tabIndex` (default: first) and pick "Dividi a destra"/
 * "Dividi in basso" from its context menu.
 *
 * `waitMs` is a post-split settle delay before the caller's next assertion —
 * copies of this helper used 1000ms or 1500ms depending on the spec; kept as
 * a param (rather than folded to one constant) so extracting it doesn't
 * silently change existing timing. New callers can default to 1000ms.
 */
export async function splitViaContextMenu(
  page: Page,
  direction: "Dividi a destra" | "Dividi in basso",
  tabIndex = 0,
  waitMs = 1000,
) {
  const tab = page.locator('[role="main"] [draggable="true"]').nth(tabIndex);
  await expect(tab).toBeVisible({ timeout: 5000 });
  await tab.click({ button: "right" });

  const splitBtn = page.getByText(direction, { exact: true });
  await expect(splitBtn).toBeVisible({ timeout: 3000 });
  await splitBtn.click();

  await page.waitForTimeout(waitMs);
}
