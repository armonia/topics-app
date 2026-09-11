/**
 * pane-zoom.spec.ts — zooming a CONVERSATION on the standalone tiling surface.
 *
 * WHAT IS BEING PROVEN HERE, and why it can only be proven end to end. The pure
 * halves of this feature (which cells a scope resolves to, where the
 * degradation lives, what the store remembers) have their own unit files. What
 * no unit can give is the GESTURE and the surface it lands on: a double click
 * that has to pin a preview BEFORE it zooms, a modifier that has to survive the
 * trip through a real keyboard event, a frame whose click must not reach the
 * grid underneath, and — above all — the invariant the whole design rests on,
 * that entering and leaving the zoom REMOUNTS NOTHING.
 *
 * HOW COVERAGE IS DECLARED, on both channels and not one.
 *  · the `@covers` line below names the FILE: it is evidence of a link, and for
 *    a Playwright file that passes whole it carries real evidential weight.
 *  · every single `test(...)` pushes its own `spec` annotation. That is the ONLY
 *    channel that carries a verdict per REQUIREMENT — a file holds many tests,
 *    so `@covers` can never say which requirement passed.
 * Both are needed. Dropping the per-scenario annotation is how a requirement
 * ends up with four scenarios written and zero outcomes, with the gate green.
 *
 * THE BENCH SERVES A BUILT BUNDLE. `tests/e2e/global-setup.ts` snapshots
 * `public/` and points the isolated test server at the copy, so nothing in this
 * file sees a source change until the client is rebuilt.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE. `NATIVEPARK-02` is not in the `@covers`
 * line, and its absence is the honest half of the drawer case below. What that
 * requirement asks for is that a view behind a hidden shell be SWITCHED OFF, not
 * merely parked — and "switched off" is a call into the native shell. Under
 * Playwright `isTauri` is false, nothing of the sort is ever emitted, and a
 * green here would mean only that Chromium has no webviews to turn off. Its
 * proof is the unit test of task 2.2 plus the manual Tauri pass of 7.7; what
 * this file does carry of that story is the LAYOUT half, `LAYOUT-38`.
 *
 * The narrow-viewport case of `LAYOUT-39` does not claim a pane shell DETACHES
 * either, and for reasons of the code rather than of the shell: a browser pane
 * is `native`, whose residency budget is `Infinity`, and every surface renders
 * its active pane unconditionally. What it asserts instead — that the cell
 * without a box says so all the way down to the pane — is spelled out where it
 * is measured.
 *
 * @covers LAYOUT-34, LAYOUT-35, LAYOUT-36, LAYOUT-37, LAYOUT-38, LAYOUT-39, LAYOUT-40
 */
import { test, expect, type Browser, type Page, type APIRequestContext, type Locator } from "@playwright/test";
import { goToApp, ensureTopicVisible } from "./helpers";
import {
  createTopic,
  deleteTopic,
  seedPaneStore,
  unarchiveTopic,
  waitForPaneStoreQuiet,
  createTerminalSession,
  deleteTerminalSession,
  seedProjectPane,
  deleteTask,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { countColDividers, countRowDividers } from "./helpers/layout";
import { projectRow } from "./helpers/project-row";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";
import { openTwoDevices } from "./helpers/multi-client";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, writeFileSync } from "fs";

// Hermetic boundary: this file restarts from the globalSetup baseline instead of
// whatever the previous spec left behind. See fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/** The app's own per-space key for the device-local grid overlay
 *  (`usePanelGridPersistence`). The default space still mirrors the legacy
 *  unsuffixed key, so a seed has to write BOTH or a stale layout survives. */
const GRID_KEY = "topics-panel-grid-layout";
const GRID_KEY_DEFAULT_SPACE = "topics-panel-grid-layout:space:default";
/** `state/browserSpawner.ts` — the window-local "which chat opened which
 *  browser" registry, in sessionStorage. It enters the zoom set in UNION. */
const SPAWNER_KEY = "topics:browser-spawners:v1";

/** The pane-store stream socket of a browser pane. Stubbed so a seeded
 *  `browser:` pane renders its tab and its CELL without the server launching a
 *  real headless Chromium — the one external boundary this file isolates. */
const BROWSER_STREAM_WS = /\/ws\/browser\//;
/** The app-wide sync socket, and ONLY that: `/\/ws/` would also swallow the
 *  browser stream above and the two mocks would fight over the same route. */
const APP_WS = /\/ws(\?|$)/;

// ─── the surface, as the DOM publishes it ────────────────────────────────────

/** The standalone tiling surface. `.first()` because a project window mounts
 *  one of its own; none of these tests opens a project. */
function surface(page: Page): Locator {
  return page.locator("[data-split-surface]").first();
}

function tab(page: Page, paneId: string): Locator {
  return page.locator(`[data-testid="pane-tab-${paneId}"]`);
}

/** A chat tab is in PREVIEW while it is not pinned, and the italic label is how
 *  the bar says so (`PaneTabBar`, `pane.preview ? 'italic' : ''`). */
function tabLabel(page: Page, paneId: string): Locator {
  return tab(page, paneId).locator('[data-testid="pane-tab-label"]').first();
}

/**
 * Make `paneId` a PINNED tab, the way a person does: one double click.
 *
 * Every chat tab of a freshly loaded window is a preview, and that is not a
 * quirk of the seed — `loadPanelOrder()` hands back `pinned: []` by design, so
 * after any reload the whole strip reads as previews. The zoom is LAYERED under
 * that: the gesture pins first and only zooms a tab that was already pinned. A
 * test that wants to zoom therefore has to spend the first double click, and
 * doing it through a named helper keeps every other case honest about which
 * gesture it is actually measuring.
 */
async function pinTab(page: Page, paneId: string): Promise<void> {
  const label = tabLabel(page, paneId);
  await expect(label).toBeVisible({ timeout: 10_000 });
  if (await label.evaluate((el) => el.classList.contains("italic"))) {
    await tab(page, paneId).dblclick();
    await expect(label).not.toHaveClass(/italic/, { timeout: 5_000 });
  }
}

/** The zoom is open on the standalone surface. Read off the surface attribute
 *  and never off the scrim NODE: the scrim is mounted unconditionally, so
 *  counting it would answer 1 whatever the state. */
async function zoomed(page: Page): Promise<boolean> {
  return (await surface(page).getAttribute("data-pane-zoom")) !== null;
}

/** The cell keys the surface is currently drawing, in document order. */
async function cellKeys(page: Page): Promise<string[]> {
  return page.$$eval("[data-split-leaf]", (els) =>
    els.map((e) => e.getAttribute("data-split-leaf") ?? ""),
  );
}

/**
 * Which cells are REVEALED and which are collapsed, by geometry.
 *
 * A collapsed cell keeps its node — the mechanism is weights, not shape — so
 * presence proves nothing. What changes is that its flex item drops to
 * `flex: 0 1 0%` and its inner wrapper goes to `display:none`, i.e. the box
 * measures zero on one axis. That is the observable, and it is the same one a
 * human sees.
 */
async function revealedCells(page: Page): Promise<string[]> {
  return page.$$eval("[data-split-leaf]", (els) =>
    els
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      })
      .map((e) => e.getAttribute("data-split-leaf") ?? ""),
  );
}

/** Rounded boxes of every cell, keyed by cell key — the "the grid did not move"
 *  signature used before/after a zoom. */
async function cellBoxes(page: Page): Promise<Record<string, number[]>> {
  return page.$$eval("[data-split-leaf]", (els) => {
    const out: Record<string, number[]> = {};
    for (const e of els) {
      const r = e.getBoundingClientRect();
      out[e.getAttribute("data-split-leaf") ?? ""] = [
        Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height),
      ];
    }
    return out;
  });
}

/** Every mounted pane shell, by id. The residency floor is measured on these. */
async function shellIds(page: Page): Promise<string[]> {
  return page.$$eval("[data-pane-shell]", (els) =>
    els.map((e) => e.getAttribute("data-pane-shell") ?? "").sort(),
  );
}

/**
 * The declared frame width, in pixels.
 *
 * Read off the surface's computed `padding-left` and NOT off the custom
 * property: `--pane-zoom-inset` is unregistered, so `getPropertyValue` hands
 * back the literal `clamp(...)` token stream instead of a number. The padding
 * IS that variable (`padding: var(--pane-zoom-inset)`), resolved by the engine —
 * the same number a click has to aim at.
 */
async function frameInset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector("[data-split-surface]") as HTMLElement;
    return parseFloat(getComputedStyle(el).paddingLeft);
  });
}

// ─── seeding ────────────────────────────────────────────────────────────────

