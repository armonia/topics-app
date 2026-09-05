/**
 * E2E tests for Phase 25 regression fixes.
 * Covers: EditorTabs abort race condition, GroupLayout data-attribute resize,
 * and App.tsx panel validation for archived topics.
 *
 * CONVENTION: No waitForTimeout() — use condition-based waits only.
 */
import { test, expect } from "@playwright/test";

import {
  createTopic,
  deleteTopic,
  fetchTopic,
  resetPaneStore,
  resetProjectPanes,
} from "./helpers/api-fixtures";
import { getVisibleTabLabels } from "./helpers/layout";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Seed server state with specific open panels, then navigate */
async function seedAndLoad(
  page: import("@playwright/test").Page,
  panelIds: string[],
  opts?: { gridRows?: unknown[] }
) {
  await Promise.all([
    page.request
      .put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: panelIds },
      })
      .catch(() => {}),
    page.request
      .put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: panelIds, pinned: panelIds },
      })
      .catch(() => {}),
    page.request
      .put(`${BASE}/api/ui-state/grid-layout`, {
        data: {
          gridRows: opts?.gridRows ?? [],
          gridRowHeights: [],
          soloTopicIds: [],
        },
      })
      .catch(() => {}),
  ]);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', {
    state: "visible",
    timeout: 15000,
  });
}

/** Count draggable tabs in the main area */
async function countTabs(
  page: import("@playwright/test").Page
): Promise<number> {
  return page.locator('[role="main"] [draggable="true"]').count();
}

// ─── Test 1: EditorTabs rapid file opening ──────────────────────────────────

test.describe("EditorTabs: rapid file opening does not show stale content", () => {
  let topicId: string;
  const TOPIC_NAME = "RF-Editor-" + Date.now();

  test.beforeAll(async ({ request }) => {
    // Create a topic with a project path so we get a file explorer / editor
    const t = await createTopic(request, TOPIC_NAME, {
      projectPath: process.cwd(),
    });
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    await deleteTopic(request, topicId);
  });

  // `seedAndLoad` semina solo la chiave legacy `panels`, che il client NON
  // legge più (nessun riferimento a `ui-state/panels` sotto client/src): la
  // finestra progetto si apriva quindi solo se un file precedente ne aveva
  // lasciata una nel pane-store — l'unico canale autoritativo. Qui la apriamo
  // per davvero, con l'id CANONICO `project:<path url-encoded>`
  // (paneConfig.createPaneId), altrimenti il pane non viene riconosciuto.
  //
  // Il layout INTERNO del progetto è una chiave `ui_state` separata
  // (`topics-project-panes-<hash>`): sopravvive al reset globale e a un contesto
  // Playwright nuovo, quindi va azzerato a parte o la finestra si idrata coi
  // pane aperti da un altro file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [`project:${encodeURIComponent(process.cwd())}`]);
    await resetProjectPanes(request, process.cwd());
  });

  test("opening files rapidly does not produce page errors from abort cleanup", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "FILE-01",
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // Open the project topic
    const projectPaneId = `project:${process.cwd()}`;
    await seedAndLoad(page, [projectPaneId]);

    // Wait for the project window to render with its tab bar
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').first()
    ).toBeVisible({ timeout: 10000 });

    // Look for the file explorer pane tab (Files tab) within the project
    const filesTab = page.locator(
      '[data-testid="panel-tab-bar"] [draggable="true"]'
    ).filter({ hasText: /Files/ });

    // If a Files tab exists, click it to show the file explorer
    if ((await filesTab.count()) > 0) {
      await filesTab.first().click();
      // Wait for file tree to render
      await page.locator('[data-testid="file-tree"]').waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    }

    // Look for file entries in the file explorer tree.
    // Directories have a chevron icon; files do not. We need to click actual files
    // (not directories) to trigger the editor open path.
    //
    // DUE FILE SONO LA PRECONDIZIONE, non una comodità dell'ambiente: senza due
    // click ravvicinati la corsa dell'AbortController non viene nemmeno
    // provocata, e l'asserzione finale (nessun errore di React) è vera a vuoto.
    // Prima qui c'erano tre attese con `.catch(() => {})` e un `if (fileCount >=
    // 2)`: con l'albero assente il test passava senza cliccare niente — verde
    // proprio nel caso che doveva intercettare. Il progetto è `process.cwd()`,
    // cioè questo repo: i file ci sono, e se non ci sono è quello il difetto.
    const fileTree = page.locator('[data-testid="file-tree"]');
    await expect(fileTree, "il pane Files deve montare l'albero").toBeVisible({ timeout: 10_000 });

    // Due file DELLA RADICE di questo repo, per nome. Prima si filtravano i
    // treeitem con `hasText: /\.(ts|js|json|…)$/`, e quel `$` non poteva mai
    // combaciare: l'etichetta di una riga finisce col BADGE GIT (`server.ts M`),
    // non con l'estensione. Il filtro restituiva zero, l'`if (fileCount >= 2)`
    // che lo avvolgeva saltava tutto in silenzio, e il test chiudeva verde senza
    // aver cliccato niente — cioe' senza aver mai provocato la corsa
    // dell'AbortController che gli da' il nome.
    const firstFile = fileTree.getByRole("treeitem", { name: /package\.json/ });
    const secondFile = fileTree.getByRole("treeitem", { name: /server\.ts/ });
    await expect(firstFile.first(), "package.json deve essere nell'albero").toBeVisible({
      timeout: 10_000,
    });
    await expect(secondFile.first(), "server.ts deve essere nell'albero").toBeVisible({
      timeout: 10_000,
    });

    // Rapidly click two different files to trigger the abort race condition path:
    // il secondo click arriva PRIMA che il primo abbia finito di caricare.
    await firstFile.first().click();
    await secondFile.first().click();

    // A vincere dev'essere il SECONDO file: e' letteralmente il titolo del
    // describe («does not show stale content»), ed e' cio' che l'AbortController
    // serve a garantire — la risposta della prima fetch, se arriva dopo, non
    // deve sovrascrivere il contenuto piu' recente.
    //
    // Il segnale e' il breadcrumb del FilePane attivo. Prima si aspettava
    // `[data-testid="editor-tabs"]`, che in questo percorso non compare mai:
    // quel testid sta dentro il pane «Files» (FileExplorer.tsx), e questo test
    // clicca nell'albero della SIDEBAR, che apre un FilePane nell'area
    // principale. Non se n'era accorto nessuno perche' l'asserzione era dentro
    // un `if` che non si avverava. `:visible` perche' i pane inattivi restano
    // montati con display:none, quindi un locator nudo ne trova due.
    await expect(
      page.locator('[data-testid="breadcrumb-nav"]:visible'),
      "deve restare aperto l'ULTIMO file cliccato, non il primo",
    ).toContainText("server.ts", { timeout: 10_000 });

    // The key assertion: no page errors from the abort controller cleanup
    // Filter out unrelated errors (e.g., network errors from other components)
    const abortRelatedErrors = pageErrors.filter(
      (e) =>
        e.includes("unmounted") ||
        e.includes("abort") ||
        e.includes("setState")
    );
    expect(
      abortRelatedErrors,
      "No React state-update-on-unmounted or abort errors expected"
    ).toHaveLength(0);
  });
});

