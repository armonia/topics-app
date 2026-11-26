/**
 * THE HINT GIVES WAY BEFORE THE NAME, AND THE NAME GOES WHOLE.
 *
 * The sidebar header holds, in this order from the left: the 64px the macOS
 * traffic lights are pinned to, the word «Topics», the column's toggle, the
 * bell, then Search and «+» at the far end, the four buttons a tab's size
 * (34px) since 25/11. Search and «+» each carry a keyboard hint inside them
 * (⌘K, ⌘N), a repetition of what their `title` already says.
 *
 * What is asserted is the rule, across the whole travel of the sidebar
 * (SIDEBAR_MIN_W to 400, its drag limits): the word is either whole or not
 * there at all (25/11, the owner: "let's hide the word altogether when it does
 * not fit"), never «To…»; no hint is visible while the word is not; and the
 * buttons never run into each other.
 *
 * HOW THE WIDTH IS SET. By writing `style.width` on the sidebar node, which is
 * exactly what the drag does: `useSidebarAndLayout` bypasses React while the
 * mouse is down and only commits to state on mouseup. Driving the test the
 * same way is what makes it a test of the mechanism that ships (container
 * queries on the header, the hints first, then the word) rather than of a React re-render the
 * drag never performs. The delivery video does the real drag, with a real
 * mouse.
 *
 * @covers WINCTL-03
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { removeTmpDir } from "./helpers/file-project";

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
const BUTTONS = ["sidebar-collapse", "inbox-button", "pane-add-menu-trigger"].map((id) => `${HEADER} [data-testid="${id}"]`).concat(SEARCH);

/** The sidebar's own drag limits (`SIDEBAR_MIN_W`, `SIDEBAR_MAX_W` in
 *  `useSidebarAndLayout`). */
const DRAG_MIN = 248;
const DRAG_MAX = 400;
/** What the app ships with. */
const DEFAULT_WIDTH = 256;
/** The sidebar at which the hints come back: a 350px row, and the column is
 *  13px wider than its row (1px border plus two ROW_INSET). The row threshold
 *  is set for the widest font the app ships to, see the sweep in index.css. */
const HINTS_FIT_WIDTH = 363;
/** Sub-pixel layout rounds; the assertions do not need more than this. */
const TOL = 1;

/** `word` is the width the word shows: its own when it is there, 0 when it
 *  is hidden. `overlaps` names the
 *  pairs of header buttons whose boxes cross. */
type Reading = { width: number; word: number; hintsVisible: number; overlaps: string[] };

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
  await page.waitForSelector(HEADER, { state: "visible", timeout: 15_000 });
  // Attached, not visible: at the default 256 the word does not fit and is
  // hidden on purpose.
  await page.waitForSelector(WORD, { state: "attached", timeout: 15_000 });
}

/** Set the column's width the way the drag does, then read the row back. */
async function readAt(page: Page, width: number): Promise<Reading> {
  return page.evaluate(
    ({ sidebar, word, hints, buttons, width }) => {
      const bar = document.querySelector(sidebar) as HTMLElement;
      // `.sidebar-transition` animates width over 200ms. Without cutting it
      // out, every rect read here would be a FRAME OF THE ANIMATION and not
      // the width asked for.
      bar.style.transition = "none";
      bar.style.width = `${width}px`;
      // Force the layout the container query depends on before measuring.
      void bar.offsetWidth;
      const label = document.querySelector(word) as HTMLElement;
      const line = label.parentElement!.getBoundingClientRect();
      const own = label.getBoundingClientRect();
      const visible = Array.from(document.querySelectorAll(hints)).filter(
        (k) => (k as HTMLElement).getBoundingClientRect().width > 0,
      ).length;
      const boxes = buttons.map((sel) => ({ sel, r: (document.querySelector(sel) as HTMLElement).getBoundingClientRect() }));
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, b = boxes[j].r;
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5) overlaps.push(`${boxes[i].sel} x ${boxes[j].sel}`);
        }
      }
      return {
        width: bar.getBoundingClientRect().width,
        word: own.top < line.bottom - 1 ? own.width : 0,
        hintsVisible: visible,
        overlaps,
      };
    },
    { sidebar: SIDEBAR, word: WORD, hints: HINTS, buttons: BUTTONS, width },
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

  test("at the default 256px no hint and no part of the name: the four buttons, side by side", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    await loadMacChrome(page);
    const r = await readAt(page, DEFAULT_WIDTH);
    expect(r.word, `the word shows ${r.word.toFixed(1)}px at ${DEFAULT_WIDTH}px: whole or nothing`).toBe(0);
    expect(r.hintsVisible, `${r.hintsVisible} hint(s) still visible at ${DEFAULT_WIDTH}px`).toBe(0);
    expect(r.overlaps, `buttons crossing at ${DEFAULT_WIDTH}px`).toEqual([]);
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

  test("at the threshold the hints come back, and the name is whole", async ({ page }) => {
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

  test("no width in the whole travel shows part of the name, a hint without it, or two buttons crossing", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-03" });
    await loadMacChrome(page);
    const natural = await naturalWordWidth(page);
    expect(natural, "the word is whole at the widest column").toBeGreaterThan(40);
    const offenders: string[] = [];
    for (let w = DRAG_MIN; w <= DRAG_MAX; w += 2) {
      const r = await readAt(page, w);
      if (r.word > 0 && r.word < natural - TOL) offenders.push(`${w}px: the word cut to ${r.word.toFixed(1)} of ${natural.toFixed(1)}`);
      if (r.hintsVisible > 0 && r.word === 0) offenders.push(`${w}px: ${r.hintsVisible} hint(s) and no word`);
      if (r.overlaps.length) offenders.push(`${w}px: ${r.overlaps.join(", ")}`);
    }
    expect(offenders, `widths that break the rule:\n${offenders.join("\n")}`).toEqual([]);
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

      await dragSidebarTo(page, DEFAULT_WIDTH, 380);
      await expect(hints.first()).toBeVisible();
      await expect(hints.nth(1)).toBeVisible();

      await dragSidebarTo(page, 380, 300);
      await expect(hints.first()).toBeHidden();

      await dragSidebarTo(page, 300, DEFAULT_WIDTH);
      await expect(hints.first()).toBeHidden();
      await expect(page.locator(SEARCH)).toBeVisible();
    } finally {
      await ctx.close();
      if (video) await video.saveAs(join(MEDIA_DIR, "sidebar-kbd-hints-resize.webm"));
      removeTmpDir(videoTmp);
    }
  });
});

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
