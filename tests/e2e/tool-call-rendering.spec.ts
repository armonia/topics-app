import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import {
  mockChatStreamWithToolCalls,
  mockHistoryWithMedia,
  unmockChatStream,
  HISTORY_ROUTE_PATTERN,
} from "./helpers/sse-helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/** Route pattern for /uploads/ image and file requests */
const UPLOADS_ROUTE_PATTERN = /\/uploads\//;

/**
 * Mock image responses so MediaImage renders instead of showing error state.
 * Returns a 1x1 transparent PNG for any /uploads/ request.
 * Uses context.route() to intercept ALL requests including those made by
 * the service worker's fetch() handler (page.route() doesn't intercept SW fetches).
 */
async function mockImageRoute(page: import("@playwright/test").Page) {
  // 1x1 transparent PNG (minimal valid PNG)
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==";
  const pngBuffer = Buffer.from(pngBase64, "base64");

  await page.context().route(UPLOADS_ROUTE_PATTERN, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: pngBuffer,
    });
  });
}

test.describe.serial("Tool Call & Attachment Rendering", () => {
  let testTopicId: string;
  let testTopicName: string;

  test.beforeAll(async ({ request }) => {
    testTopicName = "ToolCall E2E Test " + Date.now();
    const topic = await createTopic(request, testTopicName);
    testTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (testTopicId) {
      await deleteTopic(request, testTopicId);
    }
  });

  // `getByRole("textbox", { name: /Message input/ })` è STRICT: una pane chat
  // superstite di un file precedente (il pane-store è unico per tutta la suite
  // seriale) la fa risolvere a 2 elementi. Reset al topic di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [testTopicId]);
  });

  test("TOOL-01/03 - tool call card renders with name, args, and status", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-02" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(testTopicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Set up SSE mock BEFORE sending message
    await mockChatStreamWithToolCalls(page, {
      contentChunks: ["Let me read that file."],
      toolCalls: [
        {
          id: "tc-1",
          name: "Read",
          args: { path: "/src/app.ts" },
          result: "const x = 1;",
          contentOffset: 28,
        },
      ],
      userMessage: "read app.ts",
    });

    await textarea.click();
    await textarea.fill("read app.ts");
    await textarea.press("Control+Enter");

    // Wait for tool call badge to appear (inline badge with contentOffset)
    const toolCallCard = page.locator('[data-testid="tool-call-row-tc-1"]');
    await expect(toolCallCard).toBeVisible({ timeout: 15_000 });

    // Assert tool call name
    const toolCallName = toolCallCard.locator('[data-testid="tool-call-name"]');
    await expect(toolCallName).toContainText("Read");

    // Assert status is success
    await expect(toolCallCard).toHaveAttribute("data-status", "success");

    // Click to expand the tool call
    await toolCallCard.click();

    // Assert args contain the path (scoped within the expanded section's parent)
    const toolCallArgs = page.locator('[data-testid="tool-call-args"]').first();
    await expect(toolCallArgs).toContainText("/src/app.ts", {
      timeout: 5_000,
    });

    // Assert result contains the file content
    const toolCallResult = page
      .locator('[data-testid="tool-call-result"]')
      .first();
    await expect(toolCallResult).toContainText("const x = 1;", {
      timeout: 5_000,
    });

    await unmockChatStream(page);
  });

  test("TOOL-02 - tool call error renders with error styling", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-02" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(testTopicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    await mockChatStreamWithToolCalls(page, {
      contentChunks: ["Attempting to write..."],
      toolCalls: [
        {
          id: "tc-err",
          name: "Write",
          args: { path: "/etc/passwd" },
          result: "Permission denied",
          error: true,
          contentOffset: 0,
        },
      ],
      userMessage: "write to passwd",
    });

    await textarea.click();
    await textarea.fill("write to passwd");
    await textarea.press("Control+Enter");

    // Wait for error tool call badge
    const toolCallCard = page.locator('[data-testid="tool-call-row-tc-err"]');
    await expect(toolCallCard).toBeVisible({ timeout: 15_000 });

    // Assert status is error
    await expect(toolCallCard).toHaveAttribute("data-status", "error");

    // Expand and check error content
    await toolCallCard.click();

    const toolCallError = page
      .locator('[data-testid="tool-call-error"]')
      .first();
    await expect(toolCallError).toContainText("Permission denied", {
      timeout: 5_000,
    });

    await unmockChatStream(page);
  });

  test("ATTACH-01 - image attachment renders as thumbnail", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    // Mock the image route so MediaImage renders successfully
    await mockImageRoute(page);

    // Mock history with an image media path
    await mockHistoryWithMedia(page, {
      mediaPaths: ["/uploads/screenshot.png"],
      content: "Here is the screenshot.",
      userMessage: "show me",
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(testTopicName));

    // Wait for media image to render
    const mediaImage = page.locator('[data-testid="media-image"]');
    await expect(mediaImage.first()).toBeVisible({ timeout: 15_000 });

    // Assert the image src contains the media path
    const src = await mediaImage.first().getAttribute("src");
    expect(src).toContain("/uploads/screenshot.png");

    await page.context().unroute(UPLOADS_ROUTE_PATTERN).catch(() => {});
    await page.unroute(HISTORY_ROUTE_PATTERN).catch(() => {});
  });

  test("ATTACH-01b - image lightbox opens on click", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    // Mock the image route so MediaImage renders successfully
    await mockImageRoute(page);

    // Mock history with image
    await mockHistoryWithMedia(page, {
      mediaPaths: ["/uploads/screenshot.png"],
      content: "Here is the screenshot.",
      userMessage: "show me",
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(testTopicName));

    // Wait for image
    const mediaImage = page.locator('[data-testid="media-image"]');
    await expect(mediaImage.first()).toBeVisible({ timeout: 15_000 });

    // Click image to open lightbox
    await mediaImage.first().click();

    // Assert lightbox is visible
    const lightbox = page.locator('[data-testid="image-lightbox"]');
    await expect(lightbox).toBeVisible({ timeout: 5_000 });

    // Close lightbox
    const closeBtn = page.locator('[data-testid="lightbox-close"]');
    await closeBtn.click();

    // Assert lightbox is hidden
    await expect(lightbox).toBeHidden({ timeout: 5_000 });

    await page.context().unroute(UPLOADS_ROUTE_PATTERN).catch(() => {});
    await page.unroute(HISTORY_ROUTE_PATTERN).catch(() => {});
  });

  test("ATTACH-02 - file attachment renders as download link", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    // Mock history with a PDF file
    await mockHistoryWithMedia(page, {
      mediaPaths: ["/uploads/report.pdf"],
      content: "Here is the report.",
      userMessage: "get report",
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(testTopicName));

    // Wait for file attachment to render
    const mediaFile = page.locator('[data-testid="media-file"]');
    await expect(mediaFile.first()).toBeVisible({ timeout: 15_000 });

    // Assert file name is shown
    const fileName = page.locator('[data-testid="media-file-name"]');
    await expect(fileName.first()).toContainText("report.pdf");

    // Assert href contains the file path
    const href = await mediaFile.first().getAttribute("href");
    expect(href).toContain("report.pdf");

    await page.unroute(HISTORY_ROUTE_PATTERN).catch(() => {});
  });
});
