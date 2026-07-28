import { test, expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * CHANGELOG — the in-app "Novità" surface: version chip → popover → modal.
 * Hermetic: the version (/api/version) and the changelog data (/changelog.json)
 * are stubbed so the test asserts UI behavior (open, navigate, highlight the
 * running version) without depending on the generated file or the live semver.
 */
const FIXTURE = [
  {
    version: "9.9.9",
    date: "2026-07-23",
    sections: {
      new: [{ it: "prima novità di prova", en: "", scope: "chat", breaking: false }],
      fixes: [{ it: "una correzione di prova", en: "", scope: "browser", breaking: false }],
      perf: [],
      internal: [{ it: "pulizia interna", en: "", scope: "core", breaking: false }],
    },
  },
  {
    version: "9.9.8",
    date: "2026-07-22",
    sections: {
      new: [{ it: "novità della versione precedente", en: "", scope: "board", breaking: false }],
      fixes: [],
      perf: [{ it: "più veloce di prima", en: "", scope: "sidebar", breaking: false }],
      internal: [],
    },
  },
];

test.describe("Changelog (in-app Novità)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/version", (r) =>
      r.fulfill({ json: { version: "9.9.9" }, headers: { "Cache-Control": "no-store" } }),
    );
    await page.route("**/changelog.json", (r) => r.fulfill({ json: FIXTURE }));
  });

  test("CHANGELOG-01: open from the version chip and see the running version's entries", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHANGELOG-01" });
    await page.goto("/");

    // The version chip shows the stubbed version and anchors the popover.
    const chip = page.locator("[data-version-anchor]");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/v9\.9\.9/);
    await chip.click();

    // Popover → "Novità" entry point → modal.
    await page.getByTestId("changelog-open").click();
    const modal = page.getByTestId("changelog-modal");
    await expect(modal).toBeVisible();

    // Defaults to the running version, flagged "in uso" / "versione in uso".
    await expect(modal.getByText("versione in uso")).toBeVisible();
    await expect(modal.getByText("prima novità di prova")).toBeVisible();
    await expect(modal.getByText("una correzione di prova")).toBeVisible();
    // Scope tag rendered.
    await expect(modal.getByText("chat", { exact: true }).first()).toBeVisible();
  });

  test("CHANGELOG-02: navigate to an older version swaps the content", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHANGELOG-02" });
    await page.goto("/");
    await page.locator("[data-version-anchor]").click();
    await page.getByTestId("changelog-open").click();
    const modal = page.getByTestId("changelog-modal");
    await expect(modal).toBeVisible();

    // Click the previous version in the rail.
    await page.getByTestId("changelog-version-9.9.8").click();
    await expect(modal.getByText("novità della versione precedente")).toBeVisible();
    await expect(modal.getByText("più veloce di prima")).toBeVisible();
    // The current version's entry is no longer shown.
    await expect(modal.getByText("prima novità di prova")).toHaveCount(0);
  });

  test("CHANGELOG-03: 'Sotto il cofano' is collapsed then expandable", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHANGELOG-03" });
    await page.goto("/");
    await page.locator("[data-version-anchor]").click();
    await page.getByTestId("changelog-open").click();
    const modal = page.getByTestId("changelog-modal");
    await expect(modal).toBeVisible();

    // Internal churn hidden until the disclosure is toggled.
    await expect(modal.getByText("pulizia interna")).toHaveCount(0);
    await modal.getByText(/Sotto il cofano/).click();
    await expect(modal.getByText("pulizia interna")).toBeVisible();
  });
});

test.describe("Changelog (real data end-to-end)", () => {
  // No stubs — proves the server actually serves /changelog.json (static
  // allowlist in server.ts) and the modal renders the generated history.
  test("CHANGELOG-04: modal loads the real generated changelog from the server", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHANGELOG-04" });
    await page.goto("/");
    await page.locator("[data-version-anchor]").click();
    await page.getByTestId("changelog-open").click();
    const modal = page.getByTestId("changelog-modal");
    await expect(modal).toBeVisible();

    // Real data: at least one version in the rail and at least one entry rendered
    // (not the "Carico…" / "non disponibile" fallback).
    await expect(modal.locator("nav button").first()).toBeVisible();
    expect(await modal.locator("nav button").count()).toBeGreaterThan(0);
    await expect(modal.locator("section li").first()).toBeVisible();
    await expect(modal.getByText(/non disponibile/)).toHaveCount(0);
  });
});
