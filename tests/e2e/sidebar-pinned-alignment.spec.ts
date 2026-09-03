import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

/**
 * THE ALIGNMENT OF THE PINNED BLOCK, MEASURED INSTEAD OF LOOKED AT.
 *
 * The report: pinned tiles look "pushed to the right" when the sidebar has
 * spare width, and stacked tiles do not read as centred. Three pixels are not
 * seen, they are measured, so this file walks a matrix (three sidebar widths by
 * one, two, three and five tiles, in the two shapes the block can take) and
 * checks the three things the report is actually about:
 *
 *   1. ROW FORM STARTS WHERE THE COLUMN STARTS. A tile alone on its row is a
 *      row: its ink must begin at the same x as the ink of a normal row of the
 *      list underneath it.
 *   2. THE BLOCK IS CENTRED IN THE SIDEBAR. Left and right margins of a row of
 *      tiles, equal within a pixel.
 *   3. NOBODY IS PUSHED RIGHT. Inside a tile the air on the left never exceeds
 *      the air on the right: that asymmetry IS the complaint.
 *
 * The numbers also land in `test-results/pinned-alignment.json`, so the bench
 * is readable without re-reading the run.
 */

hermetic(test);

const created: string[] = [];

/** Sidebar widths the matrix walks: narrow, medium, wide. The app clamps the
 *  drag to 180-400, so all three are reachable by hand. */
const WIDTHS = [190, 260, 380];
/** How many tiles are pinned. Five is enough to make the row squeeze. */
const COUNTS = [1, 2, 3, 5];
/** The shared glyph box of the column (ROW_GLYPH_SLOT, 18px) plus the row gap:
 *  a pinned tile carries an icon where a chat row carries none, and that is the
 *  whole difference the two are allowed to have. */
const GLYPH_SLOT = 18 + 8;
/** The accordion column a top-level row reserves and a tile does not: the
 *  chevron box (`w-3`, 12px, with its `-mr-1`) plus the row gap (`gap-2`). */
const ACCORDION_COLUMN = 12 - 4 + 8;

/** `stacked` = one tile per row, so every row holds one tile and takes the ROW
 *  form. `packed` = every tile on the same row, which is the GRID form. */
type Shape = "stacked" | "packed";

interface Cell {
  width: number;
  count: number;
  shape: Shape;
  sidebar: number;
  /** Tile card left minus normal row card left. */
  cardDelta: number;
  /** Tile ink left minus normal row ink left. Reported, NOT asserted: the ink
   *  legitimately differs with the icon (a 14px glyph centred in the shared
   *  18px box paints 2px inside it, a favicon fills it), which is true of the
   *  column's own rows too. */
  inkDelta: number;
  /** THE COLUMN THAT MATTERS: where the content starts once the accordion box
   *  is out of the way, on the tile and on a normal row. A row is read inside a
   *  column, so these two must be the same pixel. */
  leadDelta: number;
  /** Left and right margin of the first row of tiles inside the sidebar. */
  blockLeft: number;
  blockRight: number;
  /** Air left of the ink and right of the ink, inside the first tile. */
  airLeft: number;
  airRight: number;
  /** The same air on the left, measured on a normal row of the column: in row
   *  form THAT is the number the tile has to match, because a row is read
   *  inside a column and the column reserves the same leading boxes. */
  rowAirLeft: number;
}

/** Pin a list of ids by writing the sidebar state directly: what is under test
 *  here is the GEOMETRY, not the gesture that produced it. */
async function setPins(page: Page, ids: string[], layout: string[][]): Promise<void> {
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: {
      viewMode: "timeline",
      showArchived: false,
      expandedNodes: [],
      pinnedItems: ids,
      pinnedLayout: layout.map(keys => ({ keys, widths: keys.map(() => 1 / keys.length) })),
    },
  });
}

/** The sidebar width is device-local (see DEVICE_LOCAL_SETTING_KEYS): it lives
 *  in localStorage and the server never sends it back, so seeding the key
 *  before the first paint is the whole story. */
async function openAt(page: Page, width: number): Promise<void> {
  await page.addInitScript((w: number) => {
    const raw = localStorage.getItem("app-settings");
    const cur: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    cur.sidebarWidth = w;
    cur.sidebarCollapsed = false;
    localStorage.setItem("app-settings", JSON.stringify(cur));
  }, width);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

/**
 * SETTLED, not immediate: the tiles animate (FLIP on the cells, a rotating
 * chevron). Every number here is taken when two consecutive frames agree on it.
 */
async function settled<T>(page: Page, take: () => Promise<T>): Promise<T> {
  let before = JSON.stringify(await take());
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    const now = await take();
    if (JSON.stringify(now) === before) return now;
    before = JSON.stringify(now);
  }
  throw new Error(`geometry never settles: last value ${before}`);
}

const section = (page: Page): Locator => page.getByTestId("sidebar-pinned-section");
const tiles = (page: Page): Locator => section(page).getByTestId("pinned-tile");

