import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { restartTestServer } from "./helpers/restart-test-server";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

hermetic(test);

/**
 * WHAT AN AGENT SHOWS STAYS IN THE MESSAGE (SHOWN-01).
 *
 * An agent opens an image in the panel and asks which one. The turn is stopped
 * on the question, the panel is closed, and the person must still SEE the image:
 * in the message, on a desktop and on a phone, and again after the server
 * restarts. One tap opens it in the viewer the chat already has. Runs on the
 * desktop project and on the phone project (touch).
 *
 * The same image reached through the address an agent copies from the desktop
 * shell (another origin, same route) is covered at the unit level
 * (`mediaRefOfOwnOrigin`): the test server has no second origin to ask from.
 *
 * @covers SHOWN-01
 */
// A 1x1 transparent PNG: enough for the image to load and be tapped.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// The allowlist of /api/media: `<app data>/media/`, in a sub-folder the end-of-turn scan never reads.
const MEDIA_DIR = join(E2E_DATA_DIR, ".app-data", "media", "shown-in-message");

test.describe("shown in the message", () => {
  let topicId = "";
  let topicName = "";
  const ctx = `shown-${Date.now()}`;
  const imagePath = join(MEDIA_DIR, "four proposals.png");

  test.beforeAll(async ({ request }) => {
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(imagePath, Buffer.from(PNG_B64, "base64"));
    topicName = `shown-message-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const row = (role: "user" | "assistant", content: string, blocks?: unknown[]) =>
      request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
        data: { role, content, ...(blocks ? { blocks } : {}) }, ignoreHTTPSErrors: true,
      });
    await row("user", "fammi vedere le proposte");
    // The opening, then the question the turn is stopped on.
    await row("assistant", "Quale delle 4 proposte?", [
      {
        kind: "tool",
        toolCall: {
          id: "o1",
          name: "mcp__topics__open_browser_pane",
          args: { url: `/api/media?path=${encodeURIComponent(imagePath)}` },
          status: "success",
          result: `Opened browser pane at /api/media?path=x [media: ${imagePath}] [contextId: ${ctx}]`,
        },
      },
      {
        kind: "tool",
        toolCall: {
          id: "q1",
          name: "mcp__topics__ask_user_question",
          args: { questions: [{ question: "Quale?", header: "Scelta", options: [{ label: "A" }, { label: "B" }] }] },
          status: "waiting_for_input",
          startedAt: Date.now() - 4_000,
          userInputSchema: { kind: "questions", questions: [{ question: "Quale?", header: "Scelta", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
        },
      },
    ]);
  });
  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });
  test.beforeEach(async ({ request }) => {
    // No browser window anywhere: the panel is closed.
    await resetPaneStore(request, [topicId]);
  });

  test("the image is in the message with the panel closed and the question open, survives a restart, and opens in the viewer", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const image = page.getByTestId("browser-open-marker-media").getByTestId("media-image");
    await expect(image).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    // Same message, after the server went down and came back.
    await restartTestServer();
    await page.reload();
    await openTopic(page, new RegExp(topicName));
    const again = page.getByTestId("browser-open-marker-media").getByTestId("media-image");
    await expect(again).toBeVisible({ timeout: 30_000 });

    // A tap opens it in the viewer the chat already has.
    await again.click();
    await expect(page.getByTestId("image-lightbox")).toBeVisible();
    await page.getByTestId("lightbox-close").click();
    await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
  });
});
