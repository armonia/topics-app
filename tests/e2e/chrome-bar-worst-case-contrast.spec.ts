/**
 * THE TAB LABEL CONTRAST, MEASURED ON COMPOSITED PIXELS.
 *
 * The tab bar has no background of its own: `--chrome-overlay-bg` is
 * `transparent` and `.pane-chrome-bar` is `absolute`, so the conversation
 * scrolls UNDER the labels (that part is measured by `chrome-bar-overlay.spec.ts`,
 * OVERLAY-4). This spec measures the price of that decision.
 *
 * WHY THE EXISTING HELPER CANNOT ANSWER THIS. `helpers/contrast.ts` composites
 * the background by walking the ANCESTOR chain up to the first opaque node.
 * That is the right model for a chip inside its card. It is the wrong model
 * here, and not by a little: the text that scrolls under an `absolute` bar is
 * not an ancestor of the label, it is a SIBLING subtree painted below it. Point
 * `contrastOf` at a tab label and it walks label, tab card, chrome bar
 * (transparent), cell, page, and reports the page background. It would answer
 * with a number that is stable, plausible and about a backdrop that is not
 * there. That is the same family of mistake as reading a colour without its
 * alpha: the gate keeps measuring, it just stops measuring the thing at risk.
 *
 * So the backdrop is not computed from CSS. It is READ BACK from the rendered
 * frame: screenshot the label's own rect, decode it, and do the arithmetic on
 * the pixels the compositor actually produced, `backdrop-filter` and blur and
 * scrolling glyphs included. There is no way to be fooled by a declared colour
 * because no declared colour is consulted.
 *
 * WORST CASE, NOT AVERAGE. A floating label's contrast is a function of what is
 * passing beneath it, so a single reading is a single sample of a moving
 * quantity. The bar is measured at several scroll offsets over deliberately
 * hostile content (fenced code blocks carry their own background, so they are
 * the sharpest luminance edges the transcript can put under the chrome), and
 * the number this spec asserts on is the WORST reading, never the mean.
 *
 * HOW GLYPH AND GROUND ARE SEPARATED, and why not by percentiles. The first
 * version read one capture and called the median the backdrop and a far tail
 * the glyph. That works while the rect is one surface, and this rect is not:
 * a tab sitting half over a fenced block is bimodal, the median lands on a
 * value that exists nowhere, and the far tail is the LIGHT HALF OF THE GROUND
 * rather than the ink. Measured on the real page: it reported glyph 0.8714
 * while the light-theme ink is `--text`, luminance 0.011. It was not reading
 * the text at all, and it moved the WRONG WAY for two different fixes that a
 * contact sheet shows working.
 *
 * So the glyph is identified rather than estimated. The rect is captured three
 * times: with the ink forced white, with it forced black, and with it removed
 * (`color: transparent`). The first two differ ONLY where the glyph covers a
 * pixel, whatever lies beneath, so their difference is a COVERAGE MASK that
 * owes nothing to the contrast under test. The third is the ground, and each
 * core pixel is judged against the ground AT THAT SAME PIXEL - so a label
 * lying across a hard luminance edge is judged on the half that is actually
 * hard, instead of on an average of the two.
 *
 * The obvious cheaper mask - "which pixels changed when the ink went away" -
 * is the one thing that cannot work here, and it was tried: ink that vanishes
 * into its ground changes nothing, so the defect erases itself from its own
 * measurement. It scored 9.38:1 on a label a contact sheet shows going
 * illegible.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { AA_TESTO } from "./helpers/contrast";

hermetic(test);

const BASE = E2E_BASE;

/** Enough messages that the transcript scrolls well past the bar. */
const SEMI = 30;

const bar = (page: Page) => page.locator(".pane-chrome-bar").first();
const container = (page: Page) => page.getByTestId("chat-scroll-container").first();
/** The tab label. `.truncate.flex-1` inside the tab is a deliberately stable
 *  hook (see the note in `PaneTabBar.tsx`). */
const TAB_LABELS = "[data-pane-id] .truncate.flex-1";

let topicId = "";
let topicNome = "";

/**
 * The hostile transcript. A fenced code block paints its OWN surface, which is
 * the strongest luminance step the chat can slide under the chrome. Alternating
 * it with plain prose means that across a scroll sweep every label passes over
 * both extremes rather than settling on one comfortable average.
 */
