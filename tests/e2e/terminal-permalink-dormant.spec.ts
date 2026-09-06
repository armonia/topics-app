/**
 * @covers TERM-09
 *
 * A PERMALINK TO A PARKED TERMINAL IS NOT A BLANK PANE THAT HAMMERS THE SERVER.
 *
 * Reported on 2026-09-05, live on the desktop: `/tab/terminal/<id>` on a shell
 * the server had parked (`status = 'dormant'`, PTY gone after a restart) drew
 * NOTHING - no prompt, no overlay - while the server log filled with
 * `POST /api/terminal/sessions/<id>/resize 404` every 500 ms, for as long as
 * the tab stayed open.
 *
 * What was looping. The server accepts the WebSocket upgrade for ANY id and
 * only in `open` finds the session is not live, closing with 1008. So the pane
 * saw a SUCCESSFUL open first: it reset its retry counter, posted a resize
 * (404), got the close, waited 500 ms and started over. The grace counter that
 * declares a session expired never got past 1, the expired overlay never
 * showed, and the auto-revive (gated on that overlay) never ran.
 *
 * Two sides, because a saved terminal tab is opened on both:
 *   - ACTIVE (the permalink): the pane comes back LIVE - the existing revive
 *     door brings the shell back in the same cwd - and the 404s stop;
 *   - IN THE BACKGROUND (a saved tab behind another): nothing is revived until
 *     the tab is clicked, per TERM-05 (a restart costs zero processes; what is
 *     looked at comes back).
 *
 * The session is parked through `POST /api/test/terminal/:id/park`, which
 * leaves the STATE a restart leaves (`reconcileSessions` -> `park`) without
 * restarting: the bridge outlives the server, so a restart here would REATTACH
 * the shell instead of parking it.
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  createTerminalSession,
  deleteAllTerminalSessions,
  getTerminalSessionBuffer,
  listTerminalSessions,
  resetPaneStore,
} from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

// A real PTY, a real bridge, then xterm: the terminal family runs on 75 s, see
// terminal-reconnect.spec.ts for the measurement behind the number.
test.describe.configure({ timeout: 75_000 });

/** A pinned utility pane: the tab that is there BEFORE the permalink arrives. */
const BYSTANDER = "__dashboard__";

/** How long a shell may take to come back on a loaded machine (terminal-reconnect). */
const SLOW_BOX_MS = 45_000;

type Dormant = { id: string };

async function dormantIds(request: import("@playwright/test").APIRequestContext): Promise<string[]> {
  const res = await request.get(`${E2E_BASE}/api/terminal/sessions/dormant`);
  if (!res.ok()) return [];
  return ((await res.json()) as Dormant[]).map((d) => d.id);
}

async function liveIds(request: import("@playwright/test").APIRequestContext): Promise<string[]> {
  return (await listTerminalSessions(request)).map((s) => s.id);
}

/**
 * Counts the two things the loop produced: resize POSTs answered 404 and
 * terminal sockets opened. Installed before `goto`, so the first attach counts.
 */
function watchTheLoop(page: Page, sessionId: string): { resize404: () => number; sockets: () => number } {
  let resize404 = 0;
  let sockets = 0;
  page.on("response", (res) => {
    if (res.url().includes(`/api/terminal/sessions/${sessionId}/resize`) && res.status() === 404) resize404++;
  });
  page.on("websocket", (ws) => {
    if (ws.url().includes(`/ws/terminal/${sessionId}`)) sockets++;
  });
  return { resize404: () => resize404, sockets: () => sockets };
}

