import type { Page } from "@playwright/test";

/**
 * With the dashboard on, the by-number / by-resources controls sit under the
 * Advanced fold, and inside it the second selector (automatic / fixed / no
 * limit) sits in a closed fold of its own; without the dashboard the radios are
 * already there. Opens whatever exists, so a spec can read the radios either way.
 */
export async function openAdvanced(page: Page): Promise<void> {
  const advanced = page.getByTestId("settings-advanced");
  if ((await advanced.count()) > 0 && !(await advanced.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await advanced.locator("summary").first().click();
  }
}

export async function openCapMode(page: Page): Promise<void> {
  await openAdvanced(page);
  const fold = page.getByTestId("global-cap-mode-fold");
  if ((await fold.count()) > 0) await fold.locator("summary").click();
}
