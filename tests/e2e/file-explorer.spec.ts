import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { resetPaneStore } from "./helpers/api-fixtures";
import {
  seedFileProject,
  cleanupFileProject,
  type FileProject,
} from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * L'albero dei file, le tab dell'editor e la ricerca nei contenuti.
 *
 * Fa parte della famiglia file-explorer, spezzata in tre file per TEMA
 * (`file-explorer`, `file-explorer-git`, `file-explorer-panels`). Erano un
 * file solo da 22 test e 138 secondi: il pezzo piu' lento della suite e — poiche'
 * Playwright distribuisce gli shard PER FILE — il pavimento sotto cui il
 * wall-clock non poteva scendere, con 4 shard come con 16. Il progetto seminato
 * e' lo stesso per tutti e tre ma ISTANZIATO A PARTE per ciascuno
 * (`helpers/file-project.ts`), cosi' i test che committano non cambiano lo stato
 * git sotto i piedi di un file che gira in parallelo su un altro shard.
 */
test.describe("File Explorer — albero, editor e ricerca", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "tree");
    ({ topicId, tmpDir, topicName } = project);
  });

  // Isolamento del pane-store fra un test e l'altro. `pane-store-v2` e' UNA
  // chiave sincronizzata dal server e condivisa da tutta la run: senza reset,
  // una pane di progetto aperta da una spec precedente — o dal test precedente
  // di questo file — rientra all'hydrate, `gotoProject` si ritrova DUE pane di
  // progetto, e ogni locator singleton (breadcrumb-nav, git-changes, il bottone
  // "Processes") sbatte contro uno strict-mode "resolved to 2 elements".
  //
  // Si riparte dalla sola chat della topic seminata qui — non da vuoto: la
  // sidebar mostra la riga del progetto solo finche' la sua pane e' aperta o una
  // topic figlia ha una tab aperta, e con lo store vuoto `gotoProject` non
  // troverebbe l'intestazione da cliccare.
  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });

  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("EXPLORER-01: file tree renders hierarchy", async ({
    fileExplorerPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Assert the file tree container is visible
    await expect(fileExplorerPage.fileTree).toBeVisible();

    // Assert root-level files are visible in the tree
    const packageJson = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /package\.json/,
    });
    await expect(packageJson).toBeVisible();

    const newfileTxt = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /newfile\.txt/,
    });
    await expect(newfileTxt).toBeVisible();

    // Assert src directory is visible
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir).toBeVisible();

    // Tree loads 3 levels deep by default, so src/index.ts may already be visible
    // If not visible, click src/ to expand it
    const indexTs = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /index\.ts/,
    });
    const alreadyVisible = await indexTs.isVisible().catch(() => false);
    if (!alreadyVisible) {
      await srcDir.click();
    }

    // Assert nested file index.ts is visible inside src/
    await expect(indexTs).toBeVisible();
  });

  test("EXPLORER-02: clicking file opens editor", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Click package.json in the file tree to open it
    const packageItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /package\.json/,
    });
    await packageItem.click();

    // In compact mode, the file opens as a FilePane tab in the main pane area
    // Look for a tab containing the filename in the panel tab bar
    const panelTabBar = page
      .locator('[data-testid="panel-tab-bar"]')
      .last();
    await expect(panelTabBar).toBeVisible();

    // The tab bar should have a tab with the filename (tabs are div elements)
    const fileTab = panelTabBar.locator("div", {
      hasText: /package\.json/,
    });
    await expect(fileTab.first()).toBeVisible();

    // The breadcrumb should appear in the file pane, confirming the file is open
    const breadcrumb = page.locator('[data-testid="breadcrumb-nav"]');
    await expect(breadcrumb).toBeVisible();
  });

  test("EXPLORER-05: editor tabs open switch and close", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // The panel tab bar contains pane tabs (file panes appear here in compact mode)
    const panelTabBar = page
      .locator('[data-testid="panel-tab-bar"]')
      .last();
    await expect(panelTabBar).toBeVisible();

    // Click package.json to open it as a preview tab first
    const packageItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /package\.json/,
    });
    await packageItem.click();

    // Wait for the tab to appear
    const packageTabSpan = panelTabBar.locator("span").filter({
      hasText: "package.json",
    });
    await expect(packageTabSpan.first()).toBeVisible();

    // Double-click the pane tab itself to pin it (makes it permanent)
    const packageTabContainer = packageTabSpan.first().locator("..");
    await packageTabContainer.dblclick();

    // Verify it's pinned (the span should not be italic)
    await expect(packageTabSpan.first()).not.toHaveClass(/italic/);

    // Now click newfile.txt to open it (should create a new preview tab since package.json is pinned)
    const newfileItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /newfile\.txt/,
    });
    await newfileItem.click();

    // Wait for newfile.txt tab to appear
    const newfileTabSpan = panelTabBar.locator("span").filter({
      hasText: "newfile.txt",
    });
    await expect(newfileTabSpan.first()).toBeVisible();

    // Both tabs should be visible
    await expect(packageTabSpan.first()).toBeVisible();
    await expect(newfileTabSpan.first()).toBeVisible();

    // Click the package.json tab container to switch to it
    await packageTabContainer.click();

    // Verify package.json breadcrumb is visible (confirming it's the active
    // pane). Two file panes are mounted (pinned package.json + preview
    // newfile.txt); inactive panes are kept alive via display:none, so scope to
    // the visible one or the unscoped locator matches both (strict-mode clash).
    const breadcrumb = page.locator('[data-testid="breadcrumb-nav"]:visible');
    await expect(breadcrumb).toContainText("package.json");

    // Close the newfile.txt tab by clicking its X close button
    // The close button is inside the tab div, a button element
    const newfileTabContainer = newfileTabSpan.first().locator("..");
    // Hover to reveal the close button (it has opacity-0 by default, opacity-100 on group-hover)
    await newfileTabContainer.hover();
    const closeButton = newfileTabContainer.locator("button").last();
    await closeButton.click();

    // After close, only package.json tab should remain
    await expect(newfileTabSpan.first()).not.toBeVisible();
    await expect(packageTabSpan.first()).toBeVisible();
  });

  test("EXPLORER-10: expand and collapse directory node", async ({
    fileExplorerPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Find the src directory node in the tree
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir).toBeVisible();

    // Ensure src is expanded first (tree loads 3 levels deep by default)
    const indexTs = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /index\.ts/,
    });
    const alreadyVisible = await indexTs.isVisible().catch(() => false);
    if (!alreadyVisible) {
      await srcDir.click();
      await expect(indexTs).toBeVisible();
    }

    // Now collapse src by clicking it
    await srcDir.click();
    await expect(indexTs).not.toBeVisible({ timeout: 5000 });

    // Re-expand src by clicking it again
    await srcDir.click();
    await expect(indexTs).toBeVisible({ timeout: 5000 });
  });

  test("EXPLORER-11: editor shows syntax highlighting", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Expand src/ and click index.ts to open it
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir).toBeVisible();
    const indexItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /index\.ts/,
    });
    const indexVisible = await indexItem.isVisible().catch(() => false);
    if (!indexVisible) {
      await srcDir.click();
    }
    await expect(indexItem).toBeVisible();
    await indexItem.click();

    // Wait for CodeMirror editor to render
    const cmEditor = page.locator(".cm-editor");
    await expect(cmEditor.first()).toBeVisible({ timeout: 10000 });

    // Verify editor has content loaded (any text inside the editor)
    const cmContent = cmEditor.first().locator(".cm-content");
    await expect(cmContent).toBeVisible();
    const editorText = await cmContent.textContent();
    expect(editorText?.length).toBeGreaterThan(0);
  });

  test("EXPLORER-12: single-click opens preview tab (italic)", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    const panelTabBar = page
      .locator('[data-testid="panel-tab-bar"]')
      .last();
    await expect(panelTabBar).toBeVisible();

    // Single-click package.json to open as preview (italic) tab
    const packageItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /package\.json/,
    });
    await packageItem.click();

    // Wait for tab to appear
    const packageTabSpan = panelTabBar.locator("span").filter({
      hasText: "package.json",
    });
    await expect(packageTabSpan.first()).toBeVisible();

    // Preview tabs have italic styling
    await expect(packageTabSpan.first()).toHaveClass(/italic/);

    // Single-click a different file - preview tab should be replaced
    const newfileItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /newfile\.txt/,
    });
    await newfileItem.click();

    // newfile.txt tab should appear
    const newfileTabSpan = panelTabBar.locator("span").filter({
      hasText: "newfile.txt",
    });
    await expect(newfileTabSpan.first()).toBeVisible();

    // package.json preview tab should have been replaced (only one preview tab at a time)
    await expect(packageTabSpan.first()).not.toBeVisible();
  });

  test("FIX-08: rapid file opens show correct final content", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Open files rapidly in quick succession: newfile.txt, package.json, then
    // src/index.ts (README.md is deleted in beforeAll to seed FILE-13, so use
    // newfile.txt as the first of the three distinct rapid opens).
    const readmeItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /newfile\.txt/,
    });
    await readmeItem.click();

    const packageItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /package\.json/,
    });
    await packageItem.click();

    // Expand src if needed
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    const indexItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /index\.ts/,
    });
    const indexVisible = await indexItem.isVisible().catch(() => false);
    if (!indexVisible) {
      await srcDir.click();
      await expect(indexItem).toBeVisible();
    }
    await indexItem.click();

    // Wait for the last file to finish loading
    const breadcrumb = page.locator('[data-testid="breadcrumb-nav"]');
    await expect(breadcrumb).toContainText("index.ts", { timeout: 5000 });

    // Verify the active tab shows the LAST file's name
    const panelTabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    await expect(panelTabBar).toBeVisible();

    // The content in the editor should be from the LAST file (src/index.ts)
    // which contains 'export const hello = "modified"'
    // Wait for loading spinner to disappear
    const spinner = page.locator('[data-testid="editor-tabs"] .animate-spin');
    await expect(spinner).not.toBeVisible({ timeout: 5000 });

    // Check that CodeEditor content shows the correct file content
    // CodeMirror renders text in .cm-content
    const cmContent = page.locator('.cm-content');
    await expect(cmContent).toContainText('hello', { timeout: 5000 });
  });

  test("EXPLORER-04: ricerca nel contenuto con ⌘F", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Intercept file search API to force using our test project path
    // The global Cmd+Shift+F may pick a different project, so we intercept
    // and redirect the search to our test dir
    await page.route("**/api/files/search**", async (route) => {
      const url = new URL(route.request().url());
      // Rewrite the path parameter to our test project
      url.searchParams.set("path", tmpDir);
      const response = await route.fetch({
        url: url.toString(),
      });
      await route.fulfill({ response });
    });

    // Open file search with keyboard shortcut
    await fileExplorerPage.openFileSearch();

    // Wait for the file search modal to appear
    await expect(fileExplorerPage.fileSearch).toBeVisible();

    // Type a search query for unique content in our test files
    const searchInput = fileExplorerPage.fileSearch.locator(
      '[data-testid="file-search-input"]'
    );
    await expect(searchInput).toBeVisible();
    await searchInput.fill("e2e-test-project");

    // Wait for search results to appear (debounce is 300ms, grep may take time)
    const resultItem = fileExplorerPage.fileSearch.locator("button").filter({
      hasText: /e2e-test-project/,
    });
    await expect(resultItem.first()).toBeVisible({ timeout: 10000 });

    // Use keyboard to navigate: ArrowDown to select first result, Enter to open
    await searchInput.press("ArrowDown");
    await searchInput.press("Enter");

    // File search should close after selection
    await expect(fileExplorerPage.fileSearch).not.toBeVisible();
  });

  test("FIX-05: Invalid regex shows error feedback", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Intercept file search API to use our test project
    await page.route("**/api/files/search**", async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("path", tmpDir);
      const response = await route.fetch({ url: url.toString() });
      await route.fulfill({ response });
    });

    // Open file search with keyboard shortcut
    await fileExplorerPage.openFileSearch();
    await expect(fileExplorerPage.fileSearch).toBeVisible();

    // Enable regex mode by clicking the .* toggle button
    const regexToggle = fileExplorerPage.fileSearch.locator(
      'button:has-text(".*")'
    );
    await expect(regexToggle).toBeVisible();
    await regexToggle.click();

    // Type an invalid regex pattern
    const searchInput = fileExplorerPage.fileSearch.locator(
      '[data-testid="file-search-input"]'
    );
    await expect(searchInput).toBeVisible();
    await searchInput.fill("[invalid(");

    // Niente sleep per il debounce (300ms): le asserzioni qui sotto sono
    // auto-retrying, aspettano loro quanto serve e non un millisecondo di più.

    // Verify no crash: the file search dialog is still visible
    await expect(fileExplorerPage.fileSearch).toBeVisible();

    // Verify error feedback is shown
    const regexError = page.locator('[data-testid="regex-error"]');
    await expect(regexError).toBeVisible();

    // Verify no results shown
    const resultButtons = fileExplorerPage.fileSearch.locator(
      "button"
    ).filter({ hasText: /\d+/ }); // line number results
    // Results list must be empty (only toggle/close buttons visible). Era un
    // locator dichiarato e mai asserito: il commento diceva una cosa che il
    // test non verificava.
    await expect(resultButtons).toHaveCount(0);

    // Now type a valid regex and verify it works normally
    await searchInput.fill("hello");

    // Error should be gone
    await expect(regexError).not.toBeVisible();
  });
});
