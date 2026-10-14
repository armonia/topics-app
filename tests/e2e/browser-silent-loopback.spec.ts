import { test, expect } from "@playwright/test";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { goToApp } from "./helpers";
import { seedPaneStore, closeAllBrowserContexts } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A TAB WHOSE PAGE NEVER ANSWERS SAYS SO, AND NEVER SPINS ON "STARTING".
 *
 * Reported on 13/10 from the iPad: a tab closed on the Mac, on a dev server of
 * the Mac (127.0.0.1:4444) that took connections and never answered, sat on
 * "starting the shared session" for as long as anybody looked. Reproduced here
 * before the fix, second by second: a pane that reloaded while the server's
 * goto was waiting stayed on that spinner for good, because arming the
 * recorder on a page stuck in a navigation waits with it (60 s measured, until
 * the context was closed), and the goto's failure went only to the socket that
 * had asked, which was gone. The reload also started the 30 s over.
 *
 * The port here is the same shape: a TCP server that accepts and keeps quiet.
 *
 * @covers BROWSER-LOAD-01
 */
let silent: Server;
const held: Socket[] = [];
let port = 0;

test.beforeAll(async () => {
  silent = createServer((socket) => {
    held.push(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  port = (silent.address() as AddressInfo).port;
});

/** The server launches its headless browser on first use: paid here, not in the test's budget. */
test.beforeAll(async ({ request }) => {
  const launched = await request.post(`/api/browsers/warm-${Date.now()}/agent/open`, {
    data: { url: "about:blank" },
    timeout: 180_000,
  });
  expect(launched.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
  for (const socket of held) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

test("a restored tab on a silent local port names the wait, survives a reload, and says why it failed", async ({ page, request }) => {
  test.setTimeout(150_000);
  const ctx = `silent-${Date.now()}`;
  const paneId = `browser:${ctx}`;
  const url = `http://127.0.0.1:${port}/dev/page?x=1`;
  await seedPaneStore(request, () => ({
    panes: { [paneId]: { id: paneId, type: "browser", url, openedAt: Date.now() } },
    groups: { "group:default": { id: "group:default", paneIds: [paneId], splitRatio: 1, splitAxis: "horizontal" } },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));
  await goToApp(page);
  const pane = page.locator("[data-browser-pane]").first();
  await expect(pane).toBeVisible({ timeout: 30_000 });

  // The wait names where it is going, not "starting the shared session".
  const opening = page.getByTestId("browser-page-opening");
  await expect(opening).toContainText(`127.0.0.1:${port}/dev/page`, { timeout: 15_000 });
  const firstSeen = Date.now();

  // And counts the seconds once they matter. The count is read back to time the reload.
  const waited = async (): Promise<number> => {
    const text = (await opening.textContent().catch(() => "")) ?? "";
    const m = /(\d+)\s*s\b/.exec(text);
    return m ? Number(m[1]) : 0;
  };
  await expect.poll(waited, { timeout: 20_000, message: "the wait never said how long" }).toBeGreaterThanOrEqual(10);

  // A reload in the middle: the reloaded pane resumes the SAME wait, counted
  // from the first request, instead of a spinner or a fresh 30 s.
  await page.reload();
  await expect(pane).toBeVisible({ timeout: 30_000 });
  // Five seconds, not ten: a pane that started its own clock at the reload
  // would read under ten for ten seconds.
  await expect.poll(waited, { timeout: 5_000, message: "the reloaded pane did not resume the wait" }).toBeGreaterThanOrEqual(10);

  // The failure, in words, with Retry, when the FIRST request runs out of time
  // (30 s): a restarted goto would land 30 s after the reload, past this bound.
  const failed = page.getByTestId("browser-page-failed");
  await expect(failed).toContainText(`127.0.0.1:${port}`, { timeout: 30_000 });
  await expect(failed).toContainText("accetta la connessione ma non risponde");
  expect(Date.now() - firstSeen, "the failure came a full timeout after the reload").toBeLessThan(38_000);

  // And no spinner is left underneath: the stuck load was stopped, the mirror
  // got its page (blank) and stopped negotiating.
  await expect(page.getByTestId("browser-dom-negotiating")).toHaveCount(0, { timeout: 15_000 });

  // Retry tries again, and says so.
  await failed.getByRole("button").click();
  await expect(opening).toContainText(`127.0.0.1:${port}/dev/page`, { timeout: 10_000 });
});
