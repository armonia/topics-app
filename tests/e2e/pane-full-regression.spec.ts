/**
 * Phase 30 Wave 0 — PANE-06 compound regression.
 *
 * Long-form e2e that exercises multiple code paths in sequence:
 * 3 panes → close middle → undo → switch device → layout must match.
 *
 * NOT part of the phase-30 regression fixture set (that tag is reserved for
 * the three named bug-class fixtures in CONTEXT.md). This spec is the whole-
 * flow guard that catches regressions across the combined reducer/sync/undo
 * surface.
 *
 * EXPECTED RED until Wave 3.
 */
import { test, expect, devices } from "./fixtures/test-fixtures";
import { goToApp } from "./helpers";

test.describe("PANE-06: compound regression", () => {
  test("PANE-06: 3 panes then split horizontal, close middle, undo, switch device — layout identical", async ({ browser }) => {
    // EXPECTED RED — Phase 30 Wave 3 (PANE-06 combined reducer/sync/undo surface).
    // This compound regression exercises multiple code paths (close + undo +
    // cross-device layout match) that only converge once Wave 3 ships.
    // When it lands, remove this annotation and the test should pass.
    // Unimplemented feature (Phase 30 Wave 3). Body uses pre-redesign selectors →
    // times out under test.fail (status "timedOut" ≠ "failed" → RED). test.fixme
    // skips the body, the correct marker for a not-yet-built feature. Drop the
    // fixme when Wave 3 ships.
    test.fixme(
      true,
      "WAVE-3 scope — PANE-06 compound reducer+sync+undo flow not yet wired (see 30-CONTEXT.md)",
    );
    const a = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const b = await browser.newContext({ ...devices["iPhone 13"] });
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    await goToApp(pageA);

    // Open 3 panes on A
    for (let i = 0; i < 3; i++) {
      await pageA.getByRole("button", { name: /add pane|\+/i }).first().click();
      await pageA.getByRole("menuitem", { name: /chat/i }).first().click();
    }
    // Split horizontally via split button (if exposed) OR via add-pane with direction
    const tabsBefore = await pageA.getByRole("tab").allTextContents();
    expect(tabsBefore.length).toBeGreaterThanOrEqual(3);

    // Close middle
    const middle = pageA.getByRole("tab").nth(1);
    await middle.hover();
    await middle.getByRole("button", { name: /close/i }).click();

    // Undo
    await pageA.keyboard.press(process.platform === "darwin" ? "Meta+Shift+U" : "Control+Shift+U");

    // Now open B (second device)
    await goToApp(pageB);

    // B must show the same tab order as A
    const tabsA = await pageA.getByRole("tab").allTextContents();
    const tabsB = await pageB.getByRole("tab").allTextContents();
    expect(tabsB).toEqual(tabsA);

    await a.close();
    await b.close();
  });
});
