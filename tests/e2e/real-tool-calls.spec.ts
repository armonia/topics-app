import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage, type SeedToolCall } from "./helpers/seed-messages";
import { isGatewayAvailable } from "./helpers/gateway-health";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Real E2E tests for tool call and media rendering.
 * NO mocking — tests run against the real test server (port 13334).
 * History tests seed messages into the DB and verify DOM rendering.
 * Live test sends a real chat and verifies tool calls appear.
 */

const UPLOADS_ROUTE = /\/uploads\//;

/** Mock /uploads/ requests with a 1x1 transparent PNG */
async function mockUploadsRoute(page: import("@playwright/test").Page) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==",
    "base64"
  );
  await page.context().route(UPLOADS_ROUTE, async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
}

// Use unique IDs per run to avoid UNIQUE constraint collisions from prior failed runs
const RUN_ID = Date.now().toString(36);
const TC_SUCCESS_ID = `tc-real-${RUN_ID}`;
const TC_ERROR_ID = `tc-err-${RUN_ID}`;
const TC_MULTI_IDS = [`tc-m1-${RUN_ID}`, `tc-m2-${RUN_ID}`, `tc-m3-${RUN_ID}`];

test.describe.serial("Real Tool Call & Media Rendering", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = "RealToolCall E2E " + Date.now();
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    sessionKey = `topic:${topic.id.slice(0, 8)}`;

    // Seed a chain of messages with parentId linking
    const msg1 = await seedMessage(request, {
      sessionKey, role: "user", content: "read app.ts",
      timestamp: new Date(Date.now() - 60000).toISOString(),
    });

    const msg2 = await seedMessage(request, {
      sessionKey, role: "assistant", parentId: msg1.id,
      content: "Let me read that file for you.\n\nHere is the content of app.ts.",
      toolCalls: [{
        id: TC_SUCCESS_ID, name: "Read", args: { path: "/src/app.ts" },
        status: "success", result: 'export const app = "hello";', contentOffset: 32,
      }],
      timestamp: new Date(Date.now() - 55000).toISOString(),
    });

    const msg3 = await seedMessage(request, {
      sessionKey, role: "user", parentId: msg2.id,
      content: "write to system file",
      timestamp: new Date(Date.now() - 50000).toISOString(),
    });

    const msg4 = await seedMessage(request, {
      sessionKey, role: "assistant", parentId: msg3.id,
      content: "I attempted to write but got an error.",
      toolCalls: [{
        id: TC_ERROR_ID, name: "Write", args: { path: "/etc/passwd" },
        status: "error", error: "Permission denied", contentOffset: 0,
      }],
      timestamp: new Date(Date.now() - 45000).toISOString(),
    });

    const msg5 = await seedMessage(request, {
      sessionKey, role: "user", parentId: msg4.id,
      content: "read three files",
      timestamp: new Date(Date.now() - 40000).toISOString(),
    });

    const msg6 = await seedMessage(request, {
      sessionKey, role: "assistant", parentId: msg5.id,
      content: "I'll read all three files.\n\nFirst file done.\n\nSecond file done.\n\nThird file done.",
      toolCalls: [
        { id: TC_MULTI_IDS[0], name: "Read", args: { path: "/a.ts" }, status: "success", result: "aaa", contentOffset: 0 },
        { id: TC_MULTI_IDS[1], name: "Read", args: { path: "/b.ts" }, status: "success", result: "bbb", contentOffset: 50 },
        { id: TC_MULTI_IDS[2], name: "Read", args: { path: "/c.ts" }, status: "success", result: "ccc", contentOffset: 120 },
      ],
      timestamp: new Date(Date.now() - 35000).toISOString(),
    });

    const msg7 = await seedMessage(request, {
      sessionKey, role: "user", parentId: msg6.id,
      content: "show me the screenshot",
      timestamp: new Date(Date.now() - 30000).toISOString(),
    });

    const msg8 = await seedMessage(request, {
      sessionKey, role: "assistant", parentId: msg7.id,
      content: "Here is the screenshot.",
      media: ["/uploads/test-screenshot.png"],
      timestamp: new Date(Date.now() - 25000).toISOString(),
    });

    const msg9 = await seedMessage(request, {
      sessionKey, role: "user", parentId: msg8.id,
      content: "get the report",
      timestamp: new Date(Date.now() - 20000).toISOString(),
    });

    await seedMessage(request, {
      sessionKey, role: "assistant", parentId: msg9.id,
      content: "Here is the report.",
      media: ["/uploads/test-report.pdf"],
      timestamp: new Date(Date.now() - 15000).toISOString(),
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) {
      await deleteTopic(request, topicId);
    }
  });

  // Il pane-store è UNO per l'intera suite seriale: se restano aperte le pane
  // dei file precedenti, il DOM monta anche le loro chat e i test qui —
  // che cercano tool-call card per data-testid nell'intera pagina — misurano
  // uno stato che non hanno seminato. Reset al solo topic di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  // --- REAL-TC-01: Tool call rendering from history ---

  test("REAL-TC-01: seeded tool call renders badge with tool name", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "REAL-TC-01" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const badge = page.locator(`[data-testid="tool-call-row-${TC_SUCCESS_ID}"]`);
    await expect(badge).toBeVisible({ timeout: 15_000 });

    const name = badge.locator('[data-testid="tool-call-name"]');
    await expect(name).toContainText("Read");
  });

  test("REAL-TC-01b: tool call badge expands to show args and result", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "REAL-TC-01" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const badge = page.locator(`[data-testid="tool-call-row-${TC_SUCCESS_ID}"]`);
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.click();

    const args = page.locator('[data-testid="tool-call-args"]').first();
    await expect(args).toContainText("/src/app.ts", { timeout: 5_000 });

    const result = page.locator('[data-testid="tool-call-result"]').first();
    await expect(result).toContainText('export const app', { timeout: 5_000 });
  });

  test("REAL-TC-01c: error tool call renders with error status", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "REAL-TC-01" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const badge = page.locator(`[data-testid="tool-call-row-${TC_ERROR_ID}"]`);
    await expect(badge).toBeVisible({ timeout: 15_000 });

    await expect(badge).toHaveAttribute("data-status", "error");

    await badge.click();
    const error = page.locator('[data-testid="tool-call-error"]').first();
    await expect(error).toContainText("Permission denied", { timeout: 5_000 });
  });

  test("REAL-TC-01d: multiple tool calls render in document order", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "REAL-TC-01" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    // Wait for all 3 tool calls in the multi-tool message
    const tc1 = page.locator(`[data-testid="tool-call-row-${TC_MULTI_IDS[0]}"]`);
    const tc2 = page.locator(`[data-testid="tool-call-row-${TC_MULTI_IDS[1]}"]`);
    const tc3 = page.locator(`[data-testid="tool-call-row-${TC_MULTI_IDS[2]}"]`);

    await expect(tc1).toBeVisible({ timeout: 15_000 });
    await expect(tc2).toBeVisible();
    await expect(tc3).toBeVisible();

    // Verify order: tc-m1 should appear before tc-m2, tc-m2 before tc-m3
    const box1 = await tc1.boundingBox();
    const box2 = await tc2.boundingBox();
    const box3 = await tc3.boundingBox();

    expect(box1).toBeTruthy();
    expect(box2).toBeTruthy();
    expect(box3).toBeTruthy();
    expect(box1!.y).toBeLessThan(box2!.y);
    expect(box2!.y).toBeLessThan(box3!.y);
  });

  // --- REAL-TC-02: Media rendering from history ---

  test("REAL-TC-02: image media renders MediaImage with correct src", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "REAL-TC-02" });
    await mockUploadsRoute(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const img = page.locator('[data-testid="media-image"]');
    await expect(img.first()).toBeVisible({ timeout: 15_000 });

    const src = await img.first().getAttribute("src");
    expect(src).toContain("test-screenshot.png");

    await page.context().unroute(UPLOADS_ROUTE).catch(() => {});
  });

  test("REAL-TC-02b: file media renders MediaFile with filename", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "REAL-TC-02" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const file = page.locator('[data-testid="media-file"]');
    await expect(file.first()).toBeVisible({ timeout: 15_000 });

    const name = page.locator('[data-testid="media-file-name"]');
    await expect(name.first()).toContainText("test-report.pdf");
  });

  // --- REAL-TC-03: Live streaming (best-effort) ---

  test("REAL-TC-03: live chat produces tool call badge (or skips if gateway offline)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "REAL-TC-03" });
    test.slow(); // Allow up to 3x default timeout

    const gatewayUp = await isGatewayAvailable();
    if (!gatewayUp) {
      test.info().annotations.push({ type: "skip", description: "Gateway unavailable" });
      test.skip(true, "Gateway unavailable — cannot test live tool calls");
      return;
    }

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });
    await textarea.click();
    await textarea.fill("Read the file package.json and tell me the name field");
    await textarea.press("Control+Enter");

    // Wait up to 30s for any tool call badge to appear
    const anyToolCall = page.locator('[data-testid^="tool-call-row-"]');
    await expect(anyToolCall.first()).toBeVisible({ timeout: 30_000 });

    // Verify it has a name
    const toolName = anyToolCall.first().locator('[data-testid="tool-call-name"]');
    await expect(toolName).not.toBeEmpty();
  });
});
