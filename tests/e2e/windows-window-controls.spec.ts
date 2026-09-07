/**
 * THE THREE WINDOWS COMMANDS, MEASURED IN PIXELS.
 *
 * On Windows the system frame is off and the app draws close, minimise and
 * maximise itself, on the Topics button, with the Mac's anchor and the Mac's
 * order (WINCTL-01). Until now nothing could check how that cluster LOOKS
 * outside a Windows build: the unit test next to the component pins the classes
 * and the arithmetic, which proves that a number equals itself, not that two
 * cells are apart on screen.
 *
 * Two things make it measurable from a plain Chromium: `?windowChrome=windows`
 * forces the Windows geometry (see `windowChrome.ts`) and the component now
 * mounts under that override as well, inert, because what the override is for is
 * exactly this measurement.
 *
 * WHAT WAS WRONG, and why "they look fine at rest" was not an answer. The cells
 * were adjacent: 18px wide at 12, 30 and 48. The ink inside them is a 10px
 * glyph, so two glyphs sat 8px apart, the same air the Mac keeps between two
 * dots, and a still frame looked right. But the cell is a hit target that FILLS
 * with colour under the pointer, and three touching rectangles read as one slab
 * the moment the first one lights up. Reported from a Windows build
 * (card 6df97deb): the commands are not spaced.
 *
 * @covers WINCTL-01
 */
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** `WINDOW_CONTROLS_INSET_PX`: where the first command starts in the window. */
const ANCHOR = 12;
/** One cell, a hit target, `h-[18px] w-[18px]`. */
const CELL = 18;
/** `WINDOW_CONTROL_CELL_GAP_PX`: the air a lit cell needs not to touch its
 *  neighbour. Written out here rather than imported: a test that imports the
 *  constant it verifies proves only that the constant equals itself. */
const AIR = 4;
/** `ROW_INSET`, the row's own step, between the cluster and the word. */
const GAP = 6;
/** Sub-pixel layout rounds; the cells do not. */
const TOL = 1;

const CELLS = ['[data-testid="win-close"]', '[data-testid="win-minimize"]', '[data-testid="win-maximize"]'];
const TITLE = '[data-testid="sidebar-topics-title"]';

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return box;
}

test.describe("The Windows window commands", () => {
  test("three cells, apart, anchored where the Mac's lights are", async ({ page }) => {
    await page.goto("/?windowChrome=windows");
    await page.waitForSelector(CELLS[0], { state: "visible", timeout: 15_000 });

    const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const selector of CELLS) boxes.push(await boxOf(page, selector));

    expect(Math.abs(boxes[0].x - ANCHOR), `il primo comando parte a ${boxes[0].x}, non a ${ANCHOR}`).toBeLessThanOrEqual(TOL);
    for (const b of boxes) {
      expect(Math.abs(b.width - CELL), "una cella non e' piu' un bersaglio da 18px").toBeLessThanOrEqual(TOL);
      expect(Math.abs(b.height - CELL), "una cella non e' piu' un bersaglio da 18px").toBeLessThanOrEqual(TOL);
    }

    // THE DEFECT, in one line: the air between two adjacent cells.
    for (let i = 1; i < boxes.length; i++) {
      const air = boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width);
      expect(
        air,
        `fra la cella ${i} e la ${i + 1} ci sono ${air}px: attaccate, al primo hover diventano un blocco solo`,
      ).toBeGreaterThanOrEqual(AIR - TOL);
    }
  });

  test("the word starts after the cluster, with the row's own breathing space", async ({ page }) => {
    await page.goto("/?windowChrome=windows");
    await page.waitForSelector(TITLE, { state: "visible", timeout: 15_000 });

    const last = await boxOf(page, CELLS[CELLS.length - 1]);
    const title = await boxOf(page, TITLE);
    const air = title.x - (last.x + last.width);
    expect(
      air,
      `fra l'ultimo comando e la parola «Topics» ci sono ${air}px: il gruppo dei comandi e la parola si leggono come uno solo`,
    ).toBeGreaterThanOrEqual(GAP - TOL);
  });
});
