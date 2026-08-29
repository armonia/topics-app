/**
 * READING THE CHROME LABELS OFF COMPOSITED PIXELS - the one implementation.
 *
 * The tab bar has no background of its own (`--chrome-overlay-bg` is
 * `transparent` and `.pane-chrome-bar` is `absolute`), so what a label is
 * legible AGAINST is whatever the pane underneath happens to be painting at
 * that instant. Two specs need this measurement and they ask opposite questions
 * of it: `chrome-bar-worst-case-contrast.spec.ts` asks whether the chat labels
 * survive the transcript sliding under them, and
 * `chrome-bar-surface-inventory.spec.ts` asks whether the surfaces that claim
 * NOT to pass under really do not. One method, two verdicts, so the method
 * lives here and neither spec owns a private copy of it.
 *
 * WHY THE ORDINARY CONTRAST HELPER CANNOT ANSWER THIS. `helpers/contrast.ts`
 * composites the background by walking the ANCESTOR chain to the first opaque
 * node. That is the right model for a chip inside its card and the wrong one
 * here: the content that scrolls under an `absolute` bar is not an ancestor of
 * the label, it is a SIBLING subtree painted below it. Pointed at a tab label it
 * walks label, tab card, chrome bar (transparent), cell, page, and reports the
 * page background - a number that is stable, plausible, and about a backdrop
 * that is not there.
 *
 * So no declared colour is consulted for the ground. The rect is screenshotted,
 * decoded, and the arithmetic runs on the pixels the compositor actually
 * produced, `backdrop-filter` and blur and scrolling glyphs included.
 *
 * HOW GLYPH AND GROUND ARE SEPARATED, and why not by percentiles. A first
 * version called the median of one capture the backdrop and a far tail the
 * glyph. That works while the rect is ONE surface, and this rect is not: a tab
 * sitting half over a fenced code block is bimodal, the median lands on a value
 * that exists nowhere, and the far tail is the LIGHT HALF OF THE GROUND rather
 * than the ink. On the real page it reported a glyph luminance of 0.8714 while
 * the light theme ink is `--text` at 0.011: it was not reading the text at all.
 *
 * The glyph is therefore identified, not estimated. The rect is captured three
 * times: ink forced white, ink forced black, ink removed (`color: transparent`).
 * The first two differ ONLY where the glyph covers a pixel, whatever lies
 * beneath, so their difference is a COVERAGE MASK that owes nothing to the
 * contrast under test. The third is the ground, and each core pixel is judged
 * against the ground AT THAT SAME PIXEL, so a label lying across a hard
 * luminance edge is judged on the half that is actually hard.
 *
 * The cheaper mask - "which pixels changed when the ink went away" - is the one
 * thing that cannot work here, and it was tried: ink that vanishes into its
 * ground changes nothing, so the defect erases itself from its own measurement.
 * It scored 9.38:1 on a label a contact sheet shows going illegible.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** The tab label. `.truncate.flex-1` inside the tab is a deliberately stable
 *  hook (see the note in `PaneTabBar.tsx`). */
export const TAB_LABELS = "[data-pane-id] .truncate.flex-1";

/**
 * How many scroll offsets a sweep visits, and how far each step goes.
 *
 * A floating label's contrast is a function of what is passing beneath it, so a
 * single reading is a single sample of a moving quantity. Fourteen steps of 90
 * pixels walk a whole screenful of transcript under the glass, which is what it
 * takes for every label to see both extremes of hostile content instead of
 * settling on one comfortable average.
 */
export const SWEEP_OFFSETS = 14;
export const SWEEP_WHEEL_STEP = 90;

/**
 * The line between "a hard backdrop" and "NO backdrop", measured on the spread
 * of the backdrop luminance across a whole sweep.
 *
 * It is deliberately tiny: it separates something passing under the glass from
 * nothing passing, not one design from another. It is load-bearing in both
 * directions. For the chat, a spread of exactly 0.0000 is how a clipped
 * transcript looked for weeks while the AA verdict was true about a surface
 * nobody could see (see `.chrome-passthrough-y` in index.css). For an excluded
 * surface, the same 0.0000 is the PROOF of the exception: the row of
 * `CHROME_BAR_SURFACES` that claims nothing scrolls under it is claiming
 * exactly this number.
 */
export const BACKDROP_SPREAD_FLOOR = 0.0005;

