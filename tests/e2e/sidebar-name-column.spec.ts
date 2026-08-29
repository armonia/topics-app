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
        return {
          kind: el.getAttribute("data-row-name") ?? "?",
          text: (el.textContent ?? "").trim().slice(0, 30),
          left: Math.round(box.left * 10) / 10,
          rowLeft: Math.round(rowBox.left * 10) / 10,
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

  test("ROWALIGN-03: rows that draw a glyph share one column; a chat starts left of it", async ({ page }) => {
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
    // What is left to guard is the half that still holds: the rows that DO
    // draw a leading glyph must agree with each other, so the column they form
    // is a column and not a scatter.
    const withGlyph = topNames.filter((n) => n.kind !== "chat");
    const glyphStarts = [...new Set(withGlyph.map((n) => n.left))];
    expect(
      glyphStarts.length,
      `rows with a leading glyph start at ${glyphStarts.length} different x: ` +
        `${glyphStarts.join(", ")}. Names: ` +
        withGlyph.map((n) => `${n.kind}:${n.text}=${n.left}`).join(" | "),
    ).toBeLessThanOrEqual(1);

    // And the chat starts STRICTLY left of them - the space is gone, not moved.
    const chats = topNames.filter((n) => n.kind === "chat");
    if (chats.length && glyphStarts.length) {
      const chatStart = Math.min(...chats.map((n) => n.left));
      expect(
        chatStart,
        `a chat name starts at ${chatStart}, a row with a glyph at ${glyphStarts[0]}: ` +
          "the chat must no longer reserve the empty leading box.",
      ).toBeLessThan(glyphStarts[0]!);
    }
  });
});
