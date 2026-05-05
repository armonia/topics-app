import { test, expect } from "@playwright/test";

test.describe("BROWSER-CHAT-01 persistence", () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "BROWSER-CHAT-01" });
    testInfo.annotations.push({ type: "plan", description: "@plan-30-01" });
  });

  // Implemented in plan 30-05. Stub guarantees the spec file exists for
  // validation pipeline + grep-based plan discovery.
  test.fixme(
    "restart server restores URL + cookies for topic with browserState",
    async ({ page: _page }) => {
      // 1. Create topic, open browser context, navigate to fixture URL,
      //    set a cookie via Playwright.
      // 2. Trigger server restart (via dev server hot-reload signal or
      //    `await ctx.browserService.close(); await ctx.browserService.launch();`
      //    helper exposed in plan 30-05).
      // 3. Reopen the same topic, verify URL is restored + cookie still set.
      expect(true).toBe(true);
    }
  );

  test.fixme(
    "data/browser-state/<topicId>/storage.json exists after navigation",
    async ({ page: _page }) => {
      // Verify file is written within debounce window (30s) or on context.close.
      expect(true).toBe(true);
    }
  );
});
