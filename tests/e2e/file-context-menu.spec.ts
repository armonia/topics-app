import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("File Context Menu (FILE-03) & Script Runner (FILE-04)", () => {
  let topicId: string;
  const tmpDir = `/tmp/e2e-ctx-menu-${Date.now()}`;
  const topicName = `e2e-ctx-menu-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    // Create temp directory with files and subdirectory
    mkdirSync(`${tmpDir}/src`, { recursive: true });
    writeFileSync(
      `${tmpDir}/package.json`,
      JSON.stringify(
        {
          name: "e2e-ctx-menu-project",
          scripts: { dev: "echo dev", build: "echo build", test: "echo test" },
        },
        null,
        2
      )
    );
    writeFileSync(`${tmpDir}/README.md`, "# Context Menu Test\n");
    writeFileSync(`${tmpDir}/src/index.ts`, 'export const x = 1;\n');

    // Init git so the project is recognized. L'identità la mette `initGitRepo`:
    // senza, su CI `git commit` fallisce con «Please tell me who you are».
    initGitRepo(tmpDir);

    const topic = await createTopic(request, topicName, { projectPath: tmpDir });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("FILE-03-01: context menu shows Show in Finder for file", async ({ fileExplorerPage, page }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-03" });

    let revealCalled = false;
    let revealPath = "";

    // Mock the reveal endpoint
    await page.route("**/api/files/reveal", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      revealCalled = true;
      revealPath = body.path || "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Right-click on README.md in the file tree
    const readmeItem = fileExplorerPage.fileTree.getByRole("treeitem", { name: /README\.md/ });
    await expect(readmeItem).toBeVisible({ timeout: 10_000 });
    await readmeItem.click({ button: "right" });

    // Verify context menu has "Show in Finder"
    const showInFinder = page.locator('button[role="menuitem"]', { hasText: "Show in Finder" });
    await expect(showInFinder).toBeVisible({ timeout: 5_000 });

    // Click "Show in Finder"
    await showInFinder.click();

    // Verify API call was made with the file path
    expect(revealCalled).toBe(true);
    expect(revealPath).toContain("README.md");
  });

  test("FILE-03b-02: context menu shows Show in Finder for folder", async ({ fileExplorerPage, page }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-03" });

    let revealCalled = false;
    let revealPath = "";

    await page.route("**/api/files/reveal", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      revealCalled = true;
      revealPath = body.path || "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Right-click on the "src" directory
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir.first()).toBeVisible({ timeout: 10_000 });
    await srcDir.first().click({ button: "right" });

    // Verify context menu has "Show in Finder"
    const showInFinder = page.locator('button[role="menuitem"]', { hasText: "Show in Finder" });
    await expect(showInFinder).toBeVisible({ timeout: 5_000 });

    // Click it
    await showInFinder.click();

    expect(revealCalled).toBe(true);
    expect(revealPath).toContain("src");
  });

  test("FILE-04-01: script runner lists scripts from package.json", async ({ fileExplorerPage, page }) => {
    // FILE-04, not FILE-03. The two requirements shared one id in the spec
    // until 2026-08-25 - "Reveal in Finder" and "Process & Script Runner" were
    // both written as `FILE-03` - so declaring one covered both, and the runner
    // looked specified when nothing pointed at it. Renumbering the second made
    // this line necessary, which is the proof the duplicate was hiding a gap.
    test.info().annotations.push({ type: "spec", description: "FILE-04" });

    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Expand the Processes section
    const processesBtn = page.locator("button", { hasText: "Processi" });
    await expect(processesBtn).toBeVisible({ timeout: 5_000 });
    await processesBtn.click();

    // Wait for script runner to load
    const scriptRunner = page.locator('[data-testid="script-runner"]');
    await expect(scriptRunner).toBeVisible({ timeout: 10_000 });

    // Verify script names are listed (use exact: true for text matching)
    await expect(scriptRunner.getByText("dev", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(scriptRunner.getByText("build", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(scriptRunner.getByText("test", { exact: true })).toBeVisible({ timeout: 5_000 });
  });
});
