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

/** Count row-resize (vertical split) dividers in the main content area. */
export async function countRowDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] .cursor-row-resize').count();
}

/** Count the tab bars in the layout — one per cell, so one more after every split. */
export async function countTabBars(page: Page): Promise<number> {
  return page.locator('[data-testid="panel-tab-bar"]').count();
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
 * The wait afterwards is CONDITIONAL, not a sleep: a split always carves one
 * cell into two, and every cell owns a tab bar, so the tab-bar count is the
 * one signal that holds for both directions and for nested splits alike
 * (the divider count does NOT — splitting inside an existing stack adds to it).
 * The old fixed `waitMs` settle was the flake in split-screen-sync's
 * "Multi-row multi-column" test: on a slow run the divider count was read
 * before the second split had landed, and 1 < 2 came out red.
 *
 * `timeoutMs` bounds that wait; callers that used a longer settle can raise it.
 */
export async function splitViaContextMenu(
  page: Page,
  direction: "Dividi a destra" | "Dividi in basso",
  tabIndex = 0,
  timeoutMs = 5000,
) {
  const before = await countTabBars(page);

  const tab = page.locator('[role="main"] [draggable="true"]').nth(tabIndex);
  await expect(tab).toBeVisible({ timeout: 5000 });
  await tab.click({ button: "right" });

  const splitBtn = page.getByText(direction, { exact: true });
  await expect(splitBtn).toBeVisible({ timeout: 3000 });
  await splitBtn.click();

  await expect
    .poll(() => countTabBars(page), {
      timeout: timeoutMs,
      message: `"${direction}" non ha prodotto una nuova cella (tab bar ferme a ${before})`,
    })
    .toBeGreaterThan(before);
}
