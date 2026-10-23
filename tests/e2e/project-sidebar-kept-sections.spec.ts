/**
 * A sidebar section that was closed keeps what it held.
 *
 * Files and Processes used to be drawn inside `{expanded && ...}`, so closing a
 * section destroyed its tree and opening it built the tree again, scroll
 * position included. They now sit in `<Activity>` (`KeptSection`): closed is
 * hidden, the DOM and the state stay, and opening is a repaint.
 *
 * "Kept" is proven on the element itself: a marker set on the DOM node before
 * the section closes is still there when it opens, which a rebuilt tree cannot
 * fake, and the scroll offset of a tree taller than the sidebar comes back to
 * the pixel. A section nobody ever opened is not mounted at all, so a project
 * with Processes closed does not pay for it.
 *
 * @covers KEPTSEC-01
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { test } from "./fixtures/file-explorer.fixture";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { resetPaneStore } from "./helpers/api-fixtures";
import { cleanupFileProject, seedFileProject, type FileProject } from "./helpers/file-project";

hermetic(test);
test.use({ video: "on" });

/** Enough rows to make the tree taller than any sidebar this suite runs at. */
const BULK_FILES = 80;
const SCROLLED_TO = 400;

type Marked = HTMLElement & { __kept?: string };

const sectionHeader = (page: Page, id: "files" | "processes") =>
  page.locator(`[data-testid="project-sidebar-${id}"]`).first();

/** The scrolling box that holds a section's content: the next sibling of its header. */
const sectionBody = (header: Locator) =>
  header.locator('xpath=following-sibling::div[contains(@class, "overflow-y-auto")][1]');

test.describe("a closed sidebar section is hidden, not rebuilt", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "kept-sections");
    ({ topicId, tmpDir, topicName } = project);
    for (let i = 0; i < BULK_FILES; i++) {
      writeFileSync(`${tmpDir}/bulk-${String(i).padStart(3, "0")}.txt`, `row ${i}\n`);
    }
  });
  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("Files: the same tree comes back, scrolled where it was left", async ({ fileExplorerPage, page }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const header = sectionHeader(page, "files");
    const tree = fileExplorerPage.fileTree;
    const body = sectionBody(header);
    await expect(tree.getByText("bulk-079.txt")).toBeAttached({ timeout: 15_000 });

    await didascalia(page, "Files: scroll the tree, close the section");
    const overflowBy = await body.evaluate((el, to) => el.scrollHeight - el.clientHeight - to, SCROLLED_TO);
    expect(overflowBy, "the harness tree is not taller than the sidebar").toBeGreaterThan(0);
    await body.evaluate((el, to) => {
      el.scrollTop = to;
      (el as Marked).__kept = "same-node";
    }, SCROLLED_TO);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(SCROLLED_TO);
    await beat(page);

    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(tree).toBeHidden();

    await didascalia(page, "Files: open it again, same node, same scroll");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(tree).toBeVisible();
    expect(await body.evaluate((el) => (el as Marked).__kept)).toBe("same-node");
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(SCROLLED_TO);
    await beat(page);
  });

  test("Processes: never opened, never mounted; opened once, kept after", async ({ fileExplorerPage, page }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const header = sectionHeader(page, "processes");
    const body = sectionBody(header);
    await expect(header).toBeVisible({ timeout: 15_000 });
    // Closed by default: nothing of it exists yet.
    if ((await header.getAttribute("aria-expanded")) === "true") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(body).toHaveCount(0);

    await didascalia(page, "Processes: first opening builds it");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
    await body.evaluate((el) => {
      (el as Marked).__kept = "same-node";
    });
    await beat(page);

    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(body).toBeHidden();

    await didascalia(page, "Processes: closing hid it, opening shows the same node");
    await header.click();
    await expect(body).toBeVisible();
    expect(await body.evaluate((el) => (el as Marked).__kept)).toBe("same-node");
    await beat(page);
  });
});
