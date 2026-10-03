import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Hermetic: this file starts from the globalSetup baseline, not from the state
// the previous specs left. See fixtures/hermetic.ts.
hermetic(test);

/**
 * ⌘P with no project anywhere says so.
 *
 * `toggleFileSearch` returned false when no topic had a project, so the key
 * opened nothing and said nothing, against the intent written four lines
 * above it (better to search somewhere than to open nothing and look broken).
 * The surface now opens and names the way to a project.
 *
 * @covers FILE-01
 */
test("⌘P with no project opens the search and says there is nothing to search in", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "FILE-01" });
  // The precondition is asserted, not assumed: the hermetic baseline seeds
  // chats without a project. If that changes, this says why it went red.
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { projectPath?: string | null }> };
  expect(Object.values(body.topics).filter((t) => t.projectPath), "the baseline has a topic with a project").toEqual([]);

  await goToApp(page);
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByTestId("file-search-no-project")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("file-search-no-project")).toContainText("Nessun progetto in cui cercare");
});
