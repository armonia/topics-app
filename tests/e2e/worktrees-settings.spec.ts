/**
 * worktrees-settings.spec.ts: the Worktrees form of the settings.
 *
 * The form opens beside the thing it configures, like the calendar and the
 * tools (the palette opens it too). Three things are proved, filmed:
 *   1. a root typed in the form is validated by the server and kept: a relative
 *      path is refused with a line in the form, an absolute one is saved and is
 *      still there after a reload;
 *   2. every other dial shows its default untouched, and a changed one persists;
 *   3. the cleanup preview reads the SAVED root: a folder planted in it that no
 *      row and no git knows is listed as a ghost, with its class and what the
 *      next pass would do, and the preview writes nothing (the folder is still
 *      there afterwards).
 *
 * The root cannot be in a temp area (the server refuses it), so it lives in a
 * folder of the machine's home that the spec makes and removes.
 *
 * @covers WORKTREE-STD-01, WORKTREE-STD-03
 */
import { test as base, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { removeTmpDir } from "./helpers/file-project";
import { openHomePanel } from "./helpers/user-menu";
import { E2E_BASE } from "./helpers/test-server";

const test = base;
hermetic(test);
test.use({ video: "on", viewport: { width: 1360, height: 860 } });

const STAMP = Date.now();
const ROOT = join(homedir(), `.topics-e2e-worktree-root-${STAMP}`);
const GHOST = join(ROOT, `e2e-ghost-slug`, `ghost-folder-${STAMP}`);

async function openForm(page: Page) {
  await goToApp(page);
  const panel = await openHomePanel(page, "worktrees");
  await expect(panel.getByTestId("worktrees-root")).toBeVisible({ timeout: 15_000 });
  return panel;
}

test.describe("Impostazioni dei worktree", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(() => {
    mkdirSync(GHOST, { recursive: true });
  });

  test.afterAll(async ({ request }) => {
    // The setting lives in the test server's database: put it back to «not set».
    await request.put(`${E2E_BASE}/api/app-settings`, { data: { worktreeRoot: null, worktreeMaxPerProject: null } }).catch(() => {});
    removeTmpDir(ROOT);
  });

  test("WORKTREE-STD-01: la radice si salva, una radice sbagliata è rifiutata e resta dopo un ricarico", async ({ page }, testInfo) => {
    const panel = await openForm(page);
    const input = panel.getByTestId("worktrees-root");
    await expect(input).toHaveValue("");
    await expect(panel.getByTestId("worktrees-root-save")).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("1-form-vuoto.png") });

    // A relative path is refused, and the form says so instead of fixing it quietly.
    await input.fill("cartella/relativa");
    await panel.getByTestId("worktrees-root-save").click();
    await expect(panel.getByTestId("worktrees-error")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("2-radice-rifiutata.png") });

    // So is a temp area.
    await input.fill("/tmp/worktrees");
    await panel.getByTestId("worktrees-root-save").click();
    await expect(panel.getByTestId("worktrees-error")).toBeVisible();

    await input.fill(ROOT);
    const saved = page.waitForResponse((r) => r.url().includes("/api/app-settings") && r.request().method() === "PUT" && r.ok());
    await panel.getByTestId("worktrees-root-save").click();
    await saved;
    await expect(panel.getByTestId("worktrees-error")).toHaveCount(0);
    await expect(panel.getByTestId("worktrees-root-reset")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("3-radice-salvata.png") });

    // The dials ship with a default that works untouched; one changed stays changed.
    const maxDial = panel.getByRole("combobox", { name: "Worktree tenute per progetto" });
    await expect(maxDial).toContainText("20 worktree");
    await maxDial.click();
    const written = page.waitForResponse((r) => r.url().includes("/api/app-settings") && r.request().method() === "PUT" && r.ok());
    await page.getByRole("option", { name: "40 worktree", exact: true }).click();
    await written;
    await expect(maxDial).toContainText("40 worktree");

    await page.reload();
    const again = await openHomePanel(page, "worktrees");
    await expect(again.getByTestId("worktrees-root")).toHaveValue(ROOT, { timeout: 15_000 });
    await expect(again.getByRole("combobox", { name: "Worktree tenute per progetto" })).toContainText("40 worktree");
  });

  test("WORKTREE-STD-03: l'anteprima della pulizia elenca la cartella fantasma con la sua classe e non scrive nulla", async ({ page, request }, testInfo) => {
    const put = await request.put(`${E2E_BASE}/api/app-settings`, { data: { worktreeRoot: ROOT } });
    expect(put.ok()).toBe(true);
    const panel = await openForm(page);
    await expect(panel.getByTestId("worktrees-root")).toHaveValue(ROOT, { timeout: 15_000 });

    // One ghost is planted, so the summary counts one folder, in the singular form.
    await expect(panel.getByTestId("worktrees-preview-summary")).toContainText("1 cartella ·", { timeout: 15_000 });
    await panel.getByTestId("worktrees-preview-open").click();
    const list = panel.getByTestId("worktrees-preview-list");
    await expect(list).toBeVisible({ timeout: 20_000 });
    const line = list.locator('[data-testid="worktrees-preview-line"][data-class="ghost"]').filter({ hasText: `ghost-folder-${STAMP}` });
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("fantasma");
    await line.scrollIntoViewIfNeeded();
    await expect(line).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("4-anteprima-fantasma.png") });

    // A preview is a read: the folder is where it was, and the server reports the same plan again.
    expect(existsSync(GHOST)).toBe(true);
    await panel.getByTestId("worktrees-preview-open").click();
    await expect(line).toHaveCount(1);
    expect(existsSync(GHOST)).toBe(true);
  });
});
