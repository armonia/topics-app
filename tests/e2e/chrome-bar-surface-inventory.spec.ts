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
import {
  BACKDROP_SPREAD_FLOOR,
  TAB_LABELS,
  setTheme,
  sweepChromeLabels,
} from "./helpers/chrome-contrast";
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
 * A BLANK BROWSER PANE ASKS ITS TAB FOR THE ADDRESS EDITOR, and the dropdown it
 * opens hangs over the row the sweep is about to read.
 *
 * `RemoteBrowserPanel` auto-focuses the address of a pane that has nowhere to
 * go, 50 ms after the pane becomes visible (`RemoteBrowserPanel.tsx`, the
 * `setTimeout(() => focusUrlBar(), 50)` guarded by `empty`), and the tab answers
 * by opening its address dropdown (`BrowserTabAddress`).
 *
 * Since 2026-09-06 that panel no longer REPLACES the label - the tab writes
 * "New tab" and keeps writing it - so the failure this dismissal was written
 * against (a label with no text is skipped by the sweep, and on the browser
 * rows of run ecbc4cd44 the sweep collected nothing at all and failed with "no
 * reading collected") cannot come back the same way. The dismissal stays
 * anyway, and for the reason that outlives the shape: the sweep reads the bar
 * AT REST, and a frosted panel hanging off a tab is not rest. The
 * post-condition is unchanged and is the one the sweep actually needs: every
 * label has ink. The wait is bounded and its absence is not an error, because a
 * pane that never asks for the editor is already in the state we want.
 */
async function labelsAtRest(page: Page, probe: string): Promise<void> {
  const editor = page.getByTestId("browser-tab-address-input");
  const dropdown = page.getByTestId("browser-address-dropdown");
  if (probe.startsWith("browser:")) {
    await dropdown.waitFor({ state: "attached", timeout: 5_000 }).catch(() => {});
  }
  if ((await dropdown.count()) > 0) {
    await editor.press("Escape");
    await expect(dropdown).toHaveCount(0);
  }

  const labels = page.locator(TAB_LABELS);
  await expect
    .poll(
      async () => {
        const total = await labels.count();
        let blank = 0;
        for (let i = 0; i < total; i++) {
          if (!((await labels.nth(i).textContent()) ?? "").trim()) blank++;
        }
        return blank;
      },
      {
        timeout: 10_000,
        message:
          "un'etichetta della barra e' senza testo: la sweep la salta, e se sono tutte cosi' non raccoglie " +
          "nessuna lettura (di solito e' l'editor dell'indirizzo rimasto aperto sopra la label)",
      },
    )
    .toBe(0);
}

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
 *
 * TWO ABSENCES, AND ONLY ONE OF THEM IS A REASON TO RELOAD. The SHELL of the
 * probe missing after the boot is the case above: the seed was lost. The
 * CONTENT missing inside a shell that is there is a pane still mounting - a
 * lazy body behind its suspense boundary, xterm fitting its grid - and the
 * first version of this loop reloaded on that too. That reload was the second
 * red: it unloaded a page whose store had not hydrated yet, the `pagehide`
 * flush wrote that empty store over the seed just applied, and every retry
 * booted on the welcome screen (measured on the terminal row: the shell was
 * there at 8 nodes and at 81 half a second later, and the case that ran
 * second in the file - warm caches, so the poll looked earlier - never got
 * past the 8). Now a shell that is there is waited for, and a reseed is only
 * written once the old page has LEFT, so its flush is already on the server
 * when the seed lands instead of a beat behind it.
 *
 * AND THE RETRY LOOP HAD NO BUDGET TO RETRY WITH, which is what made the red of
 * run 34035981200 permanent instead of merely slow. `Received: 0` in that
 * failure is not a subtree that measured zero: it is THIS loop's own reseed
 * branch returning 0, i.e. "no shell, I have re-seeded, look again". Reading it
 * as an empty pane sends you hunting a rendering bug that is not there.
 *
 * The arithmetic is the whole story. `evaluate` on an absent shell used to wait
 * for the ACTION TIMEOUT (15 s, playwright.config.ts) before the branch could
 * even run, and the branch then pays `about:blank` + reseed + a full cold boot.
 * One attempt is therefore ~20 s of a 40 s budget: two tries, and on a loaded
 * shard the first cold load eats most of the first. The loop was not converging
 * on the race, it was timing out inside its own first attempt.
 *
 * So the probe waits FIVE seconds, not fifteen. The budget is unchanged and the
 * assertion is unchanged; what changes is that the same 40 s now buys about
 * seven attempts at the race instead of two, which is the difference between a
 * retry loop and a decorative one.
 */
async function openProbePane(page: Page, request: APIRequestContext, probe: string): Promise<void> {
  // The probe's OWN shell, visible. Any visible shell would be satisfied by
  // the wrong pane, and then the measurement would be about that one.
  const shell = page.locator(`[data-pane-shell="${probe}"][data-pane-visible="1"]`);
  await resetPaneStore(request, [probe]);
  await goToApp(page);
  await expect
    .poll(
      async () => {
        // `evaluate` waits for the shell to attach: that wait is the boot. A
        // shell that is there answers with its subtree, small or not, and the
        // poll comes back for the rest.
        const nodes = await shell
          .evaluate((el) => el.querySelectorAll("*").length, undefined, { timeout: 5_000 })
          .catch(() => -1);
        if (nodes >= 0) return nodes;
        // No shell: the seed was lost. The old page goes away FIRST, so that
        // whatever it flushes on the way out lands before the seed and not on
        // top of it.
        await page.goto("about:blank");
        await resetPaneStore(request, [probe]);
        await goToApp(page);
        return 0;
      },
      {
        timeout: 40_000,
        intervals: [500, 1000, 2000],
        message: `la pane ${probe} non ha montato il contenuto: misurare qui darebbe un numero su una scatola vuota`,
      },
    )
    .toBeGreaterThan(MOUNTED_NODES);

  // The sweep reads labels AT REST, which is what sits over the glass while a
  // pane is used: `labelsAtRest` puts the tab back in that state and refuses to
  // go on while a label has no ink.
  await labelsAtRest(page, probe);
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