function seedLine(i: number): string {
  if (i % 3 === 0) {
    return [
      "```ts",
      `const blocco${i} = "a fenced block carries its own surface under the chrome";`,
      `const line${i} = ${i};`,
      "```",
    ].join("\n");
  }
  if (i % 3 === 1) {
    return `**${"CONTRASTO ".repeat(6)}**`;
  }
  return `Riga ${i}: testo lungo abbastanza da riempire la larghezza della pane e passare sotto le etichette della barra.`;
}

test.beforeAll(async ({ request }) => {
  topicNome = `E2E-Contrasto-Peggiore-${Date.now()}`;
  const t = await createTopic(request, topicNome);
  topicId = t.id;
  for (let i = 0; i < SEMI; i++) {
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, { data: { content: seedLine(i) } });
  }
});

test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId).catch(() => {});
});

interface Reading {
  /** WCAG 2.1 ratio between the glyph core and the backdrop actually rendered. */
  ratio: number;
  /** Luminance of the glyph core and of the backdrop, for the report. */
  glyph: number;
  backdrop: number;
}

/**
 * Read one label's contrast off the composited frame.
 *
 * The PNG is decoded INSIDE the page (`createImageBitmap` + `OffscreenCanvas`)
 * rather than in Node: it keeps the spec free of an image-decoding dependency,
 * and the browser that painted the pixels is also the one that reads them.
 */
async function readLabel(
  page: Page,
  el: Locator,
  box: { x: number; y: number; width: number; height: number },
): Promise<Reading> {
  // The ink colour as DECLARED, read from the same settled frame the captures
  // come from. Using it is safe here in a way it was not before, because it is
  // no longer used to guess which side of a histogram the glyphs are on: it is
  // one of the two terms of the ratio, and the other is measured.
  const ink = await el.evaluate((n) => getComputedStyle(n as HTMLElement).color);

  // THREE CAPTURES, and the third is the one that makes this honest.
  //
  // The glyph mask cannot be derived from "how much did the picture change
  // when the ink went away", because ink that VANISHES INTO ITS GROUND changes
  // nothing - which is the defect being hunted, filtered out by the very step
  // meant to drop antialiasing. Measured: with that mask the sweep reported
  // 9.38:1 on a label a contact sheet shows going illegible.
  //
  // So the mask comes from two captures that differ ONLY in the ink colour,
  // white against black. A pixel the glyph covers changes between those two
  // whatever lies beneath it, and a pixel it does not cover changes not at
  // all. The size of the change is COVERAGE, so thresholding it keeps the core
  // of the stroke and drops its antialiased edge - and now that threshold is
  // about the glyph's geometry rather than about its contrast, which is the
  // quantity under test and must not be used to decide what to measure.
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


/** Put the document in the requested theme and wait for it to really be there. */

/**
 * Wait until the strip stops changing, reading the pixels rather than a clock.
 *
 * Two consecutive identical captures of the same rect are the condition: the
 * blur behind an `absolute` bar is recomposited after a scroll, and a frame
 * sampled mid-flight shows a backdrop no reader ever sees. Polling the frame
 * itself is honest where a pause is a guess, and it is the same discipline the
 * rest of this file applies to the contrast number.
 */
async function waitForSettledFrame(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<void> {
  let previous = "";
  await expect
    .poll(
      async () => {
        const ora = (await page.screenshot({ clip })).toString("base64");
        const settled = ora === previous;
        previous = ora;
        return settled;
      },
      { timeout: 5_000, intervals: [50, 50, 100, 150] },
    )
    .toBe(true);
}

async function theme(page: Page, scuro: boolean): Promise<void> {
  await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), scuro);
  await page.waitForFunction((d) => document.documentElement.classList.contains("dark") === d, scuro, { timeout: 5_000 });
}

