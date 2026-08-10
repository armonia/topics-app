/**
 * Layout / tab-bar test helpers shared across grid-split, layout-edge-cases,
 * regression-fixes, and split-screen-sync specs.
 *
 * Extracted from four near-identical copies (see git history) — keep this
 * the single source for these three so future specs don't re-fork them.
 */
import { type Page, expect } from "@playwright/test";

/** Count column-resize (horizontal split) dividers in the main content area. */
export async function countColDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] [data-resize-axis="col"]').count();
}

/**
 * I divisori si contano per ATTRIBUTO, non per classe del cursore.
 *
 * `.cursor-col-resize` è un suggerimento di CURSORE, e lo portano anche cose che
 * divisori non sono: il ridimensionatore della barra di progetto, le maniglie
 * dei pannelli. Contare la classe vuol dire contare quelli — ed è così che
 * GRID-09 è rimasto rosso per giorni su una griglia che il reset aveva ripulito
 * davvero: sopravviveva un `project-sidebar-resizer` largo 0×0, dentro una pane
 * tenuta viva e nascosta. Il rosso era vero e il difetto non c'era.
 *
 * `data-resize-axis` lo mettono i quattro divisori della GRIGLIA (SplitTree,
 * InsertDividers, CellSubStack) e nessun altro. NB: è distinto da
 * `data-split-divider`, che sullo SplitTree porta la direzione dello SPLIT —
 * invertita rispetto all'asse del trascinamento, perché uno split `row` si
 * ridimensiona in colonna.
 */
/** Count row-resize (vertical split) dividers in the main content area. */
export async function countRowDividers(page: Page): Promise<number> {
  return page.locator('[role="main"] [data-resize-axis="row"]').count();
}

/** Count the tab bars in the layout — one per cell, so one more after every split. */
export async function countTabBars(page: Page): Promise<number> {
  return page.locator('[data-testid="panel-tab-bar"]').count();
}

/** Get the text of every visible tab label across all tab bars in the main area. */
export async function getVisibleTabLabels(page: Page): Promise<string[]> {
  // `[data-testid="pane-tab-label"]` e non `.truncate.flex-1`: quelle due
  // utility di layout le porta ora anche una riga dell'albero dei file e una
  // riga di git, che vivono dentro `[role="main"]` — quindi il conteggio
  // includeva cose che non sono tab e i test «no duplicate tabs» diventavano
  // rossi su un'app corretta.
  const tabs = page.locator('[role="main"] [data-testid="pane-tab-label"]');
  const count = await tabs.count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await tabs.nth(i).textContent();
    if (text) labels.push(text.trim());
  }
  return labels;
}

/**
 * Chiude le sezioni Terminali / Browser / Progetti della sidebar, per far posto
 * alle chat nei test che contano le tab.
 *
 * Terza copia dello stesso ciclo (grid-split e split-screen-sync avevano la
 * loro), e tutte e tre aspettavano 300ms dopo il click. L'attesa vera è
 * `aria-expanded="false"`: è il bottone stesso a dire quando la sezione è
 * chiusa, e lo dice in millisecondi, non in 300.
 */
export async function collapseSidebarSections(page: Page): Promise<void> {
  for (const name of [/sezione Terminali/, /sezione Browser/, /sezione Progetti/]) {
    const btn = page.getByRole("button", { name });
    if ((await btn.count()) === 0) continue;
    if ((await btn.getAttribute("aria-expanded")) !== "true") continue;
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "false", { timeout: 5000 });
  }
}

/**
 * Right-click the tab at `tabIndex` (default: first) and pick "Dividi a destra"/
 * "Dividi in basso" from its context menu.
 *
 * The wait afterwards is CONDITIONAL, not a sleep: a split always carves one
 * cell into two, and every cell owns a tab bar, so the tab-bar count is the
 * one signal that holds for both directions and for nested splits alike
 * (the divider count does NOT — splitting inside an existing stack adds to it).
 * The old fixed `waitMs` settle was the flake in split-screen-sync's
 * "Multi-row multi-column" test: on a slow run the divider count was read
 * before the second split had landed, and 1 < 2 came out red.
 *
 * `timeoutMs` bounds that wait; callers that used a longer settle can raise it.
 */
export async function splitViaContextMenu(
  page: Page,
  direction: "Dividi a destra" | "Dividi in basso",
  tabIndex = 0,
  timeoutMs = 5000,
) {
  const before = await countTabBars(page);

  const tab = page.locator('[role="main"] [draggable="true"]').nth(tabIndex);
  await expect(tab).toBeVisible({ timeout: 5000 });
  await tab.click({ button: "right" });

  const splitBtn = page.getByText(direction, { exact: true });
  await expect(splitBtn).toBeVisible({ timeout: 3000 });
  await splitBtn.click();

  await expect
    .poll(() => countTabBars(page), {
      timeout: timeoutMs,
      message: `"${direction}" non ha prodotto una nuova cella (tab bar ferme a ${before})`,
    })
    .toBeGreaterThan(before);
}
