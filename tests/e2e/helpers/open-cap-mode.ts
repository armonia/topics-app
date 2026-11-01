import type { Page } from "@playwright/test";

/**
 * With the dashboard on, the second selector (automatic / fixed / no limit) sits
 * in a closed fold; without it the radios are already there. Opens the fold when
 * it exists, so a spec can read the radios either way.
 */
export async function openCapMode(page: Page): Promise<void> {
  const fold = page.getByTestId("global-cap-mode-fold");
  if ((await fold.count()) > 0) await fold.locator("summary").click();
}
