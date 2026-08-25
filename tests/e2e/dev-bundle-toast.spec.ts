/**
 * @covers BUNDLE-TOAST-01
 */
import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * "Gestiamo meglio l'hot-reload" (2026-07-20). The dev bundle-freshness path no
 * longer reloads the window out from under the user. A stale-bundle signal
 * (`topics:bundle-stale` — fired by the rev-mismatch check AND the chunk-load
 * error guard) must:
 *   1. surface the DevBundleToast "Ricarica" prompt,
 *   2. NOT navigate on its own,
 *   3. reload only when the user clicks Ricarica.
 *
 * Dispatching the DOM event is the faithful integration point: both runtime
 * sources converge on it, and the toast + reload button are the observable
 * contract the user cares about.
 */
test.describe("dev bundle: prompt to reload, never auto-reload", () => {
  test("stale signal shows the toast and does not navigate; clicking Ricarica reloads", async ({ page }) => {
    await goToApp(page);

    // Sentinel that only survives if the page is NOT reloaded.
    await page.evaluate(() => { (window as unknown as { __noReload?: boolean }).__noReload = true; });

    // Fire the stale-bundle signal (what devBundleReload / chunkReloadGuard emit).
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:bundle-stale")));

    const toast = page.locator('[data-testid="bundle-stale-toast"]');
    await expect(toast).toBeVisible();

    // No auto-reload: the sentinel is intact after a settle window.
    await page.waitForTimeout(1500);
    const survived = await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true);
    expect(survived).toBe(true);
    await expect(toast).toBeVisible();

    // Clicking Ricarica performs a real (cache-busted) reload → sentinel wiped.
    await page.locator('[data-testid="bundle-stale-reload"]').click();
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
        { timeout: 10000 },
      )
      .toBeUndefined();
    // And the app comes back up (not a broken navigation).
    await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible();
  });

  test("the toast can be dismissed and re-surfaces on a new stale signal", async ({ page }) => {
    await goToApp(page);

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:bundle-stale")));
    const toast = page.locator('[data-testid="bundle-stale-toast"]');
    await expect(toast).toBeVisible();

    await toast.getByRole("button", { name: "Ignora" }).click();
    await expect(toast).toBeHidden();

    // A fresh signal (the bundle moved again) re-shows it.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:bundle-stale")));
    await expect(toast).toBeVisible();
  });
});
