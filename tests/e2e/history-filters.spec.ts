/**
 * The full history panel: filters on top, one search over the whole list, an
 * empty state that explains itself, and the ⇧⌘T hint on the tab the chord
 * really reopens (change history-panel-filters, card 2e015c9b).
 *
 * The panel is reached the way a person reaches it: the user menu, its
 * history level, then the row that opens the whole history. Both sources are seeded
 * before the app boots: visited pages in the browser's localStorage (the
 * store reads them once, at module load), closed tabs in the pane-store
 * `closedStack` the client hydrates from the server.
 *
 * The browser's time zone is pinned to Europe/Rome, and the scenarios that
 * talk about a day pin the page clock too: «yesterday» is a calendar day, and
 * a run at 00:30 must not turn a row from five hours ago into yesterday's.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { closeAllBrowserContexts, seedPaneStore } from "./helpers/api-fixtures";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ timezoneId: "Europe/Rome" });

const PAGES_KEY = "topics:browser-pages:v1";
const MINUTE = 60_000;
/** 28/09/2026 10:00 in Rome: the fixed clock of the scenarios about a day. */
const FIXED_NOW = Date.parse("2026-09-28T10:00:00+02:00");

type Visit = { url: string; title: string; favicon: string; at: number };

function visit(url: string, at: number, title = ""): Visit {
  return { url, title, favicon: "", at };
}

/** A `closedStack` record in the shape the reducer writes (ClosedPaneRecord). */
function closedTab(
  id: string,
  title: string,
  closedAt: number,
  seq: number,
  pane: { type?: string; url?: string } = {},
): Record<string, unknown> {
  return {
    id,
    closedAt,
    pane: { id, type: pane.type ?? "chat", title, ...(pane.url ? { url: pane.url } : {}) },
    groupId: "group:default",
    groupIndex: 0,
    level: "app",
    focusedAtClose: false,
    tabOrderSnapshot: [],
    seq,
  };
}

/** No open tab, and exactly these closed ones. */
async function seedClosedTabs(request: APIRequestContext, records: Record<string, unknown>[]): Promise<void> {
  await seedPaneStore(request, () => ({
    panes: {},
    groups: {
      "group:default": { id: "group:default", paneIds: [], splitRatio: 1, splitAxis: "horizontal" },
    },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: records,
  }));
}

async function seedPages(page: Page, visits: Visit[]): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [PAGES_KEY, JSON.stringify(visits)] as const,
  );
}

async function openFullHistory(page: Page): Promise<Locator> {
  await openProfileMenu(page);
  await page.getByTestId("topics-menu-history").click();
  await page.getByTestId("topics-menu-history-all").click();
  const palette = page.getByTestId("command-palette");
  await expect(palette).toHaveAttribute("data-scope", "history");
  return palette;
}

const pressed = (loc: Locator, value: "true" | "false") => expect(loc).toHaveAttribute("aria-pressed", value);

// Every scenario starts with no closed tab: the pane-store is the server's,
// and the hermetic reset runs once per file, not per test. A scenario that
// needs closed tabs seeds them again on top.
test.beforeEach(async ({ request }) => {
  await seedClosedTabs(request, []);
});

