/**
 * THE HINT GIVES WAY BEFORE THE NAME.
 *
 * The sidebar header holds, in this order from the left: the 64px the macOS
 * traffic lights are pinned to, the word «Topics», the bell, then Search and
 * «+» at the far end. Search and «+» each carry a keyboard hint inside them
 * (⌘K, ⌘N) and both are `flex-shrink-0`, so every pixel the row was short of
 * landed on the only `min-w-0` chain in the header — the word. Measured before
 * this card, at the DEFAULT sidebar width of 256px: the wordmark rendered
 * 18.7px against the 62 it wants, i.e. the app's own name as «To…», while two
 * hints repeating what the buttons' `title` already says stayed whole.
 *
 * What is asserted here is the rule, not the two endpoints of it: across the
 * whole travel of the sidebar (180 to 400, its drag limits) there SHALL NOT be
 * a width where a hint is visible and the word is under its natural size.
 *
 * HOW THE WIDTH IS SET. By writing `style.width` on the sidebar node, which is
 * exactly what the drag does: `useSidebarAndLayout` bypasses React while the
 * mouse is down and only commits to state on mouseup. Driving the test the
 * same way is what makes it a test of the mechanism that ships (a container
 * query on the row) rather than of a React re-render the drag never performs.
 * The delivery video does the real drag, with a real mouse.
 *
 * @covers WINCTL-03
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const VIEWPORT = { width: 1280, height: 800 };
/** Outside the repo: nothing untracked may be left in the checkout. */
const MEDIA_DIR = join(homedir(), ".topics", "media");

const SIDEBAR = '[aria-label="Topics sidebar"]';
const HEADER = `${SIDEBAR} .sidebar-header`;
const WORD = '[data-testid="sidebar-topics-title"]';
const SEARCH = `${SIDEBAR} [aria-label="Search, open the command palette"]`;
const ADD = `${SIDEBAR} [data-testid="pane-add-menu-trigger"]`;
const HINTS = `${HEADER} .kbd-hint`;

/** The sidebar's own drag limits (`useSidebarAndLayout`). */
const DRAG_MIN = 180;
const DRAG_MAX = 400;
/** What the app ships with, and where the defect was measured. */
const DEFAULT_WIDTH = 256;
/** The sidebar at which the hints come back: a 300px row, and the column is
 *  13px wider than its row (1px border plus two ROW_INSET). The row threshold
 *  is set for the widest font the app ships to (Linux CI measured the word at
 *  67.3px against 61.8 on a Mac, and fits everything from a 294px row) — see
 *  the two sweeps in index.css. */
const HINTS_FIT_WIDTH = 313;
/** Sub-pixel layout rounds; the assertions do not need more than this. */
const TOL = 1;

type Reading = { width: number; word: number; hintsVisible: number };

/** The app with the Mac chrome forced: the hints only exist where the
 *  modifier is ⌘ (`usesCtrl`), and that is also where the lights cost 64px. */
/**
 * The hints exist only on a Mac-keyed platform. `usesCtrl`
 * (`client/src/lib/shortcutLabel.ts`) reads `navigator.userAgentData.platform`
 * then `navigator.platform`, and where it says Ctrl the app renders no
 * `.kbd-hint` at all (measured on CI, Linux, 2026-09-07: 0 hints at 299px and
 * titles «Search (Ctrl+K)»). This spec is about the Mac chrome, so it pins the
 * platform the same way it pins `windowChrome=mac`.
 */
const PLATFORM = "MacIntel";

async function loadMacChrome(page: Page): Promise<void> {
  await page.addInitScript((platform) => {
    Object.defineProperty(navigator, "platform", { get: () => platform, configurable: true });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined, configurable: true });
  }, PLATFORM);
  await page.goto(`${E2E_BASE}/?windowChrome=mac`);
  await page.waitForSelector(SIDEBAR, { state: "visible", timeout: 15_000 });
  await page.waitForSelector(WORD, { state: "visible", timeout: 15_000 });
}

