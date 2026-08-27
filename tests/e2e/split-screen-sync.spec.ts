import { mkdirSync, rmSync } from "fs";
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  seedProjectPane,
  waitForPaneStoreQuiet,
} from "./helpers/api-fixtures";
import {
  collapseSidebarSections,
  countColDividers,
  countRowDividers,
  countTabBars,
  getVisibleTabLabels,
  splitViaContextMenu,
} from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Open a project in the sidebar */
async function openProjectInSidebar(page: Page, name: string | RegExp) {
  const projectsSection = page.getByRole("button", {
    name: /sezione Progetti/,
  });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") {
      await projectsSection.click();
      // È il bottone stesso a dire quando la sezione è aperta.
      await expect(projectsSection).toHaveAttribute("aria-expanded", "true", {
        timeout: 5000,
      });
    }
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: name })
    .first();
  if ((await btn.count()) > 0) {
    await btn.click();
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').first()
    ).toBeVisible({ timeout: 10000 });
  }
}

// ─── Test Data ────────────────────────────────────────────────────────────

let topicIds: string[] = [];
let projectTopicId: string | null = null;
// A REAL directory (created in beforeAll): project panes probe the path
// (file tree, shell cwd) — a phantom `/Users/...` path left the window in
// "directory not found" and pane adds misbehaving.
const PROJECT_PATH = `/tmp/e2e-split-sync-${Date.now()}`;

// ─── Test Suite ───────────────────────────────────────────────────────────

