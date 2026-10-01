/**
 * E2E: THE MOTION CONTRACT OF FLOATING SURFACES, FOR THE SURFACES OF A PROJECT,
 * THE BOARD AND THE PHONE.
 *
 * The sibling of `motion-floating-surfaces.spec.ts`, same recorder
 * (`helpers/motion-surface.ts`): each surface below is inserted with the shared
 * entrance and leaves through the shared exit copy. Every one of them was red
 * on the tree before the 2026-10-01 inventory: the file tree's context menu had
 * no entrance at all, the others vanished in one frame, the phone sheet rose on
 * a hard-coded 300ms and its scrim landed at full opacity.
 *
 * @covers MOTION-04
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { FileExplorerPage } from "./fixtures/file-explorer.fixture";
import { canonicalTmpRoot, cleanupFileProject, removeTmpDir, seedFileProject, type FileProject } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { E2E_BASE, E2E_PORT, testServerEnv } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  COMPOSITOR_PROPS,
  MODAL_MAX_MS,
  POPOVER_MAX_MS,
  SCRIM,
  SHEET_MAX_MS,
  expectEntrance,
  expectExit,
  installRecorder,
  watch,
} from "./helpers/motion-surface";

hermetic(test);

test.describe("The surfaces of a project enter and leave on the same mechanism", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });
  test.describe.configure({ timeout: 90_000 });

  let project: FileProject | undefined;
  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "motion");
  });
  test.beforeEach(async ({ request }) => {
    if (project) await resetPaneStore(request, [project.topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  async function ready(page: Page, explorer: FileExplorerPage) {
    await installRecorder(page);
    await explorer.gotoProject(project!.tmpDir, project!.topicName);
    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
  }

  async function openFileMenu(explorer: FileExplorerPage, page: Page) {
    const row = explorer.fileTree.getByRole("treeitem", { name: /package\.json/ });
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
  }

  test("MOTION-04t: the composer's @ mention menu", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    // A new chat of the project: the composer whose mentions list the project's files.
    await page.getByRole("button", { name: "New Chat" }).first().click();
    const composer = page.locator('[data-testid="project-window"] [data-testid="composer-card"] textarea').first();
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.click();
    const menu = "[data-mention-menu]";
    await watch(page, menu);
    await page.keyboard.type("@");
    await expect(page.locator(menu)).toBeVisible();
    await expectEntrance(page, "mention menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.locator(menu)).toHaveCount(0);
    await expectExit(page, "mention menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04w: the file tree's context menu", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await watch(page, '[role="menu"]');
    await openFileMenu(explorer, page);
    await expectEntrance(page, "file menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expectExit(page, "file menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04x: a confirmation dialog", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await openFileMenu(explorer, page);
    const dialog = '[role="dialog"][aria-label="Sposta nel cestino"]';
    await watch(page, `:has(> ${dialog})`);
    await page.getByRole("menu").getByRole("menuitem", { name: /Delete|Sposta nel cestino|Elimina/ }).first().click();
    await expect(page.locator(dialog)).toBeVisible();
    await expectEntrance(page, "confirm veil", MODAL_MAX_MS, ["opacity"]);
    await page.locator(dialog).getByRole("button", { name: "Annulla" }).click();
    await expect(page.locator(dialog)).toHaveCount(0);
    await expectExit(page, "confirm", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04y: file search, its veil and its exit", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await watch(page, '[data-testid="file-search"]');
    await explorer.openFileSearch();
    await expect(explorer.fileSearch).toBeVisible();
    await expectEntrance(page, "file search veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(explorer.fileSearch).toHaveCount(0);
    await expectExit(page, "file search", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04z: the git branch and history popovers", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    const git = explorer.gitChanges.first();
    await expect(git).toBeVisible({ timeout: 15_000 });
    // The section is born closed; its label (not the branch in the middle of
    // the row) opens it, and the history and branch buttons live inside.
    const head = git.getByTestId("project-sidebar-git");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.getByText("Git", { exact: true }).click();
    await expect(git.getByTestId("git-history-button")).toBeVisible({ timeout: 10_000 });

    await watch(page, '[data-testid="git-history-popover"]');
    await git.getByTestId("git-history-button").click();
    await expect(page.getByTestId("git-history-popover")).toBeVisible();
    await expectEntrance(page, "history popover", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("git-history-popover")).toHaveCount(0);
    await expectExit(page, "history popover", "popover", POPOVER_MAX_MS);

    await watch(page, '[data-testid="git-branch-popover"]');
    await git.getByTestId("git-branch-button").click();
    await expect(page.getByTestId("git-branch-popover")).toBeVisible();
    await expectEntrance(page, "branch popover", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("git-branch-popover")).toHaveCount(0);
    await expectExit(page, "branch popover", "popover", POPOVER_MAX_MS);
  });

  test("the project's share dialog", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    const row = projectRow(page, new RegExp(project!.tmpDir.split("/").pop()!));
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click({ button: "right" });
    await watch(page, '[data-testid="project-share-panel"]');
    await page.getByTestId("project-share").click();
    await expect(page.getByTestId("project-share-panel")).toBeVisible();
    await expectEntrance(page, "share veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-share-panel")).toHaveCount(0);
    await expectExit(page, "share", "modal", MODAL_MAX_MS);
  });

  test("a toast closed by hand fades like a timed one", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await openFileMenu(explorer, page);
    await page.getByRole("menu").getByRole("menuitem", { name: "Copy Path" }).click();
    const toast = page.getByTestId("toast").first();
    await expect(toast).toBeVisible();
    // The toast's own exit (a token transition on `opacity`), read on the
    // frame after the click: the close button used to drop it in one frame.
    await expect(toast.getByRole("button", { name: "Chiudi la notifica" })).toBeVisible();
    // Settled first: closed while its own entrance is still at opacity 0 there
    // is no fade to see, on either tree.
    await expect.poll(() => toast.evaluate((el) => getComputedStyle(el).opacity), { message: "the toast has settled in" }).toBe("1");
    const after = await toast.evaluate(async (el) => {
      const button = el.querySelector('button[aria-label="Chiudi la notifica"]') as HTMLButtonElement;
      button.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cs = getComputedStyle(el);
      return {
        connected: el.isConnected,
        transitions: el.getAnimations().map((a) => ({
          prop: (a as CSSTransition).transitionProperty ?? "",
          duration: Number(a.effect?.getComputedTiming().duration ?? 0),
        })),
        opacityTarget: cs.opacity,
      };
    });
    expect(after.connected, "the closed toast is still on screen for its fade").toBe(true);
    const fade = after.transitions.find((t) => t.prop === "opacity");
    expect(fade, `an opacity fade runs on the closed toast (${JSON.stringify(after.transitions)})`).toBeTruthy();
    expect(fade!.duration, "the fade is `--motion-fast`").toBeLessThanOrEqual(MODAL_MAX_MS);
    await expect(page.getByTestId("toast")).toHaveCount(0);
  });
});

test.describe("The board's lightbox and the task drawer's folds", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });
  test.describe.configure({ timeout: 120_000 });

  const projectPath = `${canonicalTmpRoot()}/e2e-motion-board-${Date.now()}`;
  const boardId = projectIdForPath(projectPath);
  // `/api/media` serves the server's own media root only (preview-slide.spec.ts).
  const mediaDir = `${testServerEnv(E2E_PORT).TOPICS_HOME}/media/e2e-motion-${Date.now()}`;
  const taskText = "motion card with a cover";
  const clipText = "motion card with a clip";
  let topicId: string | null = null;
  let taskId = "";
  let clipTaskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(mediaDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(`${projectPath}/package.json`, JSON.stringify({ name: "e2e-motion-board" }));
    writeFileSync(`${mediaDir}/cover.png`, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR4nGP8//8/AzJgYkAD5AsAAP//B5wBiOtZQOgAAAAASUVORK5CYII=",
      "base64",
    ));
    topicId = (await createTopic(request, "E2E-Motion-Board", { projectPath })).id;
    const res = await request.post(`${E2E_BASE}/api/boards/${boardId}/tasks`, {
      data: { text: taskText, status: "review", description: "A description to fold and unfold." },
    });
    expect(res.ok(), `task refused: ${res.status()}`).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
    const cover = await request.patch(`${E2E_BASE}/api/boards/${boardId}/tasks/${taskId}`, {
      data: { previewImage: `${mediaDir}/cover.png` },
    });
    expect(cover.ok(), `cover refused: ${cover.status()}`).toBe(true);
    // A clip WITH sound: the lightbox plays it unmuted, which is what makes a
    // copy of it that restarts audible.
    copyFileSync(resolvePath(__dirname, "fixtures/video/clip.webm"), `${mediaDir}/clip.webm`);
    const clipTask = await request.post(`${E2E_BASE}/api/boards/${boardId}/tasks`, {
      data: { text: clipText, status: "review" },
    });
    expect(clipTask.ok(), `clip task refused: ${clipTask.status()}`).toBe(true);
    clipTaskId = ((await clipTask.json()) as { id: string }).id;
    const clip = await request.patch(`${E2E_BASE}/api/boards/${boardId}/tasks/${clipTaskId}`, {
      data: { previewImage: `${mediaDir}/clip.webm` },
    });
    expect(clip.ok(), `clip refused: ${clip.status()}`).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await request.delete(`${E2E_BASE}/api/boards/${boardId}/tasks/${taskId}`).catch(() => undefined);
    if (clipTaskId) await request.delete(`${E2E_BASE}/api/boards/${boardId}/tasks/${clipTaskId}`).catch(() => undefined);
    if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
    removeTmpDir(projectPath);
    removeTmpDir(mediaDir);
  });

  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });

  async function openBoard(page: Page) {
    await installRecorder(page);
    await goToApp(page);
    const section = page.getByRole("button", { name: /sezione Progetti/ });
    if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") await section.click();
    const row = projectRow(page, /e2e-motion-board/);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const win = page.locator('[data-testid="project-window"][data-project-path*="e2e-motion-board"]');
    await expect(win).toBeVisible({ timeout: 20_000 });
    const triggers = win.getByTestId("pane-add-menu-trigger");
    const kanban = page.getByTestId("pane-add-menu-kanban");
    for (let i = (await triggers.count()) - 1; i >= 0; i--) {
      const t = triggers.nth(i);
      if (!(await t.isVisible().catch(() => false))) continue;
      if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
      if (await kanban.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
        await kanban.click();
        break;
      }
      await page.keyboard.press("Escape");
    }
    await expect(page.locator(`[data-task-card="${taskId}"]`)).toBeVisible({ timeout: 20_000 });
  }

  test("a card's preview lightbox", async ({ page }) => {
    await openBoard(page);
    const image = page.locator(`[data-task-card="${taskId}"] [data-testid="preview-card"] img`).first();
    await expect(image).toBeVisible({ timeout: 20_000 });
    await watch(page, '[data-testid="preview-lightbox"]');
    await image.click();
    await expect(page.getByTestId("preview-lightbox")).toBeVisible();
    await expectEntrance(page, "preview lightbox", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-lightbox")).toHaveCount(0);
    await expectExit(page, "preview lightbox", "modal", MODAL_MAX_MS);
  });

  /* THE EXIT COPY OF A PLAYING VIDEO. The copy is `cloneNode`, and a cloned
   * `<video autoPlay>` is a NEW media element: it has no frame (readyState 0),
   * fetches the clip again and starts it from 0 with its sound until the copy
   * is removed. So the frame the reviewer was watching vanished in one frame
   * and the clip restarted aloud on close. The copy must keep that frame and
   * neither load nor play anything. */
  test("a card's preview lightbox with a video closes on the frame it showed, in silence", async ({ page }) => {
    await openBoard(page);
    const thumb = page.locator(`[data-task-card="${clipTaskId}"] [data-testid="preview-card"] video`).first();
    await expect(thumb).toBeVisible({ timeout: 20_000 });
    await thumb.click();
    const lightbox = page.getByTestId("preview-lightbox");
    await expect(lightbox).toBeVisible();
    // The clip is really playing, with a frame on screen and its sound on.
    await expect.poll(() => lightbox.locator("video").evaluate((v: HTMLVideoElement) =>
      v.readyState >= 2 && !v.paused && !v.muted && v.currentTime > 0.2), { timeout: 15_000 }).toBe(true);

    await page.evaluate(() => {
      type Copy = { media: number; frame: { w: number; h: number; opaque: boolean } | null };
      const w = window as unknown as { __exitMedia: { copies: Copy[]; events: string[] } };
      w.__exitMedia = { copies: [], events: [] };
      const inCopy = new WeakSet<EventTarget>();
      for (const type of ["loadstart", "play", "playing"]) {
        document.addEventListener(type, (e) => { if (e.target && inCopy.has(e.target)) w.__exitMedia.events.push(type); }, true);
      }
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement) || !n.matches('[data-exit-ghost]')) continue;
          const media = n.querySelectorAll("video, audio");
          media.forEach((m) => inCopy.add(m));
          const canvas = n.querySelector("canvas");
          let frame: Copy["frame"] = null;
          if (canvas && canvas.width > 0 && canvas.height > 0) {
            const px = canvas.getContext("2d")!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
            frame = { w: canvas.width, h: canvas.height, opaque: px[3] === 255 };
          }
          w.__exitMedia.copies.push({ media: media.length, frame });
        }
      }).observe(document.body, { childList: true });
    });
    let refetched = 0;
    page.on("request", (r) => { if (r.url().includes("clip.webm")) refetched++; });

    await page.keyboard.press("Escape");
    await expect(lightbox).toHaveCount(0);
    // Read once the copy is gone: a removed media element is paused, so nothing
    // in it can start after this point.
    await expect(page.locator("[data-exit-ghost]")).toHaveCount(0);
    const seen = await page.evaluate(() => (window as unknown as { __exitMedia: unknown }).__exitMedia) as {
      copies: { media: number; frame: { w: number; h: number; opaque: boolean } | null }[];
      events: string[];
    };
    expect(seen.copies.length, "the lightbox leaves through an exit copy").toBeGreaterThan(0);
    const copy = seen.copies[0]!;
    expect(copy.media, `the copy holds no media element that could load or play: ${JSON.stringify(seen)}, refetched ${refetched}`).toBe(0);
    expect(seen.events, "nothing in the copy loads or plays").toEqual([]);
    expect(refetched, "closing does not fetch the clip again").toBe(0);
    expect(copy.frame, "the copy shows the frame the clip was on, at its size").toEqual({ w: 96, h: 64, opaque: true });
  });

  test("a section of the task drawer opens with a fade", async ({ page }) => {
    await openBoard(page);
    await page.locator(`[data-task-card="${taskId}"]`).getByText(taskText).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    const toggle = drawer.getByTestId("task-details-toggle");
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    const header = drawer.getByTestId("task-section-desc");
    await expect(header).toBeVisible({ timeout: 10_000 });
    // The section remembers its last state: start from closed.
    if ((await header.getAttribute("data-open")) === "1") await header.click();
    await expect(header).toHaveAttribute("data-open", "0");
    // The body is the block right after the header once it is open.
    const body = '[data-testid="task-section-desc"] + div';
    await watch(page, body);
    await header.click();
    await expect(page.locator(body)).toBeVisible();
    await expectEntrance(page, "drawer section", MODAL_MAX_MS, ["opacity"]);
  });
});

test.describe("The phone's sheets rise and go back down", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" }, viewport: { width: 390, height: 844 } });
  test.describe.configure({ timeout: 90_000 });

  test("the Topics sheet and its scrim", async ({ page }) => {
    await installRecorder(page);
    await page.addInitScript(() => localStorage.setItem("topics-mobile-drawer-collapsed", "0"));
    await goToApp(page);
    const trigger = page.getByTestId("sidebar-topics-menu");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await watch(page, `[data-testid="sidebar-topics-menu-panel"], ${SCRIM}`);
    await trigger.click();
    await expect(page.getByTestId("sidebar-topics-menu-panel")).toBeVisible();
    await expectEntrance(page, "Topics sheet", SHEET_MAX_MS, ["transform"], "bottom-sheet");
    await expectEntrance(page, "sheet scrim", MODAL_MAX_MS, ["opacity"], "bg-black/40");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sidebar-topics-menu-panel")).toHaveCount(0);
    await expectExit(page, "Topics sheet", "sheet", MODAL_MAX_MS);
    await expectExit(page, "sheet scrim", "modal", MODAL_MAX_MS);
  });
});