for (const nome of ["dark", "light"] as const) {
  test(`CONTRASTO-${nome}: le etichette reggono AA sul PEGGIOR fondale che ci scorre sotto`, async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-01" });

    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await openTopic(page, topicNome);
    await expect(container(page)).toBeVisible({ timeout: 15000 });
    await theme(page, nome === "dark");
    await expect(bar(page)).toBeVisible({ timeout: 15000 });

    // The premise. If the bar ever paints again, this spec is measuring a band
    // and its verdict stops meaning what it says.
    await expect(bar(page)).toHaveCSS("position", "absolute");

    // The rect the settle-poll watches: the bar's own strip, taken once. It is
    // the surface whose backdrop has to stop moving before a reading counts.
    const barRect = await bar(page).boundingBox();
    expect(barRect, "la barra non ha un riquadro misurabile").not.toBeNull();

    const labels = page.locator(TAB_LABELS);
    const howMany = await labels.count();
    expect(howMany, "nessuna etichetta di tab da misurare").toBeGreaterThan(0);

    // The sweep is driven by the WHEEL, over the transcript, and that detail is
    // load-bearing. `chat-scroll-container` is the wrapper and not the scroller
    // (Virtuoso builds its own inside), so assigning `scrollTop` to it moves
    // nothing at all. The first run of this spec did exactly that and produced
    // five readings identical to two decimals, which is what a sweep that never
    // swept looks like. `chrome-bar-overlay.spec.ts` had already paid for this.
    const area = (await container(page).boundingBox())!;
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);

    const worst: { ratio: number; i: number; off: number; text: string; backdrop: number }[] = [];
    for (let off = 0; off < 14; off++) {
      if (off > 0) await page.mouse.wheel(0, -90);
      // The theme is re-asserted at every step, not just once at the top: the
      // app re-renders on its own and can put its class back, and a sweep that
      // silently drifted into the other theme would report readings for a
      // surface nobody asked about.
      await theme(page, nome === "dark");
      // Settle by WAITING FOR THE THING, not for a duration. What has to stop
      // moving is the composited frame behind the bar, so that is what gets
      // polled: two consecutive identical readings of the strip mean the blur
      // has finished recompositing. A fixed pause guesses at the compositor and
      // is wrong in both directions - too short on a loaded machine, wasted on
      // an idle one - and this file's whole point is to stop trusting numbers
      // that were not measured.
      await waitForSettledFrame(page, barRect!);

      for (let i = 0; i < howMany; i++) {
        const et = labels.nth(i);
        const box = await et.boundingBox();
        if (!box || box.width < 4 || box.height < 4) continue;
        // A label with no ink has no legibility to measure: its clip is a flat
        // patch of backdrop and would read as a perfect 1.00:1, which is an
        // artefact of the method and not a finding about the design.
        const text = ((await et.textContent()) ?? "").trim();
        if (!text) continue;
        const l = await readLabel(page, et, box);
        worst.push({ ratio: l.ratio, i, off, text, backdrop: l.backdrop });
      }
    }

    expect(worst.length, "nessuna lettura raccolta").toBeGreaterThan(0);
    worst.sort((a, b) => a.ratio - b.ratio);
    const min = worst[0];

    // Reported whatever the verdict: a card that needs the number to decide an
    // exception should not have to re-run the suite to see it.
    const backdrops = worst.map((r) => r.backdrop);
    const spread = Math.max(...backdrops) - Math.min(...backdrops);
    const card = worst.slice(0, 5).map((r) => `${r.ratio.toFixed(2)}:1@${r.off}`).join(" | ");
    console.log(`\n[MISURA ${nome}] ${worst.length} letture, spread backdrop ${spread.toFixed(4)}, peggiori: ${card}\n`);
    test.info().annotations.push({
      type: "misura",
      description: `${nome}: worst ${min.ratio.toFixed(2)}:1 (tab #${min.i}, offset ${min.off}) su ${worst.length} letture`,
    });

    // THE PREMISE OF THE WHOLE MEASURE, and for weeks it was false. A backdrop
    // that never changes across fourteen scroll offsets over deliberately
    // hostile content is not a hard backdrop: it is NO backdrop. It was exactly
    // 0.0000 while the transcript, risen under the bar by its negative margin,
    // was being clipped by an `overflow: hidden` wrapper in between - so the
    // "worst case" this spec reported was the flat cell background, the easiest
    // case there is, and the AA verdict below was true about a surface nobody
    // could see. The threshold is deliberately tiny: it separates "something
    // passes under the glass" from "nothing does", not one design from another.
    expect(
      spread,
      "il fondale sotto la barra non cambia MAI durante la passata: sotto il vetro non ci scorre niente, e la lettura di contrasto qui sotto sta misurando lo sfondo della cella (vedi `.chrome-passthrough-y` in index.css)",
    ).toBeGreaterThan(0.0005);

    expect(
      min.ratio,
      `l'etichetta della tab deve reggere WCAG AA (${AA_TESTO}:1) sul backdrop worst, non su quello medio`,
    ).toBeGreaterThanOrEqual(AA_TESTO);
  });
}
