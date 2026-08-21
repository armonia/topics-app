import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { resetPaneStore } from "./helpers/api-fixtures";
import {
  seedFileProject,
  cleanupFileProject,
  type FileProject,
} from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Lo stato git nell'albero, il diff viewer, staging e commit.
 *
 * Gli ultimi due test MODIFICANO lo stato git del progetto (stage e commit):
 * stanno in fondo per questo, e in un file a parte perche' il loro progetto non
 * deve essere quello su cui gli altri asseriscono M/D/U.
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
test.describe("File Explorer — Git", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "git");
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

  test("FILE-03: git status indicators on files", async ({
    fileExplorerPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Ensure src/ is expanded (tree loads 3 levels deep by default)
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir).toBeVisible();

    // Check if index.ts is already visible; if not, expand src/
    const indexTreeItem = fileExplorerPage.fileTree
      .locator('[role="treeitem"]')
      .filter({ hasText: /index\.ts/ });
    const indexVisible = await indexTreeItem.isVisible().catch(() => false);
    if (!indexVisible) {
      await srcDir.click();
    }
    await expect(indexTreeItem).toBeVisible();

    // The modified indicator "M" should be visible on index.ts
    const modifiedIndicator = indexTreeItem.locator("span", {
      hasText: /^M$/,
    });
    await expect(modifiedIndicator).toBeVisible();

    // newfile.txt was created after commit - should show U (untracked) status
    const newfileItem = fileExplorerPage.fileTree
      .locator('[role="treeitem"]')
      .filter({ hasText: /newfile\.txt/ });
    await expect(newfileItem).toBeVisible();

    const untrackedIndicator = newfileItem.locator("span", {
      hasText: /^U$/,
    });
    await expect(untrackedIndicator).toBeVisible();
  });

  test("FILE-13: deleted file shows D status indicator", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // The Git section should show README.md with D status (deleted in beforeAll)
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    // Expand the Git section if collapsed
    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    const changedFilesList = gitChanges.locator("span", { hasText: /^[MDUA]$/ });
    const filesVisible = await changedFilesList.first().isVisible().catch(() => false);
    if (!filesVisible) {
      await gitHeader.click();
    }

    // Wait for file list to appear and look for README.md with D status
    const readmeRow = gitChanges.locator('[data-git-file="README.md"]');
    await expect(readmeRow.first()).toBeVisible({ timeout: 10000 });

    // Verify D indicator for deleted file
    const readmeContainer = readmeRow.first().locator("..");
    const deletedIndicator = readmeContainer.locator("span", { hasText: /^D$/ });
    await expect(deletedIndicator).toBeVisible();
  });

  test("FILE-14: git changes section lists modified files", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Navigate to the git changes section
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    // Expand the Git section if collapsed
    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    const changedFilesList = gitChanges.locator("span", { hasText: /^M$/ });
    const filesVisible = await changedFilesList.first().isVisible().catch(() => false);
    if (!filesVisible) {
      await gitHeader.click();
    }

    // Verify that src/index.ts appears with M (modified) status
    const indexFileRow = gitChanges.locator('[data-git-file="src/index.ts"]');
    await expect(indexFileRow.first()).toBeVisible({ timeout: 10000 });

    // Verify M indicator
    const indexContainer = indexFileRow.first().locator("..");
    const modifiedIndicator = indexContainer.locator("span", { hasText: /^M$/ });
    await expect(modifiedIndicator).toBeVisible();
  });

  test("ogni riga dice quante righe cambia, e il non tracciato non finge uno zero", async ({
    fileExplorerPage,
    page,
  }) => {
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });
    const modificati = gitChanges.locator("span", { hasText: /^M$/ });
    if (!(await modificati.first().isVisible().catch(() => false))) {
      await gitChanges.locator("div").filter({ hasText: /^Git$/ }).first().click();
    }

    // `src/index.ts` ha una riga sostituita nel seed: una riga in piu' e una in
    // meno. I conteggi arrivano da `git diff --numstat`, che e' un comando a
    // parte da `git status`: se si scollega, la lista resta ma i numeri no.
    const riga = gitChanges.locator('[data-git-file="src/index.ts"]').first();
    await expect(riga).toBeVisible({ timeout: 10000 });
    await expect(riga).toContainText("+1");
    await expect(riga).toContainText("-1");

    // Il file cancellato porta solo il numero delle righe tolte.
    const cancellato = gitChanges.locator('[data-git-file="README.md"]').first();
    await expect(cancellato).toContainText("-1");
    await expect(cancellato).not.toContainText("+");

    // Un file non tracciato non compare in nessun diff, quindi non c'e' numero
    // da dare. Uno zero direbbe «non e' cambiato niente» di un file nuovo.
    const nuovo = gitChanges.locator('[data-git-file="newfile.txt"]').first();
    await expect(nuovo).toBeVisible();
    await expect(nuovo).not.toContainText(/[+-]\d/);
  });

  test("FILE-18: branch indicator shows current branch", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // The git section header shows the branch name in the right-side area
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    // Branch name is shown in a truncated span (max-w-[80px]) - check for main or master
    // After git init, default branch is usually "main" or "master"
    const branchButton = gitChanges.locator("button").filter({
      hasText: /main|master/,
    });
    await expect(branchButton.first()).toBeVisible({ timeout: 5000 });
  });

  test("FILE-19: git section expand and collapse", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    // The Git header div toggles expand/collapse on click
    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    await expect(gitHeader).toBeVisible();

    // «La sezione mostra il suo contenuto» in UNA definizione sola.
    //
    // Serve perché il contenuto non ha una forma fissa: a repo sporco sono i
    // badge M/D/U/A più il campo del messaggio, a repo pulito è la scritta
    // "Clean working tree". Prima questa disgiunzione era ricopiata due volte
    // (per capire se era già aperta, e per controllare la ri-apertura), mentre
    // la CHIUSURA veniva verificata su due locator singoli con un
    // `.catch(() => {})` attaccato: quelle due asserzioni non potevano fallire,
    // quindi metà del test — la metà che dà il nome al test — non verificava
    // nulla. E non bastava togliere il `catch`: a repo pulito i badge M/D/U/A
    // sono assenti anche da APERTA, quindi asserirne l'assenza sarebbe passato
    // comunque. Il predicato giusto è questo.
    const statusIndicators = gitChanges.locator("span", { hasText: /^[MDUA]$/ });
    // `[data-testid]` e non il placeholder: la casella e passata da <input> a
    // <textarea> che cresce col testo, e un locator sul tag sarebbe morto li.
    const commitInput = gitChanges.locator('[data-testid="commit-message-input"]');
    const cleanTree = gitChanges.getByText("Albero di lavoro pulito");
    const sectionHasContent = async () =>
      (await statusIndicators.first().isVisible().catch(() => false)) ||
      (await commitInput.isVisible().catch(() => false)) ||
      (await cleanTree.isVisible().catch(() => false));

    // Ensure expanded first
    if (!(await sectionHasContent())) {
      await gitHeader.click();
      await expect.poll(sectionHasContent, { timeout: 5_000 }).toBe(true);
    }

    // Collassa: il contenuto deve sparire.
    await gitHeader.click();
    await expect
      .poll(sectionHasContent, { timeout: 5_000, message: "la sezione Git non si e' chiusa" })
      .toBe(false);

    // Ri-espandi: il contenuto deve tornare.
    await gitHeader.click();
    await expect
      .poll(sectionHasContent, { timeout: 5_000, message: "la sezione Git non si e' riaperta" })
      .toBe(true);
  });

  test("FILE-07: diff viewer renders with CodeMirror MergeView", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // The Git section header is a div (not a button) rendered by GitChanges compact mode
    // Click the div containing "Git" text to toggle/expand the section
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    // Check if the git files list is visible; if not, click the Git header to expand
    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    // The changed files appear when expanded -- look for any status badge
    const changedFilesList = gitChanges.locator("span", { hasText: /^M$/ });
    const filesVisible = await changedFilesList.first().isVisible().catch(() => false);
    if (!filesVisible) {
      await gitHeader.click();
    }

    // src/index.ts was modified (from beforeAll setup) -- find it in the changes list
    // In compact mode, changed files are inside the git-changes section
    // Click on the file text (not buttons) to trigger handleFileClick which opens diff
    // All fixture changes are unstaged (nothing is `git add`-ed), so GitChanges
    // renders only the "Changes (n)" header — the "Staged (n)" header is gated
    // on stagedFiles.length > 0. Wait for the section that actually renders.
    const changesSection = gitChanges.locator("text=Changes");
    await expect(changesSection.first()).toBeVisible({ timeout: 10000 });

    // Find the file row for index.ts within git changes -- click the filename text
    const indexFileRow = gitChanges.locator('[data-git-file="src/index.ts"]');
    await expect(indexFileRow.first()).toBeVisible({ timeout: 5000 });
    await indexFileRow.first().click();

    // Wait for the DiffViewer to appear -- it renders inside a FilePane
    const diffViewer = page.locator('[data-testid="diff-viewer"]');
    await expect(diffViewer).toBeVisible({ timeout: 10000 });

    // Assert it contains a CodeMirror MergeView: look for .cm-mergeView or two .cm-editor elements
    // Per quality note: assert .cm-mergeView and .cm-editor presence, not text content
    const mergeView = diffViewer.locator(".cm-mergeView");
    const cmEditors = diffViewer.locator(".cm-editor");

    // Either .cm-mergeView is present, or there are at least 2 .cm-editor panes
    const hasMergeView = await mergeView.count().then(c => c > 0).catch(() => false);
    const editorCount = await cmEditors.count();

    // At least one of these conditions should be true for a valid CodeMirror diff view
    expect(hasMergeView || editorCount >= 2).toBeTruthy();
  });

  // FILE-08 ("script runner lists scripts from package.json") viveva qui ed era
  // il doppione esatto di FILE-03-03 in file-context-menu.spec.ts: stesso
  // percorso utente, stesso testid, stesse tre asserzioni. Tenuto l'originale,
  // che sta nel file tematicamente giusto (File Context Menu & Script Runner) e
  // usa `getByText(..., { exact: true })` invece di `hasText` parziale.

  test("FILE-15: diff viewer shows styled additions and removals", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Navigate to git section and open diff for src/index.ts
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    const changedFilesList = gitChanges.locator("span", { hasText: /^M$/ });
    const filesVisible = await changedFilesList.first().isVisible().catch(() => false);
    if (!filesVisible) {
      await gitHeader.click();
    }

    // Find index.ts file in the changes list.
    // All fixture changes are unstaged (nothing is `git add`-ed), so GitChanges
    // renders only the "Changes (n)" header — the "Staged (n)" header is gated
    // on stagedFiles.length > 0. Wait for the section that actually renders.
    const changesSection = gitChanges.locator("text=Changes");
    await expect(changesSection.first()).toBeVisible({ timeout: 10000 });

    const indexFileRow = gitChanges.locator('[data-git-file="src/index.ts"]');
    await expect(indexFileRow.first()).toBeVisible({ timeout: 5000 });
    await indexFileRow.first().click();

    // Wait for diff viewer
    const diffViewer = page.locator('[data-testid="diff-viewer"]');
    await expect(diffViewer).toBeVisible({ timeout: 10000 });

    // Assert diff viewer has CodeMirror elements with insertion/deletion styling
    const cmEditors = diffViewer.locator(".cm-editor");
    const editorCount = await cmEditors.count();
    expect(editorCount).toBeGreaterThanOrEqual(1);

    // Check for diff-specific styling classes that indicate additions/removals
    const changedLine = diffViewer.locator(".cm-changedLine, .cm-insertedLine, .cm-deletedLine, .cm-changedText");
    const changedCount = await changedLine.count();
    expect(changedCount).toBeGreaterThanOrEqual(1);
  });

  test("FILE-16: git staging a file", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Navigate to git section
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    const changedFilesList = gitChanges.locator("span", { hasText: /^[MDUA]$/ });
    const filesVisible = await changedFilesList.first().isVisible().catch(() => false);
    if (!filesVisible) {
      await gitHeader.click();
    }

    // Wait for the Changes (unstaged) section to be visible
    const changesHeader = gitChanges.locator("button", { hasText: /Changes/ });
    await expect(changesHeader.first()).toBeVisible({ timeout: 10000 });

    // La RIGA, agganciata al path. Prima si cercava `[title="newfile.txt"]` e poi
    // si saliva col `..`: ma il `title` sta gia sulla riga, quindi quel `..` era
    // il CONTENITORE della lista. Si passava il mouse sul contenitore (cioe' al
    // centro, su una riga qualunque) e si cercava un bottone Stage fra tutti
    // quelli della lista. Passava per fortuna, finche' la lista aveva una riga.
    const newfileRow = gitChanges.locator('[data-git-file="newfile.txt"]');
    await expect(newfileRow).toBeVisible({ timeout: 5000 });

    // Le azioni ora sono `invisible` (non `opacity-0`) e occupano il posto del
    // conteggio delle righe: Playwright le vede nascoste davvero, quindi questa
    // hover e' una condizione, non una formalita'.
    await newfileRow.hover();

    const stageButton = newfileRow.locator('button[title="Stage"]');
    await expect(stageButton).toBeVisible();
    await stageButton.click();

    // Wait for the file to move to the Staged section
    // The Staged section header should be visible with the file in it
    const stagedHeader = gitChanges.locator("button", { hasText: /Staged/ });
    await expect(stagedHeader.first()).toBeVisible({ timeout: 10000 });
  });

  test("FILE-17: git commit with message", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Navigate to git section
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    const changedFilesList = gitChanges.locator("span", { hasText: /^[MDUA]$/ });
    const filesVisible = await changedFilesList.first().isVisible().catch(() => false);
    if (!filesVisible) {
      await gitHeader.click();
    }

    // Stage all files first via Stage All button
    const changesHeader = gitChanges.locator("button", { hasText: /Changes/ });
    await expect(changesHeader.first()).toBeVisible({ timeout: 10000 });

    // Hover over the Changes header to reveal Stage All button
    const changesRow = changesHeader.first().locator("..");
    await changesRow.hover();
    const stageAllBtn = changesRow.locator('button[title="Stage all"]');
    await expect(stageAllBtn).toBeVisible();
    await stageAllBtn.click();

    // Wait for Staged section to appear with all files
    const stagedHeader = gitChanges.locator("button", { hasText: /Staged/ });
    await expect(stagedHeader.first()).toBeVisible({ timeout: 10000 });

    // Find the commit message box (textarea che cresce col testo)
    const commitInput = gitChanges.locator('[data-testid="commit-message-input"]');
    await expect(commitInput).toBeVisible();

    // Type a commit message
    await commitInput.fill("e2e test commit");

    // Click the commit button (contains GitCommit icon)
    const commitBtn = gitChanges.locator('button[title="Commit staged changes"]');
    await expect(commitBtn).toBeVisible();
    await expect(commitBtn).toBeEnabled();
    await commitBtn.click();

    // After commit, the staged section should clear (clean working tree).
    //
    // Aspettare SOLO l'albero pulito rendeva due esiti diversi indistinguibili:
    // «il commit e' fallito» e «il pannello non si e' aggiornato» finivano
    // tutt'e due in un timeout muto a 15s. Il pannello ora tiene l'errore di
    // git al posto suo, quindi si aspetta il primo dei due che arriva e, se e'
    // l'errore, il rosso porta con se' lo stderr vero di `git commit`.
    const cleanTree = gitChanges.getByText("Albero di lavoro pulito");
    const commitError = gitChanges.locator('[data-testid="commit-error"]');
    await expect(cleanTree.or(commitError)).toBeVisible({ timeout: 15000 });
    if (await commitError.isVisible()) {
      throw new Error(`git commit rifiutato dal server: ${(await commitError.innerText()).trim()}`);
    }
    await expect(cleanTree).toBeVisible();
  });

  /**
   * Un commit RIFIUTATO deve lasciare un segno che resta.
   *
   * Prima c'era solo un toast: spariva da solo, e il pannello restava identico
   * a com'era un istante prima — le stesse modifiche, la stessa casella piena.
   * Cioe' indistinguibile da un commit non ancora partito. Il 400 qui e' finto
   * ma il testo e' quello vero di git: e' esattamente lo stderr che FILE-17
   * incassava in silenzio.
   */
  test("FILE-18: un commit rifiutato lascia l'errore nel pannello", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-02" });
    // FILE-17 ha appena committato tutto: senza una modifica nuova non c'e'
    // niente da mettere in stage, e il bottone Commit resta disabilitato.
    writeFileSync(join(tmpDir, "rifiutato.txt"), "una riga che non verra' committata\n");

    const STDERR = "fatal: Unable to create '/tmp/e2e/.git/index.lock': File exists.";
    await page.route("**/api/git/commit", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: STDERR }) }),
    );

    await fileExplorerPage.gotoProject(tmpDir, topicName);

    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10000 });

    // La sezione Git puo' arrivare CHIUSA, esattamente come in FILE-16/17:
    // senza questo passo non esiste nessun bottone "Changes" da trovare.
    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    const changedFilesList = gitChanges.locator("span", { hasText: /^[MDUA]$/ });
    if (!(await changedFilesList.first().isVisible().catch(() => false))) {
      await gitHeader.click();
    }

    const changesHeader = gitChanges.locator("button", { hasText: /Changes/ });
    await expect(changesHeader.first()).toBeVisible({ timeout: 10000 });
    const changesRow = changesHeader.first().locator("..");
    await changesRow.hover();
    const stageAllBtn = changesRow.locator('button[title="Stage all"]');
    await expect(stageAllBtn).toBeVisible();
    await stageAllBtn.click();

    await expect(gitChanges.locator("button", { hasText: /Staged/ }).first()).toBeVisible({ timeout: 10000 });

    const commitInput = gitChanges.locator('[data-testid="commit-message-input"]');
    await commitInput.fill("questo commit verra' rifiutato");
    await gitChanges.locator('button[title="Commit staged changes"]').click();

    // La ragione di git, per esteso, dentro al pannello.
    const commitError = gitChanges.locator('[data-testid="commit-error"]');
    await expect(commitError).toBeVisible({ timeout: 10000 });
    await expect(commitError).toContainText("index.lock");

    // E RESTA: il watcher su .git/index ricarica lo stato entro ~500ms, e un
    // toast a quel punto sarebbe gia' sulla via d'uscita.
    await page.waitForTimeout(3000);
    await expect(commitError).toBeVisible();
    // Il messaggio non e' stato buttato via: si puo' ritentare senza riscriverlo.
    await expect(commitInput).toHaveValue("questo commit verra' rifiutato");

    await page.unroute("**/api/git/commit");
    rmSync(join(tmpDir, "rifiutato.txt"), { force: true });
  });
});