test.describe("full history: filters on top of the panel", () => {
  test("the Pages filter keeps only the visited pages, and the count follows", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-03" });
    const now = Date.now();
    await seedClosedTabs(request, [
      closedTab("hist-tab-a", "Tab Alpha", now - 3 * MINUTE, 1),
      closedTab("hist-tab-b", "Tab Bravo", now - 6 * MINUTE, 2),
    ]);
    await seedPages(page, [
      visit("https://uno.example/", now - 2 * MINUTE, "Uno"),
      visit("https://due.example/", now - 4 * MINUTE, "Due"),
      visit("https://tre.example/", now - 8 * MINUTE, "Tre"),
    ]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    await expect(palette.getByRole("option")).toHaveCount(5);
    // On a desktop the two groups share one row.
    const tops = await palette
      .getByTestId("history-filters")
      .getByRole("group")
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(tops).toHaveLength(2);
    expect(tops[0]).toBe(tops[1]);

    await palette.getByTestId("history-filter-kind-page").click();

    await expect(palette.getByRole("option")).toHaveCount(3);
    await expect(palette.getByTestId("history-row-page")).toHaveCount(3);
    await expect(palette.getByTestId("palette-history-count")).toHaveText("3");
    await pressed(palette.getByTestId("history-filter-kind-page"), "true");
    await pressed(palette.getByTestId("history-filter-kind-all"), "false");
  });

  test("the Yesterday filter keeps the calendar day before today", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-03" });
    await page.clock.setFixedTime(FIXED_NOW);
    await seedPages(page, [
      visit("https://oggi-uno.example/", Date.parse("2026-09-28T09:30:00+02:00"), "Oggi uno"),
      visit("https://oggi-due.example/", Date.parse("2026-09-28T08:00:00+02:00"), "Oggi due"),
      visit("https://ieri.example/", Date.parse("2026-09-27T18:00:00+02:00"), "Ieri sera"),
    ]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    await expect(palette.getByRole("option")).toHaveCount(3);

    await palette.getByTestId("history-filter-range-yesterday").click();

    await expect(palette.getByRole("option")).toHaveCount(1);
    await expect(palette.getByRole("option")).toContainText("Ieri sera");
  });

  test("the filters start again from All and Any time when the panel reopens", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-03" });
    await page.clock.setFixedTime(FIXED_NOW);
    await seedClosedTabs(request, [closedTab("hist-tab-a", "Tab Alpha", FIXED_NOW - 30 * MINUTE, 1)]);
    await seedPages(page, [
      visit("https://oggi.example/", FIXED_NOW - 10 * MINUTE, "Oggi"),
      visit("https://ieri.example/", Date.parse("2026-09-27T18:00:00+02:00"), "Ieri"),
    ]);
    await page.goto("/");
    let palette = await openFullHistory(page);
    await expect(palette.getByRole("option")).toHaveCount(3);
    await palette.getByTestId("history-filter-kind-page").click();
    await palette.getByTestId("history-filter-range-yesterday").click();
    await expect(palette.getByRole("option")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    palette = await openFullHistory(page);

    await pressed(palette.getByTestId("history-filter-kind-all"), "true");
    await pressed(palette.getByTestId("history-filter-range-all"), "true");
    await pressed(palette.getByTestId("history-filter-kind-page"), "false");
    await pressed(palette.getByTestId("history-filter-range-yesterday"), "false");
    await expect(palette.getByRole("option")).toHaveCount(3);
  });

  test("after a click on a filter the keyboard carries on from the search field", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-03" });
    // The page opens in a browser pane: the remote engine is the external
    // boundary, so its socket and its REST routes answer here and no
    // headless browser is started on the test server.
    await page.routeWebSocket(/\/ws\/browser\//, () => {});
    await page.route(/\/api\/browsers\//, (route) => route.fulfill({ status: 404, body: "Not found" }));
    const now = Date.now();
    await seedClosedTabs(request, [closedTab("hist-tab-a", "Tab Alpha", now - 2 * MINUTE, 1)]);
    await seedPages(page, [
      visit("https://pagina-uno.example/", now - 5 * MINUTE),
      visit("https://pagina-due.example/", now - 9 * MINUTE),
    ]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    await expect(palette.getByRole("option").first()).toHaveAttribute("data-testid", "history-row-tab");
    // The selection moves off the first row before the filter: after it, it
    // has to start again from the top, or Enter opens the second page.
    await page.keyboard.press("ArrowDown");
    await expect(palette.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");

    await palette.getByTestId("history-filter-kind-page").click();

    await expect(palette.getByRole("textbox")).toBeFocused();
    await expect(palette.getByRole("option").first()).toHaveAttribute("data-testid", "history-row-page");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    const browserTab = page.getByTestId("panel-tab-bar").locator('[data-pane-id^="browser:"]');
    await expect(browserTab).toHaveCount(1);
    await expect(browserTab).toContainText("pagina-uno.example");
  });

  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request);
  });
});

