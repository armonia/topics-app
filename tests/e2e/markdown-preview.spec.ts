import { expect } from "@playwright/test";
import { writeFileSync } from "fs";
import { test } from "./fixtures/file-explorer.fixture";
import { resetPaneStore } from "./helpers/api-fixtures";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The Markdown preview of a file, and the raw HTML inside it.
 *
 * WHY IT EXISTS. The preview is the only thing in the client that pulls in
 * `parse5` (through `rehype-raw`), 157 KB raw of it, and it used to sit in the
 * FilePane chunk: every file open paid for a preview that is off by default.
 * It now lives in its own lazy chunk (`Editor/MarkdownPreview.tsx`).
 *
 * WHAT THAT COULD HAVE BROKEN, and what this test measures. The cheap way to
 * split it would have been to lazy-load the PLUGIN and render the Markdown
 * without it in the meantime: one frame of escaped tags, then a jump. So this
 * watches the DOM from before the click and asserts the escaped form never
 * appears, not even for one mutation. A README is badges and a `<details>`
 * block; seeing `<details>` written out as text is the failure.
 *
 * Video is on: appear/stay is a behaviour, and the .webm is the evidence.
 *
 * @covers FILE-01
 */
test.use({ video: "on" });

const README_WITH_HTML = [
  "# Preview me",
  "",
  '<img src="https://img.shields.io/badge/build-passing-brightgreen" alt="build badge" />',
  "",
  "<details>",
  "<summary>Hidden section</summary>",
  "",
  "Body of the collapsible section.",
  "",
  "</details>",
  "",
  "Plain paragraph after the raw HTML.",
  "",
].join("\n");

/** The literal an escaped-HTML frame would put on screen. */
const ESCAPED_MARKER = "<details>";

test.describe("Markdown preview", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "md-preview");
    ({ topicId, tmpDir, topicName } = project);
    // The shared seed DELETES README.md on purpose (it needs a `D` entry in git
    // status). This spec wants it back, with raw HTML in it.
    writeFileSync(`${tmpDir}/README.md`, README_WITH_HTML);
  });

  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });

  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("MDPREV-01: raw HTML renders in one pass, with no escaped frame", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    await fileExplorerPage.fileTree
      .getByRole("treeitem", { name: /README\.md/ })
      .first()
      .click();

    const filePane = page.locator('[data-testid="file-pane"]').first();
    await expect(filePane).toBeVisible();

    // The watcher goes in BEFORE the click: what it is looking for would live
    // for a frame, and a poll after the fact would always find it gone.
    await page.evaluate((marker) => {
      const w = window as unknown as { __escapedHtmlFrames?: number };
      w.__escapedHtmlFrames = 0;
      const look = () => {
        const pane = document.querySelector('[data-testid="file-pane"]');
        if (pane && (pane.textContent ?? "").includes(marker)) w.__escapedHtmlFrames!++;
      };
      new MutationObserver(look).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }, ESCAPED_MARKER);

    await filePane.getByRole("button", { name: "Preview Markdown" }).click();

    // The rendered form: a real <details> element and a real <img>, not text.
    const details = filePane.locator("details");
    await expect(details).toBeVisible();
    await expect(filePane.locator('img[alt="build badge"]')).toHaveCount(1);
    await expect(filePane.getByRole("heading", { name: "Preview me" })).toBeVisible();

    // It STAYS: the section opens and the preview is still the rendered one.
    await details.locator("summary").click();
    await expect(filePane.getByText("Body of the collapsible section.")).toBeVisible();

    const escapedFrames = await page.evaluate(
      () => (window as unknown as { __escapedHtmlFrames?: number }).__escapedHtmlFrames ?? -1,
    );
    expect(escapedFrames, "no frame showed the HTML escaped").toBe(0);
  });
});
