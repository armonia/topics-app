/**
 * THE NATIVE LIGHTS, MEASURED.
 *
 * On macOS the three traffic lights are painted by AppKit over the webview: no
 * DOM node stands where they are, so until now nothing could assert that the
 * word «Topics» starts to their right, or that the content's top bar keeps
 * clear of them once the sidebar collapses and that bar becomes the window's
 * top edge. Two things make it measurable from a plain Chromium:
 *
 *   1. `?windowChrome=mac` forces the Mac chrome (see `windowChrome.ts`), and
 *   2. the sidebar mounts `traffic-lights-box`, the rectangle the Rust shell
 *      pins the lights to (x=12, 52 wide).
 *
 * The numbers below are the macOS standard written out on purpose, not
 * imported from the client: the box has to be checked AGAINST something, and
 * a test that imports the constant it verifies proves only that a number
 * equals itself. If the shell moves the lights, these move with it.
 *
 * The slide is sampled with requestAnimationFrame on EVERY frame, not polled:
 * the guarantee under test is "never under the lights", and a crossing that
 * lasts three frames is invisible to anything slower than the frame.
 *
 * @covers WINCTL-02
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_BASE } from "./helpers/test-server";
import { openTestChat } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { removeTmpDir } from "./helpers/file-project";

hermetic(test);

/** Where the shell pins the first light, in window pixels (`LEFT_INSET`, lib.rs). */
const LIGHTS_LEFT = 12;
/** Three 12px circles with 8px between them. */
const LIGHTS_WIDTH = 3 * 12 + 2 * 8;
/** The row's own step, `ROW_INSET`. */
const GAP = 6;
/** The first pixel the content may use while the sidebar is away. */
const CLEAR = LIGHTS_LEFT + LIGHTS_WIDTH + GAP;
/** One pixel of tolerance: sub-pixel layout rounds, the lights do not. */
const TOL = 1;

const VIEWPORT = { width: 1280, height: 800 };
/** Outside the repo: nothing untracked may be left in the checkout. */
const MEDIA_DIR = join(homedir(), ".topics", "media");
const VIDEO_NAME = "sidebar-collapse-under-traffic-lights.webm";
const SHOT_NAME = "sidebar-header-traffic-lights-annotated.png";

const SIDEBAR = '[aria-label="Topics sidebar"]';
const BOX = '[data-testid="traffic-lights-box"]';
const TITLE_LABEL = '[data-testid="sidebar-topics-title"]';
const BELL = '[data-testid="notification-history-button"]';
const SEARCH = `${SIDEBAR} [aria-label="Search, open the command palette"]`;
const ADD = `${SIDEBAR} [data-testid="pane-add-menu-trigger"]`;
const BAR = ".pane-chrome-bar";
const BAR_TOGGLE = `${BAR} button[aria-label="Toggle sidebar"]`;
const BAR_FIRST_TAB = `${BAR} [data-testid^="pane-tab-"]`;

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

async function rectOf(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, width: box.width, height: box.height };
}

/** The app with the Mac chrome forced, sidebar visible. */
async function loadMacChrome(page: Page): Promise<void> {
  await page.request.put(`${E2E_BASE}/api/ui-state/panel-order`, { data: { order: [], pinned: [] } }).catch(() => {});
  await page.goto("/?windowChrome=mac");
  await page.waitForSelector(SIDEBAR, { state: "visible", timeout: 15_000 });
}

async function sidebarIsAway(page: Page): Promise<boolean> {
  const b = await page.locator(SIDEBAR).boundingBox();
  return !!b && b.x + b.width < 2;
}

/**
 * The slide, one number per frame: the left edge of the leftmost thing in the
 * content's top bar (the toggle or the first tab, whichever is first). Started
 * BEFORE the toggle and left running past the end of the slide, so the last
 * samples are the resting position.
 */
type Sample = { t: number; left: number };

async function sampleSlide(page: Page, trigger: () => Promise<void>, frames: number): Promise<Sample[]> {
  await page.evaluate(
    ({ toggle, tab, frames }) => {
      const w = window as unknown as { __slide?: Promise<Sample[]> };
      const leftmost = (): number => {
        let m = Number.POSITIVE_INFINITY;
        for (const selector of [toggle, tab]) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0) m = Math.min(m, r.left);
        }
        return m;
      };
      w.__slide = new Promise<Sample[]>((resolve) => {
        const out: Sample[] = [];
        const tick = (t: number) => {
          out.push({ t, left: leftmost() });
          if (out.length < frames) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      });
    },
    { toggle: BAR_TOGGLE, tab: BAR_FIRST_TAB, frames },
  );
  await trigger();
  return page.evaluate(() => (window as unknown as { __slide: Promise<Sample[]> }).__slide);
}

