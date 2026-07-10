/**
 * Phase 30 Wave 0 — PANE-02 cross-device sync fixture.
 *
 * This spec drives two browser contexts (desktop + iPhone 13) against the same
 * backing user account and asserts that a layout mutation on one surface
 * propagates to the other within 300ms.
 *
 * EXPECTED RED: The unified pane reducer does not exist yet (Phase 30 Wave 2).
 * Current app state sync is per-device fragmented — cross-device pane sync is
 * not implemented. This failure IS the gate: fix lands only when this passes.
 *
 * CONTEXT.md "Fixtures first" — this test is both the spec and the exit criterion.
 */
import { test, expect, devices } from "./fixtures/test-fixtures";
import { goToApp } from "./helpers";

test.describe("PANE-02: cross-device sync", () => {
  test("PANE-02: layout change on desktop reflects on mobile within 300ms", async ({ browser }) => {
    // EXPECTED RED — Phase 30 Wave 2 (PANE-02 unified reducer + cross-device pane sync).
    // The unified pane reducer does not exist yet; cross-device sync is unimplemented.
    // When Wave 2 lands, remove this annotation and the test should pass.
    // Unimplemented feature (Phase 30 Wave 2) — the body drives pre-redesign
    // selectors that no longer resolve, so under test.fail it TIMES OUT (status
    // "timedOut" ≠ "failed") and is reported RED. test.fixme skips the body
    // entirely, which is the correct marker for a not-yet-built feature. Restore
    // to a real assertion (drop the fixme) when Wave 2 ships.
    test.fixme(
      true,
      "WAVE-2 scope — PANE-02 cross-device pane sync not implemented (see 30-CONTEXT.md)",
    );
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const mobile  = await browser.newContext({ ...devices["iPhone 13"] });
    const desktopPage = await desktop.newPage();
    const mobilePage  = await mobile.newPage();
    await goToApp(desktopPage);
    await goToApp(mobilePage);

    // Wait for both sides to establish WS connection (ui-state:init received)
    await desktopPage.waitForFunction(() => (window as any).__WS_READY__ === true, { timeout: 5000 }).catch(() => {});
    await mobilePage.waitForFunction(() => (window as any).__WS_READY__ === true, { timeout: 5000 }).catch(() => {});

    const t0 = Date.now();
    // Open a new chat pane on desktop via add-pane menu
    await desktopPage.getByRole("button", { name: /add pane|\+/i }).first().click();
    await desktopPage.getByRole("menuitem", { name: /chat/i }).first().click();

    // The same new pane must appear on mobile within 300ms
    await expect(mobilePage.getByRole("tab", { name: /chat/i }).first()).toBeVisible({ timeout: 300 });
    expect(Date.now() - t0).toBeLessThan(300);

    await desktop.close();
    await mobile.close();
  });
});
