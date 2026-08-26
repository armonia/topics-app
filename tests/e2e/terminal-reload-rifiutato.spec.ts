/**
 * @covers RESTART-SAY-01
 *
 * A REFUSED RESTART IS NOT A WAIT.
 *
 * Reported: "session restart does not work, or it hangs". It was not a hang: it
 * was a silence that looks like one. The «Ricarica» gesture on a terminal tab   allow-italian: quoted UI string
 * fired the POST and threw its result away — no check on `ok`, and a
 * `.catch(() => {})` that swallowed everything. But the server refuses in three
 * ways (409 if a reload is already running, 404 if the session is gone, 500 if
 * the spawn fails: `server/routes/terminal.ts`), and in all three the UI showed
 * «Riavvio…» for FIFTEEN SECONDS and then took it away without a word.         allow-italian: quoted UI string
 *
 * The 15s cap is the safety net for a reconnection that never arrives, not the
 * way to learn it went wrong. What is proved here is the difference: on a
 * refusal the pane becomes usable AGAIN AT ONCE, and the reason is readable.
 *
 * The refusal is INJECTED (`page.route`) instead of provoked: a real 409 would
 * take two reloads racing, which is a race and not a proof.
 *
 * The shell is really OPENED, with the same procedure as `terminal.spec.ts`: the
 * first draft took for granted a terminal tab already on screen, and a clean app
 * has none — thirty seconds of waiting and a timeout that talked about the
 * setup, not about the gesture.
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  seedTerminalTopic,
  cleanupTerminalTopic,
  resetTerminalWorkspace,
  navigateAndOpenTerminal,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";

// The hermetic boundary is declared here too, as in terminal.spec.ts: using the terminal
// fixture does not bring it along. The guard tests/unit/e2e-hermetic-coverage.test.ts exists
// because forgetting it breaks NOTHING in this file — the bill arrives forty tests further
// on, in a spec that finds a workspace nobody ever promised it.
hermetic(test);

test.describe.serial("Ricarica di una tab terminale · il rifiuto si vede", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "reload-rifiutato"));
  });
  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });
  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("un rifiuto del server toglie SUBITO «Riavvio…» e dice il motivo", async ({ page, terminalPage }) => {
    test.info().annotations.push({ type: "spec", description: "RESTART-SAY-01" });
    const REASON = "Reload already in progress for this session";

    await page.route("**/api/terminal/sessions/*/reload", (route) =>
      route.fulfill({ status: 409, contentType: "text/plain", body: REASON }),
    );

    await navigateAndOpenTerminal(page, terminalPage, topicName);

    // The gesture lives in the context menu of the terminal tab just opened.
    const tab = page.locator('[data-pane-id^="terminal:"]').first();
    await expect(tab, "serve una tab terminale su cui provare il gesto").toBeVisible({ timeout: 15_000 });
    await tab.click({ button: "right" });

    // INSIDE the context menu: the sidebar status bar has a «Ricarica» of its   allow-italian: quoted UI string
    // own (which reloads the app), and a locator that catches both fails in
    // strict mode instead of trying the gesture.
    const reloadItem = page.getByRole("menu").getByRole("button", { name: /Ricarica/ });
    await expect(reloadItem).toBeVisible({ timeout: 10_000 });
    await reloadItem.click();

    // THE POINT. The cap is 3 seconds, i.e. WELL under the 15 of the safety
    // net: were this to pass by waiting for that one, it would prove nothing.
    await expect(
      page.getByTestId("terminal-reloading-overlay"),
      "«Riavvio…» e' rimasto su un riavvio che il server ha rifiutato",
    ).toHaveCount(0, { timeout: 3_000 });

    await expect(
      page.getByText(REASON),
      "il rifiuto e' stato ingoiato: chi guarda non sa perche' non e' successo niente",
    ).toBeVisible({ timeout: 5_000 });
  });
});