/** A frame that arrived this late after the previous one was preceded by a dropped one. */
const DROPPED_FRAME_MS = 25;

/**
 * Every frame at or past CLEAR, and no snap at the end: the last moving frame
 * within a pixel of rest. The second check is read against the clock: on a
 * loaded machine the sampler misses frames, and a last moving sample taken two
 * frames before the end sits several pixels from rest by the easing alone.
 * That is the machine, not the code, so when the sample after the last moving
 * one arrived late the check falls back to what a snap would violate and a
 * dropped frame would not: the final step is no larger than the one before it
 * (an ease decelerates; a snap ends with its biggest step).
 */
function judgeSlide(samples: Sample[], label: string): void {
  const lefts = samples.map((s) => s.left);
  const final = lefts[lefts.length - 1];
  const trace = () => samples.map((s) => `${s.left.toFixed(1)}@${(s.t - samples[0].t).toFixed(0)}ms`).join(" ");
  const distinct = new Set(lefts.map((v) => Math.round(v * 10) / 10)).size;
  expect(distinct, `${label}: the slide did not animate (frames: ${trace()})`).toBeGreaterThan(2);
  const under = samples
    .map((s, i) => ({ i, left: s.left }))
    .filter(({ left }) => left < CLEAR - TOL);
  expect(
    under.length,
    `${label}: ${under.length} frame(s) under the lights, first at frame ${under[0]?.i} with left=${under[0]?.left.toFixed(1)} < ${CLEAR} (lights end at ${LIGHTS_LEFT + LIGHTS_WIDTH} + gap ${GAP}); frames: ${trace()}`,
  ).toBe(0);
  let last = -1;
  for (let i = lefts.length - 1; i >= 0; i--) {
    if (Math.abs(lefts[i] - final) > 0.05) { last = i; break; }
  }
  expect(last, `${label}: no moving frame found`).toBeGreaterThanOrEqual(1);
  const finalStep = Math.abs(lefts[last] - final);
  const previousStep = Math.abs(lefts[last] - lefts[last - 1]);
  const frameGap = samples[last + 1].t - samples[last].t;
  if (frameGap <= DROPPED_FRAME_MS) {
    expect(
      finalStep,
      `${label}: last animated frame ${lefts[last].toFixed(1)} vs resting ${final.toFixed(1)} (frame gap ${frameGap.toFixed(0)}ms); frames: ${trace()}`,
    ).toBeLessThanOrEqual(TOL);
  } else {
    expect(
      finalStep,
      `${label}: a frame was dropped at the end (gap ${frameGap.toFixed(0)}ms), and the final step ${finalStep.toFixed(1)} is larger than the one before it ${previousStep.toFixed(1)}: that is a snap, not an ease; frames: ${trace()}`,
    ).toBeLessThanOrEqual(Math.max(TOL, previousStep));
  }
}

