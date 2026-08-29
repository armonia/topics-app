/**
 * board-preview-edge.spec.ts — the task preview has an edge, and the edge is PAINTED.
 *
 * @covers KANBAN-67
 *
 * WHY PIXELS AND NOT `getComputedStyle`. What is under test is an inset
 * box-shadow on a `::before`, and the failure this gate exists to prevent is a
 * rule that ships and paints NOTHING: an inset shadow placed on the `<img>`
 * itself is invisible, because a replaced element's bitmap paints over it - yet
 * `getComputedStyle` would report the declaration word for word. So the
 * measurement is the screenshot.
 *
 * THE ASSERTION THAT CANNOT PASS ON A NO-OP: the top hairline must read LIGHTER
 * than the side hairlines. Without the lit edge the media's border is one flat
 * token on all four sides, so top and side are THE SAME NUMBER. Light falls
 * from above only if something painted it.
 *
 * The image is a solid WHITE svg on purpose: white on a white card is the worst
 * case for "is this preview still bounded", and it needs no encoder.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type Locator } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-preview-edge-${Date.now()}`;
const MEDIA_DIR = join(E2E_DATA_DIR, ".openclaw", "media", "preview-edge");
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const WHITE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="640" viewBox="0 0 1200 640">' +
  '<rect x="0" y="0" width="1200" height="640" fill="#ffffff"/></svg>';

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

/** px of card sampled around the media box. */
const PAD = 6;

type Sample = { top: number; left: number; interior: number; above3: number; above6: number };

async function edgeSample(page: Page, media: Locator): Promise<Sample> {
  const b = (await media.boundingBox())!;
  const clip = {
    x: Math.round(b.x) - PAD,
    y: Math.round(b.y) - PAD,
    width: Math.round(b.width) + PAD * 2,
    height: Math.round(b.height) + PAD * 2,
  };
  const shot = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(
    async ({ shot, clip, PAD }) => {
      const im = new Image();
      im.src = "data:image/png;base64," + shot;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      const g = c.getContext("2d")!;
      g.drawImage(im, 0, 0);
      // The screenshot is in DEVICE pixels, the clip in CSS pixels. Derive the
      // scale instead of assuming 1, so this keeps meaning something the day a
      // project runs at deviceScaleFactor 2.
      const s = im.width / clip.width;
      const at = (x: number, y: number) =>
        g.getImageData(Math.round((x + 0.5) * s), Math.round((y + 0.5) * s), 1, 1).data[0];
      const cx = Math.round(clip.width / 2);
      const cy = Math.round(clip.height / 2);
      const interior = at(cx, PAD + 4);
      // THE BOUNDARY IS NOT AT A KNOWN PIXEL, and it is not simply "the darkest
      // one nearby" either. Two instrument bugs measured on this very gate:
      // sampling the geometric edge lands one pixel INSIDE the bitmap (side 253
      // against an interior of 255 - the instrument reading the image and
      // calling it the border); widening to a window then picks the CARD FILL
      // behind it (27), which is darker than the border but is not the border.
      //
      // So: walk OUTWARD from the interior and stop at the FIRST pixel that
      // differs from it. That pixel is the hairline, whatever subpixel row it
      // actually landed on, and the walk stops before reaching the card.
      const boundary = (pick: (k: number) => number) => {
        for (let k = 3; k >= -1; k--) {
          const v = pick(k);
          if (Math.abs(v - interior) > 4) return v;
        }
        return interior;
      };
      return {
        top: boundary((k) => at(cx, PAD + k)),
        left: boundary((k) => at(PAD + k, cy)),
        interior,
        above3: at(cx, PAD - 3),
        above6: at(cx, PAD - 6),
      };
    },
    { shot, clip, PAD },
  );
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") {
    await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-preview-edge/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      await item.click();
      await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("no + menu with a Board (kanban) entry found");
}

test.describe("l'anteprima del task ha uno spigolo", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-preview-edge" }, null, 2));
    mkdirSync(MEDIA_DIR, { recursive: true });
    const topic = await createTopic(request, "E2E-PreviewEdge", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const file = join(MEDIA_DIR, "bianca.svg");
    writeFileSync(file, WHITE_SVG);
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "anteprima tutta bianca", status: "todo" },
    });
    expect(res.ok()).toBe(true);
    const task = (await res.json()) as { id: string };
    createdTasks.push(task.id);
    const patch = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { previewImage: file, status: "todo" },
    });
    expect(patch.ok(), "PATCH previewImage").toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) {
      await request.delete(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`).catch(() => {});
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
    rmSync(MEDIA_DIR, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`KANBAN-67 (${scheme}): l'anteprima ha un confine e uno spigolo illuminato`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "KANBAN-67" });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await openProjectBoard(page);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(scheme === "dark");

      const media = page.getByTestId("preview-card").first().locator("img");
      await expect(media).toBeVisible({ timeout: 15000 });
      // The rectangle has to have STOPPED: the decode moves it once.
      let last = "";
      await expect
        .poll(async () => {
          const b = JSON.stringify(await media.boundingBox());
          const same = b === last;
          last = b;
          return same;
        }, { timeout: 15000 })
        .toBe(true);

      const p = await edgeSample(page, media);
      console.log(
        `[preview-edge] ${scheme}: top ${p.top} · lati ${p.left} · interno ${p.interior} · card ${p.above3}/${p.above6}`,
      );

      // G1 — the preview stays BOUNDED even when its content is the same colour
      // as the card behind it. This is the half that must survive any restyle.
      expect(
        Math.abs(p.left - p.interior),
        `il confine dell'anteprima deve staccarsi dal suo interno (lato ${p.left}, interno ${p.interior})`,
      ).toBeGreaterThanOrEqual(15);

      // G2 — the edge is PAINTED, not merely declared. Without the lit edge the
      // border is one flat token and these two are the same number.
      expect(
        p.top - p.left,
        `il filo superiore deve leggere piu' chiaro dei lati (top ${p.top}, lati ${p.left})`,
      ).toBeGreaterThanOrEqual(6);

      // G3 — and the card underneath is NOT lifted: no shadow spilling onto it.
      // The preview is not the thing that floats; the card is.
      expect(
        Math.abs(p.above3 - p.above6),
        `la card sopra l'anteprima deve restare piatta (${p.above3} a 3px, ${p.above6} a 6px)`,
      ).toBeLessThanOrEqual(2);

      // G4 — wrapper and media must curve together, or the lit ring cuts the
      // corners of the image it is supposed to close.
      const radii = await page.getByTestId("preview-card").first().evaluate((w) => {
        const media = w.querySelector("img")!;
        return { wrap: getComputedStyle(w).borderRadius, media: getComputedStyle(media).borderRadius };
      });
      expect(radii.wrap, `coupled radii: ${JSON.stringify(radii)}`).toBe(radii.media);
    });
  }
});