test.describe("A permalink to a PARKED terminal", () => {
  let sessionId = "";

  test.beforeEach(async ({ request }) => {
    await deleteAllTerminalSessions(request);
    const created = await createTerminalSession(request, { cwd: "/tmp", type: "shell", name: "E2E-Dormant-Link" });
    sessionId = created.id;
    // Park only a shell that really came up: a PTY killed mid-startup is the
    // reload spec's known slow exit, and it is not what is measured here.
    await expect
      .poll(async () => (await getTerminalSessionBuffer(request, sessionId)).trim().length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const parked = await request.post(`${E2E_BASE}/api/test/terminal/${sessionId}/park`);
    expect(parked.ok(), "the park seam must be armed (TOPICS_E2E=1) and find the live session").toBe(true);
    // The precondition of the whole file, stated: parked, not gone.
    expect(await dormantIds(request)).toContain(sessionId);
    expect(await liveIds(request)).not.toContain(sessionId);
  });

  test("opened ACTIVE it comes back live, and the resize storm does not start", async ({ page, request, terminalPage }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-09" });
    test.slow();
    await resetPaneStore(request, [BYSTANDER]);
    const loop = watchTheLoop(page, sessionId);

    await page.goto(`/tab/terminal/${sessionId}`);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });

    const tab = page.getByTestId(`pane-tab-terminal:${sessionId}`);
    await expect(tab, "the permalink must open the terminal tab").toBeVisible({ timeout: 15_000 });
    await expect(tab).toHaveAttribute("data-active", "true", { timeout: 15_000 });

    // THE POINT. The pane is looked at, the session is parked: the revive door
    // brings it back under the same id (a fresh shell in the same cwd), and the
    // pane reattaches to it. Measured on the server, not on the pixels: the id
    // is back in the live roster and out of the dormant list.
    await expect
      .poll(() => liveIds(request), { timeout: SLOW_BOX_MS, message: "the parked session was never revived: the pane never declared it expired" })
      .toContain(sessionId);
    await expect.poll(() => dormantIds(request), { timeout: 10_000 }).not.toContain(sessionId);
    // ...and it is a terminal one can use, not a rectangle.
    await terminalPage.waitForReady(SLOW_BOX_MS);
    const marker = `revived-${Date.now()}`;
    await terminalPage.focus();
    await terminalPage.typeCommand(`echo ${marker}`);
    await terminalPage.waitForOutput(marker, SLOW_BOX_MS);

    // The loop, measured. One attach gets the verdict (its resize may 404
    // once), one attach is the live one after the revive: anything beyond a
    // handful is the 500 ms loop back again. With the defect this reads ~2/s
    // for the whole wait above.
    expect(loop.resize404(), "resize POSTs answered 404: the reconnect loop is hammering a parked session").toBeLessThanOrEqual(3);
    expect(loop.sockets(), "terminal sockets opened: the pane is reconnecting in a loop").toBeLessThanOrEqual(3);
  });

  test("saved in the BACKGROUND it stays parked, and comes back when clicked", async ({ page, request, terminalPage }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-09" });
    test.slow();
    // The bystander first: on a fresh profile focus goes to the first pane, so
    // the terminal tab is restored BEHIND it - the saved-tab shape.
    await resetPaneStore(request, [BYSTANDER, `terminal:${sessionId}`]);
    const loop = watchTheLoop(page, sessionId);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });

    const tab = page.getByTestId(`pane-tab-terminal:${sessionId}`);
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`pane-tab-${BYSTANDER}`)).toHaveAttribute("data-active", "true", { timeout: 15_000 });
    await expect(tab).toHaveAttribute("data-active", "false");

    // Nobody is looking at it: it stays parked. TERM-05 - reviving every saved
    // tab at boot is exactly what parking exists to avoid.
    expect(await dormantIds(request)).toContain(sessionId);
    expect(await liveIds(request)).not.toContain(sessionId);

    // Looked at: it comes back.
    await tab.click();
    await expect(tab).toHaveAttribute("data-active", "true");
    await expect
      .poll(() => liveIds(request), { timeout: SLOW_BOX_MS, message: "clicking the parked tab did not revive it" })
      .toContain(sessionId);
    await terminalPage.waitForReady(SLOW_BOX_MS);

    expect(loop.resize404(), "resize POSTs answered 404 while the tab sat in the background").toBeLessThanOrEqual(3);
  });
});