/**
 * THE INK, not the box: what you see inside a row or a tile is the icon and the
 * name, not the empty slots that travel with them. Mirrors and placeholders
 * exist precisely NOT to paint, so measuring them as content would call centred
 * what the eye reads as pushed.
 */
async function inkOf(page: Page, el: Locator): Promise<{ card: number; left: number; right: number; width: number }> {
  return settled(page, () => el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const painted: DOMRect[] = [];
    for (const child of Array.from(node.querySelectorAll("svg, img, span, div"))) {
      const cr = child.getBoundingClientRect();
      if (cr.width < 1 || cr.height < 1) continue;
      const cs = getComputedStyle(child);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.position === "absolute" || cs.position === "fixed") continue;
      // A container that does not paint by itself does not count: leaves do.
      const text = (child.textContent ?? "").trim().length > 0;
      const isLeaf = child.querySelector("svg, img, span") === null;
      if (child.tagName === "SVG" || child.tagName === "svg" || child.tagName === "IMG" || (text && isLeaf)) painted.push(cr);
    }
    if (painted.length === 0) return { card: r.left, left: r.left, right: r.right, width: r.width };
    return {
      card: r.left,
      left: Math.min(...painted.map(p => p.left)),
      right: Math.max(...painted.map(p => p.right)),
      width: r.width,
    };
  }));
}

/**
 * THE LEADING CONTENT COLUMN: the x where a row starts saying something, once
 * the accordion box (which every row reserves, empty or not) is out of the way.
 * It is the alignment the eye reads down the list, and unlike raw ink it does
 * not move with the icon a single row happens to carry.
 */