export interface Reading {
  /** WCAG 2.1 ratio between the glyph core and the backdrop actually rendered. */
  ratio: number;
  /** Luminance of the glyph core and of the backdrop, for the report. */
  glyph: number;
  backdrop: number;
}

export interface LabelSample extends Reading {
  /** Which label, which step of the sweep, and what it said: a red has to name them. */
  index: number;
  offset: number;
  text: string;
}

export interface SweepResult {
  /** The worst reading of the sweep, never the mean. */
  worst: LabelSample;
  /** Max minus min backdrop luminance over every sample: does anything move under the glass. */
  spread: number;
  /** Every sample, worst first. */
  samples: LabelSample[];
  /** The five worst, formatted for a console line a card can quote. */
  card: string;
}

/**
 * Read one label's contrast off the composited frame.
 *
 * The PNG is decoded INSIDE the page (`createImageBitmap` + `OffscreenCanvas`)
 * rather than in Node: it keeps the callers free of an image-decoding
 * dependency, and the browser that painted the pixels is also the one that
 * reads them.
 */
export async function readLabel(
  page: Page,
  el: Locator,
  box: { x: number; y: number; width: number; height: number },
): Promise<Reading> {
  // The ink colour as DECLARED, read from the same settled frame the captures
  // come from. Using it is safe here in a way it was not before, because it is
  // no longer used to guess which side of a histogram the glyphs are on: it is
  // one of the two terms of the ratio, and the other is measured.
  const ink = await el.evaluate((n) => getComputedStyle(n as HTMLElement).color);

  const capture = async (declared: string) => {
    await el.evaluate((n, c) => { (n as HTMLElement).style.color = c; }, declared);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return (await page.screenshot({ clip: box })).toString("base64");
  };
  const whiteInk = await capture("#ffffff");
  const blackInk = await capture("#000000");
  // `color: transparent` removes the GLYPH FILL and nothing else. Layout does
  // not move, and a `text-shadow` keeps painting - shadows are cast from the
  // glyph outlines, not from the fill - so a halo stays in this capture, which
  // is correct: a halo IS part of the ink's ground.
  const groundShot = await capture("transparent");
  await el.evaluate((n) => { (n as HTMLElement).style.color = ""; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  return page.evaluate(
    async ([a, b, c, declared]: [string, string, string, string]) => {
      const decode = async (png: string) => {
        const bin = atob(png);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const decoded = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const cv = new OffscreenCanvas(decoded.width, decoded.height);
        const ctx = cv.getContext("2d")!;
        ctx.drawImage(decoded, 0, 0);
        return ctx.getImageData(0, 0, decoded.width, decoded.height).data;
      };
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      const lum = (px: Uint8ClampedArray, i: number) =>
        0.2126 * f(px[i]) + 0.7152 * f(px[i + 1]) + 0.0722 * f(px[i + 2]);

      const [pxB, pxN, pxT] = await Promise.all([decode(a), decode(b), decode(c)]);
      const n = Math.min(pxB.length, pxN.length, pxT.length);

      const rgb = declared.match(/[\d.]+/g)!.map(Number);
      const inkLum = 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);

      const coverage: number[] = [];
      const ground: number[] = [];
      for (let i = 0; i < n; i += 4) {
        coverage.push(Math.abs(lum(pxB, i) - lum(pxN, i)));
        ground.push(lum(pxT, i));
      }
      const fullCoverage = Math.max(...coverage);
      // No glyph in the rect at all: nothing to judge, and saying 1.00:1 would
      // be a finding about a label that is not there.
      if (fullCoverage < 0.01) return { ratio: Number.POSITIVE_INFINITY, glyph: inkLum, backdrop: inkLum };

      const readings: { r: number; g: number }[] = [];
      for (let k = 0; k < coverage.length; k++) {
        if (coverage[k] < fullCoverage * 0.5) continue;
        const g = ground[k];
        readings.push({ r: (Math.max(inkLum, g) + 0.05) / (Math.min(inkLum, g) + 0.05), g });
      }
      if (readings.length === 0) return { ratio: Number.POSITIVE_INFINITY, glyph: inkLum, backdrop: inkLum };

      // WORST, but robust: the 5th percentile rather than the single darkest
      // sample, so one stray pixel cannot condemn a label a person can read.
      readings.sort((x, y) => x.r - y.r);
      const picked = readings[Math.min(readings.length - 1, Math.round(0.05 * (readings.length - 1)))];
      return { ratio: picked.r, glyph: inkLum, backdrop: picked.g };
    },
    [whiteInk, blackInk, groundShot, ink] as [string, string, string, string],
  );
}

/**
 * Wait until the strip stops changing, reading the pixels rather than a clock.
 *
 * Two consecutive identical captures of the same rect are the condition: the
 * blur behind an `absolute` bar is recomposited after a scroll, and a frame
 * sampled mid-flight shows a backdrop no reader ever sees. Polling the frame
 * itself is honest where a pause is a guess.
 */
export async function waitForSettledFrame(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<void> {
  let previous = "";
  await expect
    .poll(
      async () => {
        const now = (await page.screenshot({ clip })).toString("base64");
        const settled = now === previous;
        previous = now;
        return settled;
      },
      { timeout: 5_000, intervals: [50, 50, 100, 150] },
    )
    .toBe(true);
}

/** Put the document in the requested theme and wait for it to really be there. */
export async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark);
  await page.waitForFunction((d) => document.documentElement.classList.contains("dark") === d, dark, { timeout: 5_000 });
}

