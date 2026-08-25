/**
 * Drop UX v2 — regression guards for the relative 5-zone hit model and the
 * two previously-dead gestures it unlocked:
 *
 *   1. RELATIVE geometry: a point ~15% from a cell's left edge is a LEFT
 *      split target. Under the old fixed-30px model that point (≈170px into
 *      a ~1100px cell) resolved to 'center' — the split targets were
 *      near-unhittable slivers hugging the borders.
 *   2. Tab drag over the pane-body CENTER paints the merge preview
 *      (data-grid-split-overlay="center"). It used to paint nothing and the
 *      drop was silently ignored.
 *   3. Tab drag over the body's top quarter paints the TOP (stack-above)
 *      region. It used to be routed to the tab bar and dropped on the floor.
 *
 * Same synthetic-dragover technique as tab-system-reliability.spec.ts: build
 * a DataTransfer carrying the PANE_TAB mime + the hashed standalone scope
 * marker, dispatch a real dragover, assert the overlay DOM. No drop is ever
 * dispatched — these tests only exercise the preview contract.
 *
 * @covers LAYOUT-01
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
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

/** djb2-xor hash → base36, mirroring client/src/lib/dndTypes.ts paneTabScopeType. */
function paneTabScopeType(scope: string): string {
  let h = 5381;
  for (let i = 0; i < scope.length; i++) h = (((h << 5) + h) ^ scope.charCodeAt(i)) >>> 0;
  return `application/x-pane-scope-${h.toString(36)}`;
}
const STANDALONE_SCOPE_TYPE = paneTabScopeType("main");

/** Dispatch dragenter+dragover with a standalone tab payload at (x, y). */
async function hoverTabDrag(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ x, y, scopeType }) => {
    const el = document.elementFromPoint(x, y)?.closest('[data-panel-cell]')
      ?? document.querySelector('[data-panel-cell]');
    if (!el) throw new Error('no [data-panel-cell] at point');
    const dt = new DataTransfer();
    dt.setData('application/x-pane-tab', 'probe-tab');
    dt.setData('application/x-panel-id', 'probe-topic');
    dt.setData('application/x-pane-tab-group', 'standalone');
    dt.setData(scopeType, '1');
    for (const type of ['dragenter', 'dragover'] as const) {
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
      }));
    }
  }, { x, y, scopeType: STANDALONE_SCOPE_TYPE });
}

test.describe("Drop zones v2", () => {
  // Le zone sono RELATIVE alla cella, quindi il test dipende dalla geometria:
  // il pane-store è unico per tutta la suite seriale e le pane lasciate aperte
  // dai file precedenti spezzano il layout in N celle, per cui `.first()` non è
  // più la cella larga ~1100px su cui sono calibrate le percentuali qui sotto.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("relative zones + center/top previews on a standalone cell", async ({ page, request }) => {
    const t1 = await createTopic(request, "DropZonesA");
    const t2 = await createTopic(request, "DropZonesB");

    try {
      await page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [t1.id, t2.id] },
      });
      await gotoAndWait(page);

      const cell = page.locator('[data-panel-cell]').first();
      await expect(cell).toBeVisible({ timeout: 10000 });
      const rect = await cell.boundingBox();
      if (!rect) throw new Error('cell has no bounding box');

      const overlay = page.locator('[data-grid-split-overlay]');
      const zoneAt = async (x: number, y: number): Promise<string | null> => {
        await hoverTabDrag(page, x, y);
        await expect(overlay).toBeVisible({ timeout: 3000 });
        return overlay.first().getAttribute('data-grid-split-overlay');
      };

      // 1. Relative geometry: 15% in from the left is a LEFT target (old
      //    model: 'center' past the 30px band → this line is THE regression
      //    guard for the v2 hit model).
      expect(await zoneAt(rect.x + rect.width * 0.15, rect.y + rect.height * 0.5)).toBe('left');

      // Mirror: 85% across is RIGHT.
      expect(await zoneAt(rect.x + rect.width * 0.85, rect.y + rect.height * 0.5)).toBe('right');

      // 2. Body middle = CENTER merge preview (used to paint nothing).
      expect(await zoneAt(rect.x + rect.width * 0.5, rect.y + rect.height * 0.5)).toBe('center');

      // 3. Body top quarter = TOP stack-above preview (used to be routed to
      //    the tab bar and dropped). y at 16% of the cell is well below the
      //    ~40px bar on a 700+px cell, so this is genuinely the body.
      expect(await zoneAt(rect.x + rect.width * 0.5, rect.y + rect.height * 0.16)).toBe('top');

      // Bottom quarter = stack-under, as before.
      expect(await zoneAt(rect.x + rect.width * 0.5, rect.y + rect.height * 0.86)).toBe('bottom');
    } finally {
      await deleteTopic(request, t1.id);
      await deleteTopic(request, t2.id);
    }
  });
});
