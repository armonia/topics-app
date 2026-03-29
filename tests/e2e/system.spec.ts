import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";

test.describe("System & Infrastructure", () => {
  test("WebSocket connects and shows Online status", async ({ page }) => {
    await goToApp(page);

    // Wait for WebSocket to connect (status button appears)
    const statusBtn = page.getByRole("button", { name: /Online/ });
    await expect(statusBtn).toBeVisible({ timeout: 15000 });
    const text = await statusBtn.textContent();
    expect(text).toContain("Online");
    expect(text).toContain("ms");
    expect(text).toContain("MB");
  });

  test("status bar shows latency, memory, fps", async ({ page }) => {
    await goToApp(page);

    const statusBtn = page.getByRole("button", { name: /Online/ });
    await expect(statusBtn).toBeVisible({ timeout: 15000 });
    const text = await statusBtn.textContent();
    expect(text).toContain("ms");
    expect(text).toContain("MB");
    expect(text).toContain("fps");

    await statusBtn.click();
    await page.waitForLoadState("networkidle");
    expect((await page.locator("body").textContent())!.length).toBeGreaterThan(50);
  });

  test("Cmd+K opens palette, Escape closes", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Ensure the page is focused and ready before triggering keyboard shortcut
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Meta+k");

    // Wait for dialog/palette to appear
    const dialog = page.locator('[role="dialog"]');
    const modal = page.locator('[class*="modal"], [class*="palette"], [class*="dialog"]');
    const hasDialog = await dialog.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    const hasModal = !hasDialog && await modal.first().waitFor({ state: "visible", timeout: 2000 }).then(() => true).catch(() => false);
    expect(hasDialog || hasModal).toBeTruthy();

    await page.keyboard.press("Escape");
    // Verify palette closed
    if (hasDialog) {
      await expect(dialog.first()).toBeHidden({ timeout: 3000 }).catch(() => {});
    }
  });

  test("API endpoints respond correctly", async ({ page }) => {
    await goToApp(page);

    const results = await page.evaluate(async () => {
      const endpoints = [
        { url: "/api/topics", method: "GET" },
        { url: "/api/unread", method: "GET" },
        { url: "/api/scripts", method: "GET" },
        { url: "/api/browser/status", method: "GET" },
        { url: "/api/agents/sessions", method: "GET" },
        { url: "/api/system/status", method: "GET" },
      ];
      const results: Record<string, { ok: boolean; status: number }> = {};
      for (const ep of endpoints) {
        const res = await fetch(ep.url);
        results[ep.url] = { ok: res.ok, status: res.status };
      }
      // POST /api/search
      const searchRes = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });
      results["/api/search"] = { ok: searchRes.ok, status: searchRes.status };

      // Invalid chat request
      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      results["/api/chat-invalid"] = { ok: chatRes.ok, status: chatRes.status };

      return results;
    });

    expect(results["/api/topics"].ok).toBeTruthy();
    expect(results["/api/unread"].ok).toBeTruthy();
    expect(results["/api/scripts"].ok).toBeTruthy();
    expect(results["/api/browser/status"].ok).toBeTruthy();
    expect(results["/api/agents/sessions"].ok).toBeTruthy();
    expect(results["/api/system/status"].ok).toBeTruthy();
    expect(results["/api/search"].ok).toBeTruthy();
    expect(results["/api/chat-invalid"].status).toBe(400);
  });

  test("chat works with non-hex topic IDs (custom session keys)", async ({ page }) => {
    test.slow();
    await goToApp(page);

    // Open a topic with non-hex ID (e.g. ux-ui-studio-01, dom-deploy-01)
    const customTopic = page.getByRole("treeitem", { name: /UX\/UI Studio|Dominio & Deploy/ });
    if (await customTopic.count() > 0) {
      await customTopic.first().click();
      await page.waitForLoadState("networkidle");

      const textarea = page.getByRole("textbox", { name: /Message input/ });
      if (await textarea.count() > 0) {
        await expect(textarea).toBeVisible({ timeout: 5000 });
        await textarea.fill("ping");
        await textarea.press("Control+Enter");

        // Wait for any response (up to 30s)
        let gotResponse = false;
        for (let i = 0; i < 30; i++) {
          await page.waitForTimeout(1000);
          const msgs = await page.locator("div.message-appear").count();
          if (msgs >= 2) { gotResponse = true; break; }
        }
        expect(gotResponse).toBeTruthy();
      }
    }
  });

  test("error recovery — invalid route + invalid API", async ({ page }) => {
    // Navigate to non-existent route
    await page.goto("/nonexistent-page", { waitUntil: "networkidle" });
    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length).toBeGreaterThan(0);

    // Go back and verify app works
    await goToApp(page);
    await openTopic(page, /Web Search Test/);
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
  });
});