/** Set the column's width the way the drag does, then read the row back. */
async function readAt(page: Page, width: number): Promise<Reading> {
  return page.evaluate(
    ({ sidebar, word, hints, width }) => {
      const bar = document.querySelector(sidebar) as HTMLElement;
      // `.sidebar-transition` animates width over 200ms. Without cutting it
      // out, every rect read here would be a FRAME OF THE ANIMATION and not
      // the width asked for: the first version of this spec measured the
      // wordmark at a 400px column and got the 18.7px of a 256px one, so it
      // compared the defect against itself and passed while broken.
      bar.style.transition = "none";
      bar.style.width = `${width}px`;
      // Force the layout the container query depends on before measuring.
      void bar.offsetWidth;
      const label = document.querySelector(word) as HTMLElement;
      const visible = Array.from(document.querySelectorAll(hints)).filter(
        (k) => (k as HTMLElement).getBoundingClientRect().width > 0,
      ).length;
      return {
        width: bar.getBoundingClientRect().width,
        word: label.getBoundingClientRect().width,
        hintsVisible: visible,
      };
    },
    { sidebar: SIDEBAR, word: WORD, hints: HINTS, width },
  );
}

/** How wide «Topics» wants to be: read at the widest the column goes, where
 *  nothing competes with it. Asked of the page, never written down here. */
async function naturalWordWidth(page: Page): Promise<number> {
  return (await readAt(page, DRAG_MAX)).word;
}

