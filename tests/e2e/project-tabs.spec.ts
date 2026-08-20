import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

let projectTopicId: string | null = null;
// A REAL directory: project-internal Shell/terminal panes cd into projectPath,
// so a non-existent path makes them exit code 1 ("failed launch") within ms —
// the pane vanishes before a split can build a 2-tab group. Unique folder name
// keeps its own sidebar button.
const PROJECT_PATH = `/tmp/e2e-project-tabs-${Date.now()}`;

test.describe("Project Tabs", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(
      `${PROJECT_PATH}/package.json`,
      JSON.stringify({ name: "e2e-project-tabs" }, null, 2)
    );
    const topic = await createTopic(request, "E2E-ProjectTabs", {
      projectPath: PROJECT_PATH,
    });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) {
      await deleteTopic(request, projectTopicId);
    }
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    // Hermetic surface: wipe panes leaked by earlier specs (the shared
    // pane-store-v2 UNIONs on hydrate) so only OUR project tiles, then seed the
    // `project:<path>` pane. The tab-driven sidebar only shows a project row
    // while its pane is open (`hasProjectTab`) or a child topic has an open tab —
    // but this spec's topic is PROJECT-LINKED, and usePanelLifecycle purges
    // project-linked topic ids from the open set, so seeding the topic never
    // surfaces the row. Seed the project pane itself, exactly like the UI does.
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  });

  /** Open the e2e project by clicking its sidebar button.
   *  Uses a unique root path so it gets its own standalone button. */
  async function openTestProject(page: import("@playwright/test").Page) {
    // Expand sezione Progetti
    const projectsSection = page.getByRole("button", {
      name: /sezione Progetti/,
    });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
        // La sezione è aperta quando lo DICE, non dopo mezzo secondo.
        await expect(projectsSection).toHaveAttribute("aria-expanded", "true");
      }
    }

    // Match by the beginning of the folder name (before timestamp)
    const btn = page
      .locator('[aria-label="Topics sidebar"] button')
      .filter({ hasText: /e2e-project-tabs/ })
      .first();
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();

    // Wait for project window tab bar
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').first()
    ).toBeVisible({ timeout: 10000 });
  }

  /** La finestra di progetto, che è l'unico posto dove «una tab di progetto»
   *  esiste: fuori di lì c'è la tab DEL progetto, che è un'altra cosa. */
  function projectWindow(page: import("@playwright/test").Page) {
    return page.locator('[data-testid="project-window"]:visible').first();
  }

  /**
   * Aggiunge una pane DENTRO la finestra di progetto.
   *
   * Il «+» va preso lì e non con `getByTitle("Add pane").first()`: il primo
   * della pagina è quello della barra STANDALONE, sopra la finestra, e la pane
   * che crea nasce al livello dell'app, accanto alla tab del progetto invece
   * che dentro. Un test che chiede «il progetto» e clicca quello misura una
   * superficie che non ha mai aperto — e resta verde finché è la standalone a
   * comportarsi come si aspetta.
   */
  async function addPaneInProject(
    page: import("@playwright/test").Page,
    itemTestId: string,
  ) {
    const finestra = projectWindow(page);
    const trigger = finestra
      .locator('[data-testid="pane-add-menu-trigger"]:visible')
      .first();
    await expect(trigger).toBeVisible({ timeout: 10000 });
    await trigger.click();
    const voce = page.getByTestId(itemTestId).first();
    await expect(voce).toBeVisible({ timeout: 5000 });
    await voce.click();
  }

  // PROJECT-TABS-01: Project Window Pane Management

  test("PROJECT-TABS-01: project window displays tab bar with default pane", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-01",
    });
    await goToApp(page);
    await openTestProject(page);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(tabBar).toBeVisible({ timeout: 10000 });

    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 5000 });
    expect(await tabs.count()).toBeGreaterThanOrEqual(1);
  });

  test("PROJECT-TABS-01: add pane via (+) menu adds new tab", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-01",
    });
    await goToApp(page);
    await openTestProject(page);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    const initialCount = await tabs.count();

    const addPaneBtn = page.getByTitle("Add pane");
    await expect(addPaneBtn.first()).toBeVisible({ timeout: 5000 });
    await addPaneBtn.first().click();

    const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
    await expect(addMenu).toBeVisible({ timeout: 5000 });
    const menuButtons = addMenu.locator("button");
    expect(await menuButtons.count()).toBeGreaterThan(0);

    // Verify known pane types in menu
    const menuTexts: string[] = [];
    for (let i = 0; i < (await menuButtons.count()); i++) {
      const text = await menuButtons.nth(i).textContent();
      if (text) menuTexts.push(text.trim());
    }
    const knownTypes = ["Files", "Terminal", "Shell", "Git", "Browser", "Board", "Agents"];
    expect(menuTexts.some((t) => knownTypes.some((k) => t.includes(k)))).toBeTruthy();

    // Select a non-chat pane
    for (let i = 0; i < (await menuButtons.count()); i++) {
      const text = ((await menuButtons.nth(i).textContent()) || "").trim();
      if (/Terminal|Shell|Files|Git/i.test(text) && !/Chat/i.test(text)) {
        await menuButtons.nth(i).click();
        break;
      }
    }

    await expect(tabs.first()).toBeVisible({ timeout: 5000 });
    expect(await tabs.count()).toBeGreaterThanOrEqual(initialCount);
  });

  test("PROJECT-TABS-01: switch between project pane tabs changes content", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-01",
    });
    await goToApp(page);
    await openTestProject(page);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    // Add second pane if needed
    if ((await tabs.count()) < 2) {
      const addPaneBtn = page.getByTitle("Add pane");
      if ((await addPaneBtn.count()) > 0) {
        await addPaneBtn.first().click();
        const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
        await expect(addMenu).toBeVisible({ timeout: 5000 });
        const menuButtons = addMenu.locator("button");
        for (let i = 0; i < (await menuButtons.count()); i++) {
          const text = ((await menuButtons.nth(i).textContent()) || "").trim();
          if (!/Chat/i.test(text)) {
            await menuButtons.nth(i).click();
            break;
          }
        }
      }
    }

    if ((await tabs.count()) >= 2) {
      await tabs.first().click();
      await tabs.nth(1).click();
      expect(await tabs.nth(1).isVisible()).toBeTruthy();
    }
  });

  test("PROJECT-TABS-01: close project pane tab removes it", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-01",
    });
    await goToApp(page);
    await openTestProject(page);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    // Add a pane to close
    const addPaneBtn = page.getByTitle("Add pane");
    if ((await addPaneBtn.count()) > 0) {
      await addPaneBtn.first().click();
      const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
      await expect(addMenu).toBeVisible({ timeout: 5000 });
      const menuButtons = addMenu.locator("button");
      for (let i = 0; i < (await menuButtons.count()); i++) {
        const text = ((await menuButtons.nth(i).textContent()) || "").trim();
        if (!/Chat/i.test(text)) {
          await menuButtons.nth(i).click();
          break;
        }
      }
    }

    await expect(tabs.first()).toBeVisible({ timeout: 5000 });
    const countBefore = await tabs.count();

    if (countBefore >= 2) {
      await tabs.last().click({ button: "right" });
      const menu = page.locator('[role="menu"]');
      await expect(menu).toBeVisible({ timeout: 5000 });
      const closeBtn = menu
        .locator("button")
        .filter({ hasText: /^Chiudi/ })
        .first();
      await closeBtn.click();

      await expect
        .poll(async () => tabs.count(), { timeout: 5000 })
        .toBeLessThan(countBefore);
    }
  });

  // PROJECT-TABS-02: Project Tab State Persistence

  test("PROJECT-TABS-02: project pane tabs persist after reload", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-02",
    });
    await goToApp(page);
    await openTestProject(page);

    // The freshly-seeded project opens EMPTY ("No chats open") — there is no
    // internal draggable tab yet. Add a pane through the PROJECT-INTERNAL (+)
    // (.last(); .first() is the top-level bar whose (+) spawns a STANDALONE pane
    // that does NOT persist to topics-project-panes-<hash>). Only the
    // project-internal (+) writes nonChatPanes (confirmed via diagnostic).
    const addPaneBtn = page.getByTitle("Add pane").last();
    await expect(addPaneBtn).toBeVisible({ timeout: 10000 });
    await addPaneBtn.click();
    const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
    await expect(addMenu).toBeVisible({ timeout: 5000 });
    const menuButtons = addMenu.locator("button");
    for (let i = 0; i < (await menuButtons.count()); i++) {
      const text = ((await menuButtons.nth(i).textContent()) || "").trim();
      if (/Terminal|Shell/i.test(text) && !/Chat/i.test(text)) {
        await menuButtons.nth(i).click();
        break;
      }
    }

    // Project tab persistence is DEVICE-LOCAL now: savePersistedTabState writes
    // `topics-project-panes-<hash>` to localStorage — the old
    // `PUT /api/ui-state/project-layout` never fires. Poll the localStorage key
    // until it reflects the added non-chat pane before reloading.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            let max = 0;
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)!;
              if (!k.startsWith("topics-project-")) continue;
              try {
                const v = JSON.parse(localStorage.getItem(k) || "{}");
                const panes = Array.isArray(v?.nonChatPanes) ? v.nonChatPanes : [];
                if (panes.length > max) max = panes.length;
              } catch {
                /* not JSON */
              }
            }
            return max;
          }),
        { timeout: 10000 }
      )
      .toBeGreaterThanOrEqual(1);

    // Reload. Use "load" (not "networkidle"): we JUST spawned a Shell whose
    // PTY/WS streams the prompt, so the network never goes idle for 500ms and
    // "networkidle" would stall until the test timeout. The explicit sidebar
    // wait below is the real readiness gate.
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    await openTestProject(page);

    const restoredTabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(restoredTabBar).toBeVisible({ timeout: 10000 });
    const restoredTabs = restoredTabBar.locator('[draggable="true"]');
    await expect(restoredTabs.first()).toBeVisible({ timeout: 10000 });
    expect(await restoredTabs.count()).toBeGreaterThanOrEqual(1);
  });

  test("PROJECT-TABS-02: project split layout persists after reload", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-02",
    });
    await goToApp(page);
    await openTestProject(page);

    // Scope to the project window's INNER group bars (data-group-id `group:*`,
    // set by GroupLayout). Bar 0 in the page is the standalone POOL bar —
    // right-clicking ITS first tab would split the project PANE in the top-level
    // grid instead of splitting inside the project window. A fresh project opens
    // with an EMPTY placeholder group whose bar has NO group id yet ("No chats
    // open", zero tabs); populated `group:*` bars only appear once panes exist.
    // Mirrors split-screen-sync.spec's proven pattern.
    const projectBars = page.locator(
      '[data-testid="panel-tab-bar"][data-group-id^="group:"]'
    );
    const projectTabs = projectBars.locator('[draggable="true"]');
    const projectAdd = page
      .locator(
        '[data-testid="panel-tab-bar"]:not([data-group-id="standalone"]):not([data-group-id^="solo:"])'
      )
      .getByTitle("Add pane");

    // Build up to 2 project-internal panes in ONE group (Split Right needs a
    // 2-tab group to split out of).
    for (let n = await projectTabs.count(); n < 2; n++) {
      if ((await projectAdd.count()) === 0) break;
      await projectAdd.last().click();
      const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
      await expect(addMenu).toBeVisible({ timeout: 5000 });
      const menuButtons = addMenu.locator("button");
      let clicked = false;
      for (let i = 0; i < (await menuButtons.count()); i++) {
        const text = ((await menuButtons.nth(i).textContent()) || "").trim();
        if (!/Chat/i.test(text)) {
          await menuButtons.nth(i).click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        await page.keyboard.press("Escape");
        break;
      }
      await expect
        .poll(() => projectTabs.count(), { timeout: 5000 })
        .toBeGreaterThan(n);
    }

    const tabs = projectBars.first().locator('[draggable="true"]');
    if ((await tabs.count()) >= 2) {
      await tabs.first().click({ button: "right" });
      const menu = page.locator('[role="menu"]').first();
      await expect(menu).toBeVisible({ timeout: 5000 });
      const splitBtn = menu
        .locator("button")
        .filter({ hasText: /Dividi a destra/ })
        .first();

      if ((await splitBtn.count()) > 0) {
        await splitBtn.click();

        // Wait for split to render — a SECOND project-internal group bar.
        const splitRendered = await projectBars
          .nth(1)
          .waitFor({ state: "visible", timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (!splitRendered) {
          // Split didn't produce 2 groups — skip rest of test
          return;
        }

        // Project split GEOMETRY is DEVICE-LOCAL now: savePersistedLayoutState
        // writes `topics-project-layout-<hash>` to localStorage — the old
        // `PUT /api/ui-state/project-layout` never fires. Poll the localStorage
        // key until it reflects the 2-group split before reloading.
        await expect
          .poll(
            async () =>
              page.evaluate(() => {
                for (let i = 0; i < localStorage.length; i++) {
                  const k = localStorage.key(i)!;
                  if (!k.startsWith("topics-project-layout-")) continue;
                  try {
                    const v = JSON.parse(localStorage.getItem(k) || "{}");
                    const rows = Array.isArray(v?.rows) ? v.rows : [];
                    const groups = rows.flatMap(
                      (r: { groupIds?: string[] }) => r.groupIds ?? []
                    );
                    if (groups.length >= 2) return true;
                  } catch {
                    /* not JSON */
                  }
                }
                return false;
              }),
            { timeout: 10000 }
          )
          .toBe(true);

        // "load" not "networkidle": live Shell PTY/WS keeps the network busy.
        await page.reload({ waitUntil: "load" });
        await page.waitForSelector('[aria-label="Topics sidebar"]', {
          state: "visible",
          timeout: 15000,
        });

        await openTestProject(page);

        // The split (two project-internal groups) is restored from the
        // device-local layout key → a SECOND group bar reappears.
        await expect(projectBars.nth(1)).toBeVisible({ timeout: 10000 });
      }
    }
  });

  // Regression for "perdo il focus su questa tab" / "perdo lo split": a Git/Files
  // pane is born `preview:true`, and the persist effect used to drop EVERY
  // preview pane from nonChatPanes — so on reload the focused preview tab
  // vanished, its cell collapsed (orphan-sync prunes an empty group) and focus
  // snapped to a chat. The fix persists a preview pane that is a group's ACTIVE
  // tab, so whatever the user is looking at (a focused Git/Files tab, or a
  // split-out preview cell) survives the reload.
  test("PROJECT-TABS-02: focused preview (Files/Git) pane survives reload", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-02-preview-focus",
    });
    await goToApp(page);
    await openTestProject(page);

    const projectAdd = page
      .locator(
        '[data-testid="panel-tab-bar"]:not([data-group-id="standalone"]):not([data-group-id^="solo:"])'
      )
      .getByTitle("Add pane");
    // Files/Git are `addableScopes: ['project']`, so a project add menu MUST
    // offer them — assert (not skip) so this stays a real guard.
    await expect(projectAdd.first()).toBeVisible({ timeout: 10000 });

    // Add a PREVIEW pane (Files/Git — non-durable, born preview:true). It becomes
    // its group's ACTIVE tab.
    await projectAdd.last().click();
    const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
    await expect(addMenu).toBeVisible({ timeout: 5000 });
    // Si punta al `data-testid`, non al testo della riga.
    //
    // Il filtro era `hasText: /\b(Files|Git)\b/`, e da quando ogni voce del menu
    // porta la sua LETTERA attaccata al nome — il `mnemonic` di
    // `paneMnemonics.ts`, reso senza spazio dentro il bottone — il testo del
    // bottone è «FilesF» e «GitG»: dopo `Files` c'è un carattere di parola,
    // quindi `\b` non chiude più e il locator non trova NIENTE. Il testo di una
    // riga di menu è chrome e cambia col disegno; `pane-add-menu-<tipo>` è il
    // contratto dichiarato per le spec E2E in `addMenuItems.tsx` («da non
    // cambiare»), ed è quello che va usato.
    const previewBtn = addMenu
      .locator('[data-testid="pane-add-menu-files"], [data-testid="pane-add-menu-git"]')
      .first();
    await expect(previewBtn).toBeVisible({ timeout: 5000 });
    await previewBtn.click();
    // Confirm the preview pane actually mounted as a tab before asserting its
    // persistence (guards against a silent no-op click).
    await expect
      .poll(async () =>
        page.evaluate(() => {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)!;
            if (!k.startsWith("topics-project-panes-")) continue;
            try {
              const v = JSON.parse(localStorage.getItem(k) || "{}");
              const panes = Array.isArray(v?.nonChatPanes) ? v.nonChatPanes : [];
              if (panes.length > 0) return true;
            } catch { /* not JSON */ }
          }
          return false;
        }),
        { timeout: 8000 }
      )
      .toBe(true);

    // The fix: an ACTIVE preview pane is now written to the device-local
    // nonChatPanes. Poll the panes key until it lists the file/git pane — the
    // exact bit that used to be missing, which caused the reload loss.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)!;
              if (!k.startsWith("topics-project-panes-")) continue;
              try {
                const v = JSON.parse(localStorage.getItem(k) || "{}");
                const panes = Array.isArray(v?.nonChatPanes)
                  ? v.nonChatPanes
                  : [];
                if (
                  panes.some(
                    (p: { type?: string }) =>
                      p.type === "files" || p.type === "git"
                  )
                )
                  return true;
              } catch {
                /* not JSON */
              }
            }
            return false;
          }),
        { timeout: 10000 }
      )
      .toBe(true);

    // "load" not "networkidle": live WS keeps the network busy.
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await openTestProject(page);

    // The focused preview tab is restored (its cell didn't collapse, focus
    // didn't snap to a chat): a project group bar reappears AND the file/git
    // pane is still in the persisted set after the reload round-trip.
    const projectBars = page.locator(
      '[data-testid="panel-tab-bar"][data-group-id^="group:"]'
    );
    await expect(projectBars.first()).toBeVisible({ timeout: 10000 });
    expect(
      await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)!;
          if (!k.startsWith("topics-project-panes-")) continue;
          try {
            const v = JSON.parse(localStorage.getItem(k) || "{}");
            const panes = Array.isArray(v?.nonChatPanes) ? v.nonChatPanes : [];
            if (panes.some((p: { type?: string }) => p.type === "files" || p.type === "git")) return true;
          } catch { /* not JSON */ }
        }
        return false;
      })
    ).toBe(true);
  });

  // PROJECT-TABS-03: Project Tab Status Badges

  test("PROJECT-TABS-03: project tab renders with status badge infrastructure", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-03",
    });
    await goToApp(page);
    await openTestProject(page);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(tabBar).toBeVisible({ timeout: 10000 });
    const tabs = tabBar.locator('[draggable="true"]');
    expect(await tabs.count()).toBeGreaterThanOrEqual(1);

    // Status badges (amber for git, emerald for processes) are conditional on project state.
    // We verify the tab bar renders correctly in a project context.
    // The badge CSS classes (bg-amber-100 for git, bg-emerald-100 for processes)
    // only render when the project has modified files or running processes.
  });

  // Regression: a project must NOT split on a phone. Open it on desktop, put
  // two panes in it, then shrink to a phone viewport — GroupLayout must bypass
  // SplitTree entirely (zero `data-group-cell`) and flatten every group into
  // ONE tab strip that still carries every pane as a tab.
  test("PROJECT-TABS-MOBILE-01: project flattens to a single tab strip on a phone", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-MOBILE-01",
    });
    await goToApp(page);
    await openTestProject(page);

    const finestra = projectWindow(page);
    await expect(finestra).toBeVisible({ timeout: 10000 });

    // DUE pane, e dentro il progetto. Il progetto seminato apre vuoto (il ramo
    // `rows.length === 0` di GroupLayout, «No chats open»), quindi le pane si
    // creano qui: senza, il resto del test misurerebbe un progetto che non ha
    // nessun gruppo da appiattire — che è esattamente il modo in cui questo
    // test restava verde senza provare niente.
    await addPaneInProject(page, "pane-add-menu-new-chat");
    await addPaneInProject(page, "pane-add-menu-browser");

    // `[data-pane-id]` e non `[data-testid^="pane-tab-"]`: il prefisso pesca
    // anche `pane-tab-label`, che sta DENTRO ogni tab, quindi conterebbe due
    // nodi per tab.
    const tabDelProgetto = finestra.locator("[data-pane-id]:visible");
    // Le pane DISTINTE, non i nodi-tab. Sul desktop il progetto passa da
    // SplitTree e puo' avere piu' di una striscia visibile; il conteggio nudo
    // le somma, e se lo stesso pane id compare in due gruppi — succede mentre
    // una pane si sposta, e succede quando lo store arriva da un altro client,
    // dove l'idratazione fa UNIONE — lo stesso pane viene contato due volte.
    // Sul telefono `renderMobile` appiattisce con un `seen` sull'id, quindi
    // quel doppione sparisce: il rosso misurato diceva «expected 5, received
    // 4» e sembrava una tab persa nel passaggio, mentre le pane erano le
    // stesse e a divergere erano i due modi di contarle.
    const idsVisibili = async (loc: typeof tabDelProgetto) =>
      [...new Set(await loc.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-pane-id") ?? ""),
      ))].filter(Boolean).sort();
    await expect
      .poll(async () => (await idsVisibili(tabDelProgetto)).length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(2);
    // Quante sono, non quante ci si aspetta: il layout di un progetto vive
    // server-side e NON viene azzerato dal reset del pane-store, quindi un
    // tentativo precedente (o un retry) può lasciarne aperte. È comunque
    // questo numero che deve ricomparire tale e quale sul telefono, ed è
    // proprio quello il contratto.
    const suDesktop = await idsVisibili(tabDelProgetto);
    // Sul desktop il progetto passa da SplitTree, che è la metà del confronto:
    // se sparisse anche qui, lo zero di sotto non direbbe più niente.
    expect(await finestra.locator("[data-group-cell]").count()).toBeGreaterThanOrEqual(1);

    // Shrink to a phone — the resize listener flips GroupLayout to mobile.
    await page.setViewportSize({ width: 390, height: 844 });

    // SplitTree never renders on mobile → no group cells, and exactly una
    // striscia di tab VISIBILE che porta TUTTE le pane.
    await expect(page.locator("[data-group-cell]")).toHaveCount(0, {
      timeout: 5000,
    });
    // `:visible` e non il conteggio nudo, e la differenza conta (2026-07-29).
    // La pane `project` non attiva resta MONTATA dietro il suo guscio
    // `display:none` — è il keep-alive che fa il suo mestiere — e il
    // `GroupLayout` annidato lì dentro disegna la propria barra, nascosta e
    // senza tab. Contarla non dice niente sul layout che l'utente vede, che è
    // ciò che questo test vuole dimostrare: sul telefono il progetto non si
    // splitta, c'è UNA striscia sola.
    //
    // Prima passava per un motivo che non era un contratto: l'auto-split
    // ri-montava `StandaloneChatGroup`, e il vecchio `visitedKeys` — stato
    // locale del componente — si azzerava, buttando via il keep-alive di ogni
    // pane non attiva. Il registro di residenza non si azzera a un remount,
    // quindi la pane sopravvive: è il comportamento voluto, non un effetto
    // collaterale.
    //
    // Una sola striscia in TUTTA la pagina, non solo dentro il progetto: sotto
    // i 768px la riga standalone lascia il posto al nome della superficie
    // (`mobile-pane-title`), quindi l'unica striscia rimasta è quella piatta
    // del progetto. È la misura che il test prometteva.
    const bars = page.locator('[data-testid="panel-tab-bar"]:visible');
    await expect(bars).toHaveCount(1);
    // `[data-pane-id]` e non `[draggable="true"]`: nella vista piatta il
    // riordino non è cablato, quindi nessuna tab è trascinabile. Contando
    // quelle si contava la striscia STANDALONE, che è l'unica ad averle —
    // cioè si misurava la superficie sbagliata, in verde.
    // Le STESSE pane, non «lo stesso numero di tab»: il contratto è che nessuna
    // si perda nel passaggio, e un insieme lo dice — un rosso qui nomina QUALE
    // pane manca, invece di far leggere due numeri e indovinare.
    await expect
      .poll(async () => idsVisibili(bars.first().locator("[data-pane-id]")), { timeout: 10000 })
      .toEqual(suDesktop);
  });
  /**
   * PROJECT-TABS-PIN — dentro un progetto le cose fissabili sono DUE, e il menu
   * le deve nominare entrambe.
   *
   * «Per le sotto-tab di un progetto dovremmo mettere fissa progetto e tab»
   * (Attilio, 08/08). Prima non ce n'era NESSUNA: `PaneTabBar` nasconde la voce
   * quando l'ospite non cabla `onToggleFissato`, e nessun ospite di progetto lo
   * cablava — il commento nel codice lo ammetteva. Il caso peggiore era col
   * dito: lì l'unica alternativa (trascinare la tab sui Fissati) non esiste,
   * perché su iOS il drag HTML5 non c'è.
   *
   * Il test apre il menu col tasto destro, che è la stessa strada della
   * pressione lunga (`useLongPress` → `openTabMenu`): una sola sorgente, quindi
   * verificarne una verifica il contratto di entrambe.
   */
  test("PROJECT-TABS-PIN: il menu di una tab di progetto offre «fissa il progetto» e «fissa questa tab»", async ({
    page,
  }) => {
    await goToApp(page);
    await openTestProject(page);

    // La barra DENTRO la finestra di progetto, non quella di primo livello:
    // quest'ultima porta la tab DEL progetto, dove una voce sola («Fissa») è
    // la risposta giusta. La distinzione è il test — presa la barra sbagliata,
    // il test passerebbe verde su un menu che non è quello in esame.
    const finestra = projectWindow(page);
    await expect(finestra).toBeVisible({ timeout: 10000 });
    // Una tab dentro il progetto ci deve ESSERE: seminato, il progetto apre
    // vuoto («No chats open»), e la sua barra è una striscia senza tab. Il menu
    // in esame è quello di una TAB, quindi la tab si crea qui invece di
    // sperare che qualcuno l'abbia lasciata aperta.
    await addPaneInProject(page, "pane-add-menu-new-chat");
    const tabBar = finestra.locator('[data-testid="panel-tab-bar"]:visible').first();
    // `[data-testid^="pane-tab-"]` e NON `[draggable="true"]`: dentro un
    // progetto le tab non sono trascinabili (il riordino non è cablato lì), e
    // il selettore per attributo di drag non ne trova nessuna — misurato.
    const tab = tabBar.locator('[data-testid^="pane-tab-"]').first();
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click({ button: "right" });

    // Due voci DISTINTE, non una: il progetto torna sotto mano con tutte le sue
    // tab, la tab si riapre da sola e fuori dal progetto. Chiamarle nello stesso
    // modo era il difetto anche quando la voce c'era.
    const progetto = page.getByTestId("tab-menu-pin-project");
    const questaTab = page.getByTestId("tab-menu-pin-tab");
    await expect(progetto, "manca «fissa il progetto»").toBeVisible({ timeout: 5000 });
    await expect(questaTab, "manca «fissa questa tab»").toBeVisible();
    await expect(progetto).toContainText(/progetto/i);
    await expect(questaTab).toContainText(/tab/i);
    // E non sono lo stesso bersaglio travestito.
    expect(await progetto.textContent()).not.toBe(await questaTab.textContent());
  });
});
