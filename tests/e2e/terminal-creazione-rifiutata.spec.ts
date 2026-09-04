/**
 * @covers TERM-SAY-01
 *
 * «+ → Shell» E NON SUCCEDE NIENTE.                allow-italian: quoted UI string
 *
 * The purest of the four silences: the three doors that open a terminal all
 * threw the POST result away (`if (!res.ok) return;` plus an empty `catch`),
 * and the caller upstream did not even look at the null they returned. So a
 * refusal — no PTY bridge in this build, a bridge that could not spawn, a cwd
 * outside the known projects — arrived as absolutely nothing on screen. On
 * Windows, where the bridge is a stub, that nothing is permanent and by
 * construction: you would click, and click again, and never learn why.
 *
 * The refusal is INJECTED (`page.route`) and not provoked: the 503 requires a
 * server started with the bridge disabled, which is a different binary, not a
 * test. What is proved here is the reaction to the answer, and that is exactly
 * where the defect was.
 *
 * The assertion is on the SENTENCE, not on its wording: a translated message
 * that names the terminal. Asserting the exact string would pin the catalogue
 * instead of the behaviour.
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  seedTerminalTopic,
  cleanupTerminalTopic,
  resetTerminalWorkspace,
  gotoTerminalProject,
  clickAddShell,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";

// Declared here as in terminal.spec.ts: using the terminal fixture does not
// bring the hermetic boundary along, and the guard for forgetting it is
// tests/unit/e2e-hermetic-coverage.test.ts.
hermetic(test);

test.describe.serial("Aprire un terminale rifiutato · il rifiuto si vede", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "creazione-rifiutata"));
  });
  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });
  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("un 503 «niente terminali qui» non e' piu' un click a vuoto", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-SAY-01" });

    await page.route("**/api/terminal/sessions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "terminals not available in standalone mode",
          code: "pty-bridge-unavailable",
        }),
      });
    });

    await gotoTerminalProject(page, topicName);
    await clickAddShell(page);

    // THE BAR: something readable, and it talks about the terminal. Before the
    // fix this locator waited its whole timeout on an empty screen.
    await expect(
      page.getByText(/terminal/i).first(),
      "il rifiuto e' stato ingoiato: si clicca «+ → Shell» e non succede niente",
    ).toBeVisible({ timeout: 5_000 });

    // And no phantom pane was opened against a session that never existed.
    await expect(page.locator('[data-pane-id^="terminal:"]')).toHaveCount(0);
  });
});