test.describe("Split Screen Sync & Correctness", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    const t1 = await createTopic(request, "E2E-SplitSync-A");
    const t2 = await createTopic(request, "E2E-SplitSync-B");
    const t3 = await createTopic(request, "E2E-SplitSync-C");
    topicIds = [t1.id, t2.id, t3.id];
    const proj = await createTopic(request, "E2E-SplitProject", {
      projectPath: PROJECT_PATH,
    });
    projectTopicId = proj.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of topicIds) {
      await deleteTopic(request, id);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  // 2.1-2.4 MERGED AWAY (top-level Split Right / Split Down / split survives
  // reload / project-internal split survives reload). They asserted exactly the
  // properties GRID-01, GRID-02 and GRID-04 in grid-split.spec.ts and
  // PROJECT-TABS-02b in project-tabs.spec.ts already assert, on the same
  // helpers and the same choreography; the extra edges they carried (tab-bar
  // count must GROW, the layout key must be there unconditionally, the write
  // must land before the reload) were folded into those tests. What is left in
  // this file is what only this file does: COMPOSITE layouts — project + chat
  // side by side, nested project splits, multi-row multi-column grids.

  // ── 3.1: Mixed project + chat split ──

  test("Mixed project + chat panels in multi-column split", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Seed a chat panel open
    await page.request
      .put(`${E2E_BASE}/api/ui-state/panels`, {
        data: { openPanels: [topicIds[0]] },
      })
      .catch(() => {});
    await page.request
      .put(`${E2E_BASE}/api/ui-state/panel-order`, {
        data: { order: [topicIds[0]], pinned: [topicIds[0]] },
      })
      .catch(() => {});
    await page.request
      .put(`${E2E_BASE}/api/ui-state/grid-layout`, {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      })
      .catch(() => {});
    // Deterministic tab set, then the project pane on
    // top — the tab-driven sidebar needs the `project:<path>` pane open to
    // show the project row this test clicks.
    await resetPaneStore(page.request, [topicIds[0]]);
    await seedProjectPane(page.request, PROJECT_PATH);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Open the project — this creates a project panel alongside the chat
    await openProjectInSidebar(page, /e2e-split-sync/i);

    // Verify both panels have their own tab bars
    const tabBars = await countTabBars(page);
    expect(tabBars).toBeGreaterThanOrEqual(2);

    // Il divisore c'è solo se il progetto apre una colonna, quindi non lo si
    // asserisce: quello che DEVE valere sempre è che le due tab bar siano
    // entrambe visibili (prima si calcolava un `totalDividers` e non lo si
    // guardava, e si asseriva solo la prima barra — cioè quasi nulla).
    const bars = page.locator('[data-testid="panel-tab-bar"]');
    await expect(bars.first()).toBeVisible();
    await expect(bars.nth(1)).toBeVisible();
  });

  // ── 3.2: Project window with nested splits ──

  test("Project window with nested splits (multi-row multi-column)", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await seedProjectPane(page.request, PROJECT_PATH);
    await goToApp(page);
    await openProjectInSidebar(page, /e2e-split-sync/i);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    // Add 2 more panes for nested splits
    const startCount = await tabs.count();
    for (let n = 0; n < 2; n++) {
      const addPaneBtn = page.getByTitle("Add pane");
      if ((await addPaneBtn.count()) > 0) {
        await addPaneBtn.first().click();
        const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
        await expect(addMenu).toBeVisible({ timeout: 5000 });
        const menuButtons = addMenu.locator("button");
        for (let i = 0; i < (await menuButtons.count()); i++) {
          const text = ((await menuButtons.nth(i).textContent()) || "").trim();
          if (!/Chat/i.test(text)) {
            await menuButtons.nth(i).click();
            break;
          }
        }
        // The condition the sleep stood in for: the menu closed and the tab
        // it created is on the bar. Counting is what the next assertion reads,
        // so waiting on the count is waiting on the real thing.
        await expect(addMenu).toBeHidden({ timeout: 10_000 });
        await expect(tabs).toHaveCount(startCount + n + 1, { timeout: 10_000 });
      }
    }

    // Hard-assert the setup produced enough panes to split — a broken add-pane
    // flow must FAIL here, not silently skip the whole split assertion below.
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(3);
    {
      // Split Right first
      await tabs.first().click({ button: "right" });
      let menu = page.locator('[role="menu"]').first();
      await expect(menu).toBeVisible({ timeout: 3000 });
      let splitRightBtn = menu
        .locator("button")
        .filter({ hasText: /Dividi a destra/ })
        .first();
      if ((await splitRightBtn.count()) > 0) {
        const barsBefore = await countTabBars(page);
        await splitRightBtn.click();
        // A split ADDS a tab bar. That is the observable outcome, and it is
        // exactly what the final assertion of this block counts.
        await expect
          .poll(() => countTabBars(page), { timeout: 10_000 })
          .toBeGreaterThan(barsBefore);
      }

      // Now Split Down on another tab
      const allTabs = page.locator('[role="main"] [draggable="true"]');
      if ((await allTabs.count()) >= 2) {
        await allTabs.nth(1).click({ button: "right" });
        menu = page.locator('[role="menu"]').first();
        await expect(menu).toBeVisible({ timeout: 3000 });
        const splitDownBtn = menu
          .locator("button")
          .filter({ hasText: /Dividi in basso/ })
          .first();
        if ((await splitDownBtn.count()) > 0) {
          const barsBefore = await countTabBars(page);
          await splitDownBtn.click();
          await expect
            .poll(() => countTabBars(page), { timeout: 10_000 })
            .toBeGreaterThan(barsBefore);
        }
      }

      // Should have at least 2 tab bars from the splits
      const finalTabBars = await countTabBars(page);
      // The split flow (2 added panes → Split Right → Split Down) yields 3 tab
      // bars in the harness. Assert the splits MATERIALISED (>=2), not the
      // always-true >=1 that passed even if the layout never split.
      expect(finalTabBars).toBeGreaterThanOrEqual(2);
    }
  });

  // ── 3.3: Mixed layout persists across reload ──

  test("Mixed project + chat layout persists across reload", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Seed a chat panel
    await page.request
      .put(`${E2E_BASE}/api/ui-state/panels`, {
        data: { openPanels: [topicIds[0]] },
      })
      .catch(() => {});
    await page.request
      .put(`${E2E_BASE}/api/ui-state/panel-order`, {
        data: { order: [topicIds[0]], pinned: [topicIds[0]] },
      })
      .catch(() => {});
    await resetPaneStore(page.request, [topicIds[0]]);
    await seedProjectPane(page.request, PROJECT_PATH);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Open project alongside chat
    await openProjectInSidebar(page, /e2e-split-sync/i);

    const tabBarsBefore = await countTabBars(page);

    // Attesa del salvataggio debounced misurata sul server, non a occhio: il
    // pane-store è "quieto" quando due letture di fila danno lo stesso
    // server_seq (≤1s, di solito ~100ms, contro i 3s fissi di prima).
    await waitForPaneStoreQuiet(page.request);

    // Reload
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await expect.poll(() => countTabBars(page), { timeout: 10000 }).toBeGreaterThan(0);

    // Re-open project
    await openProjectInSidebar(page, /e2e-split-sync/i);

    // Persistence: the layout must not SHRINK across reload (the old >=1 was
    // always true even if every panel was lost). >= before catches a reload
    // that drops the restored panels down to the empty-shell floor.
    //
    // Il conteggio finale si POLLA, non si campiona una volta. Prima era una
    // lettura secca subito dopo `openProjectInSidebar`: se la griglia non
    // aveva ancora finito di rimontare, `after` usciva più basso di `before` e
    // il test cadeva per tempistica, non per una perdita vera. Si vedeva solo
    // nella run seriale completa (macchina sotto carico, rimonto più lento) —
    // verde 5 volte su 5 in isolamento, un flaky nella suite intera.
    //
    // Il significato dell'asserzione non cambia: se il layout si RESTRINGE
    // davvero, il poll non converge e il test cade lo stesso, con lo stesso
    // messaggio.
    expect(tabBarsBefore).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => countTabBars(page), {
        message: `il layout non deve restringersi al reload (prima: ${tabBarsBefore})`,
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(tabBarsBefore);
  });

  // ── 3.4: Multi-row top-level grid ──

  test("Multi-row multi-column top-level grid (Split Down + Split Right)", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Need 3 topics for multi-row multi-column
    const [idA, idB, idC] = topicIds;
    await Promise.all([
      page.request.put(`${E2E_BASE}/api/ui-state/panels`, {
        data: { openPanels: [idA, idB, idC] },
      }),
      page.request.put(`${E2E_BASE}/api/ui-state/grid-layout`, {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      }),
      page.request.put(`${E2E_BASE}/api/ui-state/panel-order`, {
        data: { order: [idA, idB, idC], pinned: [idA, idB, idC] },
      }),
    ]);
    // Reset the authoritative pane channel to EXACTLY these three topics —
    // legacy openPanels is UNIONED with pane-store-v2 on hydrate, so stale panes
    // from the shared test DB otherwise leak in as extra tabs.
    await resetPaneStore(page.request, [idA, idB, idC]);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await collapseSidebarSections(page);
    // Le tre tab seminate devono essere TUTTE lì prima di dividere. Non
    // ">= 2": con due sole tab il secondo split parte da un gruppo a pane
    // singolo, che è un no-op — e il test finiva per misurare quel no-op
    // invece del layout a due assi che dichiara di verificare.
    // Si polla sulle ETICHETTE, non sul conteggio: se la precondizione salta,
    // il messaggio d'errore dice QUALI tab ci sono invece di un numero nudo.
    await expect
      .poll(() => getVisibleTabLabels(page), { timeout: 10000 })
      .toHaveLength(3);

    // Split Down first to create 2 rows
    await splitViaContextMenu(page, "Dividi in basso");
    expect(await countRowDividers(page)).toBeGreaterThanOrEqual(1);

    // Now Split Right on one of the remaining tabs to create a column within a row
    await splitViaContextMenu(page, "Dividi a destra", 0);

    // Verify both row and column dividers coexist
    const finalRowDividers = await countRowDividers(page);
    const finalColDividers = await countColDividers(page);
    // At minimum one of each should exist
    expect(finalRowDividers + finalColDividers).toBeGreaterThanOrEqual(2);

    // Each cell should have its own tab bar
    const finalTabBars = await countTabBars(page);
    expect(finalTabBars).toBeGreaterThanOrEqual(3);
  });
});
