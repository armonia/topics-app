/**
 * ONE ACCORDION COLUMN IN THE SIDEBAR, measured in the live DOM.
 *
 * Reported on the board (card 150ebafb): a row without an accordion started
 * further left than a row that has one, so the same column carried two
 * alignments. The cause was a MISSING BOX, not a wrong number: the chevron was
 * rendered inside a condition with no else branch, so a row with nothing to
 * expand reserved nothing and its content began `ROW_CHEVRON_SLOT` (12px) plus
 * `ROW_GAP` (8px) left of its sister's.
 *
 * The verification is NOT by eye. Every row of the tree is read with
 * `getBoundingClientRect()`, and two things are demanded of the real layout:
 *
 *   1. every row OPENS with the accordion box, chevron or not, and the box is
 *      the same width on all of them;
 *   2. inside one depth level (rows share the same left edge) the content that
 *      follows the box starts at ONE left value, not two.
 *
 * The companion unit test, `client/src/components/Sidebar/rowChevronColumn.test.ts`,
 * covers the row families no fixture happens to render here.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** What one sidebar row is worth, read from the layout the browser computed. */
interface RowMetrics {
  /** Accessible name, only to make a red readable. */
  name: string;
  /** Left edge of the row card: rows of the same depth share it. */
  rowLeft: number;
  /** Width of the row's first element child, i.e. the accordion box. */
  leadWidth: number;
  /** Left edge of the first element child. */
  leadLeft: number;
  /** Left edge of the content that follows the accordion box. */
  contentLeft: number | null;
}

async function readRows(page: import("@playwright/test").Page): Promise<RowMetrics[]> {
  return page.evaluate(() => {
    const tree = document.querySelector('[role="tree"]');
    if (!tree) return [];
    const rows = Array.from(tree.querySelectorAll('[role="treeitem"]'));
    return rows
      .map((row) => {
        const box = row.getBoundingClientRect();
        // A row hidden behind a collapsed section has no layout to measure.
        if (box.width === 0 || box.height === 0) return null;
        const children = Array.from(row.children).filter((el) => {
          const r = el.getBoundingClientRect();
          // The pending-action overlay is absolutely positioned over the whole
          // row: it is paint, not a column.
          const positioned = getComputedStyle(el).position === "absolute";
          return r.width > 0 && r.height > 0 && !positioned;
        });
        const lead = children[0];
        const next = children[1];
        if (!lead) return null;
        return {
          name: (row.textContent ?? "").trim().slice(0, 40),
          rowLeft: Math.round(box.left * 10) / 10,
          leadWidth: Math.round(lead.getBoundingClientRect().width * 10) / 10,
          leadLeft: Math.round(lead.getBoundingClientRect().left * 10) / 10,
          contentLeft: next ? Math.round(next.getBoundingClientRect().left * 10) / 10 : null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  });
}

test.describe("sidebar: the accordion column", () => {
  test("ROWALIGN-01: every row opens with the same accordion box", async ({ page }) => {
    // Both, and neither is decoration: LAYOUT-26 is the declared step of the
    // column, ROWALIGN-01 is the requirement this measurement IS. Claiming only
    // the first left an id that titles a test and is claimed by none.
    test.info().annotations.push({ type: "spec", description: "LAYOUT-26" });
    test.info().annotations.push({ type: "spec", description: "ROWALIGN-01" });
    await goToApp(page);
    await expect(page.locator('[role="tree"]')).toBeVisible({ timeout: 15000 });

    const rows = await readRows(page);
    expect(rows.length, "no sidebar row was measurable").toBeGreaterThan(1);

    const widths = [...new Set(rows.map((r) => r.leadWidth))];
    expect(
      widths.length,
      `every row must open with the SAME box (the accordion column), found ${widths.join(
        ", ",
      )}px on: ${rows.map((r) => `${r.name}=${r.leadWidth}`).join(" | ")}`,
    ).toBe(1);
  });

  test("ROWALIGN-02: one content start per depth level", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-26" });
    await goToApp(page);
    await expect(page.locator('[role="tree"]')).toBeVisible({ timeout: 15000 });

    const rows = (await readRows(page)).filter((r) => r.contentLeft !== null);
    expect(rows.length, "no sidebar row was measurable").toBeGreaterThan(1);

    const byDepth = new Map<number, RowMetrics[]>();
    for (const row of rows) {
      const group = byDepth.get(row.rowLeft) ?? [];
      group.push(row);
      byDepth.set(row.rowLeft, group);
    }

    for (const [rowLeft, group] of byDepth) {
      const starts = [...new Set(group.map((r) => r.contentLeft))];
      expect(
        starts.length,
        `at depth (row left ${rowLeft}px) the content of the rows starts at ${starts.length} ` +
          `different x: ${starts.join(", ")}. One column, one alignment. Rows: ` +
          group.map((r) => `${r.name}=${r.contentLeft}`).join(" | "),
      ).toBe(1);
    }
  });
});