async function leadLeftOf(page: Page, el: Locator): Promise<number> {
  return settled(page, () => el.evaluate((node) => {
    for (const child of Array.from(node.children)) {
      if (child.matches("[data-row-chevron-slot], [data-testid='pinned-chevron-slot']")) continue;
      const cs = getComputedStyle(child);
      if (cs.position === "absolute" || cs.position === "fixed") continue;
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = child.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      return r.left;
    }
    return node.getBoundingClientRect().left;
  }));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

test.describe("Sidebar: the alignment of the pinned block", () => {
  test.describe.configure({ mode: "serial" });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("PINALIGN-01: the matrix, three widths by 1, 2, 3 and 5 tiles", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PINALIGN-01" });
    test.setTimeout(180_000);
    const stamp = Date.now();
    // The tiles of the matrix, plus two chats that stay UNPINNED: they are the
    // normal rows of the list, which is the reference column.
    const pinnable: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTopic(request, `E2E-Align-${i}-${stamp}`);
      created.push(t.id);
      pinnable.push(t.id);
    }
    for (let i = 0; i < 2; i++) {
      const t = await createTopic(request, `E2E-Align-Row-${i}-${stamp}`);
      created.push(t.id);
    }

    const cells: Cell[] = [];
    for (const width of WIDTHS) {
      for (const count of COUNTS) {
        const ids = pinnable.slice(0, count);
        const shapes: Array<{ name: Shape; rows: string[][] }> =
          count === 1
            ? [{ name: "stacked", rows: [ids] }]
            : [
                { name: "packed", rows: [ids] },
                { name: "stacked", rows: ids.map(id => [id]) },
              ];
        for (const { name, rows } of shapes) {
          await setPins(page, ids, rows);
          const fresh = await page.context().newPage();
          try {
            await openAt(fresh, width);
            await expect(fresh.getByTestId("pinned-tile")).toHaveCount(count, { timeout: 15000 });

            const sidebarBox = (await fresh.locator('[aria-label="Topics sidebar"]').boundingBox())!;
            const tile = tiles(fresh).first();
            const tileInk = await inkOf(fresh, tile);

            // The reference row: one of the chats this test left UNPINNED, so
            // it is a row of the same kind as the tiles (same glyph, same
            // boxes). Picking "the first treeitem" would sometimes land on a
            // project row, whose favicon sits in the slot differently, and the
            // comparison would measure the icon instead of the alignment.
            const normalRow = fresh
              .locator('[role="treeitem"]:not([data-pinned="true"])')
              .filter({ hasText: `E2E-Align-Row-0-${stamp}` })
              .first();
            await expect(normalRow).toBeVisible({ timeout: 15000 });
            const rowInk = await inkOf(fresh, normalRow);
            const tileLead = await leadLeftOf(fresh, tile);
            const rowLead = await leadLeftOf(fresh, normalRow);

            // The BLOCK is what is painted, not the container: the row div is
            // full bleed and its own box would say "centred" whatever the tiles
            // inside it do.
            const rowBox = await settled(fresh, () =>
              fresh.getByTestId("pinned-row").first().evaluate((n) => {
                const rects = Array.from(n.querySelectorAll('[data-testid="pinned-tile"]'))
                  .map(k => k.getBoundingClientRect());
                if (rects.length === 0) {
                  const r = n.getBoundingClientRect();
                  return { left: r.left, right: r.right };
                }
                return {
                  left: Math.min(...rects.map(r => r.left)),
                  right: Math.max(...rects.map(r => r.right)),
                };
              }));

            cells.push({
              width,
              count,
              shape: name,
              sidebar: round1(sidebarBox.width),
              cardDelta: round1(tileInk.card - rowInk.card),
              inkDelta: round1(tileInk.left - rowInk.left),
              leadDelta: round1(tileLead - rowLead),
              blockLeft: round1(rowBox.left - sidebarBox.x),
              blockRight: round1(sidebarBox.x + sidebarBox.width - rowBox.right),
              airLeft: round1(tileInk.left - tileInk.card),
              airRight: round1(tileInk.card + tileInk.width - tileInk.right),
              rowAirLeft: round1(rowInk.left - rowInk.card),
            });
          } finally {
            await fresh.close();
          }
        }
      }
    }

    const table = cells.map(c =>
      `w=${c.width}(${c.sidebar}) n=${c.count} ${c.shape.padEnd(7)} card=${c.cardDelta} lead=${c.leadDelta} ink=${c.inkDelta} block=[${c.blockLeft}|${c.blockRight}] air=[${c.airLeft}|${c.airRight}] rowAir=${c.rowAirLeft}`,
    );
    console.log(["", "PINALIGN matrix", ...table, ""].join("\n"));
    const out = path.join(process.cwd(), "test-results");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "pinned-alignment.json"), JSON.stringify(cells, null, 2));

    // 1. ROW FORM STARTS WHERE THE COLUMN STARTS, card and content column.
    for (const c of cells.filter(x => x.shape === "stacked")) {
      expect(
        Math.abs(c.cardDelta),
        `w=${c.width} n=${c.count}: the tile card starts ${c.cardDelta}px away from the column`,
      ).toBeLessThanOrEqual(1);
      // The content of a row tile starts ONE accordion column before the
      // content of a top-level row: since card 058ea722 (2026-09-03) a pinned
      // tile reserves no accordion box in either form (the pinned block is
      // not the tree, nothing beside a tile opens in that column), while the
      // top-level row it is compared with still reserves the box beside the
      // project rows (LAYOUT-26).
      expect(
        Math.abs(c.leadDelta + ACCORDION_COLUMN),
        `w=${c.width} n=${c.count}: the tile content starts ${c.leadDelta}px away from the column, ` +
          `expected -${ACCORDION_COLUMN} (no accordion box on a tile)`,
      ).toBeLessThanOrEqual(1);
    }
    // 2. THE BLOCK IS CENTRED in the sidebar, at every width and in every shape.
    for (const c of cells) {
      expect(
        Math.abs(c.blockLeft - c.blockRight),
        `w=${c.width} n=${c.count} ${c.shape}: block margins ${c.blockLeft} against ${c.blockRight}`,
      ).toBeLessThanOrEqual(1);
    }
    // THE EVIDENCE, taken at the widest sidebar with three stacked tiles: the
    // pinned block sits above the normal rows and the two share one leading
    // column, which is the whole point and the one thing a number cannot show.
    await setPins(page, pinnable.slice(0, 3), pinnable.slice(0, 3).map(id => [id]));
    const shot = await page.context().newPage();
    try {
      await openAt(shot, 380);
      await expect(shot.getByTestId("pinned-tile")).toHaveCount(3, { timeout: 15000 });
      const box = (await shot.locator('[aria-label="Topics sidebar"]').boundingBox())!;
      await shot.screenshot({
        path: path.join(out, "pinned-alignment.png"),
        clip: { x: box.x, y: box.y, width: box.width, height: Math.min(240, box.height) },
      });
    } finally {
      await shot.close();
    }

    // 3. NOBODY PUSHED RIGHT, and the form says against what.
    //    GRID: the identity takes the middle, so the two airs are the same.
    //    ROW: the tile is a row of the column, so its leading air is the one
    //    every other row has. Asking a row for symmetric air would condemn the
    //    reserved accordion box, which is exactly what keeps the list aligned.
    for (const c of cells) {
      if (c.shape === "packed") {
        expect(
          Math.abs(c.airLeft - c.airRight),
          `w=${c.width} n=${c.count} grid: inside the tile ${c.airLeft}px of air on the left against ${c.airRight} on the right`,
        ).toBeLessThanOrEqual(1);
      } else {
        // A row does not owe symmetry: it owes the column. Its leading air is
        // the accordion box every row reserves, so what has to hold is that it
        // does not exceed it by more than the shared glyph box.
        expect(
          c.airLeft - c.rowAirLeft,
          `w=${c.width} n=${c.count} row: ${c.airLeft}px of leading air against the ${c.rowAirLeft}px of a normal row`,
        ).toBeLessThanOrEqual(GLYPH_SLOT + 1);
      }
    }
  });
});
