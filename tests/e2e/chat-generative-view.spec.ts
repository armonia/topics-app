import { test, expect } from "./fixtures/test-fixtures";
import type { Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { STAY_PHOTOS, staysCompare } from "./fixtures/sitges-compare";

hermetic(test);

/**
 * THE AGENT SENDS DATA, TOPICS DRAWS IT (GENUI-01..04).
 *
 * The comparison of topic:64095902 (three stays in Sitges) used to be a page
 * the agent hand-wrote and opened in the browser pane. Here the same content
 * goes through the real route `show_view` calls (`POST /api/sessions/:key/views`),
 * the turn is seeded the way the server stores it, and what is checked is
 * what a person sees: the block in the chat, and the same view as a page at
 * `/v/<id>`, on a desktop and on a phone, in both themes, measured on the DOM
 * and audited with axe-core.
 *
 * @covers GENUI-01, GENUI-02, GENUI-03, GENUI-04
 */

const AXE_PATH = resolve(__dirname, "../../node_modules/axe-core/axe.min.js");
// The agent's downloads, when this machine has them; generated stand-ins otherwise.
const REAL_PHOTOS = join(process.env.HOME ?? "", ".topics/media/sitges-alloggi/img");
// Under the test server's own media root (TOPICS_HOME/media): served by /api/media.
const STAGED = join(E2E_DATA_DIR, ".topics-home", "media", "genui-sitges");

function stagePhotos(): void {
  mkdirSync(STAGED, { recursive: true });
  const all = [...STAY_PHOTOS.bh, ...STAY_PHOTOS.naut, ...STAY_PHOTOS.cid];
  for (const [i, f] of all.entries()) {
    const src = join(REAL_PHOTOS, f);
    if (existsSync(src)) copyFileSync(src, join(STAGED, f));
    else writeFileSync(join(STAGED, f), standInSvg(i));
  }
}

/** A flat tile, so the layout has an image to lay out where the real photo is missing. */
function standInSvg(i: number): string {
  const hue = (i * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="hsl(${hue} 40% 55%)"/></svg>`;
}

interface Box { x: number; y: number; width: number; height: number; right: number; bottom: number }
const boxes = (page: Page, sel: string): Promise<Box[]> =>
  page.locator(sel).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }));

/**
 * Elements that stick out of the viewport sideways without a horizontal
 * scroller of their own between them and the page: what a person would have
 * to pan to see. A card cut by the edge of the snap strip is not one of them.
 */
const sidewaysOverflow = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const w = window.innerWidth;
    const clippedSideways = (el: Element): boolean => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        // Inside a scroller that is itself within the viewport: reachable by
        // scrolling it (a photo strip inside the cut card counts through the
        // card strip that holds it).
        if ((ox === "auto" || ox === "scroll" || ox === "hidden") && a.getBoundingClientRect().right <= w + 1) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll('[data-testid="view-page"] *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= w + 1 || clippedSideways(el)) continue;
      out.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.className.toString().slice(0, 40)}] right=${Math.round(r.right)}`);
    }
    return out.slice(0, 5);
  });

interface AxeViolation { id: string; impact: string | null; help: string; nodes: unknown[] }
async function axe(page: Page, sel: string): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (s) => {
    const w = window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } };
    const res = await w.axe.run({ include: [[s]] }, { resultTypes: ["violations"] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => (n as { target: unknown }).target) }));
  }, sel) as Promise<AxeViolation[]>;
}

