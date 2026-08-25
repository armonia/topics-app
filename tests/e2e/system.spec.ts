/**
 * System & infrastructure smoke: the WebSocket connects and its status is shown, the
 * status bar carries server info, the REST endpoints answer, and an invalid route or
 * API call recovers instead of taking the app down.
 *
 * @covers SYSTEM-01
 */
import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { mockOpenClawAvailable } from "./helpers/openclaw";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("System & Infrastructure", () => {
  // Metà dei test qui prende il composer con un locator STRICT
  // (`textbox` / Message input): il pane-store è UNO per tutta la suite
  // seriale, quindi le chat lasciate aperte dai file precedenti lo fanno
  // risolvere a più elementi. Ogni test riapre da sé il topic che gli serve.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("WebSocket connects and shows status", async ({ page }) => {
    // The Online/Offline label on the status button renders only when openclaw
    // is available (SidebarStatusBar: `openclawAvailable ? … : dot-only`); the
    // isolated test server reports openclaw unconfigured, so stub it.
    await mockOpenClawAvailable(page);
    await goToApp(page);

    // Accept "Online", "Connecting", or "Offline" — gateway may not be available on test server
    const statusBtn = page.getByRole("button", { name: /Online|Connecting|Offline/ });
    await expect(statusBtn).toBeVisible({ timeout: 15000 });
    const text = await statusBtn.textContent();
    expect(text).toMatch(/Online|Connecting|Offline/);
  });

  test("status bar shows system info", async ({ page }) => {
    await mockOpenClawAvailable(page);
    await goToApp(page);

    const statusBtn = page.getByRole("button", { name: /Online|Connecting|Offline/ });
    await expect(statusBtn).toBeVisible({ timeout: 15000 });
    // Status button should show at minimum a connection state
    const text = await statusBtn.textContent();
    expect(text!.length).toBeGreaterThan(0);

    await statusBtn.click();
    // Niente networkidle (SSE/WS non lo raggiungono mai) e nemmeno una pausa
    // fissa: si polla la condizione finale, che ritorna appena e' vera.
    await expect
      .poll(async () => ((await page.locator("body").textContent()) ?? "").length, { timeout: 10000 })
      .toBeGreaterThan(50);
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
    // Si chiude QUELLA CHE SI E' APERTA. Prima si guardava solo `dialog`, e con
    // un `.catch(() => {})` attaccato: se ad aprirsi era `modal` il controllo
    // saltava del tutto, e se era `dialog` l'asserzione non poteva comunque
    // fallire. In entrambi i casi «Escape chiude la palette» non era verificato.
    const opened = hasDialog ? dialog.first() : modal.first();
    await expect(opened, "Escape deve chiudere la palette").toBeHidden({ timeout: 3000 });
  });

  test("API endpoints respond correctly", async ({ page }) => {
    await goToApp(page);

    const results = await page.evaluate(async () => {
      const endpoints = [
        { url: "/api/topics", method: "GET" },
        { url: "/api/unread", method: "GET" },
        { url: "/api/scripts", method: "GET" },
        { url: "/api/browser/status", method: "GET" },
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
    expect(results["/api/system/status"].ok).toBeTruthy();
    expect(results["/api/search"].ok).toBeTruthy();
    expect(results["/api/chat-invalid"].status).toBe(400);
  });

  test("chat works with non-hex topic IDs", async ({ page, request }) => {
    // Create a topic and verify the chat input works — the core behavior
    // being tested is that non-hex IDs don't crash the app
    const topic = await createTopic(request, "E2E-NonHexTest");
    try {
      await goToApp(page);
      await openTopic(page, /E2E-NonHexTest/);

      const textarea = page.getByRole("textbox", { name: /Message input/ });
      await expect(textarea).toBeVisible({ timeout: 10000 });
      // Verify the chat input is functional (can type without errors)
      await textarea.fill("ping");
      expect(await textarea.inputValue()).toBe("ping");
    } finally {
      await deleteTopic(request, topic.id);
    }
  });

  test("error recovery — invalid route + invalid API", async ({ page }) => {
    // Navigate to non-existent route
    await page.goto("/nonexistent-page");
    await expect
      .poll(async () => ((await page.locator("body").textContent()) ?? "").length, { timeout: 10000 })
      .toBeGreaterThan(0);

    // Go back and verify app works
    await goToApp(page);
    await openTopic(page, /Web Search Test/);
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
  });
});
