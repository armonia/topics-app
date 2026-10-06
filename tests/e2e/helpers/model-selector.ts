import type { Locator } from "@playwright/test";

/**
 * Opens every closed accordion section of an open model selector.
 *
 * Tests that are NOT about the accordion but need its rows (effort text,
 * labels, stale chunks) call this after opening the panel: it restores the
 * everything-rendered precondition without asserting anything itself.
 */
export async function openAllModelSections(root: Locator): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const closed = root.locator('[data-testid="model-section-toggle"][aria-expanded="false"]');
    if ((await closed.count()) === 0) return;
    await closed.first().click();
  }
  throw new Error("model selector sections did not all open");
}