interface SeedOptions {
  /** Every open pane, in the order the tab bars should show them. */
  paneIds: string[];
  /** The cells carved out of the pool. Each inner array is ONE cell, primary
   *  first; the cell key is `solo:<primary>`. Whatever is left of `paneIds`
   *  lands in the `standalone` pool cell. */
  soloCells?: string[][];
  /** `topicId -> browser contextId`, seeded into the window-local spawner map. */
  spawners?: Record<string, string>;
  /**
   * Record what each browser pane SAYS over its stream socket, keyed by context
   * id. The mock swallows the traffic either way; handing it a log is how a case
   * can read the one thing a hidden pane is supposed to say — `set_stream`
   * `false` — without a second `routeWebSocket` whose precedence over this one
   * would be an ordering detail nobody should have to remember.
   */
  wsLog?: Map<string, string[]>;
}

const NON_CHAT_PREFIXES = ["terminal:", "browser:", "project:", "draft:"];
const isChatPaneId = (id: string): boolean =>
  !NON_CHAT_PREFIXES.some((p) => id.startsWith(p)) && !(id.startsWith("__") && id.endsWith("__"));

/** Mirrors `api-fixtures`' own `paneRecordForId`. Kept local because
 *  `openTwoDevices` seeds by hand and needs the same shape. */
function paneRecord(id: string): Record<string, unknown> {
  const openedAt = Date.now();
  if (id.startsWith("browser:")) return { id, type: "browser", title: "Browser", openedAt };
  if (id.startsWith("terminal:")) {
    return { id, type: "terminal", title: "Terminal", terminalSessionId: id.slice("terminal:".length), openedAt };
  }
  return { id, type: "chat", title: "", topicId: id, openedAt };
}

/**
 * Put the grid in a known shape and load the app on it.
 *
 * Three channels have to agree or the client hydrates something else: the
 * AUTHORITATIVE pane store (which tabs exist), the legacy panels endpoint (which
 * the hydrate unions in), and localStorage (the device-local row/cell overlay,
 * which is the ONLY place the split cells live). `gridRows` is left empty on
 * purpose: PanelGrid's read-time self-heal absorbs every missing key into one
 * row, which is exactly the single-row grid these tests want and one less thing
 * to keep in sync with the cell list.
 */
async function seedGrid(page: Page, request: APIRequestContext, opts: SeedOptions): Promise<void> {
  const { paneIds, soloCells = [], spawners = {}, wsLog } = opts;

  await page.routeWebSocket(BROWSER_STREAM_WS, (ws) => {
    // Swallow: no server, no frames. With a log, also transcribe what the pane
    // sends, keyed by the context id in its own URL.
    if (!wsLog) return;
    const ctx = decodeURIComponent(ws.url().split("/ws/browser/")[1] ?? "");
    ws.onMessage((msg) => {
      const bucket = wsLog.get(ctx) ?? [];
      bucket.push(String(msg));
      wsLog.set(ctx, bucket);
    });
  });

  // A chat pane for an ARCHIVED topic is state the UI is required to ignore:
  // the pane is in the store and the tab never appears. Asking for a chat pane
  // IS declaring the topic open.
  await Promise.all(paneIds.filter(isChatPaneId).map((id) => unarchiveTopic(request, id)));

  await seedPaneStore(request, () => ({
    panes: Object.fromEntries(paneIds.map((id) => [id, paneRecord(id)])),
    groups: {
      "group:default": { id: "group:default", paneIds: [...paneIds], splitRatio: 1, splitAxis: "horizontal" },
    },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));

  await Promise.all([
    request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: paneIds }, ignoreHTTPSErrors: true }).catch(() => {}),
    request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: paneIds, pinned: paneIds }, ignoreHTTPSErrors: true }).catch(() => {}),
  ]);

  await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
  await page.evaluate(
    ({ gridKey, spaceKey, spawnerKey, grid, spawnerMap }) => {
      localStorage.removeItem("topics-open-panels");
      localStorage.removeItem("topics-focused-panel");
      sessionStorage.removeItem("topics-open-panels");
      localStorage.setItem(gridKey, JSON.stringify(grid));
      localStorage.setItem(spaceKey, JSON.stringify(grid));
      const browserToTopic: Record<string, string> = {};
      for (const [topicId, ctx] of Object.entries(spawnerMap)) browserToTopic[ctx] = topicId;
      sessionStorage.setItem(spawnerKey, JSON.stringify({ browserToTopic, topicToBrowser: spawnerMap }));
    },
    {
      gridKey: GRID_KEY,
      spaceKey: GRID_KEY_DEFAULT_SPACE,
      spawnerKey: SPAWNER_KEY,
      grid: { gridRows: [], gridRowHeights: [], soloCells },
      spawnerMap: spawners,
    },
  );

  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
  // Counted on the CELL HEADER and not on `[data-split-leaf]`: the split tree —
  // and with it every leaf — is the desktop renderer only, so a poll on leaves
  // never resolves under 768px, which is exactly the layout one of these cases
  // is about. The header is a tab strip on the wide branch and a bare title row
  // on the narrow one, one per cell either way.
  const expectedCells = soloCells.length + (paneIds.length > soloCells.flat().length ? 1 : 0);
  await expect
    .poll(
      () => page.locator('[data-testid="panel-tab-bar"], [data-testid="mobile-pane-title"]').count(),
      { timeout: 15_000 },
    )
    .toBe(expectedCells);
}

/** The cell key a solo cell gets, mirroring `soloCellKey`. */
const solo = (primaryPaneId: string): string => `solo:${primaryPaneId}`;

/**
 * Dismiss the tab context menu WITHOUT spending Escape.
 *
 * Escape is not neutral here: its last branch closes the zoom (LAYOUT-37), so a
 * test that used it to put the menu away would also throw away the state it is
 * measuring — and then read a re-zoom as a failure to exit. A click on the tab
 * itself is outside the menu and does nothing else: that pane is already active.
 */
async function closeTabMenu(page: Page, paneId: string): Promise<void> {
  await tab(page, paneId).click();
  await expect(page.locator('[data-testid="tab-menu-unzoom"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('[data-testid="tab-menu-zoom"]')).toHaveCount(0, { timeout: 5_000 });
}

const zoomEntry = (page: Page) => page.locator('[data-testid="tab-menu-zoom"]');
const zoomCellEntry = (page: Page) => page.locator('[data-testid="tab-menu-zoom-cell"]');
const unzoomEntry = (page: Page) => page.locator('[data-testid="tab-menu-unzoom"]');

// ─── the fixture topics ─────────────────────────────────────────────────────

const STAMP = Date.now();
let t1 = "", t2 = "", t3 = "", t4 = "";
let n1 = "", n2 = "", n3 = "", n4 = "";

test.beforeAll(async ({ request }) => {
  const made = await Promise.all(
    [1, 2, 3, 4].map((i) => createTopic(request, `Zoom-${STAMP}-${i}`)),
  );
  [t1, t2, t3, t4] = made.map((t) => t.id);
  [n1, n2, n3, n4] = made.map((t) => t.name);
});

test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request).catch(() => {});
  for (const id of [t1, t2, t3, t4]) if (id) await deleteTopic(request, id).catch(() => {});
});

/**
 * The workhorse layout: three cells in one row.
 *   standalone = [t1, t4]   solo:t2   solo:t3
 * Two tabs in the pool cell is not decoration — it is what lets a test close the
 * ANCHOR without the cell itself disappearing, which is the only way the "the
 * anchor vanished" exit can be told apart from ordinary pruning.
 */
async function seedThreeCells(page: Page, request: APIRequestContext): Promise<void> {
  await seedGrid(page, request, { paneIds: [t1, t4, t2, t3], soloCells: [[t2], [t3]] });
}

// ════════════════════════════════════════════════════════════════════════════
//  7.1 — the gesture, its layers, its gates and its four ways out
// ════════════════════════════════════════════════════════════════════════════

