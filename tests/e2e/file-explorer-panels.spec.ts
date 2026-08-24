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
 * La barra breadcrumb del file aperto e la sezione Processi (ScriptRunner).
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
test.describe("File Explorer — breadcrumb e processi", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "panels");
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

  test("EXPLORER-06: breadcrumb navigation", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Ensure src/ is expanded and click index.ts to open a nested file
    const srcDir = fileExplorerPage.getDirNode(/^src$/);
    await expect(srcDir).toBeVisible();

    const indexItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /index\.ts/,
    });
    // If index.ts not visible, expand src/
    const indexVisible = await indexItem.isVisible().catch(() => false);
    if (!indexVisible) {
      await srcDir.click();
    }
    await expect(indexItem).toBeVisible();
    await indexItem.click();

    // Wait for breadcrumb to appear in the file pane. A file opened by an
    // earlier test (package.json, from FILE-05) can still be mounted as an
    // inactive editor pane (kept alive via display:none), so the unscoped
    // testid matches two breadcrumbs — scope to the visible (active) one, which
    // is the index.ts file we just opened.
    const breadcrumb = page.locator('[data-testid="breadcrumb-nav"]:visible');
    await expect(breadcrumb).toBeVisible({ timeout: 5000 });

    // Breadcrumb should show path segments including "src" and "index.ts"
    await expect(breadcrumb).toContainText("src");
    await expect(breadcrumb).toContainText("index.ts");

    // Click on the "src" breadcrumb segment to open dropdown with sibling files
    const srcSegment = breadcrumb.getByRole("button", { name: "src" });
    await expect(srcSegment).toBeVisible();
    await srcSegment.click();

    // Il dropdown di un segmento elenca il contenuto della sua directory
    // PADRE — cioe' i FRATELLI del segmento, che e' come ci si sposta di lato
    // nell'albero. Per il segmento `src` il padre e' la radice del progetto:
    // dentro ci sono `src` stesso, `package.json` e `newfile.txt` (README.md e'
    // cancellato nel seed). `index.ts` NON c'e': e' un figlio di src, e comparira'
    // nel dropdown del segmento successivo. Lo dice `BreadcrumbNav.tsx`:
    //   parentDir = i === 0 ? projectPath : projectPath + '/' + segments.slice(0, i)
    //
    // Prima qui c'era `if (visibile) expect(visibile)` — una tautologia — con il
    // commento «se non c'e' il dropdown, il click puo' aver navigato: vanno bene
    // entrambi gli esiti» e «l'interazione e' verificata dal fatto che il click
    // non da' errore». Non era vero: un click che non fa NULLA non da' errore, e
    // il test sarebbe rimasto verde comunque.
    const dropdownItems = page.locator('[class*="max-h-[300px]"] button');
    await expect
      .poll(async () => (await dropdownItems.allInnerTexts()).join(" "), {
        timeout: 10_000,
        message: "il segmento `src` deve aprire il dropdown della sua directory padre",
      })
      .toContain("package.json");

    const entries = (await dropdownItems.allInnerTexts()).map((t) => t.trim());
    expect(entries.join(" "), "i fratelli di src, non i suoi figli").toContain("newfile.txt");
    expect(entries.join(" ")).toContain("src");
  });

  test("FIX-07: breadcrumb dropdown refreshes on directory change", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Open src/index.ts to get breadcrumbs for a nested file
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

    // Wait for breadcrumb to appear. Scope to `:visible`: opening index.ts can
    // leave a prior editor tab (e.g. package.json) mounted-but-hidden, so a bare
    // selector resolves to 2 breadcrumb-nav elements (strict-mode violation).
    // Only the active editor's breadcrumb is visible.
    const breadcrumb = page.locator('[data-testid="breadcrumb-nav"]:visible');
    await expect(breadcrumb).toBeVisible({ timeout: 5000 });
    await expect(breadcrumb).toContainText("index.ts");

    // Si apre il dropdown dell'ULTIMO segmento (`index.ts`), la cui directory
    // padre e' `src/`: dentro c'e' solo `index.ts`.
    //
    // Prima si cliccava il segmento `src` con il commento «this lists children of
    // the parent directory» e, due righe sotto, «the dropdown should show
    // index.ts (child of src/)»: i due commenti si contraddicevano e il secondo
    // era sbagliato — il padre di `src` e' la RADICE, quindi quel dropdown
    // elencava package.json e fratelli. Nessuno se n'era accorto perche'
    // l'unica asserzione era «la prima voce e' visibile», vera per qualunque
    // dropdown. E cliccando `src` questo test non provava nemmeno cio' che dice
    // di provare: il dropdown della radice confrontato con... il dropdown della
    // radice. Due directory DIVERSE servono, o non c'e' nessuna cache da
    // invalidare.
    const indexSegment = breadcrumb.getByRole("button", { name: "index.ts" });
    await indexSegment.click();

    // DropdownPortal renders at page level. Il segnale che l'API ha risposto è
    // la prima voce a schermo, non 500ms di attesa al buio.
    const dropdownItems = page.locator('[class*="max-h-[300px]"] button');
    await expect
      .poll(async () => (await dropdownItems.allInnerTexts()).join(" "), { timeout: 10_000 })
      .toContain("index.ts");
    const srcEntries = (await dropdownItems.allInnerTexts()).map((t) => t.trim());
    expect(srcEntries.join(" "), "il padre di index.ts e' src/, che contiene solo lui").not.toContain(
      "package.json",
    );

    // Close the dropdown by clicking the segment again
    await indexSegment.click();

    // Now open a different file at root level: package.json (README.md is
    // deleted in beforeAll to seed FILE-13's "D" status, so it's absent).
    const readmeItem = fileExplorerPage.fileTree.getByRole("treeitem", {
      name: /package\.json/,
    });
    await readmeItem.click();

    // Wait for breadcrumb to update to the root-level file path
    await expect(breadcrumb).toContainText("package.json");

    // The breadcrumb now shows a root-level path, so the directory context is different
    // Click the first segment (project root) to open its dropdown
    const rootSegment = breadcrumb.locator("button").first();
    await rootSegment.click();

    // Il difetto in esame e' una CACHE STANTIA (BreadcrumbNav.tsx: `cache` tiene
    // la directory per cui e' stata riempita, e la si scarta se `parentDir`
    // cambia). Quindi la cosa da asserire e' che l'elenco sia CAMBIATO, non che
    // sia "abbastanza lungo".
    //
    // Prima si contavano le voci e si pretendeva `>= 3`, e il conteggio del primo
    // dropdown veniva catturato in una variabile mai confrontata con niente — era
    // l'unico pezzo che avrebbe legato il controllo al nome del test.
    const rootDropdownItems = page.locator('[class*="max-h-[300px]"] button');
    await expect
      .poll(async () => (await rootDropdownItems.allInnerTexts()).join(" "), { timeout: 10_000 })
      .toContain("package.json");

    const rootEntries = (await rootDropdownItems.allInnerTexts()).map((t) => t.trim());
    // Voci della RADICE, che `src/` non contiene: se la cache fosse stantia, qui
    // ci sarebbe ancora il solo index.ts.
    expect(rootEntries.join(" "), "il dropdown deve elencare la radice").toContain("newfile.txt");
    expect(
      rootEntries,
      `il dropdown non si e' aggiornato: mostra ancora il contenuto di src/ (${srcEntries.join(", ")})`,
    ).not.toEqual(srcEntries);
  });

  test("EXPLORER-09: process list renders", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // The ProcessList component takes topicId and shows agent sub-processes
    // In the sidebar, the "Processes" section actually renders ScriptRunner (for npm scripts)
    // ProcessList is a separate component for agent sub-processes (not in sidebar)
    // We verify the Processes section renders and is interactive

    // Click the Processes section button to expand it
    const processesBtn = page.locator("button", { hasText: "Processi" });
    await expect(processesBtn).toBeVisible({ timeout: 5000 });
    await processesBtn.click();

    // When expanded, the ScriptRunner renders inside showing scripts from package.json
    // This confirms the processes section is functional
    const scriptRunner = page.locator('[data-testid="script-runner"]');
    await expect(scriptRunner).toBeVisible({ timeout: 10000 });

    // Verify the section can be collapsed by clicking again
    await processesBtn.click();

    // ScriptRunner should no longer be visible after collapsing
    await expect(scriptRunner).not.toBeVisible({ timeout: 5000 });

    // Re-expand to confirm toggle works both ways
    await processesBtn.click();
    await expect(scriptRunner).toBeVisible({ timeout: 10000 });

    // No new processes spawned (per D-12) -- just verify the section renders
  });

  test("FIX-09: script stop updates UI correctly", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "FILE-01" });
    // Mock the scripts list API (useScripts calls GET /api/scripts) BEFORE navigation
    // so the running process appears immediately when ScriptRunner mounts
    let stopCalled = false;
    await page.route("**/api/scripts", async (route) => {
      // Only intercept GET requests for the scripts list endpoint (not sub-paths)
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || url.pathname !== "/api/scripts") {
        return route.fallback();
      }
      const scripts = stopCalled
        ? [{ processId: "proc-1", scriptName: "dev", status: "stopped", projectPath: tmpDir, command: "echo dev", ports: [], startedAt: Date.now() - 60000 }]
        : [{ processId: "proc-1", scriptName: "dev", status: "running", projectPath: tmpDir, command: "echo dev", ports: [3000], startedAt: Date.now() - 60000 }];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scripts }),
      });
    });

    await page.route("**/api/scripts/*/stop", async (route) => {
      stopCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await fileExplorerPage.gotoProject(tmpDir, topicName);

    // Navigate to Processes section
    const processesBtn = page.locator("button", { hasText: "Processi" });
    await expect(processesBtn).toBeVisible({ timeout: 5000 });
    await processesBtn.click();

    // Wait for ScriptRunner to load with the running script
    const scriptRunner = page.locator('[data-testid="script-runner"]');
    await expect(scriptRunner).toBeVisible({ timeout: 10000 });

    // The "dev" script should show as running (green pulse indicator)
    const devScript = scriptRunner.locator("span").filter({ hasText: "dev" }).first();
    await expect(devScript).toBeVisible();

    // Verify running state: green pulse indicator
    const runningIndicator = scriptRunner.locator('.animate-pulse');
    await expect(runningIndicator).toBeVisible({ timeout: 5000 });

    // Click stop button
    const stopBtn = scriptRunner.locator('button[title="Stop"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // The stop spinner should appear briefly
    const stopSpinner = scriptRunner.locator('.animate-spin');
    await expect(stopSpinner).toBeVisible({ timeout: 3000 });

    // After polling resolves (stop API called + refresh shows stopped state),
    // the spinner should disappear. The ref-based fix ensures the polling
    // reads the updated runningScripts value.
    await expect(stopSpinner).not.toBeVisible({ timeout: 15000 });

    // The running pulse indicator should no longer be present
    await expect(runningIndicator).not.toBeVisible();
  });
});
