/**
 * NO CHANGES, NO SECTION.
 *
 * The sidebar used to show its git section on a clean repository too, with a
 * title reading zero files: a row spent saying nothing happened, plus its
 * button in the collapsed strip. What is measured here are the two states a
 * single screenshot cannot prove: a clean project has NO section, and the
 * first change on disk brings it back with its count.
 *
 * The fixture repository is a real one (`initGitRepo`), not a mock: it is the
 * only way "clean" here means what git means by it.
 *
 * @covers PROJECT-12
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { canonicalTmpDir, initGitRepo } from "./helpers/file-project";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

// Canonical spelling (`/private/tmp` on macOS): it is the one the window
// carries, see `canonicalTmpDir`.
const PROJECT_DIR = canonicalTmpDir("e2e-git-empty");

test.describe("sidebar progetto: la sezione git quando non c'e' niente", () => {
  test.beforeAll(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(`${PROJECT_DIR}/README.md`, "uno\n");
    // Everything committed, and no remote, so no ahead/behind either. This is
    // the state in which the section must not exist.
    initGitRepo(PROJECT_DIR, "primo");
  });
  test.afterAll(() => {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  test("pulito non ha sezione ne' bottone, e la prima modifica la riporta", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PROJECT-12" });
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJECT_DIR);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJECT_DIR}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // The Files section is always there: it is the anchor saying the sidebar
    // is mounted and done loading. Without it, the absence of the git section
    // would hold on a sidebar that simply is not there.
    await expect(win.getByTestId("project-sidebar-files")).toBeVisible({ timeout: 15000 });

    const section = win.getByTestId("project-sidebar-git-section");
    // 1. CLEAN: no section. The git status has ARRIVED by now (the file panel
    //    is visible and the window is alive) and the absence is held for a
    //    while, because an immediate absence would also be true of a render
    //    that has simply not reached that branch yet.
    await expect(section).toHaveCount(0);
    await expect.poll(async () => section.count(), {
      // The git status poll is 15s: were the section to appear for a zero, it
      // would appear inside this window.
      timeout: 18000,
      intervals: [1000],
      message: "the git section must not appear on a clean repository",
    }).toBe(0);

    // 2. AND NEITHER DOES THE COLLAPSED STRIP: a button opening a section
    //    that does not exist is a command that does nothing.
    await win.getByRole("button", { name: "Nascondi la barra" }).click();
    const strip = win.locator('[data-testid="project-rail-inline"]');
    await expect(strip).toBeVisible({ timeout: 5000 });
    await expect(strip.getByRole("button", { name: /Modifiche git/ })).toHaveCount(0);

    // 3. THE FIRST CHANGE BRINGS IT BACK. The condition is live: nobody
    //    reopens the project, only the disk changes.
    writeFileSync(`${PROJECT_DIR}/README.md`, "uno\ndue\n");
    await expect(strip.getByRole("button", { name: /Modifiche git/ })).toHaveCount(1, { timeout: 25000 });

    // Reopened, the section is there with its count: that part is unchanged.
    await win.getByRole("button", { name: "Espandi la barra" }).click();
    await expect(win.getByTestId("project-sidebar-git-section")).toBeVisible({ timeout: 15000 });
  });
});
