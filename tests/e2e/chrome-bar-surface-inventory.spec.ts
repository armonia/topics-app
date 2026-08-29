/**
 * THE EXCEPTIONS, MEASURED - so that "where possible" is a list and not an
 * adjective.
 *
 * `CHROME_BAR_SURFACES` (client/src/lib/chromeBarSurfaces.ts) says which pane
 * surfaces let their content rise behind the glass of the tab bar and which do
 * not, each with its reason. The chat, the one that does, is measured by
 * `chrome-bar-worst-case-contrast.spec.ts`. This spec measures everybody else
 * WITH THE SAME METHOD (`helpers/chrome-contrast.ts`, same 14-offset sweep, same
 * coverage mask, same worst-not-mean rule), because an exception nobody measured
 * is a claim, and the whole point of moving the inventory out of a comment was
 * to stop making claims.
 *
 * THREE ASSERTIONS PER ROW, and they check different things.
 *
 *  - The GEOMETRY is what actually makes the exception true, and it is the only
 *    one that does not depend on what the pane happens to be showing. Every cell
 *    carries the full inset (`paneCellTopInset`, `var(--chrome-bar-h)`), and
 *    only the chat transcript takes it back with a negative margin
 *    (`.chat-under-chrome:first-child`). So for an excluded surface the check is
 *    that the inset is really there and that nothing inside the pane paints
 *    above the bottom edge of the bar. A pane with little content satisfies the
 *    second half cheaply, which is why the first half is asserted separately:
 *    the inset is the mechanism, and it holds whether the pane is full or empty.
 *
 *  - The RATIO says the labels stay legible over that surface. WCAG AA for text,
 *    the same bar the chat clears. An excluded surface has no moving backdrop,
 *    so this reading is easy by construction - and that is exactly why it is
 *    worth writing down rather than assuming: it is the number that would move
 *    the day somebody gives that pane a lighter or busier chrome strip.
 *  - The SPREAD says the exception is REAL. A row that claims
 *    `scrollsUnderChrome: false` is claiming that nothing moves under the glass
 *    while the pane is scrolled, which as a number is a backdrop spread stuck at
 *    zero across the whole sweep. If a future change lets that surface through,
 *    the spread rises and this case goes red naming the row: the table would
 *    have started describing an app that no longer exists.
 *
 * The same 0.0005 floor separates the two verdicts, and it is deliberate that it
 * is one constant: the chat spec fails BELOW it (nothing passing under means it
 * is measuring the flat cell background, which is how a clipped transcript
 * hid for weeks) and these cases fail ABOVE it. One line, read from both sides.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { AA_TESTO } from "./helpers/contrast";
import { BACKDROP_SPREAD_FLOOR, setTheme, sweepChromeLabels } from "./helpers/chrome-contrast";
import { CHROME_BAR_SURFACES } from "../../client/src/lib/chromeBarSurfaces";

hermetic(test);

const bar = (page: Page) => page.locator(".pane-chrome-bar").first();
/** The cell that hosts the pane: the surface whose backdrop is under the glass. */
const cell = (page: Page) => page.locator('[data-pane-shell][data-pane-visible="1"]').first();

/**
 * How much subtree counts as "the pane is really there".
 *
 * It is a guard against the one way this spec could lie without failing: a pane
 * that mounted its shell and rendered nothing inside still has a cell, still has
 * a tab label, and still returns a perfectly quotable contrast number - about an
 * empty box. Measured while writing this: the `__files__` panel with no project
 * seeded renders ZERO descendants, and it produced readings identical to the
 * dashboard's to four decimals. The threshold is far below the real counts
 * (terminal 81, browser 49, dashboard 136) and far above an empty shell.
 */
const MOUNTED_NODES = 20;

/**
 * Open the app on the seeded probe pane, and make sure it is really THAT pane
 * that is on screen.
 *
 * The first navigation of the file can land on the welcome screen with the
 * seeded store ignored: the client writes its own snapshot back
 * (`navigator.sendBeacon` on `pagehide`, see the note in `helpers/api-fixtures.ts`)
 * and a cold first load can hydrate from the state the previous file left
 * behind. Specs that open a topic by name never notice, because the click that
 * opens it also creates the pane. Here there is nothing to click: the pane IS
 * the fixture. Measured on this file: attempt one red at 30s with "Welcome to
 * Topics" in the snapshot, retry green in 4s, twice in a row.
 *
 * So the seed is re-applied and the page reloaded until the cell appears,
 * instead of waiting longer on a page that will never show it.
 */
async function openProbePane(page: Page, request: APIRequestContext, probe: string): Promise<void> {
  await resetPaneStore(request, [probe]);
  await goToApp(page);
  await expect
    .poll(
      async () => {
        // The cell can also appear and then go away one render later, when the
        // client finishes hydrating over the seed, so the condition is not
        // "there is a cell" but "there is a MOUNTED pane": the shell plus a
        // subtree. It is the same guard the measurement needs anyway, folded
        // into the loop that can still do something about it.
        const nodes = await cell(page)
          .evaluate((el) => el.querySelectorAll("*").length)
          .catch(() => 0);
        if (nodes > MOUNTED_NODES) return nodes;
        await resetPaneStore(request, [probe]);
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        return 0;
      },
      {
        timeout: 40_000,
        intervals: [500, 1000, 2000],
        message: `la pane ${probe} non ha montato il contenuto: misurare qui darebbe un numero su una scatola vuota`,
      },
    )
    .toBeGreaterThan(MOUNTED_NODES);
}