test.describe("full history on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("a tap on a filter leaves the search field alone, so the keyboard stays down", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-03" });
    await seedPages(page, [visit("https://uno.example/", Date.now() - 2 * MINUTE, "Uno")]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    const field = palette.getByRole("textbox");
    // The person has closed the software keyboard. A focus() inside the tap
    // is what brings it back on iOS, over the list the tap just filtered.
    await field.evaluate((el) => (el as HTMLInputElement).blur());
    await expect(field).not.toBeFocused();

    await palette.getByTestId("history-filter-kind-tab").tap();

    await pressed(palette.getByTestId("history-filter-kind-tab"), "true");
    await expect(field).not.toBeFocused();
    await palette.getByTestId("history-filter-reset").tap();

    await expect(palette.getByRole("option")).toHaveCount(1);
    await expect(field).not.toBeFocused();
  });

  test("the filters stack one group per row, with 44 px buttons and no sideways scroll", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-03" });
    await seedPages(page, [visit("https://uno.example/", Date.now() - 2 * MINUTE, "Uno")]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    const bar = palette.getByTestId("history-filters");
    await expect(bar).toBeVisible();

    const buttons = bar.getByRole("button");
    await expect(buttons).toHaveCount(7);
    // The layout height, not the painted box: the page slides in with a
    // 150 ms scale from 0.98, and a rect read during it reads 43.8 for a
    // button that is 44 once the entry is over (measured).
    const heights = await buttons.evaluateAll((els) => els.map((el) => (el as HTMLElement).offsetHeight));
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    const groups = await bar.getByRole("group").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      }),
    );
    expect(groups).toHaveLength(2);
    expect(groups[1]!.top).toBeGreaterThanOrEqual(groups[0]!.bottom);
    const overflow = await bar.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  });
});

test.describe("full history: one search over the whole list", () => {
  /** 45 pages, one a minute; the oldest is the only one on quarantacinque.example. */
  function fortyFivePages(now: number): Visit[] {
    return Array.from({ length: 45 }, (_, i) =>
      i === 44
        ? visit("https://quarantacinque.example/", now - 45 * MINUTE)
        : visit(`https://pagina-${i + 1}.example/`, now - (i + 1) * MINUTE, `Pagina ${i + 1}`),
    );
  }

  test("row 45 is shown and can be found", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-04" });
    await seedPages(page, fortyFivePages(Date.now()));
    await page.goto("/");
    const palette = await openFullHistory(page);

    await expect(palette.getByRole("option")).toHaveCount(45);
    await expect(palette.getByTestId("palette-history-count")).toHaveText("45");

    await palette.getByRole("textbox").fill("quarantacinque");
    await expect(palette.getByRole("option")).toHaveCount(1);
    await expect(palette.getByRole("option")).toContainText("quarantacinque.example");
  });

  test("the words may sit in different fields", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-04" });
    const now = Date.now();
    await seedPages(page, [
      visit("https://github.com/armonia/topics/3", now - 2 * MINUTE, "Pull request"),
      visit("https://esempio.dev/", now - 4 * MINUTE, "Esempio"),
    ]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    await expect(palette.getByRole("option")).toHaveCount(2);

    await palette.getByRole("textbox").fill("github pull");

    await expect(palette.getByRole("option")).toHaveCount(1);
    await expect(palette.getByRole("option")).toContainText("Pull request");
    // The highlight marks each word where it sits: the whole phrase is in no
    // field, so a phrase-only mark would leave the title bare.
    await expect(palette.getByRole("option").locator("mark")).toHaveText(["Pull"]);
  });

  test("the age of a row is not searched", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-04" });
    const now = Date.now();
    // Two to ten minutes ago: under a minute the age reads «ora», and «fa»
    // would not be on screen at all. No title holds «fa» or «chiusa». allow-italian: the Italian age text is what the search must skip
    await seedClosedTabs(request, [
      closedTab("hist-tab-a", "Alpha", now - 2 * MINUTE, 1),
      closedTab("hist-tab-b", "Bravo", now - 5 * MINUTE, 2),
      closedTab("hist-tab-c", "Delta", now - 10 * MINUTE, 3),
    ]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    await expect(palette.getByTestId("history-row-tab")).toHaveCount(3);
    await expect(palette.getByTestId("history-row-tab").first()).toContainText("fa");

    await palette.getByRole("textbox").fill("fa");

    await expect(palette.getByRole("option")).toHaveCount(0);
    // Only a query is active: the plain «no results», with nothing to reset.
    await expect(palette.getByText("Nessun risultato")).toBeVisible();
    await expect(palette.getByTestId("history-filter-reset")).toHaveCount(0);
  });

  test("a closed browser tab is found by its address", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-04" });
    const now = Date.now();
    await seedClosedTabs(request, [
      closedTab("browser:hist-guida", "Guida", now - 3 * MINUTE, 1, { type: "browser", url: "https://esempio.dev/guida" }),
      closedTab("hist-tab-a", "Alpha", now - 6 * MINUTE, 2),
    ]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    await expect(palette.getByTestId("history-row-tab")).toHaveCount(2);

    await palette.getByRole("textbox").fill("esempio.dev");

    await expect(palette.getByRole("option")).toHaveCount(1);
    await expect(palette.getByTestId("history-row-tab")).toContainText("Guida");
  });

  test("⌘K searches the whole history too, not its 40 newest rows", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-04" });
    await seedPages(page, fortyFivePages(Date.now()));
    await page.goto("/");
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press("Meta+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toHaveAttribute("data-scope", "all");
    await expect(palette.getByTestId("history-filters")).toHaveCount(0);
    await palette.getByRole("textbox").fill("quarantacinque");

    await expect(palette.getByTestId("history-row-page").filter({ hasText: "quarantacinque.example" })).toHaveCount(1);
  });
});

