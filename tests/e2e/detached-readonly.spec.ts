import { expect, test } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
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
 */

/** Dispatch the open-and-navigate event until the pane claims it (the handler
 *  bails while the hosted topic hasn't hydrated into the group yet). */
async function openBrowserPaneWithRetry(
  page: import("@playwright/test").Page,
  topicId: string,
): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await page.evaluate((tid) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: "https://example.com" } }),
      );
    }, topicId);
    const mounted = await page
      .locator('[data-browser-pane]')
      .first()
      .isVisible()
      .catch(() => false);
    if (mounted) return true;
    await page.waitForTimeout(1000);
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
      // Detached windows hide the sidebar — settle on load + hydration instead.
      await page.waitForLoadState("load");
      await page.waitForTimeout(1500);

      // Exercise the exact leak path: open a browser pane inside the detached
      // window (persistBrowserPane fires on claim). Mount is best-effort — the
      // assertion below holds either way, but a mounted pane exercises more.
      const mounted = await openBrowserPaneWithRetry(page, topic.id);

      // Outwait the sync debounce (500 ms) + retry backoff generously.
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
