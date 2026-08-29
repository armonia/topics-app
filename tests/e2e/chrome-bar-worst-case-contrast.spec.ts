/**
 * THE TAB LABEL CONTRAST OVER THE CHAT, MEASURED ON COMPOSITED PIXELS.
 *
 * The tab bar has no background of its own: `--chrome-overlay-bg` is
 * `transparent` and `.pane-chrome-bar` is `absolute`, so the conversation
 * scrolls UNDER the labels (that part is measured by `chrome-bar-overlay.spec.ts`,
 * OVERLAY-4). This spec measures the price of that decision, on the one surface
 * that really passes under the glass.
 *
 * HOW the pixels are read - the three captures, the coverage mask, the reason
 * the ordinary contrast helper cannot answer this question - lives in
 * `helpers/chrome-contrast.ts`, because a second spec asks the same question of
 * the surfaces that claim NOT to pass under
 * (`chrome-bar-surface-inventory.spec.ts`). One method, two verdicts: read the
 * helper before changing anything here.
 *
 * WORST CASE, NOT AVERAGE. A floating label's contrast is a function of what is
 * passing beneath it, so a single reading is a single sample of a moving
 * quantity. The bar is measured at several scroll offsets over deliberately
 * hostile content (fenced code blocks carry their own background, so they are
 * the sharpest luminance edges the transcript can put under the chrome), and the
 * number this spec asserts on is the WORST reading, never the mean.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { AA_TESTO } from "./helpers/contrast";
import { BACKDROP_SPREAD_FLOOR, setTheme, sweepChromeLabels } from "./helpers/chrome-contrast";

hermetic(test);

const BASE = E2E_BASE;

/** Enough messages that the transcript scrolls well past the bar. */
const SEMI = 30;

const bar = (page: Page) => page.locator(".pane-chrome-bar").first();
const container = (page: Page) => page.getByTestId("chat-scroll-container").first();

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

for (const nome of ["dark", "light"] as const) {
  test(`CONTRASTO-${nome}: le etichette reggono AA sul PEGGIOR fondale che ci scorre sotto`, async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-01" });

    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await openTopic(page, topicNome);
    await expect(container(page)).toBeVisible({ timeout: 15000 });
    await setTheme(page, nome === "dark");
    await expect(bar(page)).toBeVisible({ timeout: 15000 });

    // The premise. If the bar ever paints again, this spec is measuring a band
    // and its verdict stops meaning what it says.
    await expect(bar(page)).toHaveCSS("position", "absolute");

    const sweep = await sweepChromeLabels(page, {
      bar: bar(page),
      body: container(page),
      dark: nome === "dark",
    });

    // Reported whatever the verdict: a card that needs the number to decide an
    // exception should not have to re-run the suite to see it.
    console.log(
      `\n[MISURA ${nome}] ${sweep.samples.length} letture, spread backdrop ${sweep.spread.toFixed(4)}, peggiori: ${sweep.card}\n`,
    );
    test.info().annotations.push({
      type: "misura",
      description: `${nome}: worst ${sweep.worst.ratio.toFixed(2)}:1 (tab #${sweep.worst.index}, offset ${sweep.worst.offset}) su ${sweep.samples.length} letture`,
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
      sweep.spread,
      "il fondale sotto la barra non cambia MAI durante la passata: sotto il vetro non ci scorre niente, e la lettura di contrasto qui sotto sta misurando lo sfondo della cella (vedi `.chrome-passthrough-y` in index.css)",
    ).toBeGreaterThan(BACKDROP_SPREAD_FLOOR);

    expect(
      sweep.worst.ratio,
      `l'etichetta della tab deve reggere WCAG AA (${AA_TESTO}:1) sul backdrop worst, non su quello medio`,
    ).toBeGreaterThanOrEqual(AA_TESTO);
  });
}