test.describe("The room for the native lights", () => {
  test.beforeAll(() => {
    mkdirSync(MEDIA_DIR, { recursive: true });
  });

  test("the reserved box is the lights: 52 wide, anchored at 12", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-02" });
    await loadMacChrome(page);
    const box = await rectOf(page, BOX);
    expect(Math.abs(box.width - LIGHTS_WIDTH), `box width ${box.width} vs ${LIGHTS_WIDTH}`).toBeLessThanOrEqual(TOL);
    expect(Math.abs(box.left - LIGHTS_LEFT), `box left ${box.left} vs ${LIGHTS_LEFT}`).toBeLessThanOrEqual(TOL);
  });

  test("one step along the header: lights, word, bell, and search to add", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-02" });
    await loadMacChrome(page);
    const [box, word, bell, search, add] = await Promise.all([
      rectOf(page, BOX),
      rectOf(page, TITLE_LABEL),
      rectOf(page, BELL),
      rectOf(page, SEARCH),
      rectOf(page, ADD),
    ]);
    const gaps = {
      "lights to word": word.left - box.right,
      "word to bell": bell.left - word.right,
      "search to add": add.left - search.right,
    };
    const values = Object.values(gaps);
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread, `gaps differ: ${JSON.stringify(gaps)}`).toBeLessThanOrEqual(TOL);
    for (const [name, v] of Object.entries(gaps)) {
      expect(Math.abs(v - GAP), `${name} = ${v.toFixed(1)}, expected ${GAP}`).toBeLessThanOrEqual(TOL);
    }

    // The annotated shot: the measured rects and gaps drawn over the header
    // as fixed-position labels, then removed. Numbers from the DOM, not eyes.
    await page.evaluate(
      ({ box, rowBottom, pairs }) => {
        const root = document.createElement("div");
        root.id = "e2e-annotations";
        root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:10px/1 ui-monospace,monospace;";
        const el = (css: string, text = "") => {
          const d = document.createElement("div");
          d.style.cssText = css;
          d.textContent = text;
          root.appendChild(d);
        };
        el(`position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;outline:1px solid #e0245e;`);
        // Labels go UNDER the row, not above it: the header is the first 40px
        // of the window and there is no room above it in the clip.
        el(`position:absolute;left:${box.left}px;top:${rowBottom + 4}px;color:#e0245e;white-space:nowrap;`, `lights ${box.width}px`);
        for (const [i, p] of pairs.entries()) {
          const w = p.right - p.left;
          el(`position:absolute;left:${p.left}px;top:${p.top}px;width:${w}px;height:${p.height}px;background:rgba(0,120,255,.35);`);
          el(`position:absolute;left:${p.left - 10}px;top:${rowBottom + 4 + (i + 1) * 12}px;color:#0a58ca;white-space:nowrap;`, `${p.name} ${w.toFixed(0)}px`);
        }
        document.body.appendChild(root);
      },
      {
        box,
        rowBottom: Math.max(word.bottom, bell.bottom, add.bottom),
        pairs: [
          { name: "gap", left: box.right, right: word.left, top: word.top, height: word.height },
          { name: "gap", left: word.right, right: bell.left, top: bell.top, height: bell.height },
          { name: "gap", left: search.right, right: add.left, top: add.top, height: add.height },
        ],
      },
    );
    const sidebar = await rectOf(page, SIDEBAR);
    await page.screenshot({
      path: join(MEDIA_DIR, SHOT_NAME),
      clip: { x: 0, y: 0, width: sidebar.width, height: 96 },
    });
    await page.evaluate(() => document.getElementById("e2e-annotations")?.remove());
  });

  test("the content's top bar never crosses the lights while the sidebar slides", async ({ browser }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-02" });
    test.setTimeout(120_000);
    const videoTmp = mkdtempSync(join(tmpdir(), "window-chrome-"));
    const ctx = await openRecordingContext(browser, videoTmp);
    const page = await ctx.newPage();
    const video = page.video();
    try {
      await loadMacChrome(page);
      await openTestChat(page);
      await expect(page.locator(BAR_TOGGLE)).toBeVisible();

      // Sixty frames: the slide is 200ms, the cleanup 60 more, and the rest of
      // the second is resting frames that tie the last moving one to the end.
      const collapse = await sampleSlide(page, () => page.keyboard.press("Meta+b"), 60);
      expect(await sidebarIsAway(page), "sidebar did not collapse").toBe(true);
      judgeSlide(collapse, "collapse");

      const reopen = await sampleSlide(page, () => page.keyboard.press("Meta+b"), 60);
      await expect(page.locator(SIDEBAR)).toBeVisible();
      judgeSlide(reopen, "reopen");
    } finally {
      await ctx.close();
      if (video) {
        await video.saveAs(join(MEDIA_DIR, VIDEO_NAME));
      }
      removeTmpDir(videoTmp);
    }
  });

  test("with no pane open the floating toggle also stands clear of the lights", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "WINCTL-02" });
    await resetPaneStore(request, []);
    await loadMacChrome(page);
    await page.keyboard.press("Meta+b");
    await expect.poll(() => sidebarIsAway(page)).toBe(true);
    const toggle = page.getByTitle(/Expand sidebar/);
    await expect(toggle).toBeVisible();
    const r = await rectOf(page, 'button[title^="Expand sidebar"]');
    expect(r.left, `floating toggle left ${r.left} < ${CLEAR}`).toBeGreaterThanOrEqual(CLEAR - TOL);
  });
});

/**
 * The suite runs with `reducedMotion: "reduce"`; the sidebar slide is what is
 * being measured, so this context asks for motion, and records it: the clip is
 * part of the delivery.
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
