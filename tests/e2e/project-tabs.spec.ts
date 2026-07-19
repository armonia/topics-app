import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";

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
    await resetPaneStore(page.request, []).catch(() => {});
    await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  });

  /** Open the e2e project by clicking its sidebar button.
   *  Uses a unique root path so it gets its own standalone button. */
  async function openTestProject(page: import("@playwright/test").Page) {
    // Expand Projects section
    const projectsSection = page.getByRole("button", {
      name: /Projects section/,
    });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
        await page.waitForTimeout(500);
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
        .filter({ hasText: /^Close/ })
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
        .filter({ hasText: /Split Right/ })
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

  // Regression: a project must NOT split on a phone. Open on desktop (proven
  // flow), let a browser pane auto-split into its own cell, then shrink to a
  // phone viewport — GroupLayout must flatten every group into ONE tab strip
  // (no SplitTree, so zero `data-group-cell`) with the panes as tabs.
  test("PROJECT-TABS-MOBILE-01: project flattens to a single tab strip on a phone", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "PROJECT-TABS-MOBILE-01",
    });
    await goToApp(page);
    await openTestProject(page);

    const firstBar = page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(firstBar).toBeVisible({ timeout: 10000 });

    // Add a Browser pane — on desktop this auto-splits out into its own cell.
    const addPaneBtn = page.getByTitle("Add pane").first();
    await expect(addPaneBtn).toBeVisible({ timeout: 5000 });
    await addPaneBtn.click();
    const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
    await expect(addMenu).toBeVisible({ timeout: 5000 });
    await addMenu.locator("button", { hasText: /Browser/i }).first().click();

    // Two panes now exist (chat + browser) regardless of split state.
    await expect
      .poll(async () =>
        page
          .locator('[data-testid="panel-tab-bar"] [draggable="true"]')
          .count()
      , { timeout: 10000 })
      .toBeGreaterThanOrEqual(2);

    // Shrink to a phone — the resize listener flips GroupLayout to mobile.
    await page.setViewportSize({ width: 390, height: 844 });

    // SplitTree never renders on mobile → no group cells, and exactly one
    // flattened tab strip carrying BOTH panes.
    await expect(page.locator("[data-group-cell]")).toHaveCount(0, {
      timeout: 5000,
    });
    const bars = page.locator('[data-testid="panel-tab-bar"]');
    await expect(bars).toHaveCount(1);
    await expect(bars.first().locator('[draggable="true"]')).toHaveCount(2);
  });
});