test.describe("The keyboard hints yield before the wordmark", () => {
  test.beforeAll(() => {
    mkdirSync(MEDIA_DIR, { recursive: true });
  });

  test("at the default 256px the name is whole and no hint is shown", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    await loadMacChrome(page);
    const natural = await naturalWordWidth(page);
    const r = await readAt(page, DEFAULT_WIDTH);
    expect(
      r.word,
      `wordmark ${r.word.toFixed(1)}px at a ${r.width}px sidebar, natural ${natural.toFixed(1)}px`,
    ).toBeGreaterThanOrEqual(natural - TOL);
    expect(r.hintsVisible, `${r.hintsVisible} hint(s) still visible at ${DEFAULT_WIDTH}px`).toBe(0);
    await expect(page.locator(SEARCH)).toBeVisible();
    await expect(page.locator(ADD)).toBeVisible();
  });

  test("the shortcut is still named, in the title of both buttons", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    await loadMacChrome(page);
    await readAt(page, DEFAULT_WIDTH);
    // The hint is a repetition; this is the original, and it survives.
    await expect(page.locator(SEARCH)).toHaveAttribute("title", /\u2318K/);
    await expect(page.locator(ADD)).toHaveAttribute("title", /\u2318N/);
  });

  test("at the threshold the hints come back, and the name is still whole", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    await loadMacChrome(page);
    const natural = await naturalWordWidth(page);
    const r = await readAt(page, HINTS_FIT_WIDTH);
    expect(r.hintsVisible, `hints at ${HINTS_FIT_WIDTH}px: ${r.hintsVisible}, expected 2`).toBe(2);
    expect(
      r.word,
      `wordmark ${r.word.toFixed(1)}px at ${HINTS_FIT_WIDTH}px with both hints up, natural ${natural.toFixed(1)}px`,
    ).toBeGreaterThanOrEqual(natural - TOL);
  });

  test("no width in the whole travel shows a hint over a shrunken name", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    await loadMacChrome(page);
    const natural = await naturalWordWidth(page);
    const offenders: string[] = [];
    for (let w = DRAG_MIN; w <= DRAG_MAX; w += 2) {
      const r = await readAt(page, w);
      if (r.hintsVisible > 0 && r.word < natural - TOL) {
        offenders.push(`${w}px: word ${r.word.toFixed(1)} < ${natural.toFixed(1)} with ${r.hintsVisible} hint(s)`);
      }
    }
    expect(offenders, `widths where a hint outlived the name:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("the before and after of 256px, with the numbers read off the DOM", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    await loadMacChrome(page);
    const natural = await naturalWordWidth(page);

    // BEFORE is not a stale screenshot from another branch: it is this build
    // with the one class that carries the rule taken off the row, which is
    // exactly the layout that measured 18.7px.
    // Tag the row first: once the class is off, the selector that found it is
    // gone too, and re-finding it by its Tailwind classes would pick whatever
    // else in the column happens to be a flex row.
    await page.evaluate((header) => {
      const row = document.querySelector(header) as HTMLElement;
      row.dataset.e2eHeader = "1";
      row.classList.remove("sidebar-header");
    }, HEADER);
    const before = await readAt(page, DEFAULT_WIDTH);
    await annotate(page, `PRIMA — sidebar ${DEFAULT_WIDTH}px`, before, natural);
    await page.screenshot({ path: join(MEDIA_DIR, "sidebar-kbd-hints-256-before.png"), clip: shotClip() });
    await clearAnnotations(page);

    await page.evaluate(() => {
      (document.querySelector("[data-e2e-header]") as HTMLElement).classList.add("sidebar-header");
    });
    const after = await readAt(page, DEFAULT_WIDTH);
    await annotate(page, `DOPO — sidebar ${DEFAULT_WIDTH}px`, after, natural);
    await page.screenshot({ path: join(MEDIA_DIR, "sidebar-kbd-hints-256-after.png"), clip: shotClip() });
    await clearAnnotations(page);

    expect(before.word, "the before shot did not reproduce the defect").toBeLessThan(natural - TOL);
    expect(after.word, "the after shot does not show a whole wordmark").toBeGreaterThanOrEqual(natural - TOL);
  });

  test("dragging the column shows the hints leave and come back", async ({ browser }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    test.setTimeout(120_000);
    const videoTmp = mkdtempSync(join(tmpdir(), "sidebar-hints-"));
    const ctx = await openRecordingContext(browser, videoTmp);
    const page = await ctx.newPage();
    const video = page.video();
    try {
      await loadMacChrome(page);
      const hints = page.locator(HINTS);
      await expect(hints.first()).toBeHidden();

      await dragSidebarTo(page, DEFAULT_WIDTH, 360);
      await expect(hints.first()).toBeVisible();
      await expect(hints.nth(1)).toBeVisible();

      await dragSidebarTo(page, 360, 220);
      await expect(hints.first()).toBeHidden();

      await dragSidebarTo(page, 220, DEFAULT_WIDTH);
      await expect(hints.first()).toBeHidden();
      await expect(page.locator(WORD)).toBeVisible();
    } finally {
      await ctx.close();
      if (video) await video.saveAs(join(MEDIA_DIR, "sidebar-kbd-hints-resize.webm"));
      rmSync(videoTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

/** The header plus a little air, at whatever the column measures now. */
function shotClip() {
  return { x: 0, y: 0, width: 420, height: 120 };
}

/**
 * The measured rects drawn over the row as fixed labels, then removed. The
 * numbers come from `getBoundingClientRect`, not from eyes.
 */
async function annotate(page: Page, caption: string, r: Reading, natural: number): Promise<void> {
  await page.evaluate(
    ({ word, caption, r, natural }) => {
      const label = document.querySelector(word) as HTMLElement;
      const box = label.getBoundingClientRect();
      const root = document.createElement("div");
      root.id = "e2e-annotations";
      root.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:11px/1.4 ui-monospace,monospace;";
      const el = (css: string, text = "") => {
        const d = document.createElement("div");
        d.style.cssText = css;
        d.textContent = text;
        root.appendChild(d);
      };
      el(
        `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;outline:1px solid #e0245e;`,
      );
      el(`position:absolute;left:8px;top:${box.bottom + 8}px;color:#e0245e;white-space:nowrap;`, caption);
      el(
        `position:absolute;left:8px;top:${box.bottom + 24}px;color:#e0245e;white-space:nowrap;`,
        `wordmark ${r.word.toFixed(1)}px / ${natural.toFixed(1)} naturali`,
      );
      el(
        `position:absolute;left:8px;top:${box.bottom + 40}px;color:#0a58ca;white-space:nowrap;`,
        `hint visibili: ${r.hintsVisible}`,
      );
      document.body.appendChild(root);
    },
    { word: WORD, caption, r, natural },
  );
}

async function clearAnnotations(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("e2e-annotations")?.remove());
}

/**
 * The real gesture: press the resize band, move, release. The band sits at
 * `left: width - 8` and is 10px wide, so its middle is `width - 3`.
 */
async function dragSidebarTo(page: Page, from: number, to: number): Promise<void> {
  const y = 300;
  await page.mouse.move(from - 3, y);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from - 3 + ((to - from) * i) / steps, y);
  }
  await page.mouse.up();
  await expect
    .poll(async () => Math.round(await page.evaluate((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().width, SIDEBAR)))
    .toBe(to);
}

/**
 * The suite runs with `reducedMotion: "reduce"`; the drag is what is being
 * shown here, so this context asks for motion and records it.
 */
function openRecordingContext(browser: Browser, dir: string) {
  return browser.newContext({
    baseURL: E2E_BASE,
    viewport: VIEWPORT,
    locale: "it-IT",
    reducedMotion: "no-preference",
    recordVideo: { dir, size: VIEWPORT },
  });
}
