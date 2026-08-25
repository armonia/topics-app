import { mkdirSync } from "fs";
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, seedProjectPane, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import {
  collapseSidebarSections,
  countColDividers,
  countRowDividers,
  getVisibleTabLabels,
  splitViaContextMenu,
} from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Il click su una topic è servito quando la sua tab bar è a schermo — non dopo
 * 1,5s di speranza. Chi chiama questo helper legge subito tab, divisori o
 * bounding box del main: la tab bar è la prima cosa che esiste in tutti e tre i
 * casi. L'esito è volutamente ignorato perché alcuni test verificano proprio lo
 * stato "nessuna tab" e devono poter proseguire.
 */
async function waitForTabBar(page: Page) {
  await page
    .locator('[data-testid="panel-tab-bar"]')
    .first()
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});
}

/** Open any available chat topic from the sidebar */
async function openAnyTopic(page: Page) {
  // Try clicking the first treeitem that looks like a topic (not a project folder)
  const treeItems = page.getByRole("treeitem");
  const count = await treeItems.count();
  for (let i = 0; i < Math.min(count, 30); i++) {
    const text = await treeItems.nth(i).textContent();
    // Skip project folder entries (they contain file-like names)
    if (text && !text.includes('.ts') && !text.includes('.json') && !text.includes('.md')) {
      await treeItems.nth(i).click();
      await waitForTabBar(page);
      return;
    }
  }
  // Fallback: just click the first one
  if (count > 0) {
    await treeItems.first().click();
    await waitForTabBar(page);
  }
}

/** Open a project window by clicking its sidebar entry. The tab-driven
 *  sidebar only shows the row while the `project:<path>` pane is open — if a
 *  previous test's seeding wiped openPanels, re-open the pane and reload. */
async function openProject(page: Page, name: string | RegExp, projectPath = "/tmp/e2e-grid") {
  const projectBtn = typeof name === 'string'
    ? page.locator(`button:has-text("${name}")`)
    : page.locator('button').filter({ hasText: name });
  const visible = await projectBtn.first().waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false);
  if (!visible) {
    await seedProjectPane(page.request, projectPath);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: 'visible', timeout: 15000 });
    await expect(projectBtn.first()).toBeVisible({ timeout: 10000 });
  }
  await projectBtn.first().click();
  // Attesa CONDIZIONALE (era waitForTimeout(2000)): la finestra progetto è
  // pronta quando ha renderizzato la sua tab bar — esattamente ciò che ogni
  // chiamante legge subito dopo con getVisibleTabLabels(). Chi verifica il
  // caso "progetto senza tab" lo fa con le proprie expect (o skip), quindi qui
  // l'esito è volutamente ignorato: serve solo a non proseguire troppo presto.
  await page
    // Stesso appiglio stabile di `getVisibleTabLabels`: `.truncate.flex-1`
    // sono due utility di layout che ora porta anche una riga di file o di git.
    .locator('[role="main"] [data-testid="pane-tab-label"]')
    .first()
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => {});
}

// ─── Test Suite ───────────────────────────────────────────────────────────

let projectTopicId: string | null = null;