test.describe("Ingrandire una conversazione", () => {
  test("il doppio clic FISSA un'anteprima e non la ingrandisce; su una tab gia' fissata ingrandisce", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-34" });
    await seedGrid(page, request, { paneIds: [t1, t4, t2], soloCells: [[t2]] });

    // A tab in PREVIEW — and it is the app that says so, not the seed: every
    // chat tab of a freshly loaded window is one (`loadPanelOrder` returns
    // `pinned: []`), which is why the layering matters at all.
    await expect(tabLabel(page, t1)).toHaveClass(/italic/);

    // The double click is spent on pinning it, and nothing is enlarged. The
    // order IS the requirement: the meaning of the gesture does not change, it
    // scales.
    await tab(page, t1).dblclick();
    await expect(tabLabel(page, t1), "il gesto ha fissato la tab").not.toHaveClass(/italic/);
    expect(await zoomed(page), "un'anteprima si fissa e basta").toBe(false);

    // Now it is pinned, and the same gesture zooms.
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);

    // …and repeating it gives the grid back.
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
    expect((await revealedCells(page)).sort()).toEqual(["solo:" + t2, "standalone"]);
  });

  test("su una tab di un'ALTRA cella: prima attiva e spegne il badge, POI ingrandisce", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-34" });
    const ws = await interceptWebSocket(page, APP_WS);
    await seedThreeCells(page, request);

    // t2 has to be PINNED first, or the gesture under test would be spent on
    // pinning it (the layering of LAYOUT-34) and never reach the zoom.
    await pinTab(page, t2);

    // Focus lives in the pool cell; t2 sits in a cell of its own and carries an
    // unread badge, which only shows while its group does NOT have the focus.
    await tab(page, t1).click();
    ws.send({ type: "unread:updated", topicId: t2, unreadCount: 3 });
    const badge = tab(page, t2).locator("[data-notification-count]");
    await expect(badge).toBeVisible({ timeout: 8_000 });

    await tab(page, t2).dblclick();

    // BOTH halves, because a proof that sees one of them is green for the wrong
    // reason: the pane became active (its badge is gone) AND only then did its
    // cell fill the surface.
    await expect(badge).toHaveCount(0, { timeout: 8_000 });
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual([solo(t2)]);
  });

  test("una BOZZA non e' un'anteprima: si marca come toccata, non si ingrandisce, e il testo resta", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-34" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    // ⌘T = a fresh chat, i.e. a draft: opened permanent, so `preview` is false
    // and without an explicit rule it would fall straight into the zoom branch.
    await page.keyboard.press("Meta+t");
    const draftTab = page.locator('[data-testid="panel-tab-bar"]').first().getByText(/^New Chat$/);
    await expect(draftTab).toHaveCount(1, { timeout: 10_000 });
    const composer = page.getByRole("textbox", { name: /Campo del messaggio per New Chat|Message input for New Chat/ });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("una bozza che non deve sparire");

    await draftTab.first().dblclick();

    expect(await zoomed(page), "una bozza non e' ingrandibile").toBe(false);
    await expect(composer).toHaveValue("una bozza che non deve sparire");
  });

  test("il set porta con se' la browser della conversazione", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-36" });
    const browserPane = `browser:${t1}`;
    await seedGrid(page, request, {
      paneIds: [t1, browserPane, t2],
      soloCells: [[browserPane], [t2]],
    });

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    // The chat's cell AND the cell holding the browser that carries its context;
    // everything else goes. Zooming the chat's cell alone would leave out
    // exactly the half the agent just produced.
    expect((await revealedCells(page)).sort()).toEqual([solo(browserPane), "standalone"].sort());
  });

  test("una tab che nasce per la conversazione entra da sola, e lo zoom non si chiude", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-36" });
    await seedGrid(page, request, { paneIds: [t1, t2], soloCells: [[t2]] });

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);

    // The canonical "the agent opened a browser for this chat" funnel — the very
    // event ChatPane fires for `/browser <url>`. The pane it opens carries the
    // topic's context, so it belongs to the set and the set is recomputed on
    // every render: it must walk in instead of closing the zoom.
    await page.evaluate((tid) => {
      window.dispatchEvent(new CustomEvent("browser:open-and-navigate", {
        detail: { topicId: tid, url: "https://example.com" },
      }));
    }, t1);

    await expect(tab(page, `browser:${t1}`).first()).toBeVisible({ timeout: 15_000 });
    // AS BUILT TODAY THIS IS RED, on a real defect, and it is left red on
    // purpose. The new browser lands in a cell of its OWN (`solo:browser:<id>`
    // appears in the grid, measured), and the auto-split that puts it there
    // goes through `handleSplitPane` — which D8 made call `exitZoom()` before
    // it applies. So the blanket "any command that REORGANISES leaves the zoom"
    // fires on the very event LAYOUT-36 says must walk INTO the zoom, and the
    // two rules cancel each other exactly in the layout this feature exists
    // for: a chat plus the browser its agent just opened.
    expect(await zoomed(page), "una tab della conversazione non chiude lo zoom").toBe(true);
    // Wherever it landed, it is on screen: a pane is never born inside a
    // collapsed cell.
    await expect(tab(page, `browser:${t1}`).first()).toBeVisible();
  });

  test("una pane nuova che nasce DENTRO la cella ingrandita non chiude lo zoom, ed e' visibile", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-36" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);

    // ⌘T opens a draft, and a draft is born in the FOCUSED cell — which while
    // zoomed is the enlarged one. LAYOUT-36 measures the CELL the new pane lands
    // in and never its membership of the set: a draft belongs to no set at all,
    // and it is still already on screen, so leaving would throw away the revealed
    // layout with nobody gaining anything.
    await page.keyboard.press("Meta+t");
    const draftTab = page.locator('[data-testid="panel-tab-bar"]').getByText(/^New Chat$/);
    await expect(draftTab).toHaveCount(1, { timeout: 10_000 });

    // THE POINT, and it is two claims, because either one alone can be true for
    // the wrong reason: the zoom is still open, AND the draft is on screen. A
    // zoom that survived while the draft sat inside a collapsed cell would be
    // the very failure «una pane NUOVA non SHALL mai nascere invisibile» names.
    // `toBeVisible` is the measure of that: a tab in a collapsed cell has a zero
    // box.
    await expect(draftTab).toBeVisible();
    // The negative gets a real anchor instead of a stopwatch: the draft is a
    // write to the pane store, so waiting for the server's own sequence to
    // settle puts this read strictly AFTER every effect that write can trigger.
    await waitForPaneStoreQuiet(request);
    expect(await zoomed(page), "una pane nata nella cella ingrandita non fa uscire").toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);
  });

  test("una pane nuova che atterrerebbe in una cella collassata fa uscire dallo zoom", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-36" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);

    // The same funnel the case above this describe uses to prove a tab WALKS IN,
    // pointed at another conversation: the browser carries t2's context, so it
    // belongs to t2's set and not to the anchored one, and the auto-split gives
    // it a cell of its own — a cell that, with the zoom open, is collapsed.
    // Two of the four exits agree here (the pane is born outside the revealed
    // set, and the focus follows it out), and the case measures neither: what
    // LAYOUT-36 names is the OUTCOME, which is that the pane is never left
    // inside a collapsed cell.
    await page.evaluate((tid) => {
      window.dispatchEvent(new CustomEvent("browser:open-and-navigate", {
        detail: { topicId: tid, url: "https://example.com" },
      }));
    }, t2);

    const born = tab(page, `browser:${t2}`).first();
    await expect(born).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
    // …and the grid it comes back to is whole, with the new cell in it: an exit
    // that left the surface showing one cell would satisfy the line above and
    // still hide the pane.
    expect((await revealedCells(page)).length).toBeGreaterThanOrEqual(3);
    await expect(born).toBeVisible();
  });

  test("il clic sulla cornice chiude lo zoom e NON raggiunge la griglia sotto", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });
    await seedThreeCells(page, request);

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    // The point is DERIVED from the declared measure, never picked by eye: half
    // the band, half the height. With a hand-picked coordinate the first
    // adjustment to the inset turns this red for no reason.
    const inset = await frameInset(page);
    expect(inset, "la cornice non scende mai sotto i 20px dichiarati").toBeGreaterThanOrEqual(20);
    const box = (await surface(page).boundingBox())!;
    const point = { x: inset / 2, y: box.height / 2 };

    // Who answers there: the veil, and nothing of the grid. This is the half
    // that says the click cannot reach a cell — asserted BEFORE spending it,
    // because after the click the zoom is gone and the frame with it.
    const hit = await page.evaluate(({ x, y }) => {
      const s = document.querySelector("[data-split-surface]") as HTMLElement;
      const r = s.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + x, r.y + y);
      return {
        scrim: !!el?.closest(".pane-zoom-scrim"),
        insideACell: !!el?.closest("[data-split-leaf]"),
      };
    }, point);
    expect(hit.scrim, "sulla banda risponde il velo").toBe(true);
    expect(hit.insideACell, "il clic sulla cornice non raggiunge nessuna cella").toBe(false);

    await surface(page).click({ position: point });
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
  });

  test("Escape resta dell'agente: con un turno in streaming interrompe il turno e lo zoom resta", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    // Hold POST /api/chat open so the turn stays `partial` and the indicator
    // stays up long enough to work on — the same device escape-modal-guard uses.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 30_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await pinTab(page, t1);
    await tab(page, t1).click();
    const composer = page.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }).first();
    await composer.click();
    await composer.fill("scrivi qualcosa di lungo");
    await composer.press("Enter");
    const streaming = page.locator('[data-testid="chat-streaming-indicator"]');
    await expect(streaming).toBeVisible({ timeout: 15_000 });

    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    await page.keyboard.press("Escape");

    // The turn dies, the zoom lives: whoever enlarges a chat does it to WATCH
    // the agent work, and taking away the key that stops it is the opposite of
    // the point. Three other ways out stay, all one click away.
    await expect(streaming).toBeHidden({ timeout: 10_000 });
    expect(await zoomed(page), "lo zoom resta aperto").toBe(true);
  });

  test("Escape senza turno vivo chiude lo zoom", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    await page.keyboard.press("Escape");
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
  });

  test("con la tavolozza aperta Escape chiude la tavolozza e lo zoom resta", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    await page.keyboard.press("Meta+Shift+p");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0, { timeout: 5_000 });
    expect(await zoomed(page), "un modale sopra lo zoom ha la precedenza, e basta").toBe(true);
  });

  test("sotto i 768px il comando non esiste in nessuno dei suoi inneschi, e il doppio clic fa quello che fa oggi", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-34" });
    await page.setViewportSize({ width: 600, height: 800 });
    await seedGrid(page, request, { paneIds: [t1, t2], soloCells: [[t2]] });

    // WHAT THE NARROW BRANCH ACTUALLY LOOKS LIKE, because it decides what can
    // even be asserted: under the column threshold the cell header is a bare
    // TITLE ROW, not a tab strip (`StandaloneChatGroup`, the `mobile` branch),
    // so there is no linguetta on screen at all. That is the strongest possible
    // form of "the command does not exist in any of its triggers" — the two
    // gestures that hang off a tab have nowhere to land — and it is also why
    // the double click cannot be exercised here: there is nothing to click.
    await expect(page.locator('[data-testid="mobile-pane-title"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="panel-tab-bar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="pane-tab-"]')).toHaveCount(0);

    // Guard against an empty green: the grid is really there, with both its
    // cells, and the split renderer really is off.
    await expect(page.locator("[data-split-leaf]")).toHaveCount(0);
    await expect(page.locator("[data-split-surface]")).toHaveCount(1);

    // ⌘E / ⌥⌘E: nothing is enlarged, and no frame appears.
    await page.keyboard.press("Meta+e");
    await page.keyboard.press("Meta+Alt+e");
    expect(await zoomed(page), "sotto i 768px la chord non ingrandisce niente").toBe(false);
    await expect(page.locator("[data-split-surface][data-pane-zoom]")).toHaveCount(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  7.2 — the modifier, the degradation, and the single way out (LAYOUT-40)
// ════════════════════════════════════════════════════════════════════════════

test.describe("Ingrandimento della sola cella", () => {
  test("⌥ + doppio clic lascia viva la SOLA cella della chat, e la voce di menu fa la stessa cosa", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-40" });
    const browserPane = `browser:${t1}`;
    await seedGrid(page, request, {
      paneIds: [t1, browserPane, t2],
      soloCells: [[browserPane], [t2]],
    });

    await pinTab(page, t1);

    // Without the modifier the browser comes along (LAYOUT-36); with it, it goes
    // with the others. Choosing WHICH conversation to isolate is not the same as
    // choosing HOW MUCH of it.
    await tab(page, t1).dblclick({ modifiers: ["Alt"] });
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);

    // Repeating the gesture WITHOUT the modifier still reduces: every trigger
    // reduces while the zoom is open, whatever scope it carries.
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);

    // The menu twin, same outcome.
    await tab(page, t1).click({ button: "right" });
    await expect(zoomCellEntry(page)).toBeVisible({ timeout: 5_000 });
    await zoomCellEntry(page).click();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);
  });

  test("quando il set copre gia' tutte le celle vive il gesto DEGRADA invece di essere un no-op muto", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-40" });
    // The worst case, i.e. the case the feature exists for: the conversation's
    // own panes fill EVERY live cell, so the derived set covers the whole
    // surface. Two browsers of the same chat: one carries the topic's own
    // context, the other comes from the window-local spawner registry.
    const ownBrowser = `browser:${t1}`;
    const spawnedCtx = `zoomspawn-${STAMP}`;
    const spawnedBrowser = `browser:${spawnedCtx}`;
    await seedGrid(page, request, {
      paneIds: [t1, ownBrowser, spawnedBrowser],
      soloCells: [[ownBrowser], [spawnedBrowser]],
      spawners: { [t1]: spawnedCtx },
    });
    await pinTab(page, t1);

    // BOTH entries are on offer, and that is the assertion: dropping one exactly
    // here would put the content of the menu back at the mercy of the derived
    // set, the one collection nobody can see on screen.
    await tab(page, t1).click({ button: "right" });
    await expect(zoomEntry(page)).toBeVisible({ timeout: 5_000 });
    await expect(zoomCellEntry(page)).toBeVisible();
    await page.keyboard.press("Escape");

    // The plain double click: it used to be a silent no-op here. Now it leaves
    // the anchor's cell alone on screen.
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual(["standalone"]);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
  });

  test("il comando resta assente SOLO quando esiste una cella viva sola", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-34" });
    // Without this the case above is green for the wrong reason: "the command
    // appeared" proves nothing if it appears everywhere.
    await seedGrid(page, request, { paneIds: [t1, t4] });
    expect(await cellKeys(page)).toEqual(["standalone"]);

    await tab(page, t1).click({ button: "right" });
    await expect(page.getByText("Chiudi le altre", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(zoomEntry(page)).toHaveCount(0);
    await expect(zoomCellEntry(page)).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The first gesture is spent on the layer below (pinning the preview); the
    // ones after it land on a pinned tab, where the zoom would fire if it were
    // on offer.
    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    expect(await zoomed(page)).toBe(false);
    await tab(page, t1).dblclick({ modifiers: ["Alt"] });
    expect(await zoomed(page)).toBe(false);
  });

  test("si esce allo stesso modo nei due ambiti, e in DOM non esiste nessuna modalita' da distinguere", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-40" });
    const browserPane = `browser:${t1}`;
    await seedGrid(page, request, {
      paneIds: [t1, browserPane, t2],
      soloCells: [[browserPane], [t2]],
    });
    await page.keyboard.press("Escape");
    await pinTab(page, t1);
    const rest = await cellBoxes(page);

    // The attribute the surface publishes is the SAME string in both scopes:
    // there is one zoom state with a different set of cells, not two modes.
    const marks: string[] = [];
    for (const modifiers of [[] as "Alt"[], ["Alt"] as "Alt"[]]) {
      await tab(page, t1).dblclick({ modifiers });
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
      marks.push((await surface(page).getAttribute("data-pane-zoom"))!);

      // …and while it is open the menu offers the single reduce entry, whatever
      // scope is stored.
      await tab(page, t1).click({ button: "right" });
      await expect(unzoomEntry(page)).toBeVisible({ timeout: 5_000 });
      await expect(zoomEntry(page)).toHaveCount(0);
      await expect(zoomCellEntry(page)).toHaveCount(0);
      await closeTabMenu(page, t1);
      expect(await zoomed(page), "chiudere il menu non ha toccato lo zoom").toBe(true);

      await tab(page, t1).dblclick({ modifiers });
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
      expect(await cellBoxes(page)).toEqual(rest);
    }
    expect(marks[0], "nessun attributo distingue i due ambiti").toBe(marks[1]);

    // The frame, in both scopes.
    for (const modifiers of [[] as "Alt"[], ["Alt"] as "Alt"[]]) {
      await tab(page, t1).dblclick({ modifiers });
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
      const inset = await frameInset(page);
      const box = (await surface(page).boundingBox())!;
      await surface(page).click({ position: { x: inset / 2, y: box.height / 2 } });
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
      expect(await cellBoxes(page)).toEqual(rest);
    }

    // Escape, in both scopes.
    for (const modifiers of [[] as "Alt"[], ["Alt"] as "Alt"[]]) {
      await tab(page, t1).dblclick({ modifiers });
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
      expect(await cellBoxes(page)).toEqual(rest);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  7.3 — the structural proof: entering and leaving remounts NOTHING
// ════════════════════════════════════════════════════════════════════════════

test.describe("Entrare e uscire non rimonta niente", () => {
  test("foglie, gusci e divisori identici prima e dopo, e la bozza e' ancora nel campo", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    // A draft with text in it, in a cell that will be COLLAPSED: the state that
    // a remount would take away, in the place a remount would hit first. It is
    // born where the focus is, so the focus goes to the POOL cell first and the
    // anchor is t2 — that way the pool is the cell that collapses.
    await tab(page, t1).click();
    await page.keyboard.press("Meta+t");
    const composer = page.getByRole("textbox", { name: /Campo del messaggio per New Chat|Message input for New Chat/ });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("marcatore della bozza");
    await pinTab(page, t2);

    const leavesBefore = await cellKeys(page);
    const shellsBefore = await shellIds(page);
    const colsBefore = await countColDividers(page);
    const rowsBefore = await countRowDividers(page);
    const boxesBefore = await cellBoxes(page);

    await tab(page, t2).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    // Non-vacuous: something really did collapse.
    expect(await revealedCells(page)).toEqual([solo(t2)]);

    await tab(page, t2).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);

    expect(await cellKeys(page), "l'elenco delle foglie e' identico").toEqual(leavesBefore);
    expect(await shellIds(page), "l'elenco dei gusci di pane e' identico").toEqual(shellsBefore);
    expect(await countColDividers(page)).toBe(colsBefore);
    expect(await countRowDividers(page)).toBe(rowsBefore);
    expect(await cellBoxes(page)).toEqual(boxesBefore);

    const draftTab = page.locator('[data-testid="panel-tab-bar"]').first().getByText(/^New Chat$/);
    await draftTab.first().click();
    await expect(composer).toHaveValue("marcatore della bozza");
  });

  test("un marcatore scritto in un terminale di una cella collassata e' ancora leggibile dopo", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });
    // The other half of "nothing remounts", and the one with teeth: a chat draft
    // lives in React state, a PTY does not. A terminal that were remounted would
    // come back with a fresh shell and an empty screen, and the marker is how
    // that shows.
    const session = await createTerminalSession(request, { cwd: "/tmp", name: `zoom-${Date.now()}` });
    const termPane = `terminal:${session.id}`;
    try {
      await seedGrid(page, request, { paneIds: [t1, termPane], soloCells: [[termPane]] });

      const marker = `ZOOMMARK-${Date.now()}`;
      const rows = page.locator(".xterm-rows:visible").first();
      await expect(rows).toBeVisible({ timeout: 20_000 });
      await page.locator(".xterm-screen:visible").first().click();
      await page.keyboard.type(`echo ${marker}\n`);
      await expect(rows).toContainText(marker, { timeout: 20_000 });

      const shellBefore = await shellIds(page);

      await pinTab(page, t1);
      await tab(page, t1).dblclick();
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
      // Guard against an empty green: the terminal's cell really did collapse.
      expect(await revealedCells(page)).toEqual(["standalone"]);

      await tab(page, t1).dblclick();
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);

      expect(await shellIds(page), "nessun guscio di pane e' stato rimontato").toEqual(shellBefore);
      await expect(page.locator(".xterm-rows:visible").first()).toContainText(marker, { timeout: 20_000 });
    } finally {
      await deleteTerminalSession(request, session.id).catch(() => {});
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  7.4 — residency: a collapsed cell keeps its ACTIVE tab mounted, and a cell
//        without a box says so all the way down to the pane (LAYOUT-39). The
//        second case is the one task 4.1 asks for: the same requirement on the
//        narrow branch, where the cell is collapsed by the 768px fold and not by
//        the zoom.
// ════════════════════════════════════════════════════════════════════════════

test.describe("Residenza sotto zoom", () => {
  // Eighteen chats get mounted one by one and then the residency reaper has to
  // run: that is real wall clock the default 30 s cannot hold.
  test.describe.configure({ timeout: 180_000 });

  test("la tab ATTIVA di ogni cella collassata resta montata quando il tetto morde", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-39" });
    // Three cells, six tabs each: more than the light budget (12 extra slots)
    // of background panes, so the cap really bites. An aggregate count on a
    // single-cell seed would be identical with and without zoom and would prove
    // nothing — this asserts per ID.
    const stamp = Date.now();
    const made = await Promise.all(
      Array.from({ length: 18 }, (_, i) => createTopic(request, `ZoomRes-${stamp}-${i}`)),
    );
    const ids = made.map((t) => t.id);
    try {
      const poolIds = ids.slice(0, 6);
      const cellA = ids.slice(6, 12);
      const cellB = ids.slice(12, 18);
      await seedGrid(page, request, {
        paneIds: [...poolIds, ...cellA, ...cellB],
        soloCells: [cellA, cellB],
      });

      // Mount every pane: a pane never visited is never mounted, so without the
      // walk there is nothing for the cap to evict and the test would measure
      // its own patience.
      for (const id of ids) {
        await tab(page, id).click({ timeout: 15_000 });
        await expect(page.locator(`[data-pane-shell="${id}"][data-pane-visible="1"]`)).toBeAttached({ timeout: 15_000 });
      }

      // The tab each collapsed cell will be left showing.
      const activeA = cellA[cellA.length - 1];
      const activeB = cellB[cellB.length - 1];
      await tab(page, activeA).click();
      await tab(page, activeB).click();
      await tab(page, poolIds[0]).click();
      await pinTab(page, poolIds[0]);

      await tab(page, poolIds[0]).dblclick();
      await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
      expect(await revealedCells(page)).toEqual(["standalone"]);

      // WAIT FOR THE CAP, NOT FOR THE CLOCK. "Ten seconds of zoom" is really
      // "long enough that the reaper has decided": the honest condition is that
      // it evicted something. That is also strictly stronger — a run where
      // nothing was ever evicted would prove nothing about a floor.
      await expect
        .poll(() => shellIds(page).then((s) => s.length), { timeout: 60_000, intervals: [500, 1000, 1000, 2000] })
        .toBeLessThan(ids.length);

      // THE POINT: the active tab of each collapsed cell is still mounted. Per
      // id, because an aggregate count cannot tell a survivor from a stand-in.
      await expect(page.locator(`[data-pane-shell="${activeA}"]`)).toBeAttached();
      await expect(page.locator(`[data-pane-shell="${activeB}"]`)).toBeAttached();
      await expect(page.locator(`[data-pane-shell="${poolIds[0]}"]`)).toBeAttached();
    } finally {
      for (const id of ids) await deleteTopic(request, id).catch(() => {});
    }
  });

  test("sotto i 768px la cella nascosta propaga l'assenza di box fino alla pane, e la cella visibile no", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-39" });
    // WHY THIS CASE IS NOT AN ASSERTION ABOUT `[data-pane-shell]`, which is what
    // the task asked for. Three independent facts of the code make "the shell
    // DETACHES" unreachable for a browser pane, and any one of them alone would
    // be enough:
    //   1. `RESIDENCY_BUDGET.native` is `Infinity` (`state/pane/residency/
    //      policy.ts`): a browser pane is never evicted by the cap, floor or no
    //      floor. Measured with this exact seed — the cap bit and evicted four
    //      chats while BOTH browser shells stayed attached.
    //   2. Every surface renders its active pane unconditionally
    //      (`isResidentPane(p) || p.id === activePaneId`, StandaloneChatGroup and
    //      GroupLayout alike), so the pane whose floor status this fix flips is
    //      exactly the one that stays mounted regardless.
    //   3. For a pane sitting DIRECTLY in the cell, `hasBox` never reaches
    //      `visibleKeys` at all: `StandaloneChatGroup` computes that list from
    //      `usePaneAlive()`, i.e. the context ABOVE the cell, and `PanelGrid`
    //      lowers `hasBox` as a prop. The floor it removes is a NESTED surface's.
    // What IS observable in Chromium, per id and discriminating, is the other
    // THEN of the scenario — that the collapsed cell propagates the absence of
    // box DOWN TO THE PANE. A browser pane answers that in its own words: with
    // `paneAlive` false it stops being a viewer and says so on its stream socket
    // (`set_stream` / `set_watching` false, RemoteBrowserPanel → useRemoteBrowser).
    // Without the propagation the pane is the ACTIVE tab of its cell, so
    // `isVisibleProp` is true, and nothing would ever be sent — which is the
    // defect this task closes, stated as something a test can read.
    const stamp = Date.now();
    const made = await Promise.all(
      Array.from({ length: 18 }, (_, i) => createTopic(request, `ZoomMob-${stamp}-${i}`)),
    );
    const ids = made.map((t) => t.id);
    // The context id IS the pane id minus its prefix, so the socket URL names it.
    const visCtx = ids[0];
    const hidCtx = ids[1];
    const bVisible = `browser:${visCtx}`;
    const bHidden = `browser:${hidCtx}`;
    const wsLog = new Map<string, string[]>();
    const said = (ctx: string, from: number): string[] => (wsLog.get(ctx) ?? []).slice(from);
    const STOPPED = '"type":"set_stream","active":false';
    try {
      // The seed of 7.4 — three cells, six tabs each, more background panes than
      // the light budget — so the cap really bites here too, plus one browser as
      // the ACTIVE tab of a cell that will be hidden and one as the active tab of
      // the cell that will stay. The second is not decoration: without it the
      // case would be green on a run that switched EVERYTHING off.
      const pool = [...ids.slice(0, 6), bVisible];
      const cellA = [...ids.slice(6, 12), bHidden];
      const cellB = ids.slice(12, 18);
      await seedGrid(page, request, {
        paneIds: [...pool, ...cellA, ...cellB],
        soloCells: [cellA, cellB],
        wsLog,
      });

      // Mount every pane: one never visited is never mounted, so without the walk
      // there is nothing for the cap to evict and no socket for either browser.
      for (const id of [...ids, bVisible, bHidden]) {
        await tab(page, id).first().click({ timeout: 15_000 });
        await expect(page.locator(`[data-pane-shell="${id}"][data-pane-visible="1"]`)).toBeAttached({ timeout: 15_000 });
      }
      // Leave each browser the ACTIVE tab of its own cell, and the focus on the
      // one in the pool — `mobileVisibleKey` follows the focus, so this is what
      // decides which cell survives the fold.
      await tab(page, bHidden).first().click();
      await tab(page, bVisible).first().click();

      // Both are on a wide screen and on screen. Read the cursor of each log
      // instead of asserting the logs are empty: what the walk said on the way
      // here is not this case's business, only what the FOLD makes them say.
      const visFrom = (wsLog.get(visCtx) ?? []).length;
      const hidFrom = (wsLog.get(hidCtx) ?? []).length;

      await page.setViewportSize({ width: 375, height: 812 });
      // The narrow branch really took over: one cell with a box, the others at
      // zero. Without this the assertions below could be true of a layout that
      // never folded.
      await expect
        .poll(
          () => page.$$eval("[data-panel-cell]", (els) =>
            els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; }).length,
          ),
          { timeout: 15_000 },
        )
        .toBe(1);

      // THE POINT. The pane in the cell without a box stops being a viewer…
      await expect
        .poll(() => said(hidCtx, hidFrom).some((m) => m.includes(STOPPED)), { timeout: 15_000 })
        .toBe(true);
      // …and the one in the cell that kept its box does not. Read AFTER the poll
      // above, so the negative has a real event behind it and not a stopwatch.
      expect(
        said(visCtx, visFrom).filter((m) => m.includes(STOPPED)),
        "la pane della cella VISIBILE non smette di guardare",
      ).toEqual([]);

      // And the residency half, in the only shape the code can answer: the cap
      // bit — otherwise nothing here would be about residency at all — and the
      // two native panes are still mounted through it, which is fact 1 above
      // measured rather than asserted from the policy file.
      await expect
        .poll(() => shellIds(page).then((s) => s.length), { timeout: 60_000, intervals: [500, 1000, 1000, 2000] })
        .toBeLessThan(ids.length + 2);
      const shells = await shellIds(page);
      expect(shells, "una pane browser non si sfratta: il tetto `native` e' Infinity").toContain(bHidden);
      expect(shells).toContain(bVisible);
    } finally {
      for (const id of ids) await deleteTopic(request, id).catch(() => {});
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  7.8 — the four LAYOUT-35 scenarios no other case here touches
// ════════════════════════════════════════════════════════════════════════════

test.describe("La cornice e la griglia sotto", () => {
  test("le celle collassate escono dal percorso di tabulazione", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    const revealed = await revealedCells(page);
    expect(revealed).toEqual(["standalone"]);

    // Walk the tab order from the very top of the document and ask, at every
    // stop, WHICH cell the focus is in.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const visits: (string | null)[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      visits.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return null;
          const cell = el.closest("[data-split-leaf]");
          return cell ? cell.getAttribute("data-split-leaf") : null;
        }),
      );
    }

    const inACell = visits.filter((v): v is string => v !== null);
    // THE GUARD AGAINST AN EMPTY GREEN, and here it is the likeliest failure
    // mode by far: "nobody outside" is trivially true of a walk that never
    // entered the grid at all.
    expect(
      inACell.filter((v) => v === "standalone").length,
      "almeno un fuoco deve atterrare DENTRO la cella ingrandita",
    ).toBeGreaterThan(0);
    expect(
      inACell.filter((v) => v !== "standalone"),
      "nessun fuoco deve atterrare in una cella fuori dallo zoom",
    ).toEqual([]);
  });

  test("chi ha chiesto meno movimento: la sola opacita' e' animata, e per lui nemmeno quella", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });

    // THE TRAP THIS CASE IS BUILT AROUND. The whole suite already runs with
    // `contextOptions: { reducedMotion: "reduce" }`, so a case that asserted a
    // duration of zero would be green even if the transition had never existed.
    // The two contexts are opened by hand — `contextOptions` is ONE fixture, and
    // a `test.use` REPLACES it instead of adding a key — exactly as
    // reduced-motion-chrome-controls.spec.ts does.
    async function misura(mode: "reduce" | "no-preference") {
      const ctx = await browser.newContext({
        baseURL: BASE,
        viewport: { width: 1280, height: 800 },
        locale: "it-IT",
        reducedMotion: mode,
      });
      try {
        const page = await ctx.newPage();
        await seedGrid(page, ctx.request, { paneIds: [t1, t2], soloCells: [[t2]] });
        await page.keyboard.press("Escape");
        await pinTab(page, t1);
        await tab(page, t1).dblclick();
        await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
        return page.evaluate(() => {
          const el = document.querySelector(".pane-zoom-scrim") as HTMLElement;
          const cs = getComputedStyle(el);
          const props = cs.transitionProperty.split(",").map((s) => s.trim());
          const durations = cs.transitionDuration.split(",").map((s) => parseFloat(s) || 0);
          return {
            reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
            props,
            durations,
            // The properties that actually MOVE: a longhand with a zero
            // duration animates nothing, whatever its name.
            animated: props.filter((_, i) => (durations[i] ?? durations[0] ?? 0) > 0),
          };
        });
      } finally {
        await ctx.close();
      }
    }

    const plain = await misura("no-preference");
    expect(plain.reduce, "il contesto deve davvero essere in no-preference").toBe(false);
    // 120ms, and on OPACITY: no geometry is animated, here or anywhere.
    expect(plain.props).toEqual(["opacity"]);
    expect(plain.durations[0]).toBeCloseTo(0.12, 3);
    expect(plain.animated).toEqual(["opacity"]);

    const ridotto = await misura("reduce");
    expect(ridotto.reduce, "il contesto deve davvero essere in reduce").toBe(true);
    // Nothing travels. NB the rule is written `transition: none`, and that
    // shorthand resets `transition-property` to its initial `all` — so the
    // honest assertion is on what MOVES (nothing), not on the property name.
    expect(ridotto.durations.every((d) => d === 0), "nessuna transizione dura piu' di zero").toBe(true);
    expect(ridotto.animated, "per chi ha chiesto meno movimento non si muove niente").toEqual([]);
  });

  test("il comando che riapre la colonna resta dentro la cornice, e la cella ingrandita non riserva le pastiglie", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    // Close the column, using the command that lives in the top-left cell. It
    // SLIDES OUT — a `fixed` element pushed off by a transform — so it never
    // goes `hidden`, and the `data-open` attribute belongs to the MOBILE scrim,
    // not to the column. What the column does publish is its geometry.
    await page.locator('[data-testid="sidebar-reopen"]').first().click();
    await expect
      .poll(() => page.locator("[data-sidebar]").boundingBox().then((b) => Math.round(b?.x ?? 0)), { timeout: 5_000 })
      .toBeLessThan(0);

    // Zoom a cell that is NOT (0,0): that is precisely when a command bolted to
    // the top-left cell would go off screen with the column still closed.
    await pinTab(page, t3);
    await tab(page, t3).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect(await revealedCells(page)).toEqual([solo(t3)]);

    const reopen = page.locator('[data-testid="pane-zoom-sidebar-toggle"]');
    await expect(reopen, "il comando vive dentro la cornice").toBeVisible({ timeout: 5_000 });

    // It falls inside the TOP BAND, i.e. above the stage's top edge, with the
    // measure read from the declared inset instead of guessed.
    const box = await page.evaluate(() => {
      const s = document.querySelector("[data-split-surface]") as HTMLElement;
      const stage = document.querySelector(".pane-zoom-stage") as HTMLElement;
      const cmd = document.querySelector('[data-testid="pane-zoom-sidebar-toggle"]') as HTMLElement;
      const r = (e: HTMLElement) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
      return { surface: r(s), stage: r(stage), cmd: r(cmd), bandTop: parseFloat(getComputedStyle(s).paddingTop) };
    });
    expect(box.bandTop).toBeGreaterThanOrEqual(20);
    expect(box.cmd.top).toBeGreaterThanOrEqual(box.surface.top - 0.5);
    expect(box.cmd.bottom, "il comando sta sopra il bordo alto dello stage").toBeLessThanOrEqual(box.stage.top + 0.5);

    // And the enlarged cell reserves NOTHING for the native lights: it is not
    // flush to the window, the lights sit over the frame (design D6).
    const reserved = await page.evaluate((key) => {
      const cell = document.querySelector(`[data-split-leaf="${key}"]`) as HTMLElement;
      return !!cell.querySelector(".content-chrome-inset");
    }, solo(t3));
    expect(reserved, "la cella ingrandita non riserva lo spazio delle pastiglie").toBe(false);
  });

  test("i divisori non sono maniglie: trascinarne uno a zoom attivo non muove la geometria", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });
    const browserPane = `browser:${t1}`;
    // TWO surviving cells on purpose: a divider only appears between two
    // siblings of positive weight, so with a single survivor there would be no
    // target to drag and the case would be green for lack of a subject.
    await seedGrid(page, request, {
      paneIds: [t1, browserPane, t2],
      soloCells: [[browserPane], [t2]],
    });
    await page.keyboard.press("Escape");
    await pinTab(page, t1);
    const restingBoxes = await cellBoxes(page);
    const cellsBefore = (await cellKeys(page)).length;

    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    expect((await revealedCells(page)).sort()).toEqual([solo(browserPane), "standalone"].sort());

    // The divider is still IN the DOM with its axis — the change removes the
    // handlers, not the node — so the proof is a drag that moves nothing, never
    // a count of dividers.
    //
    // AS BUILT TODAY THIS IS RED, on a real defect, and it is left red on
    // purpose. `PanelGrid` stops passing `onResize` while zoomed, which kills
    // the COMMIT — no weight is ever written to the persisted layout — but
    // `SplitTree`'s `Divider` moves the cells IMPERATIVELY during the drag
    // (`prevEl.style.flex = ...`, SplitTree.tsx) and nothing re-renders those
    // nodes afterwards to put the weights back. Measured: the surviving cells
    // go 320/320 → 499/140 and STAY there, with the zoom still open. What
    // LAYOUT-35 asks for is "la geometria NON SHALL cambiare", and today it
    // changes and sticks.
    const divider = page.locator('[role="main"] [data-resize-axis="col"]').first();
    await expect(divider).toBeVisible({ timeout: 5_000 });
    const zoomedBoxes = await cellBoxes(page);
    const db = (await divider.boundingBox())!;
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
    await page.mouse.down();
    await page.mouse.move(db.x + db.width / 2 + 180, db.y + db.height / 2, { steps: 12 });
    await page.mouse.up();
    // Polled, not read once: if the weights snapped back on the next render this
    // would still pass, so a red here means the geometry really stayed moved.
    await expect
      .poll(() => cellBoxes(page), { timeout: 3_000 })
      .toEqual(zoomedBoxes);

    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
    expect(await cellBoxes(page), "uscendo, la griglia e' quella di prima").toEqual(restingBoxes);
  });

  test("ogni comando che RIORGANIZZA la griglia esce dallo zoom PRIMA di applicarsi", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-35" });
    // Split out of the divider case on purpose: that one is red on a real
    // defect (see its comment), and left in the same test it would take the
    // four exits below down with it — four scenarios written, zero verdicts,
    // which is the exact blindness 7.8 exists to close.
    const browserPane = `browser:${t1}`;
    await seedGrid(page, request, {
      paneIds: [t1, browserPane, t2],
      soloCells: [[browserPane], [t2]],
    });
    await page.keyboard.press("Escape");
    await pinTab(page, t1);
    const cellsBefore = (await cellKeys(page)).length;

    // ── «Dividi a destra»: esce, e si applica alla griglia INTERA ──────────
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    await tab(page, t1).click({ button: "right" });
    const splitRight = page.getByText("Dividi a destra", { exact: true });
    await expect(splitRight).toBeVisible({ timeout: 5_000 });
    await splitRight.click();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
    // Without this second half the case would be green with the command applied
    // INSIDE a collapsed cell, which is the very failure the rule exists for.
    await expect.poll(() => cellKeys(page).then((k) => k.length), { timeout: 10_000 }).toBe(cellsBefore + 1);
    expect((await revealedCells(page)).length, "la cella nuova e' visibile").toBe(cellsBefore + 1);

    // ── «Disponi» ─────────────────────────────────────────────────────────
    // RE-PINNED between sections, and it is not ceremony: each cell owns its own
    // pinned set (`usePaneOrdering`, seeded from `loadPanelOrder()` = empty), so
    // a tab that lands in a NEW cell after a split is a preview again — and the
    // first double click there would be spent on the layer below.
    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:auto-tile-layout")));
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
    expect((await revealedCells(page)).length, "la disposizione tocca tutta la griglia").toBeGreaterThan(1);

    // ── «Reimposta pannelli» ──────────────────────────────────────────────
    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:reset-split-layout")));
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => cellKeys(page), { timeout: 10_000 }).toEqual(["standalone"]);

    // ── l'avvio di un trascinamento di tab ────────────────────────────────
    await seedGrid(page, request, { paneIds: [t1, t4, t2], soloCells: [[t2]] });
    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await tab(page, t1).dispatchEvent("dragstart", { dataTransfer: dt });
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  7.9 — the five LAYOUT-37 exits nobody else asserts
// ════════════════════════════════════════════════════════════════════════════