// ─── Test 2: PanelGrid resize with split panels ─────────────────────────────
// PanelGrid uses cursor-col-resize dividers when topics are split side-by-side.
// GroupLayout (inside project windows) uses data-group-cell / data-divider-* attributes.
// This test verifies that split + resize works correctly in the PanelGrid layout.

test.describe("PanelGrid: resize works after split", () => {
  let topicIds: string[] = [];
  const NAMES = [
    "RF-Resize-A-" + Date.now(),
    "RF-Resize-B-" + Date.now(),
  ];

  test.beforeAll(async ({ request }) => {
    for (const name of NAMES) {
      const t = await createTopic(request, name);
      topicIds.push(t.id);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of topicIds) {
      await deleteTopic(request, id);
    }
  });

  // Il test conta i tab in `[role="main"]` e pretende che il PRIMO sia uno dei
  // suoi: il pane-store è unico per tutta la suite seriale, quindi si riparte
  // esattamente dai due topic del beforeAll (`seedAndLoad` scrive solo la
  // chiave legacy `panels`, che il client non legge più — i tab arrivano dal
  // pane-store, dove createTopic li ha aperti).
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, topicIds);
  });

  test("split creates col-resize divider and resize drag changes panel widths", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "LAYOUT-01",
    });

    const [idA, idB] = topicIds;
    await seedAndLoad(page, [idA, idB]);

    // Wait for at least 2 tabs to appear
    await expect
      .poll(() => countTabs(page), { timeout: 10000 })
      .toBeGreaterThanOrEqual(2);

    // Split the first tab to the right via context menu
    const firstTab = page.locator('[role="main"] [draggable="true"]').first();
    await expect(firstTab).toBeVisible({ timeout: 5000 });
    await firstTab.click({ button: "right" });

    // Pane context menu moved from a `.z-[9999]` class to an inline zIndex +
    // role="menu" (PaneTabBar.tsx). Target the menu role.
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });
    const splitBtn = menu.getByText("Dividi a destra", { exact: true });
    await expect(splitBtn).toBeVisible({ timeout: 3000 });
    await splitBtn.click();

    // Wait for split to create multiple tab bars (one per solo panel group)
    await expect
      .poll(
        () => page.locator('[data-testid="panel-tab-bar"]').count(),
        { timeout: 8000 }
      )
      .toBeGreaterThanOrEqual(2);

    // Verify a col-resize divider exists between the split panels
    const colDivider = page.locator('[role="main"] .cursor-col-resize').first();
    await expect(colDivider).toBeVisible({ timeout: 5000 });

    // Get the divider's bounding box
    const dividerBox = await colDivider.boundingBox();
    expect(dividerBox).not.toBeNull();

    // Record initial widths of the two panel tab bars
    const tabBars = page.locator('[data-testid="panel-tab-bar"]');
    const tabBarCount = await tabBars.count();
    expect(tabBarCount).toBeGreaterThanOrEqual(2);

    // Get widths of the panel areas (parent containers of tab bars)
    const leftBarBox = await tabBars.nth(0).boundingBox();
    const rightBarBox = await tabBars.nth(tabBarCount - 1).boundingBox();
    expect(leftBarBox).not.toBeNull();
    expect(rightBarBox).not.toBeNull();

    // Drag divider 80px to the right
    await page.mouse.move(
      dividerBox!.x + dividerBox!.width / 2,
      dividerBox!.y + dividerBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      dividerBox!.x + dividerBox!.width / 2 + 80,
      dividerBox!.y + dividerBox!.height / 2,
      { steps: 10 }
    );
    await page.mouse.up();

    // After resize, both tab bars should still be visible
    await expect(tabBars.first()).toBeVisible();
    await expect(tabBars.nth(tabBarCount - 1)).toBeVisible();

    // Verify at least one width changed
    const leftBarBoxAfter = await tabBars.nth(0).boundingBox();
    const rightBarBoxAfter = await tabBars.nth(tabBarCount - 1).boundingBox();
    expect(leftBarBoxAfter).not.toBeNull();
    expect(rightBarBoxAfter).not.toBeNull();

    const leftChanged =
      Math.abs(leftBarBoxAfter!.width - leftBarBox!.width) > 5;
    const rightChanged =
      Math.abs(rightBarBoxAfter!.width - rightBarBox!.width) > 5;
    expect(
      leftChanged || rightChanged,
      "Resize drag should change panel widths"
    ).toBeTruthy();
  });
});

