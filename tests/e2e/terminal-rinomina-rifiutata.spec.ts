/**
 * @covers TERM-SAY-01
 *
 * IL NOME CHE TORNA QUELLO DI PRIMA.                allow-italian: quoted UI string
 *
 * Renaming a terminal tab fires a PATCH and closes the editor immediately: the
 * tab relabels off the roster the server re-broadcasts, never off a local
 * write. That design is fine and it is also why a refusal was invisible — the
 * call was `void fetch(...).catch(() => {})`, so a 404 «Terminal session not
 * found» or a dead network simply left the old label there, and the person who
 * typed a new name got no answer at all to the question "did it work?".
 *
 * The 404 is INJECTED because provoking a real one means racing a session
 * deletion against the PATCH, which is a race and not a proof.
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

hermetic(test);

test.describe.serial("Rinomina di una tab terminale · il rifiuto si vede", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "rinomina-rifiutata"));
  });
  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });
  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("un 404 sulla PATCH diventa un avviso, non un nome che torna indietro", async ({ page, terminalPage }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-SAY-01" });

    await navigateAndOpenTerminal(page, terminalPage, topicName);

    const tab = page.locator('[data-testid^="pane-tab-terminal:"]').first();
    await expect(tab, "serve una tab terminale su cui provare il gesto").toBeVisible({ timeout: 15_000 });

    // Routed AFTER the terminal exists: the same path also serves the DELETE of
    // the cleanup, so the interception is scoped to the PATCH alone.
    await page.route("**/api/terminal/sessions/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Terminal session not found" }),
      });
    });

    await tab.click({ button: "right" });
    const renameItem = page.getByTitle("Rinomina questa scheda");
    await expect(renameItem).toBeVisible({ timeout: 3_000 });
    await renameItem.click();

    const editor = page.locator('input[placeholder="Nuovo nome"]');
    await expect(editor).toBeVisible({ timeout: 2_000 });
    await editor.fill(`rifiutato-${Date.now()}`);
    await editor.press("Enter");

    // THE BAR: after the Enter, a readable refusal. The editor closes either
    // way, so without this the gesture ends in nothing at all.
    await expect(
      page.getByText(/sessione di terminale non esiste|terminal session no longer exists/i).first(),
      "la rinomina rifiutata e' stata ingoiata: il nome torna il vecchio senza una parola",
    ).toBeVisible({ timeout: 5_000 });
  });
});
