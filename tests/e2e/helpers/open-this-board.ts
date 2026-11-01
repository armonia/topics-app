import type { Locator, Page } from "@playwright/test";

/**
 * The per-board rows of the settings panel (model, language, worktree, workflow,
 * deploy...) sit under a «This board» divider that is closed by default. Opens it
 * when it is closed, so a spec can reach those rows whatever state it finds.
 */
export async function openThisBoard(scope: Page | Locator): Promise<void> {
  const fold = scope.getByTestId("settings-this-board");
  if (!(await fold.evaluate((el) => (el as HTMLDetailsElement).open))) await fold.locator("summary").first().click();
}