test.describe("Grid Split System", () => {
  test.beforeAll(async ({ request }) => {
    // Create a project-linked topic so the "Projects" section has an entry
    // Real directory — a phantom path leaves the project window in
    // "directory not found" and pane adds misbehave.
    mkdirSync("/tmp/e2e-grid", { recursive: true });
    const topic = await createTopic(request, "E2E-GridProject", {
      projectPath: "/tmp/e2e-grid",
    });
    projectTopicId = topic.id;
    // Open the project WINDOW pane: a project-linked topic id seeded into
    // openPanels is purged by the client (project topics live INSIDE the
    // project window), and the tab-driven sidebar only shows a project row
    // while its `project:<path>` pane is open. Without this every
    // `openProject(page, /e2e-grid/)` call times out on a missing button.
    await seedProjectPane(request, "/tmp/e2e-grid");
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) {
      await deleteTopic(request, projectTopicId);
    }
  });

  test.describe("Chat splits", () => {
    test.beforeEach(async ({ page }) => {
      await goToApp(page);
      await openAnyTopic(page);
    });

    test("no duplicate tabs in initial state", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      const labels = await getVisibleTabLabels(page);
      const counts = new Map<string, number>();
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
      for (const [label, count] of counts) {
        expect(count, `Tab "${label}" should not be duplicated`).toBe(1);
      }
    });

    test("main area has sufficient dimensions", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      const mainBox = await page.locator('[role="main"]').boundingBox();
      expect(mainBox).not.toBeNull();
      expect(mainBox!.width).toBeGreaterThan(400);
      expect(mainBox!.height).toBeGreaterThan(300);
    });

    test("tab bar is not oversized", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      const tabBar = page.locator('[role="main"] .border-b.border-app-border.flex-shrink-0').first();
      if (await tabBar.count() === 0) return;

      const box = await tabBar.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height, 'Tab bar height should be compact').toBeLessThan(60);
    });

    test("layout persists after page reload", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      // Open the self-provisioned project to ensure we have tabs
      await openProject(page, /e2e-grid/);

      // Asserzione, non `test.skip()` muto: dopo il reload questo stesso test
      // pretende `reloadedLabels.length > 0`, quindi trattava "nessuna tab"
      // come un fallimento dopo e come un motivo per sparire prima. Se la
      // finestra progetto si apre senza tab, la persistenza non è verificabile
      // ed è una cosa da guardare.
      const initialLabels = await getVisibleTabLabels(page);
      expect(
        initialLabels.length,
        "il progetto deve aprirsi con almeno una tab, altrimenti non c'è nessuna persistenza da verificare",
      ).toBeGreaterThan(0);

      await page.reload({ waitUntil: 'load' });
      // Era waitForTimeout(3000): il segnale reale che il reload è servito è la
      // sidebar montata — la stessa condizione che goToApp aspetta.
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: 'visible', timeout: 15000 });
      // Re-open the same project
      await openProject(page, /e2e-grid/);

      const reloadedLabels = await getVisibleTabLabels(page);
      expect(reloadedLabels.length).toBeGreaterThan(0);
      const overlap = initialLabels.filter(l => reloadedLabels.includes(l));
      expect(overlap.length, 'Some tabs should persist across reload').toBeGreaterThan(0);
    });
  });

  test.describe("GroupLayout flex fix (Bug 2)", () => {
    test("row wrappers with flex style do not have flex-1", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openAnyTopic(page);

      const flexColContainers = page.locator('[role="main"] .flex.flex-col.min-h-0');
      const count = await flexColContainers.count();

      for (let i = 0; i < count; i++) {
        const el = flexColContainers.nth(i);
        const style = await el.getAttribute('style');
        const classes = await el.getAttribute('class');

        if (style && style.includes('flex:')) {
          expect(classes, 'Row with flex style should not have flex-1').not.toContain('flex-1');
        }
      }
    });
  });

  test.describe("Project window splits", () => {
    test.beforeEach(async ({ page }) => {
      await goToApp(page);
    });

    test("project window opens with tab bar", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);

      const labels = await getVisibleTabLabels(page);
      expect(labels.length, 'Project should have at least one tab').toBeGreaterThan(0);
    });

    test("project tabs include utility types (terminal, git, browser)", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);

      // Il "+" canonico è <PaneAddMenu>, che espone testid stabili: trigger e
      // righe. Il vecchio test cercava `button[title*="Add"]` e poi leggeva
      // `body.textContent()` per le parole "Terminal"/"Browser"/"Git" — passava
      // anche col menu chiuso, perché quelle parole stanno pure altrove nella
      // pagina. Ora si asserisce il menu vero e le sue righe vere.
      const addBtn = page.locator('[role="main"] [data-testid="pane-add-menu-trigger"]').first();
      await expect(addBtn).toBeVisible({ timeout: 10_000 });
      await addBtn.click();

      const menu = page.locator('[data-testid="pane-add-menu"]').last();
      await expect(menu).toBeVisible({ timeout: 5000 });

      // Un tipo utility può mancare se è già presente nel gruppo (i singleton
      // vengono filtrati da availableTypesForGroup) — se ne pretende almeno uno.
      const utilityRows = menu.locator(
        '[data-testid="pane-add-menu-terminal"], [data-testid="pane-add-menu-browser"], [data-testid="pane-add-menu-git"]',
      );
      await expect
        .poll(() => utilityRows.count(), {
          timeout: 5000,
          message: 'il menu "+" di un progetto non offre nessun tipo utility',
        })
        .toBeGreaterThan(0);

      await page.keyboard.press('Escape');
    });

    test("project window tab bar remains compact", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);

      const tabBars = page.locator('[role="main"] .border-b.border-app-border.flex-shrink-0');
      const count = await tabBars.count();

      for (let i = 0; i < count; i++) {
        const box = await tabBars.nth(i).boundingBox();
        if (box) {
          expect(box.height, `Tab bar ${i} height should be compact`).toBeLessThan(60);
        }
      }
    });

    test("no duplicate tabs after project operations", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await openProject(page, /e2e-grid/);

      const labels = await getVisibleTabLabels(page);
      const counts = new Map<string, number>();
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);

      for (const [label, count] of counts) {
        expect(count, `Tab "${label}" should not be duplicated in project`).toBe(1);
      }
    });
  });

  test.describe("Resize dividers", () => {
    // Questi due test SALTAVANO a ogni run, da sempre.
    //
    // Aprivano una topic sola e poi facevano `if (dividers.count() === 0)
    // test.skip()`. Una topic sola non produce nessuno split, quindi nessun
    // divisore, quindi skip: sempre. Nel conteggio finale finivano fra i
    // «saltati», che non guarda nessuno, mentre l'annotazione dichiarava di
    // coprire LAYOUT-01 — copertura zero spacciata per copertura.
    //
    // Il divisore non è qualcosa che «ci si trova»: è il risultato di uno
    // split. Ora il test lo CREA, e se il cursore non è quello giusto cade.
    let dividerTopicIds: string[] = [];

    test.beforeAll(async ({ request }) => {
      const a = await createTopic(request, `e2e-div-A-${Date.now()}`);
      const b = await createTopic(request, `e2e-div-B-${Date.now()}`);
      dividerTopicIds = [a.id, b.id];
    });

    test.afterAll(async ({ request }) => {
      for (const id of dividerTopicIds) await deleteTopic(request, id).catch(() => {});
    });

    /** Due tab nello stesso gruppo, poi lo split richiesto: il divisore esiste. */
    async function splitTwoPanes(page: Page, direction: "Dividi a destra" | "Dividi in basso") {
      const [idA, idB] = dividerTopicIds;
      // Il pane-store fa UNION in idratazione: senza reset questo test eredita
      // le pane lasciate dalle spec precedenti e lo split parte dal gruppo
      // sbagliato (stessa ragione scritta in openTwoTopics più sotto).
      await resetPaneStore(page.request, [idA, idB]);
      await page.request
        .put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: [idA, idB] } })
        .catch(() => {});
      await goToApp(page);
      await collapseSidebarSections(page);
      // Entrambe le tab devono essere a schermo: con una sola, lo split è un
      // no-op su un gruppo a pane singola e non nasce nessun divisore.
      await expect
        .poll(() => page.locator('[role="main"] [draggable="true"]').count(), { timeout: 15000 })
        .toBeGreaterThanOrEqual(2);
      await splitViaContextMenu(page, direction);
    }

    test("column resize divider has correct cursor", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await splitTwoPanes(page, "Dividi a destra");

      await expect
        .poll(() => countColDividers(page), { timeout: 10000 })
        .toBeGreaterThan(0);

      const divider = page.locator('[role="main"] .cursor-col-resize').first();
      expect(await divider.boundingBox()).not.toBeNull();
      expect(await divider.evaluate((el) => getComputedStyle(el).cursor)).toBe('col-resize');
    });

    test("row resize divider has correct cursor", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await splitTwoPanes(page, "Dividi in basso");

      await expect
        .poll(() => countRowDividers(page), { timeout: 10000 })
        .toBeGreaterThan(0);

      const divider = page.locator('[role="main"] .cursor-row-resize').first();
      expect(await divider.boundingBox()).not.toBeNull();
      expect(await divider.evaluate((el) => getComputedStyle(el).cursor)).toBe('row-resize');
    });
  });

  // Il describe "Split handler correctness (unit-level via evaluate)" viveva
  // qui: quattro test che incollavano la logica dei gruppi dentro
  // `page.evaluate` e asserivano l'incollatura, avviando un browser per
  // provare una tautologia. La logica vera è ora `groupOps.ts` e i test sono
  // `client/src/components/Layout/hooks/groupOps.test.ts` (bun:test, 13 casi
  // sull'implementazione che l'app esegue davvero).


  test.describe("Panel splitting", () => {
    let splitTopicIds: string[] = [];

    test.beforeAll(async ({ request }) => {
      // Create test topics for split tests
      const t1 = await createTopic(request, "E2E-Split-A");
      const t2 = await createTopic(request, "E2E-Split-B");
      const t3 = await createTopic(request, "E2E-Split-C");
      splitTopicIds = [t1.id, t2.id, t3.id];
    });

    test.afterAll(async ({ request }) => {
      for (const id of splitTopicIds) {
        await deleteTopic(request, id);
      }
    });

    /** Open two topics so both appear as tabs */
    async function openTwoTopics(page: Page) {
      const [idA, idB] = splitTopicIds;
      // 0. Make the pane-store AUTHORITATIVE for this spec. Without it the file
      // inherited whatever workspace the previous spec left behind (the store
      // UNIONs on hydrate), so these tests saw foreign panes and their
      // "the first/only tab" assumptions broke — green alone, red in a full
      // suite run. Same pattern spaces-switcher.spec uses, which is stable.
      await resetPaneStore(page.request, [idA, idB]);
      // 1. Seed server state with both panels open
      await Promise.all([
        page.request.put(`${E2E_BASE}/api/ui-state/panels`, {
          data: { openPanels: [idA, idB] },
        }).catch(() => {}),
        page.request.put(`${E2E_BASE}/api/ui-state/grid-layout`, {
          data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
        }).catch(() => {}),
        page.request.put(`${E2E_BASE}/api/ui-state/panel-order`, {
          data: { order: [idA, idB], pinned: [idA, idB] },
        }).catch(() => {}),
      ]);
      // 2. Navigate — app loads both panels from server
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await collapseSidebarSections(page);
      // Entrambe le tab seminate devono essere renderizzate: gli 800ms fissi
      // aspettavano la seconda senza dirlo, e su una run lenta lo split partiva
      // da una tab sola (gruppo a pane singola = no-op).
      await expect
        .poll(() => page.locator('[role="main"] [draggable="true"]').count(), { timeout: 10000 })
        .toBeGreaterThanOrEqual(2);
    }

    test("GRID-01: Split Right via context menu creates side-by-side panels", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      const initialColDividers = await countColDividers(page);

      await splitViaContextMenu(page, 'Dividi a destra');

      // After split, should have more col-resize dividers
      const afterColDividers = await countColDividers(page);
      expect(afterColDividers, 'Split Right should create a col-resize divider').toBeGreaterThan(initialColDividers);

      // Should have multiple tab bar regions (standalone group + solo panel)
      const tabBars = page.locator('[role="main"] [data-testid="panel-tab-bar"]');
      expect(await tabBars.count(), 'Should have multiple tab bars after split').toBeGreaterThanOrEqual(2);
    });

    test("GRID-02: Split Down via context menu creates above/below panels", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      const initialRowDividers = await countRowDividers(page);

      await splitViaContextMenu(page, 'Dividi in basso');

      // After split, should have more row-resize dividers
      const afterRowDividers = await countRowDividers(page);
      expect(afterRowDividers, 'Split Down should create a row-resize divider').toBeGreaterThan(initialRowDividers);
    });

    test("GRID-02b: Split Down survives a page reload (persistence) @nightly", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (persistence)" });
      await goToApp(page);
      await openTwoTopics(page);
      await splitViaContextMenu(page, 'Dividi in basso');

      // Capture localStorage before reload — should now contain `cellStacks`.
      const before = await page.evaluate(() =>
        localStorage.getItem('topics-panel-grid-layout'),
      );
      expect(before, 'split-down should have written cellStacks to localStorage').toBeTruthy();
      expect(before!, 'cellStacks key must be present in saved layout').toContain('cellStacks');

      await page.reload({ waitUntil: 'load' });
      // Era waitForTimeout(2000) per "far sedimentare" l'effetto di sync post
      // hydrate: si aspetta il RISULTATO, non una durata. Esce appena la chiave
      // ricompare, e fallisce con lo stesso messaggio se non ricompare mai.
      await expect
        .poll(
          () => page.evaluate(() => localStorage.getItem('topics-panel-grid-layout')),
          { message: 'cellStacks key must survive reload', timeout: 10_000 },
        )
        .toContain('cellStacks');
    });

    test("GRID-03: Resize split panels by dragging col-resize divider", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split right to ensure we have a col divider
      await splitViaContextMenu(page, 'Dividi a destra');

      const divider = page.locator('[role="main"] .cursor-col-resize').first();
      await expect(divider).toBeVisible({ timeout: 3000 });

      const box = await divider.boundingBox();
      expect(box).not.toBeNull();

      // Record initial divider X position
      const initialX = box!.x;

      // Drag the divider 100px to the right
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2, { steps: 10 });
      await page.mouse.up();

      // Il reflow non ha un evento: si polla la posizione finché non si è
      // spostata (era waitForTimeout(300)). Se non si sposta mai il messaggio
      // riporta di quanti pixel si è mossa, non un booleano nudo.
      await expect
        .poll(async () => Math.abs(((await divider.boundingBox())?.x ?? initialX) - initialX), {
          message: 'Divider should have moved after drag',
          timeout: 5000,
        })
        .toBeGreaterThan(30);
    });

    test("GRID-03b: Resize split panels by dragging row-resize divider", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split down to ensure we have a row divider
      await splitViaContextMenu(page, 'Dividi in basso');

      const divider = page.locator('[role="main"] .cursor-row-resize').first();
      await expect(divider).toBeVisible({ timeout: 3000 });

      const box = await divider.boundingBox();
      expect(box).not.toBeNull();

      const initialY = box!.y;

      // Drag the divider 80px down
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 80, { steps: 10 });
      await page.mouse.up();

      await expect
        .poll(async () => Math.abs(((await divider.boundingBox())?.y ?? initialY) - initialY), {
          message: 'Row divider should have moved after drag',
          timeout: 5000,
        })
        .toBeGreaterThan(20);
    });

    test("GRID-07: double-click col-resize divider equalizes the two columns", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (equalize)" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split right → two side-by-side columns with one col-resize divider.
      await splitViaContextMenu(page, 'Dividi a destra');

      const cells = page.locator('[role="main"] [data-panel-cell]');
      await expect(cells).toHaveCount(2, { timeout: 3000 });
      const widthOf = async (i: number) => {
        const b = await cells.nth(i).boundingBox();
        if (!b) throw new Error(`cell ${i} has no bounding box`);
        return b.width;
      };

      const divider = page.locator('[role="main"] .cursor-col-resize').first();
      await expect(divider).toBeVisible({ timeout: 3000 });

      // 1. Drag the divider well off-center so the two columns are clearly unequal.
      const box = await divider.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 160, box!.y + box!.height / 2, { steps: 10 });
      await page.mouse.up();

      await expect
        .poll(async () => Math.abs((await widthOf(0)) - (await widthOf(1))), {
          message: 'columns should be unequal after dragging the divider',
          timeout: 5000,
        })
        .toBeGreaterThan(80);

      // 2. Double-click the divider → equalize. (No drag movement, so useGridResize
      //    treats it as a click, not a resize, and onDoubleClick → equalizeHorizontal
      //    fires — the wiring under test. For two plain chats the weights are [1,1],
      //    so it resolves to a 50/50 split.)
      const dBox = await divider.boundingBox();
      expect(dBox).not.toBeNull();
      await page.mouse.dblclick(dBox!.x + dBox!.width / 2, dBox!.y + dBox!.height / 2);

      // 3. The two columns should now be approximately equal width.
      await expect
        .poll(async () => Math.abs((await widthOf(0)) - (await widthOf(1))), {
          message: 'double-click should equalize the two columns to ~50/50',
          timeout: 5000,
        })
        .toBeLessThan(30);
    });

    test("GRID-08: double-click row-resize divider equalizes the two rows", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (equalize)" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split down → two stacked rows with one row-resize divider.
      await splitViaContextMenu(page, 'Dividi in basso');

      const divider = page.locator('[role="main"] .cursor-row-resize').first();
      await expect(divider).toBeVisible({ timeout: 3000 });

      // Measure the row-band heights via the divider's offset within the main area.
      const main = page.locator('[role="main"]');
      const mainBox = await main.boundingBox();
      expect(mainBox).not.toBeNull();
      const topHeight = async () => {
        const b = await divider.boundingBox();
        if (!b) throw new Error('divider has no bounding box');
        return b.y - mainBox!.y; // distance from main top to the divider = top row height
      };

      // 1. Drag the divider well off-center so the two rows are clearly unequal.
      const box = await divider.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 120, { steps: 10 });
      await page.mouse.up();

      const half = mainBox!.height / 2;
      await expect
        .poll(async () => Math.abs((await topHeight()) - half), {
          message: 'top row should be clearly off 50% after drag',
          timeout: 5000,
        })
        .toBeGreaterThan(60);

      // 2. Double-click the divider → equalizeVertical (weights [1,1] → 50/50).
      const dBox = await divider.boundingBox();
      expect(dBox).not.toBeNull();
      await page.mouse.dblclick(dBox!.x + dBox!.width / 2, dBox!.y + dBox!.height / 2);

      // 3. The divider should return to ~the vertical midpoint (equal row heights).
      await expect
        .poll(async () => Math.abs((await topHeight()) - half), {
          message: 'double-click should equalize the two rows to ~50/50',
          timeout: 5000,
        })
        .toBeLessThan(40);
    });

    test("GRID-04: Split layout persists after page reload @nightly", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openTwoTopics(page);

      // Split right to create a col divider
      await splitViaContextMenu(page, 'Dividi a destra');

      const preDividers = await countColDividers(page);
      expect(preDividers, 'Should have at least 1 col divider before reload').toBeGreaterThanOrEqual(1);

      // Reload and wait for layout restore. Era waitForTimeout(3000) — il
      // segnale reale è che i divider siano tornati, che è anche l'asserzione.
      await page.reload({ waitUntil: 'load' });
      await expect
        .poll(() => countColDividers(page), {
          message: 'Col dividers should persist after reload',
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(preDividers);

      // Also verify localStorage has grid layout data
      const layoutData = await page.evaluate(() => localStorage.getItem('topics-panel-grid-layout'));
      if (layoutData) {
        expect(layoutData, 'Layout data should contain grid rows').toContain('gridRows');
      }
    });

    test("GRID-05: Splitting works in project windows", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      // `openProject` invece della navigazione a mano della sidebar: la versione
      // scritta a mano qui non trovava più la riga del progetto e il test usciva
      // da un `test.skip()` muto — verde in mezzo agli altri, e questo AC non
      // veniva verificato da mesi senza che nulla diventasse rosso. L'helper
      // ri-semina la pane e ricarica quando la riga manca, che è esattamente la
      // ragione per cui i test che lo usano passano.
      await openProject(page, /e2e-grid/);

      // La tab DEVE esserci: se una finestra progetto si apre senza tab è un
      // difetto del prodotto, non una condizione dell'ambiente da saltare.
      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await expect(tab, "una finestra progetto aperta deve avere almeno una tab").toBeVisible({
        timeout: 10_000,
      });

      // Right-click on a project tab
      await tab.click({ button: 'right' });

      // Check if context menu appears
      const ctxMenu = page.getByRole('menu').last();
      await expect(ctxMenu).toBeVisible({ timeout: 3000 });

      const menuText = await ctxMenu.textContent();
      expect(menuText).toBeTruthy();

      // Split options are only for chat panes (per Plan 01), so verify project tabs have context menu
      // but may not have split actions
      await page.keyboard.press('Escape');
    });

    test("GRID-06: Context menu shows Split Right and Split Down for chat panes", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await collapseSidebarSections(page);
      await openTopic(page, /E2E-Split-A/);

      // Right-click on a chat tab
      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await expect(tab).toBeVisible({ timeout: 5000 });
      await tab.click({ button: 'right' });

      // Wait for context menu
      const ctxMenu = page.getByRole('menu').last();
      await expect(ctxMenu).toBeVisible({ timeout: 3000 });

      // Verify both split options are present
      await expect(ctxMenu.getByText('Dividi a destra')).toBeVisible();
      await expect(ctxMenu.getByText('Dividi in basso')).toBeVisible();

      // Close the menu
      await page.keyboard.press('Escape');
    });

    // BUCO NOTO — «GRID-01/02: DnD edge-drop creates split» non esiste.
    //
    // Qui c'era un test il cui corpo era la sola riga `test.fixme()`: nessun
    // drag, nessuna asserzione, il parametro `page` mai usato. Compariva nel
    // report come "skipped" e si annotava da sé la copertura di LAYOUT-01, che
    // e' il danno vero — un buco che si presenta come una casella spuntata.
    // Rimosso il 05/08/2026: un'assenza dichiarata si vede, uno stub perenne no.
    //
    // Il motivo per cui non e' scritto e' reale e documentato altrove: il
    // drop su bordo passa dagli eventi di drag HTML5, che in Playwright headless
    // non arrivano a dnd-kit — vedi il `test.fixme` con la sua spiegazione in
    // `layout-edge-cases.spec.ts` (DnD fra gruppi). Servirebbe una sequenza di
    // pointer event costruita a mano per dnd-kit: finche' non c'e', questo
    // percorso resta scoperto e va detto.
    //
    // Quello che invece E' coperto, e passa: lo split via menu contestuale
    // (GRID-01 e GRID-02 qui sopra), il raggruppamento per drop dalla sidebar
    // (GRID-GROUP) e i MIME type impostati sul drag di ogni tab.

    test("GRID-09: 'Reimposta pannelli' collapses the standalone grid to one tabbed cell", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (flatten)" });
      await goToApp(page);
      await openTwoTopics(page);

      // Nest the layout: Split Down creates a vertical sub-stack (cellStack).
      await splitViaContextMenu(page, 'Dividi in basso');
      expect(await countRowDividers(page), 'Split Down should create a row divider').toBeGreaterThanOrEqual(1);

      // The tabs we own in this test (union-hydrate may carry residue from
      // earlier tests in the shared DB, so exact counts are not hermetic —
      // assert on OUR topics surviving instead).
      const labelsBefore = await getVisibleTabLabels(page);
      expect(labelsBefore.some(l => /E2E-Split-A/.test(l)), 'topic A visible before reset').toBe(true);
      expect(labelsBefore.some(l => /E2E-Split-B/.test(l)), 'topic B visible before reset').toBe(true);

      // Right-click a tab → "Reimposta pannelli" is offered on a nested layout.
      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await tab.click({ button: 'right' });
      const resetBtn = page.getByText('Reimposta pannelli', { exact: true });
      await expect(resetBtn, 'nested layout must offer Reimposta pannelli').toBeVisible({ timeout: 3000 });
      await resetBtn.click();

      // Reset semantics (since abfa87f9): every split dissolves and ALL tabs
      // collapse into ONE tabbed cell — no dividers of either axis remain.
      // Pollato invece di atteso a tempo: il reset è l'unica cosa che può far
      // scendere il conteggio, quindi la condizione è il segnale.
      await expect
        .poll(async () => (await countRowDividers(page)) + (await countColDividers(page)), {
          message: 'reset should remove every divider, both axes',
          timeout: 5000,
        })
        .toBe(0);

      // Our panes are not closed: both topics live on as tabs of the single cell.
      const labelsAfter = await getVisibleTabLabels(page);
      expect(labelsAfter.some(l => /E2E-Split-A/.test(l)), 'topic A must survive the reset').toBe(true);
      expect(labelsAfter.some(l => /E2E-Split-B/.test(l)), 'topic B must survive the reset').toBe(true);
      expect(await page.locator('[role="main"] [data-panel-cell]').count(), 'reset collapses to a single cell').toBe(1);

      // Persistence: the flat layout survives a reload (written through the
      // usePanelGridPersistence debounced writer, restored by its sanitizers).
      await page.reload({ waitUntil: 'load' });
      // Era waitForTimeout(2000): il layout è ripristinato quando le tab sono
      // tornate, non dopo un tempo fisso.
      await expect
        .poll(() => getVisibleTabLabels(page).then(l => l.length), {
          message: 'le tab devono tornare dopo il reload',
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      expect(await countRowDividers(page), 'flat layout must persist across reload').toBe(0);
      const labelsReloaded = await getVisibleTabLabels(page);
      expect(labelsReloaded.some(l => /E2E-Split-A/.test(l)), 'topic A must persist across reload').toBe(true);
      expect(labelsReloaded.some(l => /E2E-Split-B/.test(l)), 'topic B must persist across reload').toBe(true);

      // Already flat → the menu entry is hidden.
      const tabAfter = page.locator('[role="main"] [draggable="true"]').first();
      await tabAfter.click({ button: 'right' });
      const ctxMenu = page.getByRole('menu').last();
      await expect(ctxMenu).toBeVisible({ timeout: 3000 });
      await expect(ctxMenu.getByText('Reimposta pannelli', { exact: true }), 'menu entry must hide on a flat layout').toHaveCount(0);
      await page.keyboard.press('Escape');
    });

    test("GRID-GROUP: dropping a sidebar topic onto a pane opens & groups it (raggruppa da sidebar)", async ({ page, request }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (sidebar-drop group)" });
      const idA = splitTopicIds[0];
      // A FRESH sidebar-only topic (raw POST — NOT seeded into openPanels/pane-
      // store like createTopic does), so it starts CLOSED and can't be residue.
      const dropName = `E2E-DropGroup-${Date.now()}`;
      const res = await request.post(`${E2E_BASE}/api/topics`, { data: { name: dropName }, ignoreHTTPSErrors: true });
      const idDrop = ((await res.json()) as { id: string }).id;

      // Ensure topic A is open so there's a target cell (its own tab).
      await page.request.put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: [idA] } }).catch(() => {});
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      const cell = page.locator('[role="main"] [draggable="true"]').first();
      await cell.waitFor({ state: "visible", timeout: 10000 });

      expect((await getVisibleTabLabels(page)).some(l => l.includes(dropName)), 'fresh topic must NOT be a tab yet').toBe(false);

      // Synthesize the sidebar drag's DROP onto the pane cell: a PANEL_ID(idDrop)
      // payload dragged onto the cell must OPEN the topic and add it as a tab
      // (grouping it into the main pool). Dispatched on a child inside the cell so
      // the cell's capture-phase drag handlers fire (they key on PANEL_ID).
      await cell.evaluate((el, topicId) => {
        const dt = new DataTransfer();
        dt.setData('application/x-panel-id', topicId);
        for (const type of ['dragenter', 'dragover', 'drop'] as const) {
          el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        }
      }, idDrop);

      await expect
        .poll(async () => (await getVisibleTabLabels(page)).some(l => l.includes(dropName)), { timeout: 6000 })
        .toBe(true);
      await deleteTopic(request, idDrop).catch(() => {});
    });

    test("GRID-10: 'Reimposta pannelli' flattens a project window's internal splits", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01 (flatten, project)" });
      await goToApp(page);
      // Stessa storia di GRID-05: la navigazione a mano della sidebar non
      // trovava più la riga del progetto e il test spariva in un `test.skip()`
      // muto. L'helper ri-semina e ricarica quando serve.
      await openProject(page, /e2e-grid/);

      // Split a project-internal tab down → a cellStack inside GroupLayout.
      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await expect(tab, "una finestra progetto aperta deve avere almeno una tab").toBeVisible({
        timeout: 10_000,
      });
      await tab.click({ button: 'right' });
      const ctxMenu = page.getByRole('menu').last();
      await expect(ctxMenu).toBeVisible({ timeout: 3000 });
      const splitDown = ctxMenu.getByText('Dividi in basso', { exact: true });
      await expect(
        splitDown,
        "il menu contestuale di una tab di progetto deve offrire «Dividi in basso»: senza, non c'è niente da appiattire e questo AC non è verificabile",
      ).toBeVisible({ timeout: 3000 });
      await splitDown.click();
      // Cliccato «Dividi in basso», il divisore DEVE comparire. Prima qui c'era
      // un `test.skip()` che chiamava "no-op" la mancata comparsa: cioè il modo
      // esatto in cui una divisione rotta si sarebbe travestita da test verde.
      await expect(
        page.locator('[role="main"] .cursor-row-resize').first(),
        "dopo «Dividi in basso» deve comparire il divisore di riga",
      ).toBeVisible({ timeout: 5000 });

      // Scope the invariant to the PROJECT window's own tabs. The reset event
      // is global: it may legitimately purge a project-bound topic that was
      // squatting as a STANDALONE tab (the PURGE_ORPHAN_PANE enforcement), so
      // page-wide label counts are not a valid oracle here.
      const projectTabLabels = async (): Promise<string[]> => {
        const tabs = page.locator('[data-testid="project-window"] [data-testid="pane-tab-label"]');
        const n = await tabs.count();
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const t = await tabs.nth(i).textContent();
          if (t) out.push(t.trim());
        }
        return out.sort();
      };
      const labelsBefore = await projectTabLabels();

      // Flatten from any project tab's context menu.
      const anyTab = page.locator('[role="main"] [draggable="true"]').first();
      await anyTab.click({ button: 'right' });
      const resetBtn = page.getByText('Reimposta pannelli', { exact: true });
      await expect(resetBtn, 'project window with a stack must offer Reimposta pannelli').toBeVisible({ timeout: 3000 });
      await resetBtn.click();

      await expect
        .poll(() => countRowDividers(page), {
          message: 'project flatten should remove row dividers',
          timeout: 5000,
        })
        .toBe(0);
      // Set equality (order-insensitive), polled past the reflow: a lost
      // project tab shows up as an explicit diff of WHICH label vanished.
      await expect
        .poll(projectTabLabels, {
          message: 'project flatten must not close project tabs',
          timeout: 7000,
        })
        .toEqual(labelsBefore);
    });
  });

  test.describe("DnD MIME types", () => {
    test("all pane tabs set PANE_TAB on drag", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      // Open the self-provisioned project to ensure we have draggable tabs
      await openProject(page, /e2e-grid/);

      const draggableTabs = page.locator('[role="main"] [draggable="true"]');
      const count = await draggableTabs.count();
      expect(count, 'Should have at least one draggable tab').toBeGreaterThan(0);
    });

    test("tabs within project window are draggable", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
      await goToApp(page);
      await openProject(page, /e2e-grid/);

      const draggableTabs = page.locator('[role="main"] [draggable="true"]');
      const count = await draggableTabs.count();
      expect(count, 'Project window should have draggable tabs').toBeGreaterThan(0);
    });
  });
});
