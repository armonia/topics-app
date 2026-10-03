import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { canonicalTmpDir, initGitRepo, removeTmpDir } from "./helpers/file-project";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("File Context Menu (FILE-03) & Script Runner (FILE-04)", () => {
  let topicId: string;
  const tmpDir = canonicalTmpDir("e2e-ctx-menu");
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
    removeTmpDir(tmpDir);
  });

  // FILE-03 (commands-ui): the reveal runs `open -R` on the SERVER, so a web
  // client (this browser, a phone, another computer) would open Finder on the
  // Mac that runs Topics, in front of nobody. The row is offered only in the
  // desktop shell on a loopback server (`lib/revealInFinder.ts`, unit-tested
  // there): it cannot be faked here, because a page posing as the shell talks
  // to the real shell's port. What this client must show is its absence.
  test("FILE-03-01: a web client is not offered Show in Finder, on a file or a folder", async ({ fileExplorerPage, page }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-03" });
    let revealCalled = false;
    await page.route("**/api/files/reveal", async (route) => {
      revealCalled = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await fileExplorerPage.gotoProject(tmpDir, topicName);

    const readmeItem = fileExplorerPage.fileTree.getByRole("treeitem", { name: /README\.md/ });
    await expect(readmeItem).toBeVisible({ timeout: 10_000 });
    await readmeItem.click({ button: "right" });
    // The menu is open (its copy row is there), and the reveal row is not.
    await expect(page.locator('button[role="menuitem"]', { hasText: /Copia il percorso|Copy path/ }).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("files-menu-reveal")).toHaveCount(0);
    await page.keyboard.press("Escape");

    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir.first()).toBeVisible({ timeout: 10_000 });
    await srcDir.first().click({ button: "right" });
    await expect(page.locator('button[role="menuitem"]', { hasText: /Copia il percorso|Copy path/ }).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("files-menu-reveal")).toHaveCount(0);
    expect(revealCalled).toBe(false);
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
