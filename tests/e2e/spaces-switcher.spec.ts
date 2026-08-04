/**
 * spaces-switcher.spec.ts — checklist point 12 (Spazi).
 *
 * Verifies the Spaces feature end-to-end through the REAL UI:
 *   - "Sposta nello Spazio → Nuovo Spazio" in the standalone tab context menu
 *     creates the first space and moves the tab into it.
 *   - Creating a space makes the SpaceSwitcher strip appear (it renders nothing
 *     until at least one live space exists) with the implicit "Principale" chip
 *     plus the new one.
 *   - Arc semantics: moving a tab does NOT auto-switch the window — the moved
 *     tab leaves the currently-visible ("Principale") set.
 *   - Clicking a space chip switches the active space (aria-selected).
 *
 * These map to SpaceSwitcher.tsx (data-testid="space-switcher", chips role="tab"
 * / data-space-id) and PaneTabBar.tsx ("Sposta nello Spazio" / "Nuovo Spazio").
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

test.describe.serial("Spaces (Spazi) switcher", () => {
  let idA = "";
  let idB = "";

  test.beforeAll(async ({ request }) => {
    const a = await createTopic(request, "SPACE-A-" + Date.now());
    const b = await createTopic(request, "SPACE-B-" + Date.now());
    idA = a.id;
    idB = b.id;
  });

  test.afterAll(async ({ request }) => {
    if (idA) await deleteTopic(request, idA);
    if (idB) await deleteTopic(request, idB);
  });

  /** Seed two standalone chat tabs open and navigate. */
  async function openTwoStandaloneTabs(page: Page) {
    // PRISTINE pane-store reset first — including `spaces`, which the legacy
    // key clears below never touched. This group is `.serial`: when a later
    // test flakes (SPACE-03's chip-switch timing), Playwright retries the
    // WHOLE group from SPACE-01 — which asserts "no switcher" and found the
    // space its own previous pass had created. The retry could then never
    // go green (observed as the shard-4 CI "flake": ✘ SPACE-03 → ✘ SPACE-01
    // retry#1/#2). resetPaneStore writes a snapshot with no spaces key, so
    // every (re)run starts from zero spaces. The two chat panes must be IN the
    // snapshot (empty panes would out-rank the legacy `panels` key and the
    // tabs would never render).
    await resetPaneStore(page.request, [idA, idB]);
    await Promise.all([
      page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [idA, idB] },
      }).catch(() => {}),
      page.request.put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: [idA, idB], pinned: [idA, idB] },
      }).catch(() => {}),
      // Clear any residual space state from a prior run so the switcher starts
      // hidden and the default space is active.
      page.request.put(`${BASE}/api/ui-state/grid-layout`, {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      }).catch(() => {}),
    ]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-pane-id="${idB}"]`).first()).toBeVisible({ timeout: 10000 });
  }

  test("SPACE-01: switcher is hidden until a space exists", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    // Zero chrome: no space-switcher strip when no live user space exists.
    await expect(page.getByTestId("space-switcher")).toHaveCount(0);
  });

  test("SPACE-02: 'Sposta nello Spazio → Nuovo Spazio' creates a space, moves the tab, shows the switcher (no auto-switch)", async ({ page }) => {
    await openTwoStandaloneTabs(page);

    // Right-click tab A → open the standalone tab context menu.
    const tabA = page.locator(`[data-pane-id="${idA}"]`).first();
    await tabA.click({ button: "right" });

    // Expand the "Sposta nello Spazio →" submenu, then "Nuovo Spazio".
    const moveEntry = page.getByText("Sposta nello Spazio", { exact: true });
    await expect(moveEntry, "tab menu must offer 'Sposta nello Spazio'").toBeVisible({ timeout: 3000 });
    await moveEntry.click();

    const newSpace = page.getByText("Nuovo Spazio", { exact: true });
    await expect(newSpace, "submenu must offer 'Nuovo Spazio'").toBeVisible({ timeout: 3000 });
    await newSpace.click();

    // The switcher now renders with the implicit "Principale" chip + the new one.
    const switcher = page.getByTestId("space-switcher");
    await expect(switcher, "switcher appears once a space exists").toBeVisible({ timeout: 3000 });
    const chips = switcher.getByRole("tab");
    await expect(chips, "Principale + the new space = 2 chips").toHaveCount(2);
    await expect(switcher.getByRole("tab", { name: "Principale" })).toBeVisible();

    // Arc semantics: the window did NOT auto-switch — "Principale" stays active,
    // and tab A (now in the new space) left the visible set.
    await expect(
      switcher.getByRole("tab", { name: "Principale" }),
      "the default space stays active after a quiet move",
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator(`[data-pane-id="${idA}"]`),
      "moved tab A left the Principale (visible) set",
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-pane-id="${idB}"]`).first(),
      "tab B stays in Principale",
    ).toBeVisible();
  });

  test("SPACE-03: clicking a space chip switches the active space and its visible tabs", async ({ page }) => {
    await openTwoStandaloneTabs(page);

    // Re-create the space + move tab A (each test gets a fresh page/state).
    const tabA = page.locator(`[data-pane-id="${idA}"]`).first();
    await tabA.click({ button: "right" });
    await page.getByText("Sposta nello Spazio", { exact: true }).click();
    await page.getByText("Nuovo Spazio", { exact: true }).click();

    const switcher = page.getByTestId("space-switcher");
    await expect(switcher).toBeVisible({ timeout: 3000 });

    // The non-default chip is "Spazio 2" (nextSpaceName for the first user space).
    const spazio2 = switcher.getByRole("tab", { name: /Spazio 2/ });
    await expect(spazio2, "the new space chip is labelled 'Spazio 2'").toBeVisible();

    // Switch to it → it becomes active, and tab A (its member) becomes visible;
    // tab B (in Principale) leaves the visible set.
    await spazio2.click();
    await expect(spazio2).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "tab A is visible in its own space",
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator(`[data-pane-id="${idB}"]`),
      "tab B (Principale) is hidden while Spazio 2 is active",
    ).toHaveCount(0);
  });

  test("SPACE-04: from a non-default space, the 'Principale' move-back target is ENABLED", async ({ page }) => {
    await openTwoStandaloneTabs(page);

    // Move tab A into a new space and switch to it.
    const tabA = page.locator(`[data-pane-id="${idA}"]`).first();
    await tabA.click({ button: "right" });
    await page.getByText("Sposta nello Spazio", { exact: true }).click();
    await page.getByText("Nuovo Spazio", { exact: true }).click();
    const switcher = page.getByTestId("space-switcher");
    await expect(switcher).toBeVisible({ timeout: 3000 });
    await switcher.getByRole("tab", { name: /Spazio 2/ }).click();
    const tabAinSpace = page.locator(`[data-pane-id="${idA}"]`).first();
    await expect(tabAinSpace, "tab A is now visible in Spazio 2").toBeVisible({ timeout: 5000 });

    // Reopen its menu → "Sposta nello Spazio". The "Principale" row must be
    // ENABLED so you can move the tab BACK. The bug: the submenu read the pane
    // from a reconstructed array with no spaceId, so resolvePaneSpace always
    // returned Principale → the "Principale" row was ALWAYS disabled.
    await tabAinSpace.click({ button: "right" });
    await page.getByText("Sposta nello Spazio", { exact: true }).click();
    const principaleEntry = page.getByRole("button", { name: "Principale", exact: true });
    await expect(principaleEntry, "the Principale move-back row must render").toBeVisible({ timeout: 3000 });
    await expect(principaleEntry, "and it must be ENABLED (fixable move-back)").toBeEnabled();
  });

  // I gruppi si vedono dalla SIDEBAR, non solo nella striscia di chip: è lì che
  // vive il modello ("un gruppo è l'unità, una finestra è un gruppo staccato").
  test("SPACE-05: the sidebar lists the groups with their tabs, and a row switches group", async ({ page }) => {
    await openTwoStandaloneTabs(page);

    // Crea uno Spazio spostandoci la tab A (stessa via di SPACE-02).
    await page.locator(`[data-pane-id="${idA}"]`).first().click({ button: "right" });
    await page.getByText("Sposta nello Spazio", { exact: true }).click();
    await page.getByText("Nuovo Spazio", { exact: true }).click();

    const section = page.getByTestId("sidebar-groups");
    await expect(section, "the sidebar shows the groups once one exists").toBeVisible({ timeout: 5000 });
    const rows = section.getByTestId("group-row");
    await expect(rows, "Principale + the new group").toHaveCount(2);

    // Le righe elencano le TAB, non solo le chat: la tab spostata sta nel nuovo
    // gruppo, l'altra è rimasta in Principale.
    await expect(
      section.locator(`[data-testid="group-tab"]`),
      "every app-level tab appears under exactly one group",
    ).toHaveCount(2);

    // Un click sulla riga commuta il gruppo attivo — la stessa azione del chip.
    const other = rows.nth(1);
    await other.click();
    await expect(
      page.getByTestId("space-switcher").getByRole("tab").nth(1),
      "clicking a sidebar group activates it",
    ).toHaveAttribute("aria-selected", "true", { timeout: 5000 });
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "and its tab is now the visible one",
    ).toBeVisible({ timeout: 5000 });
  });
});
