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
 * WHAT LABELGUTTER-01 DOES *NOT* MEASURE. The indent per depth is a WANTED
 * difference (it is how the hierarchy is read), so the budget above only
 * judges the rows at depth 0: the CONSTANT gutter every row pays. The indent
 * itself is LABELGUTTER-02, which seeds the second depth it needs instead of
 * hoping the world has one.
 *
 * @covers LAYOUT-30
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetProjectPanes,
  seedProjectInnerChats,
  seedProjectPane,
} from "./helpers/api-fixtures";
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

/**
 * THE SECOND DEPTH IS SEEDED, NOT HOPED FOR.
 *
 * The hermetic baseline is FLAT: a board row and a chat row, both at inset 0.
 * The first version of LABELGUTTER-02 noticed that and stepped aside
 * (`insets.length < 2` and skip), so it never ran once while the report
 * counted it as a test. A test that cannot fail is worse than a missing one.
 *
 * A nested row exists only where the sidebar has a PARENT: a project row with
 * its chats inside (the accordion, `renderChatItem(child, 2)`), which is also
 * the everyday shape of this app. `parentId` on a topic gives no indent, and a
 * raw `POST /api/topics` never even reaches the sidebar: since the tab-driven
 * redesign a row shows only while a pane of it is open. Hence the three seeds
 * below, all through the same helpers the rest of the suite uses: the project
 * pane (which is also what auto-expands the accordion), the chat that belongs
 * to that project, and the chat as an open pane INSIDE the project window.
 */
const NESTED_PROJECT = join(tmpdir(), `e2e-label-gutter-${Date.now()}`);
const NESTED_PROJECT_NAME = NESTED_PROJECT.split("/").pop() ?? "";
// Short on purpose: `readLabels` truncates the text it reports at 24 chars, and
// the assertion below finds this row by an EXACT match on that text.
const NESTED_CHAT_NAME = `Gutter child ${Date.now() % 1000000}`;

test.describe("sidebar: the air left of a label", () => {
  let nestedChatId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(NESTED_PROJECT, { recursive: true });
    writeFileSync(join(NESTED_PROJECT, "package.json"), JSON.stringify({ name: NESTED_PROJECT_NAME }));
    nestedChatId = (await createTopic(request, NESTED_CHAT_NAME, { projectPath: NESTED_PROJECT })).id;
  });

  test.afterAll(async ({ request }) => {
    if (nestedChatId) await deleteTopic(request, nestedChatId).catch(() => {});
    rmSync(NESTED_PROJECT, { recursive: true, force: true });
  });

  // Both cases get the SAME world, retries included: the top-level budget is
  // then measured on a sidebar that actually has a project row in it, which is
  // the harder case, and not on a two-row world that flatters it.
  test.beforeEach(async ({ request }) => {
    await resetProjectPanes(request, NESTED_PROJECT).catch(() => {});
    await seedProjectPane(request, NESTED_PROJECT);
    await seedProjectInnerChats(request, NESTED_PROJECT, [nestedChatId]);
  });

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

  test("LABELGUTTER-02: the depth indent is still readable", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-30" });
    await goToApp(page);
    await expect(page.locator('[role="tree"]').first()).toBeVisible({ timeout: 15000 });

    // The seed reached the DOM, or the measurement below means nothing. These
    // two are the ONLY guards in this test and they are assertions, not exits:
    // a world that failed to seed makes the case RED, it does not make it
    // vanish from the report.
    await expect(
      page.locator('[data-row-name="project"]').filter({ hasText: NESTED_PROJECT_NAME }).first(),
      `the seeded project row "${NESTED_PROJECT_NAME}" is not in the sidebar: without a parent row ` +
        `there is no second depth to measure`,
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('[data-row-name="chat"]').filter({ hasText: NESTED_CHAT_NAME }).first(),
      `the seeded chat "${NESTED_CHAT_NAME}" is not nested under its project row`,
    ).toBeVisible({ timeout: 15000 });

    const labels = await readLabels(page);
    expect(labels.length, "no sidebar label was measurable").toBeGreaterThan(0);
    const situation = "rows: " + labels.map((l) => `${l.kind}:${l.text}@${l.rowInset}`).join(" | ");

    // eslint-disable-next-line no-console -- same reason as LABELGUTTER-01: the number in the log is what makes a regression readable instead of just red.
    console.log(`[label-gutter] ${situation}`);

    // TWO CHAT ROWS, not a chat against a project row. Comparing different row
    // kinds would put their own chrome into the difference (a project row
    // carries a chevron and a favicon, and it sits inside the group card), and
    // that chrome would keep the numbers apart even with the indent at zero.
    // Two rows of the SAME component leave only one variable in the
    // subtraction: the depth.
    const chats = labels.filter((l) => l.kind === "chat");
    const nested = chats.find((l) => l.text === NESTED_CHAT_NAME);
    expect(
      nested,
      `the seeded chat "${NESTED_CHAT_NAME}" is not among the measurable rows. ` + situation,
    ).toBeTruthy();
    const flat = chats.filter((l) => l.text !== NESTED_CHAT_NAME);
    expect(
      flat.length,
      `no top-level chat row to compare the nested one against. ` + situation,
    ).toBeGreaterThan(0);

    const step = (nested?.rowInset ?? NaN) - Math.min(...flat.map((l) => l.rowInset));

    // The gutter trim of card 14c086a5 closed the CONSTANT air on the left of
    // every row. The indent per depth is a DIFFERENT number and a wanted one:
    // this is the assertion that goes red when a trim, or a CSS that flattens
    // the tree, takes it away as collateral damage. It is also the one that
    // dies first if SIDEBAR_INDENT_STEP ever goes to zero.
    expect(
      step,
      `the nested chat starts at the same x as a top-level one: the tree is FLAT, ` +
        `nothing distinguishes a child from its parent. ` + situation,
    ).toBeGreaterThan(0);
    expect(
      step,
      `the nested chat is indented ${step}px, less than the one declared step of ` +
        `${SIDEBAR_INDENT_STEP}px (it renders two steps in, so ${2 * SIDEBAR_INDENT_STEP} is the ` +
        `expected value). The hierarchy stopped being readable. ` + situation,
    ).toBeGreaterThanOrEqual(SIDEBAR_INDENT_STEP - 1);
  });
});
