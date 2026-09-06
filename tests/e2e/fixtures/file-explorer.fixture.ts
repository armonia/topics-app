import { test as base, type Page } from "@playwright/test";
import { realpathSync } from "fs";
import { goToApp } from "../helpers";
import { resetPaneStore, resetProjectPanes, seedProjectPane } from "../helpers/api-fixtures";

/** The canonical spelling of a path, or the path itself when it cannot be resolved. */
export function canonicalPath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * The project row, under either spelling. Exported because the CLS spec drives
 * the same row to open the "+" menu on it, and two copies of this selector
 * would drift the way the two copies of the path spelling already did.
 */
export function projectRowSelector(projectPath: string): string {
  const spellings = [...new Set([projectPath, canonicalPath(projectPath)])];
  return spellings.map((p) => `button[title="${p}"], button[data-tip="${p}"]`).join(", ");
}

export class FileExplorerPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Navigate to a project's file explorer by:
   * 1. Opening the app and expanding the sezione Progetti
   * 2. Clicking the project header to open the project pane
   * 3. Optionally clicking a child topic to create a pane group
   * 4. Waiting for the file tree to become visible
   */
  async gotoProject(projectPath: string, topicName?: string | RegExp) {
    // Clear panes leaked by earlier specs (the shared pane-store-v2 UNIONs in
    // on hydrate) so only OUR project pane tiles, THEN seed OUR project pane.
    // The tab-driven sidebar only surfaces a project row while its pane is open
    // (`hasProjectTab`) or a child topic has an open tab — but this spec's topic
    // is PROJECT-LINKED, and usePanelLifecycle purges project-linked topic ids
    // from the open set (they live INSIDE the project window), so seeding the
    // child topic never surfaces the row. Seed the `project:<path>` pane itself,
    // exactly like the UI does when you open a project. Note: a single open
    // project still legitimately renders two file trees (sidebar + files pane) —
    // the `fileTree` getter scopes to the first to stay strict-mode safe.
    //
    // Si azzera anche il layout INTERNO del progetto: `topics-project-panes-<hash>`
    // e' una ui_state a se' e SOPRAVVIVE a resetPaneStore, quindi gli editor
    // aperti da un test precedente si riaprivano nel test dopo. Sintomo:
    // FIX-08 andava in strict-mode violation perche' `[data-testid="breadcrumb-nav"]`
    // risolveva a DUE pane (package.json rimasto aperto da FILE-14, piu' il suo).
    await resetPaneStore(this.page.request, []);
    await resetProjectPanes(this.page.request, projectPath);
    await seedProjectPane(this.page.request, projectPath).catch(() => {});
    await goToApp(this.page);

    // Expand the sezione Progetti if collapsed
    const projectsSection = this.page.getByRole("button", {
      name: /sezione Progetti/,
    });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Find the project header and click to open
    // BOTH SPELLINGS OF THE PATH. Since 7cd202448 the server serves the
    // project pane under the CANONICAL path (realpath), and on macOS the
    // realpath of `/tmp/x` is `/private/tmp/x`: the row on screen carries the
    // canonical spelling while the seed hands this method the one it wrote.
    // A locator on the seed's spelling alone waited ten seconds for a row that
    // was on screen the whole time, under the other name (FILES + OPEN in
    // pane-return-cls, red since that commit). `data-tip` next to `title`:
    // TooltipDelegate moves the label between the two while the pointer is
    // over the row, and the pointer stays wherever the last hover left it.
    const projectHeader = this.page.locator(projectRowSelector(projectPath)).first();
    await projectHeader.waitFor({ state: "visible", timeout: 10000 });
    await projectHeader.click();

    // If a topic name was provided, click it to create a chat pane (ensures a group exists)
    if (topicName) {
      const topicItem = this.page.getByRole("treeitem", { name: topicName });
      await topicItem
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
      if (await topicItem.isVisible()) {
        await topicItem.click();
        await this.page
          .locator('[data-testid="panel-tab-bar"]')
          .last()
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
      }
    }

    // Wait for file tree to appear
    await this.fileTree.waitFor({ state: "visible", timeout: 15000 });
  }

  // --- File Tree ---

  get fileTree() {
    // A project window shows TWO legitimate file trees: the ProjectSidebar's
    // compact tree AND the ProjectWindow's `files` pane tree — both carry
    // data-testid="file-tree". Scope to the first so the locator is strict-safe;
    // both are fully interactive (same component, same context menu).
    return this.page.locator('[data-testid="file-tree"]').first();
  }

  getTreeItem(name: string) {
    return this.fileTree.getByRole("treeitem", { name });
  }

  getDirNode(name: string | RegExp) {
    return this.fileTree.locator('[role="treeitem"]', { hasText: name });
  }

  // --- Editor & Tabs ---

  get editorTabs() {
    return this.page.locator('[data-testid="editor-tabs"]');
  }

  getTab(name: string) {
    return this.editorTabs.locator("div", { hasText: name }).first();
  }

  // --- Breadcrumb ---

  get breadcrumb() {
    return this.page.locator('[data-testid="breadcrumb-nav"]');
  }

  getBreadcrumbSegment(name: string) {
    return this.breadcrumb.getByRole("button", { name });
  }

  // --- Git ---

  get gitChanges() {
    return this.page.locator('[data-testid="git-changes"]');
  }

  getGitStatusLabel(filename: string) {
    const treeItem = this.fileTree.locator('[role="treeitem"]', {
      hasText: filename,
    });
    return treeItem.locator("span").last(); // git status badge is last span
  }

  // --- File Search ---

  get fileSearch() {
    return this.page.locator('[data-testid="file-search"]');
  }

  /**
   * Apre la ricerca nel CONTENUTO.
   *
   * Era `Meta+Shift+f`, e quella scorciatoia non esiste più: oggi `⌘F` cerca
   * dentro e `⌘P` cerca per nome (`useKeyboardShortcuts`, il commento «⌘P —
   * apri un file per NOME» racconta il cambio). Nessuno ascoltava più
   * `⌘⇧F`, quindi la modale non si apriva e i due test che la usano
   * fallivano con «element(s) not found» — un rosso che era il TEST, non il
   * prodotto.
   *
   * Il fuoco si toglie prima di premere: `⌘F` si rifiuta di rubare la find a un
   * campo di testo (è l'unico ramo con quell'uscita, e ha una buona ragione),
   * quindi con il compositore a fuoco il tasto non farebbe niente.
   */
  async openFileSearch() {
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await this.page.keyboard.press("Meta+f");
  }

  // --- Diff Viewer ---

  get diffViewer() {
    return this.page.locator('[data-testid="diff-viewer"]');
  }

  // --- Script Runner ---

  get scriptRunner() {
    return this.page.locator('[data-testid="script-runner"]');
  }

  getScript(name: string) {
    return this.scriptRunner.locator("div", { hasText: name });
  }

  // --- Sidebar Section Expansion ---

  async expandSection(name: string) {
    // Click section header button with matching text (e.g., "Files", "Git Changes", "Scripts")
    const header = this.page.locator("button", { hasText: name });
    const expanded = await header.getAttribute("aria-expanded");
    if (expanded === "false") {
      await header.click();
    }
  }
}

export const test = base.extend<{ fileExplorerPage: FileExplorerPage }>({
  fileExplorerPage: async ({ page }, use) => {
    await use(new FileExplorerPage(page));
  },
});
