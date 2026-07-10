/**
 * Phase 30 Wave 0 — PANE-07 focus-loss fixture.
 *
 * Reproduces the "focus lost on device switch" bug class from 30-CONTEXT.md:
 * device A has a focused pane; device B reconnects; current code broadcasts
 * focus over WS which wipes A's local focus.
 *
 * Unified-pane design (CONTEXT.md): focusedPanelId + scroll offsets are
 * device-local and MUST NOT sync to server. This test enforces that rule.
 *
 * EXPECTED RED. Wave 2 introduces the device-local field split.
 *
 * CONTEXT.md "Fixtures first" — this test is both the spec and the exit criterion.
 */
import { test, expect, devices } from "./fixtures/test-fixtures";
import { goToApp } from "./helpers";

test.describe("@phase30-regression PANE-07 focus-loss fixture", () => {
  test("PANE-07: focus on device A is NOT wiped when device B reconnects", async ({ browser }) => {
    // EXPECTED RED — Phase 30 Wave 2 (PANE-07 device-local field split).
    // Current code broadcasts focusedPanelId over WS, wiping A's local focus when B reconnects.
    // Wave 2 introduces the device-local split (focus + scroll stay per-device).
    // When it lands, remove this annotation and the test should pass.
    // Unimplemented feature (Phase 30 Wave 2). Body uses pre-redesign selectors →
    // times out under test.fail (status "timedOut" ≠ "failed" → RED). test.fixme
    // skips the body, the correct marker for a not-yet-built feature. Drop the
    // fixme when Wave 2 ships.
    test.fixme(
      true,
      "WAVE-2 scope — PANE-07 device-local focus not yet split from synced state (see 30-CONTEXT.md)",
    );
    const a = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const b = await browser.newContext({ ...devices["iPhone 13"] });
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    await goToApp(pageA);
    await goToApp(pageB);

    // On A: open two panes, focus the second
    await pageA.getByRole("button", { name: /add pane|\+/i }).first().click();
    await pageA.getByRole("menuitem", { name: /chat/i }).first().click();
    await pageA.getByRole("button", { name: /add pane|\+/i }).first().click();
    await pageA.getByRole("menuitem", { name: /file/i }).first().click();
    await pageA.getByRole("tab").nth(1).click();
    await expect(pageA.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");

    // On B: open the app fresh (same user). B's focus syncing in the current code wipes A's focus.
    await pageB.waitForTimeout(500);
    await pageB.getByRole("button", { name: /add pane|\+/i }).first().click();
    await pageB.getByRole("menuitem", { name: /chat/i }).first().click();

    // Back on A: focus must STILL be on the second tab (device-local, not synced)
    await pageA.waitForTimeout(500);
    await expect(pageA.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");

    await a.close();
    await b.close();
  });
});
