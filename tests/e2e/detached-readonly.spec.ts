import { expect, test } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Detached pop-out windows (`?topics=a,b`) are READ-ONLY toward the shared
 * pane store (bootstrapPaneStore gates every write path on isDetached). The
 * live incident behind this guard (2026-07-20): a detached automation window
 * dispatched browser:open-and-navigate, persistBrowserPane committed the pane
 * to the store, and syncServer PUT it to /api/ui-state/pane-store-v2 — nine
 * orphaned browser panes then floated in every client's standalone grid.
 *
 * Two tests: the detached window must never PUT; a NORMAL window doing the
 * same thing MUST PUT (proves the interception pattern actually matches the
 * write, so the zero-count in the first test is meaningful).
 *
 * @covers LAYOUT-01
 */

/** Dispatch the open-and-navigate event until the pane claims it (the handler
 *  bails while the hosted topic hasn't hydrated into the group yet). */
async function openBrowserPaneWithRetry(
  page: import("@playwright/test").Page,
  topicId: string,
): Promise<boolean> {
  const pane = page.locator('[data-browser-pane]').first();
  for (let i = 0; i < 10; i++) {
    await page.evaluate((tid) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: "https://example.com" } }),
      );
    }, topicId);
    // A dispatch that found nothing is a retry, not a verdict — but the pane may
    // also mount a beat later, so this waits for the pane and gives up on the
    // timeout instead of napping a fixed second between attempts. Same ceiling,
    // and it returns the instant the pane is there.
    if (await pane.waitFor({ state: "visible", timeout: 1000 }).then(() => true, () => false)) return true;
  }
  return false;
}

test.describe("detached window is read-only toward the shared pane store", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("a ?topics= window never PUTs pane-store-v2, even after opening a browser pane", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-DETACH-RO-${Date.now()}`);
    try {
      let paneStorePuts = 0;
      await page.route(/\/api\/ui-state\/pane-store-v2/, async (route) => {
        if (route.request().method() === "PUT") paneStorePuts += 1;
        await route.fallback();
      });

      await page.goto(`/?topics=${topic.id}`);
      // Detached windows hide the sidebar, so the readiness signal is the hosted
      // topic itself reaching the DOM — which is exactly what the dispatch below
      // needs and what the fixed sleep here was guessing at.
      await page.waitForLoadState("load");
      await waitForTopicVisible(page, topic.id, { timeout: 15_000 });

      // Exercise the exact leak path: open a browser pane inside the detached
      // window (persistBrowserPane fires on claim). Mount is best-effort — the
      // assertion below holds either way, but a mounted pane exercises more.
      const mounted = await openBrowserPaneWithRetry(page, topic.id);

      // DELIBERATE FIXED WAIT: the assertion is that a PUT never happens, and
      // "never" has no condition to poll — `paneStorePuts === 0` is true the
      // instant after the dispatch too. This is the window in which the write
      // WOULD have landed: the sync debounce (500 ms) plus retry backoff.
      await page.waitForTimeout(3000);
      expect(paneStorePuts).toBe(0);

      // Belt: the server-side store must not have picked the pane up through
      // any other route either.
      const store = await request.get(`/api/ui-state/pane-store-v2`).then((r) => r.json());
      expect(JSON.stringify(store)).not.toContain(`browser:${topic.id}`);

      // The pane itself is allowed (and expected) to work locally.
      if (mounted) {
        await expect(page.locator('[data-browser-pane]').first()).toBeVisible();
      }
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("control: a NORMAL window opening a browser pane DOES PUT pane-store-v2", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-DETACH-CTRL-${Date.now()}`);
    try {
      let paneStorePuts = 0;
      await page.route(/\/api\/ui-state\/pane-store-v2/, async (route) => {
        if (route.request().method() === "PUT") paneStorePuts += 1;
        await route.fallback();
      });

      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

      const mounted = await openBrowserPaneWithRetry(page, topic.id);
      expect(mounted).toBe(true);

      await expect.poll(() => paneStorePuts, { timeout: 5000 }).toBeGreaterThan(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
