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
});
