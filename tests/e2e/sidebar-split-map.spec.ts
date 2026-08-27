/**
 * THE SPLIT SCHEMATIC IS ON THE ROW AND ON THE PINNED TILE, or it is on neither.
 *
 * The report: the split preview shows up on some sidebar entries and not on
 * others. The structural half - every row family calls the one component - is
 * held by `client/src/components/Sidebar/rowSplitMap.test.ts`, which is cheap
 * and can read families no fixture happens to render. What only a browser can
 * say is the other half, and it is the half that was broken twice in this area:
 * that the thing actually PAINTS where it was put. The pinned tile is a
 * `<button>`, and the map used to be built out of `<div>`s.
 *
 * The negative case is part of the subject, not politeness: with a single cell
 * there is nothing to orient against, and a map that showed up there would be a
 * badge saying "you are here" on an empty street.
 *
 * @covers LAYOUT-29
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { splitViaContextMenu } from "./helpers/layout";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Pin by writing the sidebar state: the subject is what the pinned tile
 *  SHOWS, not the gesture that pinned it. */
async function pin(page: Page, ids: string[]): Promise<void> {
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: {
      viewMode: "timeline",
      showArchived: false,
      expandedNodes: [],
      pinnedItems: ids,
      // One tile per layout row: alone on its row a tile takes the ROW form,
      // which is the form that is read inside the column and the only one that
      // carries the schematic.
      pinnedLayout: ids.map(id => ({ keys: [id], widths: [1] })),
    },
  });
}

test.describe("Sidebar: the split schematic", () => {
  test.describe.configure({ mode: "serial" });

  let fissata: { id: string; name: string };
  let inLista: { id: string; name: string };

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    fissata = await createTopic(request, `split-map-pinned-${stamp}`);
    inLista = await createTopic(request, `split-map-row-${stamp}`);
  });

  test.afterAll(async ({ request }) => {
    for (const t of [fissata, inLista]) {
      if (t?.id) await deleteTopic(request, t.id).catch(() => {});
    }
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("SPLITMAP-01: one cell shows no map, two cells show one on the row AND on the pinned tile", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-29" });
    await resetPaneStore(request, [fissata.id, inLista.id]);
    await pin(page, [fissata.id]);
    await goToApp(page);

    const tile = page.getByTestId("pinned-tile").first();
    const row = page.locator(`[role="treeitem"][aria-label="${inLista.name}"]`).first();
    await expect(tile).toBeVisible({ timeout: 20000 });
    await expect(row).toBeVisible({ timeout: 20000 });

    // ONE CELL: nothing to orient against, so nobody draws a map.
    await expect(tile.getByTestId("split-mini-map")).toHaveCount(0);
    await expect(row.getByTestId("split-mini-map")).toHaveCount(0);

    // TWO CELLS: both entries answer "where does this pane sit", and the pinned
    // tile answers it exactly like the row of the list under it.
    await splitViaContextMenu(page, "Dividi a destra", 1);
    await expect(tile.getByTestId("split-mini-map")).toHaveCount(1, { timeout: 15000 });
    await expect(row.getByTestId("split-mini-map")).toHaveCount(1, { timeout: 15000 });

    // AND IT IS PAINTED, not just present: a box of zero width is the failure
    // mode of a schematic dropped into a container that squeezes it.
    for (const map of [tile.getByTestId("split-mini-map"), row.getByTestId("split-mini-map")]) {
      const box = await map.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(8);
      expect(box?.height ?? 0).toBeGreaterThan(6);
    }
  });
});