test.describe("full history: the empty state and the ⇧⌘T hint", () => {
  test("filters that empty the list say so, and «Mostra tutto» brings the rows back", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-05" });
    const now = Date.now();
    await seedPages(page, [
      visit("https://github.com/armonia/topics", now - 2 * MINUTE, "Topics repo"),
      visit("https://github.com/armonia/quadra", now - 4 * MINUTE, "Quadra repo"),
      visit("https://esempio.dev/", now - 6 * MINUTE, "Esempio"),
    ]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    const field = palette.getByRole("textbox");
    await field.fill("github");
    await expect(palette.getByRole("option")).toHaveCount(2);

    await palette.getByTestId("history-filter-kind-tab").click();

    await expect(palette.getByRole("option")).toHaveCount(0);
    await expect(palette.getByText("Niente con questi filtri")).toBeVisible();
    await palette.getByTestId("history-filter-reset").click();

    await expect(palette.getByRole("option")).toHaveCount(2);
    await expect(palette.getByTestId("history-row-page")).toHaveCount(2);
    await pressed(palette.getByTestId("history-filter-kind-all"), "true");
    await expect(field).toHaveValue("github");
    await expect(field).toBeFocused();
  });

  test("with nothing in the history the panel says so even under a filter, with nothing to reset", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-05" });
    await page.goto("/");
    const palette = await openFullHistory(page);

    await palette.getByTestId("history-filter-kind-tab").click();

    await pressed(palette.getByTestId("history-filter-kind-tab"), "true");
    await expect(palette.getByRole("option")).toHaveCount(0);
    await expect(palette.getByText("Ancora niente in cronologia")).toBeVisible();
    await expect(palette.getByTestId("history-filter-reset")).toHaveCount(0);
  });

  test("the ⇧⌘T hint sits on the tab the chord reopens, not on the first row", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "HISTORY-05" });
    await page.clock.setFixedTime(FIXED_NOW);
    await seedClosedTabs(request, [
      closedTab("hist-tab-b", "Tab di ieri", Date.parse("2026-09-27T18:00:00+02:00"), 1),
      closedTab("hist-tab-a", "Tab recente", FIXED_NOW - 5 * MINUTE, 2),
    ]);
    await seedPages(page, [visit("https://pagina.example/", FIXED_NOW - MINUTE, "Pagina recente")]);
    await page.goto("/");
    const palette = await openFullHistory(page);
    const rows = palette.getByRole("option");
    await expect(rows).toHaveCount(3);

    await expect(rows.first()).toContainText("Pagina recente");
    await expect(rows.first().locator("kbd")).toHaveCount(0);
    await expect(rows.filter({ hasText: "Tab recente" }).locator("kbd")).toHaveCount(1);
    await expect(rows.filter({ hasText: "Tab di ieri" }).locator("kbd")).toHaveCount(0);

    await palette.getByTestId("history-filter-range-yesterday").click();

    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Tab di ieri");
    await expect(rows.first().locator("kbd")).toHaveCount(0);
  });
});
