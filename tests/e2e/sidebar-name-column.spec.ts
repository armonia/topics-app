/**
 * ONE NAME COLUMN IN THE SIDEBAR, measured in the live DOM.
 *
 * Reported on the board (card 018fd91f): with the accordion column already
 * made one, the names still started at three different x. Measured at the
 * default 256px sidebar: a chat name at 34px from the edge, a project name at
 * 56, a board / utility / terminal / browser name at 60. Nothing looked wrong
 * on any single row, which is what a crooked column does.
 *
 * WHY THIS FILE EXISTS NEXT TO `sidebar-chevron-column.spec.ts`. That one reads
 * `[role="treeitem"]` and compares the FIRST CHILD of each row. A project row
 * is not a treeitem (it is a long-press row), so ROWALIGN-01/02 never compared
 * a project against a chat: the very pair the report is about was outside the
 * measurement. Here the subject is the NAME, marked `data-row-name`, whatever
 * element renders the row around it.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";

hermetic(test);

/** One sidebar name, as the browser laid it out. */
interface NameMetrics {
  /** `chat` or `project`, only to make a red readable. */
  kind: string;
  /** The text itself, truncated. */
  text: string;
  /** Left edge of the name. */
  left: number;
  /** Left edge of the row card holding it: rows of the same depth share it. */
  rowLeft: number;
  /** The row draws a leading glyph box (`data-row-glyph-slot`): a favicon, a
   *  board / terminal / browser glyph. Only these rows pay the glyph column. */
  hasGlyph: boolean;
}

async function readNames(page: import("@playwright/test").Page): Promise<NameMetrics[]> {
  return page.evaluate(() => {
    const sidebar = document.querySelector('[role="tree"]')?.closest("aside, nav, div");
    const scope = sidebar ?? document.body;
    return Array.from(scope.querySelectorAll("[data-row-name]"))
      .map((el) => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        // The row card: the nearest ancestor that carries the row's own left
        // edge, i.e. the depth. Chats nest, projects do not.
        const row = el.closest('[role="treeitem"], [data-project-row], li, div[class*="group"]');
        const rowBox = (row ?? el).getBoundingClientRect();
        // The glyph box that precedes THIS name: a SIBLING of the name, or of
        // the block that holds it, never a descendant of the row card (a
        // project's card contains its child rows, and those have glyphs of
        // their own). Three levels up is the deepest a name sits: the
        // terminal's name lives in a block under the row's button.
        let hasGlyph = false;
        for (let node: HTMLElement | null = el as HTMLElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
          if (node.parentElement?.querySelector(":scope > [data-row-glyph-slot]")) { hasGlyph = true; break; }
        }
        return {
          kind: el.getAttribute("data-row-name") ?? "?",
          text: (el.textContent ?? "").trim().slice(0, 30),
          left: Math.round(box.left * 10) / 10,
          rowLeft: Math.round(rowBox.left * 10) / 10,
          hasGlyph,
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  });
}

test.describe("sidebar: the name column", () => {
  // A PROJECT ROW HAS TO EXIST, and under `hermetic` none does: the world
  // starts empty, so the sidebar carried one name (the chat) and the check
  // below - which compares a chat name with a PROJECT name - could never see
  // its own subject. It failed with "no sidebar name was measurable", which
  // reads like a broken selector and was instead an empty world.
  let project: FileProject;
  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "name-column");
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("ROWALIGN-03: rows that draw a glyph share one column; rows without one start left of it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-27" });
    await goToApp(page);
    // `.first()`: with a project seeded the sidebar carries a second tree (the
    // project's own), and a bare locator is a strict-mode violation.
    await expect(page.locator('[role="tree"]').first()).toBeVisible({ timeout: 15000 });

    const names = await readNames(page);
    expect(names.length, "no sidebar name was measurable").toBeGreaterThan(1);

    // Top level only: the indent step per depth is a WANTED difference, and it
    // is guarded elsewhere. The shallowest row left is the top level.
    const top = Math.min(...names.map((n) => n.rowLeft));
    const topNames = names.filter((n) => Math.abs(n.rowLeft - top) < 1);

    // REVERSED ON 29/08. allow-italian: «vedo ancora spazio prima delle label nelle tab della sidebar»
    // The one shared column was bought with an empty box
    // in front of every chat name, and that box is the space complained about.
    // REVERSED AGAIN ON 03/09 (card 058ea722) for the project row: a project
    // without a favicon draws no box either, so what decides the column is
    // no longer the KIND of the row but whether it DRAWS a glyph. What is
    // left to guard is the half that still holds: the rows that do draw one
    // must agree with each other, so the column they form is a column and not
    // a scatter; the rows that draw none start strictly left of it.
    const withGlyph = topNames.filter((n) => n.hasGlyph);
    const glyphStarts = [...new Set(withGlyph.map((n) => n.left))];
    expect(
      glyphStarts.length,
      `rows with a leading glyph start at ${glyphStarts.length} different x: ` +
        `${glyphStarts.join(", ")}. Names: ` +
        withGlyph.map((n) => `${n.kind}:${n.text}=${n.left}`).join(" | "),
    ).toBeLessThanOrEqual(1);

    // And the rows without a glyph start STRICTLY left of them - the space is
    // gone, not moved. The seeded project has no favicon, so it is one of them
    // and this branch cannot go quietly green on an empty set.
    const bare = topNames.filter((n) => !n.hasGlyph);
    expect(bare.length, "no glyph-less row was measurable: " + topNames.map((n) => `${n.kind}:${n.text}`).join(" | ")).toBeGreaterThan(0);
    expect(
      bare.some((n) => n.kind === "project"),
      "the seeded project (no favicon) must draw no glyph box: " + topNames.map((n) => `${n.kind}:${n.text} glyph=${n.hasGlyph}`).join(" | "),
    ).toBe(true);
    const bareStarts = [...new Set(bare.map((n) => n.left))];
    expect(
      bareStarts.length,
      `rows without a glyph start at ${bareStarts.length} different x: ${bareStarts.join(", ")}. Names: ` +
        bare.map((n) => `${n.kind}:${n.text}=${n.left}`).join(" | "),
    ).toBeLessThanOrEqual(1);
    if (glyphStarts.length) {
      expect(
        bareStarts[0]!,
        `a row without a glyph starts at ${bareStarts[0]}, a row with one at ${glyphStarts[0]}: ` +
          "the empty leading box must be gone.",
      ).toBeLessThan(glyphStarts[0]!);
    }
  });
});
