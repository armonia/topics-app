import { test, expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { isEvidenceRun } from "./helpers/evidence";

hermetic(test);

/**
 * STATUSLINE-03 - the version chip admits when the CODE on screen is not the
 * version it is showing.
 *
 * The chip reads `/api/version`, which the server re-reads off `package.json`
 * fresh, so a bump is never stale. `public/` is a different story: it is a
 * deploy artefact rebuilt by hand (docs/build-watch-decision.md), so it can sit
 * days behind. On 2026-08-29 it sat four versions behind and the chip happily
 * showed the repo number over old code.
 *
 * Hermetic: `/api/version` is stubbed, so the drift is produced without
 * touching the tree. The bundle's own baked `__APP_VERSION__` is whatever this
 * build carries, and `9.9.9` is guaranteed not to be it.
 */
test.describe("Version chip vs the bundle on screen", () => {
  test("STATUSLINE-03: a repo version different from the bundle is declared", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-03" });

    // `/api/…` is passed straight through by the service worker, so page.route
    // sees it (the reasoning is spelled out in changelog.spec.ts).
    await page.route("**/api/version", (r) =>
      r.fulfill({ json: { version: "9.9.9" }, headers: { "Cache-Control": "no-store" } }),
    );
    await page.goto("/");

    const chip = page.locator("[data-version-anchor]");
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toContainText("9.9.9");
    // The mark on the chip: the number alone cannot say that it disagrees with
    // the code underneath it.
    await expect(page.getByTestId("version-drift-dot")).toBeVisible();

    await chip.click();
    const block = page.getByTestId("version-bundle-drift");
    await expect(block).toBeVisible();
    // Both numbers, or the sentence is an alarm without a fact.
    await expect(block).toContainText("9.9.9");
    await expect(block).toContainText("build:client");

    // Delivery evidence: the whole point is a sentence that has to be READ, and
    // a full 1280px frame shrunk to a card is a grey smudge. Crop to the corner
    // that carries it, in a landscape box (the card crops a tall image at the
    // bottom). No-op in a normal run.
    if (isEvidenceRun()) {
      const box = await block.boundingBox();
      if (box) {
        const W = 320;
        const H = 210;
        await page.screenshot({
          path: "test-results/bundle-drift-evidence.png",
          clip: {
            x: Math.min(Math.max(0, box.x - 22), 1280 - W),
            y: Math.min(Math.max(0, box.y - 22), 800 - H),
            width: W,
            height: H,
          },
        });
      }
    }
  });

  test("STATUSLINE-03: with no repo version to compare, nothing is declared", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-03" });

    // The server is unreachable for this fact: a standalone bundle, or a server
    // that could not read a version. A missing fact is not a drift.
    await page.route("**/api/version", (r) => r.abort());
    await page.goto("/");

    const chip = page.locator("[data-version-anchor]");
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("version-drift-dot")).toHaveCount(0);

    await chip.click();
    await expect(page.getByTestId("version-bundle-drift")).toHaveCount(0);
  });
});
