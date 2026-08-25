import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * BRW-EMPTY-01 — "Add pane → Browser" must work from a client with ZERO tabs.
 *
 * Repro of the audit finding (2026-07-10, noted during BRW-REL-04 F2.6): on a
 * fresh client showing the Welcome screen, the header "+" palette's Browser
 * entry was a silent no-op — the pending pane request had no standalone group
 * to land in and the Welcome screen stayed.
 *
 * @covers BROWSER-CHAT-04
 */
test.describe.serial("Add pane → Browser on an empty client", () => {
  test("opens a browser pane from the welcome screen", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await goToApp(page);
    await page.keyboard.press("Escape");

    // Zero tabs → the Welcome empty state is showing.
    await expect(page.getByText("Welcome to Topics")).toBeVisible({ timeout: 10_000 });

    // Header "+" palette → Browser.
    await page.getByTestId("pane-add-menu-trigger").click();
    await page.getByTestId("pane-add-menu-browser").click();

    // A browser pane must actually mount: welcome gone, browser chrome visible.
    await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Welcome to Topics")).toHaveCount(0);
  });
});
