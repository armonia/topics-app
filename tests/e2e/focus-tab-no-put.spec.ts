/**
 * FOCUS-TAB-NO-PUT — changing tab is a device-local gesture, and it must not
 * push the pane store to the server.
 *
 * WHAT WAS MEASURED, BEFORE. Eight clicks alternating between two tabs sent
 * eight PUT /api/ui-state/pane-store-v2 of 68,820 B each, roughly 470 ms after
 * every click, all carrying the same body hash. `focusedPaneId` is device-local
 * and `selectSyncableSnapshot` (state/pane/selectors.ts) strips it from the
 * outbound snapshot, so not one of those bodies differed from the one already
 * stored: every write bought a SQLite round trip, a cascade recompute on the
 * server and a HYDRATE broadcast to every other client, for a change no peer
 * could observe.
 *
 * WHERE THE FIX IS. `isDeviceLocalAction` in state/pane/store.ts: FOCUS_PANE
 * and SET_ACTIVE_SPACE still bump `lastSeq` (persistLocal subscribes to it and
 * writes the focused id to localStorage synchronously) but no longer bump
 * `localSeq`, which is the counter syncServer watches to arm a push.
 *
 * IT IS NOT the same-id guard in reducers/panes.ts. That one only spares a
 * state write when you re-focus what is ALREADY focused; here every click
 * lands on a DIFFERENT tab, so the guard never fires and never did.
 *
 * HOW THIS COUNTS. Every non-GET is intercepted and answered locally, the pane
 * store PUT included (200 with an empty body). Two reasons: the count is then a
 * count of what the CLIENT decided to send rather than of what survived the
 * server, and the measurement cannot dirty the shared test database.
 *
 * TIMING. The sync middleware debounces at roughly half a second, so the wait
 * after the last click is what makes the number real: reading immediately gives
 * zero even on the broken build. Verified against the pre-fix bundle, where
 * this spec reports 8.
 *
 * @covers IDLE-02
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const PANE_STORE_PUT = "/api/ui-state/pane-store-v2";

/** Longer than the sync middleware's debounce, so a late push still lands in the count. */
const DEBOUNCE_GRACE_MS = 2000;

/**
 * The pause between two clicks, and it has to CLEAR the 500 ms debounce in
 * syncServer.ts rather than sit under it.
 *
 * Measured while writing this spec: clicking every 150 ms the pre-fix build
 * reports ONE PUT, not eight, because the debounce coalesces the whole burst
 * into a single push. That number is real but it answers the wrong question:
 * nobody changes tab eight times in a second. The gesture the card measured is
 * a person clicking between two tabs, seconds apart, and each of those used to
 * pay its own 69 KB write. Clicking slower than the debounce is what makes the
 * count read the per-gesture cost instead of the coalescing window.
 */
const BETWEEN_CLICKS_MS = 700;

/**
 * Intercept every non-GET and answer it here. Returns a live counter of the
 * pane store PUTs the client tried to send.
 */
async function countOutboundPaneStorePuts(page: Page): Promise<{ total: () => number }> {
  let total = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fallback();
    if (request.method() === "PUT" && request.url().includes(PANE_STORE_PUT)) total += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return { total: () => total };
}

/** The app-level tab for a pane id, as rendered by PaneTabBar. */
function topLevelTab(page: Page, paneId: string) {
  return page.locator(`[data-pane-id="${paneId}"]`).first();
}

test.describe("changing tab does not push the pane store", () => {
  let firstTopicId = "";
  let secondTopicId = "";

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    const first = await createTopic(request, `e2e-focus-put-a-${stamp}`);
    const second = await createTopic(request, `e2e-focus-put-b-${stamp}`);
    firstTopicId = first.id;
    secondTopicId = second.id;
  });

  test.afterAll(async ({ request }) => {
    if (firstTopicId) await deleteTopic(request, firstTopicId);
    if (secondTopicId) await deleteTopic(request, secondTopicId);
  });

  test("IDLE-02: eight alternating tab clicks send zero pane-store PUTs", async ({ page, request }) => {
    const firstPane = `chat:${firstTopicId}`;
    const secondPane = `chat:${secondTopicId}`;
    await resetPaneStore(request, [firstPane, secondPane]);

    await goToApp(page);
    await expect(topLevelTab(page, firstPane)).toBeVisible({ timeout: 15000 });
    await expect(topLevelTab(page, secondPane)).toBeVisible({ timeout: 15000 });

    // DELIBERATE FIXED WAIT: counting starts AFTER the app has settled, and
    // "settled" here means a window with no push in it. Boot legitimately
    // writes the store (hydrate, migration, the first focus) and there is no
    // condition that says "the last of those has gone out" — only elapsed
    // quiet longer than the middleware's debounce says it.
    await page.waitForTimeout(DEBOUNCE_GRACE_MS);
    const puts = await countOutboundPaneStorePuts(page);

    for (let click = 0; click < 8; click += 1) {
      const target = click % 2 === 0 ? secondPane : firstPane;
      await topLevelTab(page, target).click();
      await expect(topLevelTab(page, target)).toHaveAttribute("data-active", "true", { timeout: 10000 });
      // DELIBERATE FIXED WAIT: the pause IS the experiment. Clicking faster
      // than the debounce measures the coalescing window instead of the
      // per-gesture cost, and reports 1 where a person clicking would pay 8.
      await page.waitForTimeout(BETWEEN_CLICKS_MS);
    }

    // DELIBERATE FIXED WAIT: the assertion is that NOTHING was sent, so the
    // window is the oracle. A push arrives about half a second late; reading
    // the counter immediately would report zero on a broken build too.
    await page.waitForTimeout(DEBOUNCE_GRACE_MS);

    // eslint-disable-next-line no-console -- the number IS the deliverable of this spec
    console.log(`[IDLE-02] PUT ${PANE_STORE_PUT} after 8 alternating focus clicks: ${puts.total()}`);
    expect(
      puts.total(),
      "focus is device-local: a tab click must not ship a 69 KB snapshot the peers cannot observe",
    ).toBe(0);
  });
});
