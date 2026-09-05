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
import { resetPaneStore } from "./helpers/api-fixtures";
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
    // The server's own words, in the envelope `errorResponse` always builds.
    // They must NOT reach the screen: they are English, internal, and wrapped
    // in braces the person reading has no use for.
    const SERVER_SAID = "Reload already in progress for this session";

    await page.route("**/api/terminal/sessions/*/reload", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: SERVER_SAID }),
      }),
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

    // The reason is READABLE, i.e. the translated sentence for a 409 — and not
    // the raw `{"error":"..."}` the first cure used to paste into the toast.
    await expect(
      page.getByText(/gia' occupata|già occupata|already busy/i).first(),
      "il rifiuto e' stato ingoiato: chi guarda non sa perche' non e' successo niente",
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByText(SERVER_SAID),
      "il corpo grezzo della risposta e' finito a schermo, graffe comprese",
    ).toHaveCount(0);
  });

  test("resume command reports an unavailable clipboard", async ({ page, request }) => {
    const sessionId = `clipboard-resume-${Date.now()}`;
    const claudeSessionId = "01234567-89ab-4cde-8f01-23456789abcd";
    const session = {
      id: sessionId,
      name: "E2E Clipboard Resume",
      createdAt: new Date().toISOString(),
      cwd: "/clipboard-e2e",
      command: "claude",
      clients: 0,
      type: "claude-code",
      claudeSessionId,
    };
    let inject: ((data: string) => void) | null = null;
    let rosterRequested = false;

    await page.route("**/api/terminal/sessions", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      rosterRequested = true;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify([session]) });
    });
    await page.route("**/api/terminal/sessions/dormant", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: sessionId }]) });
    });
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        if (String(message).includes('"type":"terminal:sessions"')) return;
        ws.send(message);
      });
      inject = (data) => ws.send(data);
    });
    await page.routeWebSocket(/\/ws\/terminal\//, (ws) => {
      ws.close({ code: 1008, reason: "e2e-session-not-found" });
    });
    await resetPaneStore(request, [`terminal:${sessionId}`]);

    await page.goto("/");
    await expect.poll(() => rosterRequested).toBe(true);
    await expect.poll(() => inject !== null).toBe(true);
    const tab = page.locator(`[data-testid="pane-tab-terminal:${sessionId}"]`);
    await expect(tab).toBeVisible();
    await expect(tab).toContainText(session.name);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    inject!(JSON.stringify({ type: "terminal:sessions", sessions: [], reconciled: true }));
    await expect(page.getByTestId("terminal-stale-overlay")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("terminal-stale-info")).toContainText(`resume ${claudeSessionId.slice(0, 8)}`);

    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await page.getByRole("button", { name: `resume ${claudeSessionId.slice(0, 8)}` }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "Non è stato possibile copiare" })).toBeVisible();
  });
});