/**
 * The rows this spec can actually open. `runtime` means the surface needs a
 * fixture built at test time (the chat, with its seeded transcript) and is
 * measured by its own spec; `null` means the row declares itself unmeasurable
 * and has to say why, which the unit test on the table enforces.
 */
const MEASURABLE = CHROME_BAR_SURFACES.filter((s) => s.probe && s.probe !== "runtime");

test.describe("L'inventario delle superfici sotto la barra di chrome", () => {
  for (const surface of MEASURABLE) {
    for (const theme of ["dark", "light"] as const) {
      test(`INVENTARIO-${surface.id}-${theme}: la riga regge AA e la sua eccezione e' vera`, async ({ page, request }) => {
        test.info().annotations.push({ type: "spec", description: "CHROME-01" });
        // Three captures per label per offset, plus a settle-poll on the strip:
        // the sweep alone is seconds, and the FIRST case of the file also pays
        // the cold load of the app (measured: 22s against 4s for the ones that
        // follow, red on attempt one and green on the retry). The budget is
        // raised rather than the wait shortened, because a shorter wait would
        // trade a slow case for a flaky one.
        test.setTimeout(60_000);

        const probe = surface.probe!;
        await openProbePane(page, request, probe);
        await expect(bar(page)).toBeVisible({ timeout: 15_000 });
        await setTheme(page, theme === "dark");

        // The premise, same as the chat spec: a bar that paints its own
        // background makes every number below a measurement of that band.
        await expect(bar(page)).toHaveCSS("position", "absolute");

        const barBox = (await bar(page).boundingBox())!;
        const barBottom = barBox.y + barBox.height;

        // THE MECHANISM OF THE EXCEPTION, read off the live DOM. The inset on
        // the cell is what keeps this surface out from under the glass, and the
        // highest painted rect inside the pane is the proof that nothing found
        // a way around it (a negative margin, an absolute child, a sticky
        // header that escaped upward).
        const geometry = await cell(page).evaluate((el) => {
          const style = getComputedStyle(el);
          let highest = Number.POSITIVE_INFINITY;
          let culprit = "";
          for (const node of Array.from(el.querySelectorAll("*"))) {
            const r = node.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            if (r.top < highest) {
              highest = r.top;
              const testId = node.getAttribute("data-testid");
              culprit = `${node.tagName.toLowerCase()}${testId ? `[${testId}]` : ""}`;
            }
          }
          return { paddingTop: parseFloat(style.paddingTop), highest, culprit };
        });

        expect(
          geometry.paddingTop,
          `la cella della superficie «${surface.id}» ha perso il rientro di \`--chrome-bar-h\`: senza quello il contenuto nasce dietro il vetro`,
        ).toBeGreaterThanOrEqual(barBox.height - 1);

        if (Number.isFinite(geometry.highest)) {
          expect(
            geometry.highest,
            `qualcosa dentro la pane «${surface.id}» (${geometry.culprit}) dipinge sopra il fondo della barra: la riga la dichiara eccezione, il DOM dice il contrario`,
          ).toBeGreaterThanOrEqual(barBottom - 1);
        }

        const sweep = await sweepChromeLabels(page, {
          bar: bar(page),
          body: cell(page),
          dark: theme === "dark",
        });

        // Printed whatever the verdict: the table records these numbers, and
        // whoever updates it should not have to re-run the suite to read them.
        console.log(
          `\n[MISURA ${surface.id} ${theme}] ${sweep.samples.length} letture, fondale L=${sweep.worst.backdrop.toFixed(4)}, spread ${sweep.spread.toFixed(4)}, peggiori: ${sweep.card}\n`,
        );
        test.info().annotations.push({
          type: "misura",
          description: `${surface.id} ${theme}: worst ${sweep.worst.ratio.toFixed(2)}:1, spread ${sweep.spread.toFixed(4)}`,
        });

        if (surface.scrollsUnderChrome) {
          expect(
            sweep.spread,
            `la riga «${surface.id}» dice che il contenuto passa sotto il vetro, ma il fondale non cambia mai durante la passata`,
          ).toBeGreaterThan(BACKDROP_SPREAD_FLOOR);
        } else {
          expect(
            sweep.spread,
            `la riga «${surface.id}» e' dichiarata eccezione (\`scrollsUnderChrome: false\`) ma qualcosa scorre sotto il vetro: o la riga e' vecchia, o la pane ha smesso di rispettare il rientro della cella`,
          ).toBeLessThanOrEqual(BACKDROP_SPREAD_FLOOR);
        }

        expect(
          sweep.worst.ratio,
          `le etichette sopra la superficie «${surface.id}» devono reggere WCAG AA (${AA_TESTO}:1)`,
        ).toBeGreaterThanOrEqual(AA_TESTO);
      });
    }
  }
});
