/**
 * Dragging a file from OUTSIDE the browser onto the explorer tree: the node under
 * the pointer highlights, the drop uploads the file into that directory (or into the
 * parent of a file node), and sibling nodes do not flash while the drag passes over.
 *
 * @covers FILE-01
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("External File Drop", () => {
  let topicId: string;
  const tmpDir = `/tmp/e2e-external-drop-${Date.now()}`;
  const topicName = "e2e-external-drop-test";

  test.beforeAll(async ({ request }) => {
    mkdirSync(`${tmpDir}/src`, { recursive: true });
    writeFileSync(`${tmpDir}/package.json`, JSON.stringify({ name: "test" }, null, 2));
    writeFileSync(`${tmpDir}/src/index.ts`, 'export const x = 1;\n');
    initGitRepo(tmpDir);

    const topic = await createTopic(request, topicName, { projectPath: tmpDir });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("EXTDROP-01: dragover on directory shows visual indicator", async ({ fileExplorerPage, page }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    await expect(fileExplorerPage.fileTree).toBeVisible();

    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir).toBeVisible();

    // Simulate external dragover (with Files type) on the src directory
    await srcDir.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["hello"], "test.txt", { type: "text/plain" }));
      const dragEnter = new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(dragEnter);
      const dragOver = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(dragOver);
    });

    // Il bersaglio si DICHIARA: `data-drop-active` e' il contratto unico
    // (`DROP_ACTIVE_ATTR` in lib/dragPreview), disegnato da una regola sola in
    // index.css. Prima qui c'era un anello scritto a mano riga per riga, e
    // questo caso ne assertava la CLASSE: quando l'anello e' diventato una
    // regola condivisa il segno c'era ancora e il test no.
    await expect(srcDir).toHaveAttribute('data-drop-active', 'into');
  });

  test("EXTDROP-02: dragover on file shows visual indicator", async ({ fileExplorerPage, page }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    await expect(fileExplorerPage.fileTree).toBeVisible();

    const packageJson = fileExplorerPage.fileTree.getByRole("treeitem", { name: /package\.json/ });
    await expect(packageJson).toBeVisible();

    // Simulate external dragover on a file node
    await packageJson.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["content"], "dropped.txt", { type: "text/plain" }));
      const dragEnter = new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(dragEnter);
      const dragOver = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(dragOver);
    });

    // File node should also show drag indicator during external drag
    await expect(packageJson).toHaveAttribute('data-drop-active', 'into');
  });

  test("EXTDROP-03: drop file on directory uploads it", async ({ fileExplorerPage, page }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    await expect(fileExplorerPage.fileTree).toBeVisible();

    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir).toBeVisible();

    // Simulate full drop sequence
    await srcDir.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["hello world"], "dropped-in-src.txt", { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });

    // Wait for toast confirmation
    await expect(page.locator("text=Uploaded dropped-in-src.txt")).toBeVisible({ timeout: 10000 });

    // Verify file was created on disk
    expect(existsSync(`${tmpDir}/src/dropped-in-src.txt`)).toBe(true);
  });

  test("EXTDROP-04: drop file on file node uploads to parent directory", async ({ fileExplorerPage, page }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    await expect(fileExplorerPage.fileTree).toBeVisible();

    const packageJson = fileExplorerPage.fileTree.getByRole("treeitem", { name: /package\.json/ });
    await expect(packageJson).toBeVisible();

    // Drop on a file node — should upload to parent (root)
    await packageJson.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["content"], "dropped-at-root.txt", { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });

    await expect(page.locator("text=Uploaded dropped-at-root.txt")).toBeVisible({ timeout: 10000 });
    expect(existsSync(`${tmpDir}/dropped-at-root.txt`)).toBe(true);
  });

  test("EXTDROP-05: no flash between sibling nodes during external drag", async ({ fileExplorerPage, page }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    await expect(fileExplorerPage.fileTree).toBeVisible();

    const packageJson = fileExplorerPage.fileTree.getByRole("treeitem", { name: /package\.json/ });
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(packageJson).toBeVisible();
    await expect(srcDir).toBeVisible();

    // Simulate dragenter on package.json
    await packageJson.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "test.txt", { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(packageJson).toHaveAttribute('data-drop-active', 'into');

    // Move to src dir — package.json should lose indicator, src should gain it
    await srcDir.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "test.txt", { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });

    // src should now be highlighted
    await expect(srcDir).toHaveAttribute('data-drop-active', 'into');
    // package.json should NOT be highlighted anymore
    await expect(packageJson).not.toHaveAttribute('data-drop-active', 'into');
  });
});
