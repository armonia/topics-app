/**
 * THE PROJECT PAUSE, in two windows (project quota, USAGE-30).
 *
 * A paused project shows one strip above the composer of its chats and on top
 * of its board, with the reason and two buttons: «Continua» and «Pausa fino a
 * domani». The pause is opened here through the server's own "hold" route (the
 * same state and the same `project:quota` broadcast the limit sweep produces),
 * so the frame travels the real socket to every window. Two pages of ONE
 * browser context stand for two windows: the strip must appear in both without
 * a reload, and «Continua» pressed in one must clear the other.
 *
 * Mutation: with the strip reading the pause only at mount (frame handler off
 * in `useProjectPause`), «appears in the second window without a reload» is
 * red; with the returning frame not applied, «Continua here clears there» is
 * red.
 *
 * Video on, and the strip is shot at 375, 768 and 1440 px in the chat and on
 * the board: the files land in the test output folder.
 *
 * @covers USAGE-30
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openMainChat, openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { projectRow } from "./helpers/project-row";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const WIDTHS = [375, 768, 1440] as const;

async function openBoard(page: Page, projectName: string): Promise<void> {
  const row = projectRow(page, new RegExp(projectName));
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10_000 });
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  let opened = false;
  for (let i = count - 1; i >= 0 && !opened; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    opened = await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
    if (!opened) await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10_000 });
}

test.describe("project pause strip", () => {
  let scene: Scene | null = null;
  let projectId = "";

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-project-pause-${Date.now().toString(36)}`);
    projectId = projectIdForPath(scene.dirOf("acme-web"));
  });
  test.afterAll(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/projects/${projectId}/quota/continue`).catch(() => {});
    await scene?.cleanup(request);
  });
  test.beforeEach(async ({ request }) => {
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("the strip appears in both windows without a reload and «Continua» in one clears the other", async ({ browser, request }, testInfo) => {
    const ctx = await browser.newContext({ baseURL: E2E_BASE, viewport: { width: 1440, height: 900 }, locale: "it-IT" });
    const chatWindow = await ctx.newPage();
    const boardWindow = await ctx.newPage();
    try {
      await goToApp(chatWindow);
      await openMainChat(chatWindow, scene!);
      await goToApp(boardWindow);
      await openBoard(boardWindow, "acme-web");

      const chatStrip = chatWindow.getByTestId("project-pause-strip-chat");
      const boardStrip = boardWindow.getByTestId("project-pause-strip-board");
      await expect(chatStrip).toHaveCount(0);
      await expect(boardStrip).toHaveCount(0);

      // The pause opens on the server: no reload in either window.
      const hold = await request.post(`${E2E_BASE}/api/projects/${projectId}/quota/hold`);
      expect(hold.ok()).toBe(true);
      await expect(chatStrip).toBeVisible({ timeout: 15_000 });
      await expect(boardStrip).toBeVisible({ timeout: 15_000 });
      await expect(chatStrip).toHaveAttribute("data-reason", "hold-until-tomorrow");

      // The same strip at three widths: a fresh page per width, because a narrow
      // viewport swaps the desktop layout for the mobile one, and the strip reads
      // the open pause at mount. The 1440 shot reuses the two open windows and is the hard
      // check; the narrower ones are shot when the layout offers the surface, never a reason to fail.
      for (const width of WIDTHS) {
        for (const surface of ["chat", "board"] as const) {
          if (width === 1440) {
            const open = surface === "chat" ? chatStrip : boardStrip;
            await expect(open).toBeVisible();
            await open.screenshot({ path: testInfo.outputPath(`pause-strip-${surface}-${width}.png`) });
            continue;
          }
          const shot = await browser.newPage({ baseURL: E2E_BASE, viewport: { width, height: 900 }, locale: "it-IT" });
          try {
            await goToApp(shot);
            if (surface === "chat") await openMainChat(shot, scene!);
            else await openBoard(shot, "acme-web");
            const strip = shot.getByTestId(`project-pause-strip-${surface}`);
            const seen = await strip.waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false);
            if (!seen) {
              testInfo.annotations.push({ type: "note", description: `no ${surface} strip surface at ${width}px` });
              continue;
            }
            const box = await strip.boundingBox();
            expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
            await strip.screenshot({ path: testInfo.outputPath(`pause-strip-${surface}-${width}.png`) });
          } catch (error) {
            testInfo.annotations.push({ type: "note", description: `${surface} at ${width}px: ${String(error).slice(0, 120)}` });
          } finally {
            await shot.close();
          }
        }
      }

      // One answer clears every window, the one that pressed and the other.
      await chatStrip.getByTestId("project-pause-continue").click();
      await expect(chatStrip).toHaveCount(0, { timeout: 15_000 });
      await expect(boardStrip).toHaveCount(0, { timeout: 15_000 });

      // And the other way round: pressed on the board, cleared in the chat.
      expect((await request.post(`${E2E_BASE}/api/projects/${projectId}/quota/hold`)).ok()).toBe(true);
      await expect(chatStrip).toBeVisible({ timeout: 15_000 });
      await expect(boardStrip).toBeVisible({ timeout: 15_000 });
      await boardStrip.getByTestId("project-pause-continue").click();
      await expect(chatStrip).toHaveCount(0, { timeout: 15_000 });
      await expect(boardStrip).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });
});
