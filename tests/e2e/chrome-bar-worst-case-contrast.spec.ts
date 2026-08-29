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
 * HOW GLYPH AND BACKDROP ARE SEPARATED. Inside a label's rect the glyphs are a
 * minority of the pixels and the backdrop is the bulk, so the median luminance
 * of the clip is the backdrop and the far percentile, on whichever side the
 * text colour sits, is the glyph core. Antialiasing fills the space between the
 * two and is deliberately excluded: it belongs to neither term.
 */
import { test, expect, type Page } from "@playwright/test";
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
async function readLabel(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<Reading> {
  const png = (await page.screenshot({ clip: box })).toString("base64");
  return page.evaluate(
    async (png: string) => {
      const bin = atob(png);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const decoded = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const cv = new OffscreenCanvas(decoded.width, decoded.height);
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(decoded, 0, 0);
      const px = ctx.getImageData(0, 0, decoded.width, decoded.height).data;

      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const lums: number[] = [];
      for (let i = 0; i < px.length; i += 4) {
        lums.push(0.2126 * f(px[i]) + 0.7152 * f(px[i + 1]) + 0.0722 * f(px[i + 2]));
      }
      lums.sort((a, b) => a - b);
      const pct = (p: number) => lums[Math.max(0, Math.min(lums.length - 1, Math.round(p * (lums.length - 1))))];

      // Backdrop: the bulk of the rect. Glyph core: the tail that lies FARTHER
      // from the backdrop, whichever side that is.
      //
      // Picking the side from the declared text colour is what the first draft
      // did, and it was wrong in a way worth recording. The colour is read at
      // one instant and the frame is captured at another, so a theme that
      // settles between the two makes the reader take the tail on the wrong
      // side of the histogram. It does not fail loudly: it returns the
      // backdrop against itself, a flat 1.00:1, which reads like a real
      // contrast catastrophe and is only a bookkeeping error. Deriving the
      // side from the pixels removes the second instant, and with it the bug.
      //
      // Ink that genuinely vanished into its backdrop still fails, and for the
      // right reason: if neither tail departs from the median, the farther tail
      // IS the median and the ratio collapses to 1 on its own.
      const backdrop = pct(0.5);
      const alto = pct(0.97);
      const basso = pct(0.03);
      const glyph = Math.abs(alto - backdrop) >= Math.abs(backdrop - basso) ? alto : basso;
      const ratio = (Math.max(glyph, backdrop) + 0.05) / (Math.min(glyph, backdrop) + 0.05);
      return { ratio, glyph, backdrop };
    },
    png,
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
        const l = await readLabel(page, box);
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
