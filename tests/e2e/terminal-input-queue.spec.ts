import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
  openShellViaSidebar,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * TERM-11: what you type before the attach is held, not lost.
 *
 * The bug this measures is invisible by design: the pane remounts, xterm draws,
 * the bridge replays the scrollback and the cursor moves, so the terminal looks
 * alive while the socket is still connecting. Every key pressed in that window
 * used to go nowhere and say nothing.
 *
 * The window is milliseconds on an idle machine, so it is WIDENED here on
 * purpose: the WebSocket proxy delays the reconnection by two seconds, which is
 * inside the range a real reconnect backoff reaches (up to 3 s per retry, and
 * a server restart keeps that up for ~11 s - see
 * `scripts/terminal-attach-latency.ts`). Without the queue this test is red:
 * the command typed during the gap never reaches the shell.
 *
 * Same timeout reasoning as `terminal-reconnect.spec.ts`: a real pty, a real
 * bridge and a real xterm paint cost tens of seconds on a loaded machine.
 */
test.describe.configure({ timeout: 75_000 });

const SLOW_BOX_MS = 45_000;
/** Wide enough that the keystrokes really land while nothing is attached. */
const RECONNECT_DELAY_MS = 2_000;
/** Past the 15 s age limit, so the held input really expires before the attach
 *  comes back, plus room for a loaded box to notice. */
const EXPIRY_HOLD_MS = 30_000;

test.describe("Terminal input queue", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "input-queue"));
  });

  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("TERM-11: keys typed while the socket is down arrive in order, once", async ({
    page,
    terminalPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-11" });
    test.slow();

    type WsRoute = { close: (options?: { code?: number; reason?: string }) => void | Promise<void> };
    const clientConnections: WsRoute[] = [];
    let connections = 0;
    await page.routeWebSocket(/\/ws\/terminal\//, async (ws) => {
      connections++;
      // The first attach is instant; every RECONNECT is held back, which is the
      // window this test is about.
      if (connections > 1) await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      const server = ws.connectToServer();
      clientConnections.push(ws);
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    await gotoTerminalProject(page, topicName);
    await openShellViaSidebar(page, terminalPage, SLOW_BOX_MS);

    const before = `pre-drop-${Date.now()}`;
    await terminalPage.focus();
    await terminalPage.typeCommand(`echo ${before}`);
    await terminalPage.waitForOutput(before, SLOW_BOX_MS);

    // Drop the link the way a network glitch does (1000 would mean the pty
    // exited and the client would not reconnect).
    const marker = `queued-${Date.now()}`;
    const openBefore = clientConnections.length;
    await clientConnections[clientConnections.length - 1]!.close({ code: 1001, reason: "e2e-drop" });

    // The pane says it is not attached, instead of letting the cursor imply it is.
    await expect(page.locator('[data-testid="terminal-input-held"]')).toBeVisible({ timeout: SLOW_BOX_MS });

    // Type into a terminal that has nowhere to send. Character by character,
    // the way a person does, so the ORDER is what is being tested.
    await terminalPage.focus();
    for (const ch of `echo ${marker}`) await page.keyboard.press(ch === " " ? "Space" : ch);
    await page.keyboard.press("Enter");

    // Nothing left yet: the socket is still held by the proxy.
    expect(clientConnections.length).toBe(openBefore);

    // The attach lands, the queue drains, the shell runs the command exactly once.
    await terminalPage.waitForOutput(marker, SLOW_BOX_MS);
    await expect(page.locator('[data-testid="terminal-input-held"]')).toBeHidden({ timeout: SLOW_BOX_MS });

    const text = await terminalPage.getTerminalText();
    const runs = text.split(marker).length - 1;
    // Twice: the echoed command line and its output. A replayed queue would
    // show it four times.
    expect(runs).toBeLessThanOrEqual(3);
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  /**
   * The BAND, not the queue. TERM-11b.
   *
   * `inputQueue.test.ts` proves the queue reports the right cause; nothing
   * proved the pane asks it. `inputLost` is written in exactly one place - the
   * `onStateChange` callback, through `nextInputBands` - so a pane that stops
   * calling it keeps a perfectly correct queue and goes back to losing input
   * in silence, which is the whole bug. This test is red for that, and red
   * again for the two things the warning used to get wrong: it said "too old
   * to send" whatever the cause, and it invited a retype while the queue was
   * still refusing every key.
   */
  test("TERM-11b: the loss band names its cause and only invites a retype once reattached", async ({
    page,
    terminalPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-11b" });
    test.slow();

    type WsRoute = { close: (options?: { code?: number; reason?: string }) => void | Promise<void> };
    const clientConnections: WsRoute[] = [];
    let connections = 0;
    await page.routeWebSocket(/\/ws\/terminal\//, async (ws) => {
      connections++;
      // The reconnect is held past the age limit: this is a server that takes
      // its time coming back, which is the measured case (~11,5 s of restart
      // plus the client's own backoff) pushed just over the edge.
      if (connections > 1) await new Promise((r) => setTimeout(r, EXPIRY_HOLD_MS));
      const server = ws.connectToServer();
      clientConnections.push(ws);
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    await gotoTerminalProject(page, topicName);
    await openShellViaSidebar(page, terminalPage, SLOW_BOX_MS);

    const before = `pre-expiry-${Date.now()}`;
    await terminalPage.focus();
    await terminalPage.typeCommand(`echo ${before}`);
    await terminalPage.waitForOutput(before, SLOW_BOX_MS);

    await clientConnections[clientConnections.length - 1]!.close({ code: 1001, reason: "e2e-drop" });

    const held = page.locator('[data-testid="terminal-input-held"]');
    const lost = page.locator('[data-testid="terminal-input-lost"]');
    await expect(held).toBeVisible({ timeout: SLOW_BOX_MS });

    await terminalPage.focus();
    await page.keyboard.press("l");
    await page.keyboard.press("s");

    // The age limit runs out while nobody touches the keyboard: the promise of
    // delivery has to come down on its own and be replaced by the loss.
    await expect(lost).toBeVisible({ timeout: SLOW_BOX_MS });
    await expect(held).toBeHidden();
    // The cause is named. "expired" and not the byte ceiling: 2 bytes were held.
    await expect(lost).toHaveAttribute("data-reason", "expired");
    // And no "retype it" yet: until the attach is back the queue is poisoned
    // and every key typed here goes in the bin.
    await expect(lost).toHaveAttribute("data-retype", "false");

    // The attach lands: NOW retyping works, so now the band may ask for it.
    await expect(lost).toHaveAttribute("data-retype", "true", { timeout: SLOW_BOX_MS });
    await expect(lost).toBeVisible();

    // And the retyped command really runs, which is what the invitation claims.
    const marker = `after-loss-${Date.now()}`;
    await terminalPage.focus();
    await terminalPage.typeCommand(`echo ${marker}`);
    await terminalPage.waitForOutput(marker, SLOW_BOX_MS);
    await expect(lost).toBeHidden();
  });
});