/**
 * Sweep the labels of the chrome bar over whatever the pane puts under them.
 *
 * The sweep is driven by the WHEEL over the pane body, and that detail is
 * load-bearing rather than stylistic. `chat-scroll-container` is a wrapper and
 * not the scroller (Virtuoso builds its own inside), so assigning `scrollTop` to
 * it moves nothing at all: the first run of the chat spec did exactly that and
 * produced five readings identical to two decimals, which is what a sweep that
 * never swept looks like. The wheel goes through the real scroll handler, like
 * the finger of whoever uses the app - and on a surface that does not scroll at
 * all (a terminal grid, a native webview) it is also the honest way to find out,
 * because it asks the page instead of assuming.
 */
export async function sweepChromeLabels(
  page: Page,
  opts: { bar: Locator; body: Locator; dark: boolean; offsets?: number; wheelStep?: number },
): Promise<SweepResult> {
  const offsets = opts.offsets ?? SWEEP_OFFSETS;
  const wheelStep = opts.wheelStep ?? SWEEP_WHEEL_STEP;

  // The rect the settle-poll watches: the bar's own strip, taken once. It is
  // the surface whose backdrop has to stop moving before a reading counts.
  const barRect = await opts.bar.boundingBox();
  expect(barRect, "the chrome bar has no measurable rect").not.toBeNull();

  const labels = page.locator(TAB_LABELS);
  const howMany = await labels.count();
  expect(howMany, "no tab label to measure").toBeGreaterThan(0);

  const area = await opts.body.boundingBox();
  expect(area, "the pane body has no measurable rect").not.toBeNull();
  await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);

  const samples: LabelSample[] = [];
  for (let off = 0; off < offsets; off++) {
    if (off > 0) await page.mouse.wheel(0, -wheelStep);
    // The theme is re-asserted at every step, not just once at the top: the app
    // re-renders on its own and can put its class back, and a sweep that
    // silently drifted into the other theme would report readings for a surface
    // nobody asked about.
    await setTheme(page, opts.dark);
    // Settle by WAITING FOR THE THING, not for a duration. What has to stop
    // moving is the composited frame behind the bar, so that is what gets
    // polled. A fixed pause guesses at the compositor and is wrong in both
    // directions: too short on a loaded machine, wasted on an idle one.
    await waitForSettledFrame(page, barRect!);

    for (let i = 0; i < howMany; i++) {
      const el = labels.nth(i);
      const box = await el.boundingBox();
      if (!box || box.width < 4 || box.height < 4) continue;
      // A label with no ink has no legibility to measure: its clip is a flat
      // patch of backdrop and would read as a perfect 1.00:1, which is an
      // artefact of the method and not a finding about the design.
      const text = ((await el.textContent()) ?? "").trim();
      if (!text) continue;
      const r = await readLabel(page, el, box);
      samples.push({ ...r, index: i, offset: off, text });
    }
  }

  expect(samples.length, "no reading collected").toBeGreaterThan(0);
  samples.sort((a, b) => a.ratio - b.ratio);
  const backdrops = samples.map((s) => s.backdrop);
  return {
    worst: samples[0],
    spread: Math.max(...backdrops) - Math.min(...backdrops),
    samples,
    card: samples.slice(0, 5).map((s) => `${s.ratio.toFixed(2)}:1@${s.offset}`).join(" | "),
  };
}
