import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * @covers PROJECT-14
 *
 * A project's icon follows its folder LIVE, on every open window.
 *
 * Before: the store kept a verified "no icon" for twelve hours and a "has icon"
 * forever, and the server pushed nothing when the files changed. A project that
 * gained a favicon stayed iconless in the sidebar until the entry expired, an
 * icon that changed kept showing the old bytes (same URL, already decoded in the
 * page), and a removed icon stayed on screen.
 *
 * The tests below change the folder ONLY on disk, never reload the page,
 * and watch two pages of the same browser: the second page is a second window.
 */

const svg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="${fill}"/></svg>`;
const RED = "#ff0000";
const BLUE = "#0000ff";

/**
 * The colour the project row's icon actually DRAWS, read back from the decoded
 * image through a canvas (same origin, so the canvas stays readable): "" when
 * no icon element is drawn or it has not decoded yet. Colour and not size,
 * because WebKit reports an SVG's natural size as the box it is drawn in.
 */
async function drawnIconColor(page: Page, dirName: string): Promise<string> {
  const icon = page.getByTestId(`project-toggle-${dirName}`).locator('img[src*="/api/projects/icon"]');
  if ((await icon.count()) === 0) return "";
  return icon.first().evaluate((el: HTMLImageElement) => {
    if (!el.complete || el.naturalWidth === 0) return "";
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(el, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  });
}

const iconCount = (page: Page, dirName: string) =>
  page.getByTestId(`project-toggle-${dirName}`).locator('img[src*="/api/projects/icon"]').count();

/**
 * Open the app on `page`. The first window of a context asks the server about
 * the icon (an empty cache); the second one draws it from the cache the first
 * one wrote, so for it the row being visible is the whole wait.
 */
async function openWindow(page: Page, dir: string, dirName: string, firstOfContext: boolean): Promise<void> {
  const firstAnswer = firstOfContext
    ? page.waitForResponse((r) => r.url().includes("/api/projects/icon?") && decodeURIComponent(r.url()).includes(dir))
    : null;
  await goToApp(page);
  await expect(page.getByTestId(`project-toggle-${dirName}`)).toBeVisible();
  await firstAnswer;
}

test.describe("PROJECT-14: a project's icon follows its folder without a reload", () => {
  let dir = "";
  let dirName = "";
  let topicId = "";
  let second: Page | null = null;

  test.beforeEach(async ({ request }, info) => {
    dirName = `e2e-icon-live-${info.title.split(" ")[0].toLowerCase()}-${Date.now().toString(36)}`;
    dir = `${canonicalTmpRoot()}/${dirName}`;
    mkdirSync(dir, { recursive: true });
    // A topic bound to the folder puts it in the icon endpoint's allowlist
    // and draws its project row in the sidebar.
    topicId = (await createTopic(request, `E2E icon ${dirName}`, { projectPath: dir })).id;
  });

  test.afterEach(async ({ request }) => {
    await second?.close().catch(() => {});
    second = null;
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    removeTmpDir(dir);
  });

  async function twoWindows(page: Page, context: BrowserContext): Promise<Page[]> {
    await openWindow(page, dir, dirName, true);
    second = await context.newPage();
    await openWindow(second, dir, dirName, false);
    return [page, second];
  }

  test("added: a favicon that appears shows up on both windows", async ({ page, context }) => {
    const pages = await twoWindows(page, context);
    for (const p of pages) await expect.poll(() => iconCount(p, dirName)).toBe(0);

    writeFileSync(`${dir}/favicon.svg`, svg(RED));

    for (const p of pages) {
      await expect.poll(() => drawnIconColor(p, dirName), { timeout: 5000 }).toBe(RED);
    }
  });

  test("changed: the new bytes replace the old ones on both windows", async ({ page, context }) => {
    writeFileSync(`${dir}/favicon.svg`, svg(RED));
    const pages = await twoWindows(page, context);
    for (const p of pages) await expect.poll(() => drawnIconColor(p, dirName)).toBe(RED);

    writeFileSync(`${dir}/favicon.svg`, svg(BLUE));

    for (const p of pages) {
      await expect.poll(() => drawnIconColor(p, dirName), { timeout: 5000 }).toBe(BLUE);
    }
  });

  test("named: an icon a manifest names in its own folder shows up, and comes back after a regeneration", async ({ page, context }) => {
    // `public/icons/` is not one of the usual places: only the manifest says
    // the icon lives there.
    mkdirSync(`${dir}/public/icons`, { recursive: true });
    writeFileSync(`${dir}/public/manifest.json`, JSON.stringify({ icons: [{ src: "/icons/icon.svg", sizes: "192x192" }] }));
    const pages = await twoWindows(page, context);
    for (const p of pages) await expect.poll(() => iconCount(p, dirName)).toBe(0);

    writeFileSync(`${dir}/public/icons/icon.svg`, svg(RED));
    for (const p of pages) {
      await expect.poll(() => drawnIconColor(p, dirName), { timeout: 5000 }).toBe(RED);
    }

    // A script that regenerates the icons: the file goes away, then comes back.
    unlinkSync(`${dir}/public/icons/icon.svg`);
    for (const p of pages) {
      await expect.poll(() => iconCount(p, dirName), { timeout: 5000 }).toBe(0);
    }
    writeFileSync(`${dir}/public/icons/icon.svg`, svg(BLUE));
    for (const p of pages) {
      await expect.poll(() => drawnIconColor(p, dirName), { timeout: 5000 }).toBe(BLUE);
    }
  });

  test("removed: an icon taken out of the folder leaves both windows", async ({ page, context }) => {
    writeFileSync(`${dir}/favicon.svg`, svg(RED));
    const pages = await twoWindows(page, context);
    for (const p of pages) await expect.poll(() => drawnIconColor(p, dirName)).toBe(RED);

    unlinkSync(`${dir}/favicon.svg`);

    for (const p of pages) {
      await expect.poll(() => iconCount(p, dirName), { timeout: 5000 }).toBe(0);
    }
  });
});
