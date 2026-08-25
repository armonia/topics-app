/**
 * E2E — reopen-closed-tab-history change.
 *
 * Verifies the two user-facing reopen surfaces share the same recently-closed
 * substrate (closedStack):
 *   1. ⇧⌘T (primary chord) reopens the most recently closed tab.
 *   2. ⌘K "Chiuse di recente" lists the closed tab and reopening from there works.
 *
 * Strategy mirrors pane-undo.spec.ts: state-inject two app-level chat tabs into
 * pane-store-v2, then drive close + reopen through the real UI.
 *
 * @covers CMD-03, CMD-04
 *
 * Reopening the most recently closed tab (CMD-03) and every surface going
 * through the same single entry point (CMD-04). Partial: durability and the
 * bound on the history are CMD-05, in closedStack.test.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, seedPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

async function gotoAndWait(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

async function seedTwoTabs(
  request: import("@playwright/test").APIRequestContext,
  t1: { id: string; name: string },
  t2: { id: string; name: string },
): Promise<void> {
  // The seed must OUT-RANK whatever is already stored (the client merges the
  // snapshot under an LWW gate on lastSeq, so a hard-coded `1` silently loses
  // against state a previous spec left behind) AND survive a late `pagehide`
  // beacon from the previous spec. `seedPaneStore` does both — this file
  // asserts "exactly 2 tabs", which is why it went red only in a full run.
  await seedPaneStore(request, () => ({
    panes: {
      [t1.id]: { id: t1.id, type: "chat", title: t1.name, topicId: t1.id },
      [t2.id]: { id: t2.id, type: "chat", title: t2.name, topicId: t2.id },
    },
    groups: {
      "group:default": {
        id: "group:default",
        paneIds: [t1.id, t2.id],
        splitRatio: 1,
        splitAxis: "horizontal",
      },
    },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));
  await request.put(`${BASE}/api/ui-state/panels`, {
    data: { openPanels: [t1.id, t2.id] },
    ignoreHTTPSErrors: true,
  });
}

/** Close the last tab in the bar via its close button. Returns the locator set. */
async function closeLastTab(page: Page) {
  const tabBar = page.locator('[data-testid="panel-tab-bar"]');
  await expect(tabBar).toBeVisible({ timeout: 10_000 });
  const tabs = tabBar.locator('[draggable="true"]');
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });
  const lastTab = tabs.nth(1);
  await lastTab.hover();
  await lastTab.locator("button").last().click({ force: true });
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
  return { tabBar, tabs };
}

test.describe("@reopen-closed-tab reopen-closed-tab-history", () => {
  let t1: { id: string; name: string; slug: string };
  let t2: { id: string; name: string; slug: string };

  test.beforeEach(async ({ request }) => {
    t1 = await createTopic(request, `Reopen-A-${Date.now()}`);
    t2 = await createTopic(request, `Reopen-B-${Date.now()}`);
    await seedTwoTabs(request, t1, t2);
  });

  test.afterEach(async ({ request }) => {
    await deleteTopic(request, t1.id).catch(() => {});
    await deleteTopic(request, t2.id).catch(() => {});
  });

  // Regression guard for the reopen "swap" bug (fixed): reopening a closed tab
  // used to be misread by usePaneOrdering as a preview-navigation, which
  // replaced+closed the current preview tab — so the reopened tab appeared but
  // the previously-open one vanished (a swap, not a restore). Reopen now marks
  // the restored id (lib/previewTabs markTabRestored) so the add stays additive.
  test("⇧⌘T reopens the most recently closed tab", async ({ page }) => {
    await gotoAndWait(page);
    await waitForTopicVisible(page, t2.id);

    const { tabBar, tabs } = await closeLastTab(page);

    // Focus a neutral spot so the chord isn't swallowed by a text input.
    //
    // `force: true` perche' questo click NON sta verificando niente: serve solo
    // a togliere il fuoco da un campo di testo. Senza, Playwright pretende che
    // il punto (5, 5) sia davvero raggiungibile — e un'attesa che non prova
    // nulla non deve poter far fallire un test. Due righe sopra, `closeLastTab`
    // usa gia' `force` per lo stesso motivo.
    //
    // Che quel punto sia raggiungibile e' comunque un fatto, e ha il suo test:
    // l'08/08 non lo era (il comando in testa alla riga di chrome stava a
    // `md:left-[5.5px]`, mezzo pixel dentro il bersaglio, e l'hit-test di
    // Chromium arrotondava DENTRO la sua scatola: click ritentato fino ai 30 s).
    // Lo misura ora `reduced-motion-chrome-controls.spec.ts`, con e senza
    // `prefers-reduced-motion` — li' il click e' NON forzato, perche' li' e'
    // proprio quello l'oggetto della verifica.
    await tabBar.click({ position: { x: 5, y: 5 }, force: true });
    await page.waitForTimeout(100); // no observable post-focus signal to poll
    await page.keyboard.press("Meta+Shift+T");

    await expect(tabs).toHaveCount(2, { timeout: 10_000 });
    // The reopened tab carries t2's pane id again.
    const ids = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("data-pane-id")));
    expect(ids).toContain(t2.id);
  });

  // Same additive-reopen guarantee from the ⌘K palette surface.
  test("⌘K 'Chiuse di recente' lists the closed tab and reopens it", async ({ page }) => {
    await gotoAndWait(page);
    await waitForTopicVisible(page, t2.id);

    const { tabs } = await closeLastTab(page);

    // Open the command palette (empty query → Projects + Chiuse di recente columns).
    await page.keyboard.press("Meta+k");
    const palette = page.locator('[data-testid="command-palette"]');
    await expect(palette).toBeVisible({ timeout: 5_000 });

    // The closed tab appears as a recent-closed row labelled with its title.
    const recentRow = palette.getByRole("option").filter({ hasText: t2.name }).first();
    await expect(recentRow).toBeVisible({ timeout: 5_000 });
    await recentRow.click();

    // Palette closes and the tab is back.
    await expect(palette).toBeHidden({ timeout: 5_000 });
    await expect(tabs).toHaveCount(2, { timeout: 10_000 });
    const ids = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("data-pane-id")));
    expect(ids).toContain(t2.id);
  });
});