test.describe("Le uscite automatiche", () => {
  test("chiudere la tab ANCORATA esce dallo zoom, anche se la sua cella sopravvive", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    // The pool cell holds TWO tabs so closing the anchor does NOT take the cell
    // with it: otherwise the exit would be explained by ordinary pruning and
    // this case would be green for the wrong reason.
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    await pinTab(page, t1);
    await tab(page, t1).click();
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    // Guard against an empty green: the zoom really was hiding something.
    const all = await cellKeys(page);
    const shown = await revealedCells(page);
    expect(all.filter((k) => !shown.includes(k)).length, "almeno una cella deve risultare collassata").toBeGreaterThan(0);

    const anchorTab = tab(page, t1).first();
    await anchorTab.hover();
    await anchorTab.locator('[data-testid="pane-tab-close"]').first().click();

    await expect(tab(page, t1)).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => zoomed(page), { timeout: 10_000 }).toBe(false);
    // The cell survived (t4 is still in it) and the collapsed ones are back.
    expect((await revealedCells(page)).length).toBe(3);
  });

  test("il fuoco su una cella FUORI dal set chiude lo zoom; cambiare tab DENTRO il set no", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    await pinTab(page, t1);
    await tab(page, t1).click();
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    // THE HALF THAT BITES A CRUDE IMPLEMENTATION, and it comes first: switching
    // tab INSIDE the set's cell must NOT close anything. Without it, "closes on
    // a focus change" would be satisfied by an effect that closes ALWAYS.
    await tab(page, t4).click();
    await expect(page.locator(`[data-pane-shell="${t4}"][data-pane-visible="1"]`)).toBeAttached({ timeout: 10_000 });
    expect(await zoomed(page), "cambiare tab dentro la cella del set non chiude").toBe(true);

    // The focus moves to a pane in a cell outside the set. It cannot be a click
    // on that cell's tab — the cell is collapsed and unclickable — so it comes
    // from OUTSIDE the grid, via the sidebar row of a topic already open there.
    await ensureTopicVisible(page, new RegExp(n2));
    await page.getByRole("treeitem", { name: new RegExp(n2) }).first().click();
    await expect.poll(() => zoomed(page), { timeout: 10_000 }).toBe(false);
  });

  test("cambiare Spazio e tornare: nessuno dei due risulta ingrandito", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");

    // A second group, made the only way one can be made: by moving a tab into
    // it. t4 shares the pool cell with t1, so the cell count does not change.
    await tab(page, t4).click({ button: "right" });
    const move = page.getByText("Sposta nel gruppo", { exact: true });
    await expect(move).toBeVisible({ timeout: 5_000 });
    await move.click();
    const newGroup = page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" });
    await expect(newGroup).toBeVisible({ timeout: 5_000 });
    await newGroup.click();
    await expect(page.getByTestId("space-row")).toHaveCount(1, { timeout: 10_000 });

    const cellsBefore = await cellKeys(page);
    expect(cellsBefore.length).toBe(3);

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    // Leaving is WANTED and not a defect: App keys this subtree on the active
    // space, the surface remounts, and its unmount effect exits the zoom.
    await page.getByTestId("space-row").first().click();
    await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2", { timeout: 10_000 });
    expect(await zoomed(page), "l'altro gruppo non nasce ingrandito").toBe(false);

    await page.getByTestId("space-row").filter({ hasText: "Principale" }).click();
    await expect(page.getByTestId("space-row-active")).toContainText("Principale", { timeout: 10_000 });
    expect(await zoomed(page), "tornando, non e' ingrandito").toBe(false);
    // Guard against an empty green: "not zoomed" would also be true of a layout
    // that got lost on the way.
    await expect.poll(() => cellKeys(page), { timeout: 10_000 }).toEqual(cellsBefore);
  });

  test("dopo un ricaricamento lo stato di riposo e' «non ingrandito», e nessuna cornice compare su una griglia non idratata", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    await seedThreeCells(page, request);
    await page.keyboard.press("Escape");
    const cellsBefore = await cellKeys(page);

    await pinTab(page, t1);
    await tab(page, t1).dblclick();
    await expect.poll(() => zoomed(page), { timeout: 5_000 }).toBe(true);

    // `waitUntil: "load"` and never "networkidle": the live WebSocket keeps the
    // network busy forever and networkidle would simply time out.
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => cellKeys(page), { timeout: 15_000 }).toEqual(cellsBefore);
    expect(await zoomed(page), "lo stato di riposo e' non ingrandito").toBe(false);

    // ── nessuna cornice su una griglia non ancora idratata ────────────────
    // The boot window has to be WIDENED to be observable, and BOTH channels
    // have to be held back: the `ui-state:init` frame and the
    // `GET /api/ui-state/pane-store-v2` fallback. Delaying one lets the other
    // through and the observation measures nothing.
    // THREE channels, not two. Besides the WS frame and the GET there is a LOCAL
    // mirror (`localStorage['pane-store-v2']`, persistLocal middleware) that
    // rehydrates the whole grid synchronously at mount — with it in place the
    // boot window does not exist at all and the observation below would be taken
    // on a grid that is already up. It is cleared through `addInitScript` so the
    // wipe lands on the NEW document, before any app code runs: clearing it from
    // the current page would be undone by that page's own pagehide flush.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("pane-store-v2");
        localStorage.removeItem("pane-store-focused-id");
      } catch { /* storage disabled — nothing to clear */ }
    });
    await page.route("**/api/ui-state/pane-store-v2*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await new Promise((r) => setTimeout(r, 5_000));
      return route.fallback();
    });
    await page.routeWebSocket(APP_WS, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        const s = String(m);
        if (s.includes('"ui-state:init"')) { setTimeout(() => ws.send(m), 5_000); return; }
        ws.send(m);
      });
    });

    await page.reload({ waitUntil: "load" });
    const duringBoot = await page.evaluate(() => {
      const s = document.querySelector("[data-split-surface]");
      const scrim = document.querySelector(".pane-zoom-scrim") as HTMLElement | null;
      return {
        cells: document.querySelectorAll("[data-split-leaf]").length,
        marked: !!s?.getAttribute("data-pane-zoom"),
        // On the NODE we say nothing: scrim and stage are mounted
        // unconditionally, so counting them would answer 1 always and prove the
        // opposite of what is wanted. The question is whether the veil SHOWS.
        veilVisible: !!scrim && getComputedStyle(scrim).opacity !== "0" && !scrim.hasAttribute("hidden"),
      };
    });
    expect(duringBoot.marked, "nessuna cornice prima dell'idratazione").toBe(false);
    expect(duringBoot.veilVisible, "e nessun velo").toBe(false);
    // The guard: the observation only counts if it fell INSIDE the boot window.
    expect(duringBoot.cells, "la griglia non doveva essere ancora idratata").toBeLessThan(cellsBefore.length);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("lo zoom non viaggia: sull'altro dispositivo non cambia niente e non parte nessuna scrittura dei pannelli", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-37" });
    const dev = await openTwoDevices(browser, {
      seed: async (req) => {
        await Promise.all([t1, t4, t2].map((id) => unarchiveTopic(req, id)));
        await seedPaneStore(req, () => ({
          panes: Object.fromEntries([t1, t4, t2].map((id) => [id, paneRecord(id)])),
          groups: { "group:default": { id: "group:default", paneIds: [t1, t4, t2], splitRatio: 1, splitAxis: "horizontal" } },
          projects: {},
          groupOrder: ["group:default"],
          closedStack: [],
        }));
        await req.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [t1, t4, t2] }, ignoreHTTPSErrors: true }).catch(() => {});
      },
    });
    try {
      // The split cells are DEVICE-LOCAL (localStorage), so both devices are
      // given the same overlay by hand and then reloaded onto it.
      for (const p of [dev.pageA, dev.pageB]) {
        await p.evaluate(({ k1, k2, grid }) => {
          localStorage.setItem(k1, JSON.stringify(grid));
          localStorage.setItem(k2, JSON.stringify(grid));
        }, { k1: GRID_KEY, k2: GRID_KEY_DEFAULT_SPACE, grid: { gridRows: [], gridRowHeights: [], soloCells: [[t2]] } });
        await p.reload({ waitUntil: "load" });
        await expect.poll(() => cellKeys(p).then((k) => k.length), { timeout: 15_000 }).toBe(2);
      }

      await pinTab(dev.pageA, t1);
      // The pin is a real write, and its debounced flush must land BEFORE the
      // counter is armed or "zero PUT" would be spent on somebody else's
      // gesture. `waitForPaneStoreQuiet` polls the server's own sequence, so
      // this is the condition and not a guess at how long a debounce takes.
      await waitForPaneStoreQuiet(request);

      const boxesB = await cellBoxes(dev.pageB);

      // Count the pane-store writes device A makes. `page.on("request")` and not
      // `page.route`: a route would have to forward the very request it is
      // counting, and the PUT carries a `?base=<seq>` tail that a pattern ending
      // on the key would miss — counting zero for the wrong reason.
      let puts = 0;
      dev.pageA.on("request", (r) => {
        if (r.method() === "PUT" && r.url().includes("/api/ui-state/pane-store-v2")) puts++;
      });

      await tab(dev.pageA, t1).dblclick();
      await expect.poll(() => zoomed(dev.pageA), { timeout: 5_000 }).toBe(true);

      expect(await zoomed(dev.pageB), "sull'altro dispositivo non compare nessuna cornice").toBe(false);
      expect(await cellBoxes(dev.pageB), "e la sua griglia non si muove").toEqual(boxesB);
      expect(puts, "un toggle di zoom non scrive lo stato dei pannelli").toBe(0);

      // THE GUARD: something that DOES write has to make the counter rise, or
      // "zero PUT" only says the listener was never wired.
      await dev.pageA.keyboard.press("Meta+t");
      await expect(dev.pageA.locator('[data-testid="panel-tab-bar"]').first().getByText(/^New Chat$/)).toHaveCount(1, { timeout: 10_000 });
      await expect.poll(() => puts, { timeout: 15_000 }).toBeGreaterThan(0);
    } finally {
      await dev.dispose();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  7.1 (coda) — il cassetto di un task monta lo stesso tiling e NON offre lo zoom
// ════════════════════════════════════════════════════════════════════════════

const DRAWER_PROJECT_PATH = `${canonicalTmpRoot()}/e2e-pane-zoom-drawer-${STAMP}`;
const DRAWER_BOARD_ID = boardIdForPath(DRAWER_PROJECT_PATH);

test.describe("Il cassetto di un task", () => {
  test.describe.configure({ timeout: 90_000 });

  let drawerTopicId = "";
  let drawerTaskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(DRAWER_PROJECT_PATH, { recursive: true });
    writeFileSync(`${DRAWER_PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-pane-zoom-drawer" }, null, 2));
    const topic = await createTopic(request, `ZoomDrawer-${STAMP}`, { projectPath: DRAWER_PROJECT_PATH });
    drawerTopicId = topic.id;
    await seedProjectPane(request, DRAWER_PROJECT_PATH);
    const res = await request.post(`${BASE}/api/boards/${DRAWER_BOARD_ID}/tasks`, {
      data: { text: `ZoomDrawerTask-${STAMP}` },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok(), "il task del cassetto deve nascere").toBe(true);
    drawerTaskId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (drawerTaskId) await deleteTask(request, DRAWER_BOARD_ID, drawerTaskId).catch(() => {});
    if (drawerTopicId) await deleteTopic(request, drawerTopicId).catch(() => {});
  });

  test("dentro il cassetto il comando «Ingrandisci» non esiste, ma il tiling c'e'", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-38" });
    await page.routeWebSocket(BROWSER_STREAM_WS, () => { /* swallow: no server, no frames */ });
    await goToApp(page);
    await page.keyboard.press("Escape");

    // The project window, then its board.
    const row = projectRow(page, /e2e-pane-zoom-drawer/);
    if ((await row.count()) === 0) {
      await seedProjectPane(request, DRAWER_PROJECT_PATH);
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
    }
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });

    const triggers = page.getByTestId("pane-add-menu-trigger");
    const kanbanEntry = page.getByTestId("pane-add-menu-kanban");
    let opened = false;
    for (let i = (await triggers.count()) - 1; i >= 0; i--) {
      const t = triggers.nth(i);
      if (!(await t.isVisible().catch(() => false))) continue;
      if (!(await t.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
      if (await kanbanEntry.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) { opened = true; break; }
      await page.keyboard.press("Escape");
    }
    expect(opened, "il menu «+» deve offrire la board").toBe(true);
    await kanbanEntry.click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("kanban-board").getByText(`ZoomDrawerTask-${STAMP}`, { exact: true }).first().click({ timeout: 15_000 });
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15_000 });

    // The drawer's workspace only mounts its tiling once it HAS a pane, so the
    // one gesture that gives it one is spent first. Without this the assertion
    // below would be true of an empty column, i.e. green for lack of a subject.
    await page.getByTestId("task-workspace-add-tab").click();
    const body = page.getByTestId("task-drawer-body");
    await expect(body).toBeVisible({ timeout: 15_000 });
    const drawerTab = body.locator('[data-testid^="pane-tab-"]').first();
    await expect(drawerTab, "il cassetto monta lo stesso tiling, con la sua barra").toBeVisible({ timeout: 15_000 });

    // THE POINT: the same tab bar, and neither entry. The drawer is already an
    // overlaid surface; two nested "outsides" are not an interface.
    await drawerTab.click({ button: "right" });
    // Anchored on the MENU itself (`role="menu"`, the portal PaneTabBar opens)
    // and not on one of its entries: the drawer's bar is handed fewer callbacks
    // than the app-level one, so any particular entry may legitimately be
    // missing — and then "no zoom entry" would be true of a menu that never
    // opened.
    await expect(page.getByRole("menu").first()).toBeVisible({ timeout: 5_000 });
    await expect(zoomEntry(page)).toHaveCount(0);
    await expect(zoomCellEntry(page)).toHaveCount(0);
    await expect(unzoomEntry(page)).toHaveCount(0);
    await page.keyboard.press("Escape");

    // …and the double click does not enlarge anything either.
    await drawerTab.dblclick();
    await drawerTab.dblclick();
    await expect(page.locator("[data-split-surface][data-pane-zoom]")).toHaveCount(0);

    // The other half of this scenario — that the drawer's own browser behind a
    // hidden shell is SWITCHED OFF (`NATIVEPARK-02`) — is not asserted here and
    // cannot be: it is a call into the native shell, and under Playwright there
    // is no shell to call. See the file header.
  });
});