// ─── Test 3: Panel validation removes archived topics ───────────────────────

test.describe("Panel validation: archived topic panels are removed", () => {
  // `countTabs` conta TUTTE le tab del workspace e `getVisibleTabLabels` legge le
  // loro etichette: una pane lasciata aperta da un file precedente falsa entrambi.
  // Il test si crea e si apre il topic da solo, quindi non c'è nulla da preservare.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("archiving a topic removes its tab without infinite re-render", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "TOPIC-01",
    });

    const topicName = "RF-Archive-" + Date.now();
    const topic = await createTopic(request, topicName);

    try {
      // Open the topic as a panel
      await seedAndLoad(page, [topic.id]);

      // Verify the topic tab is visible
      await expect
        .poll(() => countTabs(page), { timeout: 10000 })
        .toBeGreaterThanOrEqual(1);

      const labelsBefore = await getVisibleTabLabels(page);
      expect(
        labelsBefore.some((l) => l.includes(topicName)),
        "Topic should be visible in tab bar before archiving"
      ).toBeTruthy();

      // Archive the topic via DELETE (server sets archived=true, broadcasts topic:archived)
      await request.delete(`${BASE}/api/topics/${topic.id}`, {
        data: { archived: true },
        ignoreHTTPSErrors: true,
      });

      // Verify the archive was persisted server-side. By id: the boot list
      // (`GET /api/topics`) carries only the live topics now.
      expect(
        (await fetchTopic(request, topic.id))?.archived,
        "Server should have archived=true for the topic"
      ).toBeTruthy();

      // Re-seed the panel state to ensure the archived topic is still in openPanels,
      // then reload. App.tsx validation should filter it out on load.
      await page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [topic.id] },
      });
      await page.request.put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: [topic.id], pinned: [topic.id] },
      });

      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', {
        state: "visible",
        timeout: 15000,
      });

      // After reload, the archived topic's tab should NOT be in the tab bar
      // because App.tsx validation filters panels where topic.archived === true
      await expect
        .poll(
          async () => {
            const labels = await getVisibleTabLabels(page);
            return labels.some((l) => l.includes(topicName));
          },
          { timeout: 10000, message: "Archived topic tab should be removed by validation" }
        )
        .toBeFalsy();

      // Verify the page is still responsive (no infinite re-render)
      // by checking the sidebar and search box are interactive
      await expect(
        page.locator('[aria-label="Topics sidebar"]')
      ).toBeVisible({ timeout: 5000 });

      // Click the search box to verify the page is responsive
      const searchBox = page.locator('[data-testid="file-search-input"]');
      if ((await searchBox.count()) > 0) {
        await searchBox.click();
        await expect(searchBox).toBeFocused();
      }
    } finally {
      // Unarchive via DELETE with archived: false, then hard-delete
      await request.delete(`${BASE}/api/topics/${topic.id}`, {
        data: { archived: false },
        ignoreHTTPSErrors: true,
      }).catch(() => {});
      await deleteTopic(request, topic.id);
    }
  });
});