test.describe("chat generative view", () => {
  let topicId = "";
  let topicName = "";
  let viewId = "";

  test.beforeAll(async ({ request }) => {
    stagePhotos();
    topicName = `genui-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const spec = staysCompare(STAGED);
    // The photos are reachable through the door the page uses, or the layout
    // checks below would measure broken images.
    const probe = await request.get(`${E2E_BASE}/api/media?path=${encodeURIComponent(spec.options[0].images[0].src)}`, { ignoreHTTPSErrors: true });
    expect(probe.status(), "staged photo served by /api/media").toBe(200);

    // The route `show_view` calls, with what the agent sends.
    const created = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(`topic:${topicId}`)}/views`, { data: spec, ignoreHTTPSErrors: true });
    expect(created.status()).toBe(201);
    viewId = ((await created.json()) as { id: string }).id;

    const bash = (id: string) => ({
      kind: "tool",
      toolCall: { id, name: "Bash", args: { command: `echo ${id}` }, status: "success", detail: { type: "shell", command: `echo ${id}`, output: "ok" } },
    });
    const row = (role: "user" | "assistant", content: string, blocks?: unknown[]) =>
      request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, { data: { role, content, ...(blocks ? { blocks } : {}) }, ignoreHTTPSErrors: true });
    await row("user", "quindi cosa è meglio fra Beach Haven, Nautilus ed El Cid?");
    await row("assistant", "Il Nautilus.", [
      bash("b1"), bash("b2"), bash("b3"),
      {
        kind: "tool",
        toolCall: {
          id: "toolu_view1",
          name: "mcp__topics__show_view",
          args: spec,
          status: "success",
          result: `shown in chat · compare · 3 options · page https://127.0.0.1:3333/v/${viewId}`,
        },
      },
      { kind: "text", text: "Il Nautilus: suite vostra, in centro, e sul balcone si fuma." },
    ]);
  });
  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("the comparison is a block in the chat that stays in sight, with the page one click away", async ({ page, chatPage }) => {
    // Four screenshots, five axe passes, a swapping machine: the work, not a hang.
    test.setTimeout(90_000);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // The finished turn folds its three commands; the view is not one of them.
    const fold = page.getByTestId("turn-work-fold").first();
    await expect(fold).toHaveAttribute("data-actions", "3", { timeout: 15_000 });
    const block = page.getByTestId("view-block");
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("data-view-id", viewId);
    await expect(block.getByTestId("compare-option-title")).toHaveText(["Beach Haven", "Nautilus", "Hotel El Cid"]);
    await expect(block.locator('[data-recommended="true"]').getByTestId("compare-option-title")).toHaveText("Nautilus");
    await expect(block.getByTestId("compare-verdict")).toContainText("Nautilus");
    await expect(block.getByTestId("compare-price").first()).toContainText("184");

    // Who wins a metric is marked, the worst too (walking minutes: lower wins).
    const center = block.getByTestId("compare-metric").filter({ hasText: "centro" });
    await expect(center.nth(0)).toHaveAttribute("data-rank", "worst");
    await expect(center.nth(1)).toHaveAttribute("data-rank", "best");

    // Every photo loaded (a broken image has naturalWidth 0).
    await expect.poll(() => block.locator("img[loading=eager]").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth > 0))).toEqual([true, true, true]);

    // Geometry, measured: the block stays inside the message column, cards do not overlap.
    const [blockBox] = await boxes(page, '[data-testid="view-block"]');
    const [bubble] = await boxes(page, '[data-testid="message-content-assistant"]');
    expect(blockBox.x).toBeGreaterThanOrEqual(bubble.x - 1);
    expect(blockBox.right).toBeLessThanOrEqual(bubble.right + 1);
    const cards = await boxes(page, '[data-testid="view-block"] [data-testid="compare-option"]');
    for (let i = 1; i < cards.length; i++) expect(cards[i].x).toBeGreaterThanOrEqual(cards[i - 1].right);

    // The gallery moves and says where it is.
    const gallery = block.getByTestId("compare-option").nth(1).getByTestId("compare-gallery");
    await expect(gallery.getByTestId("compare-gallery-count")).toHaveText("1 di 5");
    await gallery.getByRole("button", { name: "Foto successiva" }).click();
    await expect(gallery.getByTestId("compare-gallery-count")).toHaveText("2 di 5");
    // And lands on a photo, not between two.
    await expect.poll(() => gallery.getByRole("group").evaluate((el) => el.scrollLeft / el.clientWidth)).toBe(1);

    // The same view as a page, on the origin that serves this app.
    const open = block.getByTestId("view-open-page");
    await expect(open).toHaveAttribute("href", new RegExp(`/v/${viewId}$`));
    await block.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("genui-chat-desktop.png") });

    const violations = await axe(page, '[data-testid="view-block"]');
    expect(violations.map((v) => `${v.id}: ${v.help}`), "axe on the chat block").toEqual([]);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the standalone page draws the same view, desktop and phone, ${scheme}`, async ({ page }) => {
    test.setTimeout(90_000);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(`${E2E_BASE}/v/${viewId}`);
      const view = page.getByTestId("view-page");
      await expect(view.getByTestId("compare-option-title")).toHaveText(["Beach Haven", "Nautilus", "Hotel El Cid"], { timeout: 15_000 });
      await expect(page).toHaveTitle("Sitges, lun 19 - mer 21 ottobre");
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(scheme === "dark");

      // Desktop: one row, three equal columns, nothing overflowing the page.
      const desk = await boxes(page, '[data-testid="compare-option"]');
      expect(new Set(desk.map((b) => Math.round(b.y))).size, "cards on one row").toBe(1);
      expect(Math.max(...desk.map((b) => b.width)) - Math.min(...desk.map((b) => b.width))).toBeLessThanOrEqual(1);
      expect(await sidewaysOverflow(page), "nothing sticks out sideways").toEqual([]);
      // Metric rows line up across cards: same label, same height on screen.
      const centerTops = await boxes(page, '[data-testid="compare-metric"]:first-child');
      expect(new Set(centerTops.map((b) => Math.round(b.y))).size, "first metric aligned").toBe(1);
      await page.screenshot({ path: test.info().outputPath(`genui-page-desktop-${scheme}.png`)});
      const deskAxe = await axe(page, '[data-testid="view-page"]');
      expect(deskAxe.map((v) => `${v.id}: ${v.help}`), `axe on the page (${scheme}, desktop)`).toEqual([]);

      // Phone: a strip, one card and the edge of the next, the page never scrolls sideways.
      await page.setViewportSize({ width: 390, height: 844 });
      const phone = await boxes(page, '[data-testid="compare-option"]');
      expect(phone[0].x).toBeGreaterThanOrEqual(0);
      expect(phone[0].right).toBeLessThanOrEqual(390);
      expect(phone[1].x, "the next card shows its edge").toBeLessThan(390);
      expect(phone[1].right, "and is cut by the edge").toBeGreaterThan(390);
      // The page body and its scroller never pan sideways. (`documentElement.scrollWidth`
      // is no witness here: WebKit counts in it the photos clipped by the nested
      // strips, 815 px on a 390 px phone, while `html` itself does not scroll.)
      expect(await page.evaluate(() => { const vp = document.querySelector("[data-testid=view-page]")!; return [document.body.scrollWidth <= innerWidth, vp.scrollWidth <= vp.clientWidth]; })).toEqual([true, true]);
      expect(await sidewaysOverflow(page), "nothing sticks out sideways").toEqual([]);
      // The link is a finger-sized target on a touch-less phone viewport too.
      const link = await boxes(page, '[data-testid="compare-link"]');
      expect(link[0].height).toBeGreaterThanOrEqual(36);
      await page.screenshot({ path: test.info().outputPath(`genui-page-mobile-${scheme}.png`)});
      const phoneAxe = await axe(page, '[data-testid="view-page"]');
      expect(phoneAxe.map((v) => `${v.id}: ${v.help}`), `axe on the page (${scheme}, phone)`).toEqual([]);
    });
  }

  test("an unknown view says so instead of a blank page", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${E2E_BASE}/v/0000000000000000`);
    await expect(page.getByTestId("view-page-missing")).toBeVisible({ timeout: 15_000 });
  });
});
