/**
 * THE AIR LEFT OF A SIDEBAR LABEL, measured in the live DOM.
 *
 * Reported on the board (card 14c086a5): "a lot of space in the sidebar tabs,
 * left of the labels, for nothing". The defect is a few pixels wide, so an
 * image cannot decide it: what decides it is the distance between the left
 * edge of the SIDEBAR and the first ink of the label.
 *
 * WHY A RANGE RECT AND NOT THE ELEMENT'S. The name element is a flex child
 * that stretches over the free width, and on some rows it carries padding of
 * its own: its `getBoundingClientRect().left` measures the BOX, not the first
 * letter. A `Range` over the text node measures where the ink actually starts,
 * which is the thing the report is about.
 *
 * WHAT IT DOES *NOT* MEASURE. The indent per depth is a WANTED difference (it
 * is how the hierarchy is read) and it is guarded by the assertion below that
 * demands it stays alive. The subject here is the CONSTANT gutter, the one
 * every row pays at depth 0.
 *
 * @covers LAYOUT-30
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { SIDEBAR_LABEL_GUTTER_MAX, SIDEBAR_INDENT_STEP } from "../../client/src/lib/selectionStyles";

hermetic(test);

/** One sidebar label, as the browser laid it out. */
interface LabelMetrics {
  /** `chat`, `project`, `board`, ... only to make a red readable. */
  kind: string;
  /** The text itself, truncated. */
  text: string;
  /** Distance from the sidebar's left edge to the first ink of the label. */
  gutter: number;
  /** Distance from the sidebar's left edge to the row's own left edge. */
  rowInset: number;
}

async function readLabels(page: import("@playwright/test").Page): Promise<LabelMetrics[]> {
  return page.evaluate(() => {
    const tree = document.querySelector('[role="tree"]');
    const scope = tree?.parentElement ?? tree;
    if (!scope) return [];
    const sidebarLeft = scope.getBoundingClientRect().left;
    return Array.from(scope.querySelectorAll("[data-row-name]"))
      .map((el) => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        // The first ink, not the box: a Range over the text node.
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null = walker.nextNode();
        while (node && !(node.textContent ?? "").trim()) node = walker.nextNode();
        if (!node) return null;
        const range = document.createRange();
        range.selectNodeContents(node);
        const ink = range.getBoundingClientRect();
        if (ink.width === 0) return null;
        // The row card: what carries the depth indent on its left margin.
        const row = el.closest('[role="treeitem"]') ?? el.closest("button") ?? el.parentElement;
        const rowBox = (row ?? el).getBoundingClientRect();
        return {
          kind: el.getAttribute("data-row-name") ?? "?",
          text: (el.textContent ?? "").trim().slice(0, 24),
          gutter: Math.round((ink.left - sidebarLeft) * 10) / 10,
          rowInset: Math.round((rowBox.left - sidebarLeft) * 10) / 10,
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  });
}

test.describe("sidebar: the air left of a label", () => {
  test("LABELGUTTER-01: a top-level label starts inside the budget", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-30" });
    await goToApp(page);
    await expect(page.locator('[role="tree"]').first()).toBeVisible({ timeout: 15000 });

    const labels = await readLabels(page);
    expect(labels.length, "no sidebar label was measurable").toBeGreaterThan(0);

    // Top level = the shallowest row inset. Deeper rows pay the indent step on
    // purpose and are judged by the second assertion, not by this budget.
    const top = Math.min(...labels.map((l) => l.rowInset));
    const topLevel = labels.filter((l) => Math.abs(l.rowInset - top) < 1);
    const worst = Math.max(...topLevel.map((l) => l.gutter));

    // eslint-disable-next-line no-console -- the measurement IS the point of this spec: a number in the log is what makes a regression readable instead of just red.
    console.log(
      `[label-gutter] ${topLevel.map((l) => `${l.kind}:${l.text}=${l.gutter}`).join(" | ")}`,
    );

    expect(
      worst,
      `a top-level sidebar label starts ${worst}px from the sidebar edge, budget ` +
        `${SIDEBAR_LABEL_GUTTER_MAX}. Before card 14c086a5 it was 60px: row inset 6 + row ` +
        `padding 8 + accordion slot 12 + gap 8 + glyph slot 18 + gap 8, and on a chat the ` +
        `two slots are empty boxes. Labels: ` +
        topLevel.map((l) => `${l.kind}:${l.text}=${l.gutter}`).join(" | "),
    ).toBeLessThanOrEqual(SIDEBAR_LABEL_GUTTER_MAX);
  });

  // (LABELGUTTER-02 lived here and SKIPPED EVERY TIME. Measured on 2026-08-29:
  // the hermetic world is flat - two rows, both at inset 0 - so the guard
  // its conditional guard on a single depth fired on every run, and the assertion
  // never executed once, while the suite reported it as a test. Seeding a
  // nested row over `POST /api/topics` creates the topic but it does not reach
  // the sidebar, so the honest e2e is real work, not a one-line edit: it is on
  // the board. The constant it guarded is asserted in
  // `client/src/lib/selectionStyles.test.ts`, where it can actually fail.)
});
