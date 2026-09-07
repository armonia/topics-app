import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { reachVersionChip } from "./helpers/open-version-chip";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * LINK-TAB-01 for the anchors that carry a bare `target="_blank"`.
 *
 * Those anchors never went through `openLink`, so the browser decided: on the
 * web build a tab of the SYSTEM browser (a popup, which this test catches), and
 * under the desktop shell nothing at all, because the nav guard cancels a
 * non-app-origin http navigation and `on_new_window` answers Deny. The changelog
 * footer link is the cheapest of the ten to reach from a test, and it exercises
 * the same one-line handler the other nine now use.
 *
 * RED before the change: `waitForEvent('popup')` resolved.
 */
const FIXTURE = [
  {
    version: "9.9.9",
    date: "2026-07-23",
    sections: {
      new: [
        { it: "prima novità di prova", en: "", scope: "chat", breaking: false },
      ],
      fixes: [],
      perf: [],
      internal: [],
    },
  },
];

test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("LINK-TAB-01 a bare target=_blank anchor opens a Topics tab", () => {
  test.beforeEach(async ({ page, context, request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "LINK-TAB-01" });
    await resetPaneStore(request, []);
    await page.route("**/api/version", (r) =>
      r.fulfill({
        json: { version: "9.9.9" },
        headers: { "Cache-Control": "no-store" },
      }),
    );
    await context.route("**/changelog.json", (r) =>
      r.fulfill({ json: FIXTURE }),
    );
  });

  test("the changelog footer link mounts a pane instead of a system tab", async ({
    page,
    browserProcessPageV2,
    request,
  }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "about:blank",
      hasScreenshot: true,
    });

    // A topic has to be open: the workspace layout is what claims the open-tab
    // request, and without it every link falls back to the system browser.
    const name = `E2E-BlankAnchor-${Date.now()}`;
    const topic = await createTopic(request, name);
    try {
      await goToApp(page);
      await openTopic(page, new RegExp(name));
      const chip = await reachVersionChip(page);
      await chip.click();
      await page.getByTestId("changelog-open").click();
      await expect(page.getByTestId("changelog-modal")).toBeVisible({
        timeout: 15000,
      });

      const link = page.getByTestId("changelog-full-link");
      await expect(link).toBeVisible();

      // Leaving the app is the failure mode, so waiting for the new page IS the
      // assertion: it has to time out. `rel="noopener"` makes the tab detached,
      // so it surfaces on the CONTEXT as `page` and not on the page as `popup`:
      // watching for `popup` alone would never see it.
      const escaped = Promise.race([
        page
          .context()
          .waitForEvent("page", { timeout: 4000 })
          .then((p) => p.url()),
        page.waitForEvent("popup", { timeout: 4000 }).then((p) => p.url()),
      ]).catch(() => null);

      await link.click();

      expect(await escaped).toBeNull();
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({
        timeout: 15000,
      });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
