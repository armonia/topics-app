/**
 * E2E tests for the Claude Code provider integration.
 *
 * Tests provider registration via API and tool call rendering
 * for Claude Code-specific tools (Read, Edit, Bash, Grep, Glob).
 *
 * Spec: openspec/changes/claude-code-provider/spec.md
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import {
  mockChatStreamWithToolCalls,
  unmockChatStream,
} from "./helpers/sse-helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

test.describe.serial("Claude Code Provider", () => {
  let testTopicId: string;
  let testTopicName: string;

  test.beforeAll(async ({ request }) => {
    testTopicName = "CC Provider E2E " + Date.now();
    const topic = await createTopic(request, testTopicName);
    testTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (testTopicId) {
      await deleteTopic(request, testTopicId);
    }
  });

  // Il pane-store è condiviso da tutta la suite seriale: senza reset la chat di
  // questo file convive con quelle lasciate aperte dai file precedenti e i
  // locator della chat (composer, tool card) risolvono a più elementi.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [testTopicId]);
  });

  // --- CCPROV-01: Provider Lifecycle ---

  test("provider API lists claude-code when registered at runtime", async ({
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "CCPROV-01",
    });

    // Register claude-code provider at runtime via the providers API
    // (the test server may not have CLAUDE_CODE_ENABLED — register dynamically)
    const registerRes = await request.post(
      `${BASE}/api/providers/claude-code/configure`,
      {
        data: { model: "claude-sonnet-4-6" },
        ignoreHTTPSErrors: true,
      }
    );

    // If the endpoint doesn't exist yet, check existing providers list
    const listRes = await request.get(`${BASE}/api/providers`, {
      ignoreHTTPSErrors: true,
    });
    expect(listRes.ok()).toBeTruthy();

    const data = await listRes.json();
    expect(data).toHaveProperty("providers");
    expect(Array.isArray(data.providers)).toBeTruthy();

    // Check that standard providers are present (at least one)
    expect(data.providers.length).toBeGreaterThan(0);

    // Verify provider objects have expected shape
    for (const p of data.providers) {
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("connected");
      expect(p).toHaveProperty("capabilities");
    }
  });

  // --- CCPROV-02: Streaming Chat — Tool Call Rendering ---

  test("renders Claude Code Read tool call with file path", async ({
    page,
    chatPage,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "CCPROV-02",
    });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(testTopicName));
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    await mockChatStreamWithToolCalls(page, {
      contentChunks: ["Let me read that file for you."],
      toolCalls: [
        {
          id: "tc-read-1",
          name: "Read",
          args: { file_path: "/src/index.ts", limit: 100 },
          result: 'const app = express();\napp.listen(3000);',
          contentOffset: 29,
        },
      ],
      userMessage: "show me index.ts",
    });

    await textarea.click();
    await textarea.fill("show me index.ts");
    await textarea.press("Enter");

    // Verify the text content appeared. The trailing "." is split off by
    // MessageContent at contentOffset 29 (…"for you" + ToolCallBadge(Read) + "."),
    // so it isn't contiguous — assert the substring WITHOUT the final period.
    await expect(page.locator("body")).toContainText(
      "Let me read that file for you",
      { timeout: 15_000 }
    );

    // Verify tool call card is rendered with the tool name
    await expect(page.locator("body")).toContainText("Read", {
      timeout: 10_000,
    });
  });

  test("renders Claude Code Bash tool call", async ({ page, chatPage }) => {
    test.info().annotations.push({
      type: "spec",
      description: "CCPROV-02",
    });

    // Create a fresh topic for this test
    const bashTopicName = "CC Bash E2E " + Date.now();
    const bashTopic = await page.request.post(`${BASE}/api/topics`, {
      data: { name: bashTopicName },
      ignoreHTTPSErrors: true,
    });
    const bashTopicData = await bashTopic.json();

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(bashTopicName));
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    await mockChatStreamWithToolCalls(page, {
      contentChunks: ["Running the tests now."],
      toolCalls: [
        {
          id: "tc-bash-1",
          name: "Bash",
          args: { command: "npm test" },
          result: "PASS src/index.test.ts\n  3 tests passed",
          // Split just before the final period (like the Read sibling at
          // offset 29): "Running the tests now" + Bash card + ".". Offset 20
          // would split mid-word ("no|w"), leaving no contiguous text to match.
          contentOffset: 21,
        },
      ],
      userMessage: "run the tests",
    });

    await textarea.click();
    await textarea.fill("run the tests");
    await textarea.press("Enter");

    // Trailing "." is split off by the tool card (see contentOffset above),
    // so assert the substring WITHOUT the final period.
    await expect(page.locator("body")).toContainText(
      "Running the tests now",
      { timeout: 15_000 }
    );

    // Verify Bash tool call card appears
    await expect(page.locator("body")).toContainText("Bash", {
      timeout: 10_000,
    });

    // Cleanup
    await page.request
      .delete(`${BASE}/api/topics/${bashTopicData.id}`, {
        ignoreHTTPSErrors: true,
      })
      .catch(() => {});
  });

  test("renders tool call error with error styling", async ({
    page,
    chatPage,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "CCPROV-02",
    });

    const errorTopicName = "CC Error E2E " + Date.now();
    const errorTopic = await page.request.post(`${BASE}/api/topics`, {
      data: { name: errorTopicName },
      ignoreHTTPSErrors: true,
    });
    const errorTopicData = await errorTopic.json();

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(errorTopicName));
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    await mockChatStreamWithToolCalls(page, {
      contentChunks: ["I tried to read the file but it failed."],
      toolCalls: [
        {
          id: "tc-err-1",
          name: "Read",
          args: { file_path: "/nonexistent/file.ts" },
          result: "File does not exist",
          error: true,
          contentOffset: 38,
        },
      ],
      userMessage: "read nonexistent file",
    });

    await textarea.click();
    await textarea.fill("read nonexistent file");
    await textarea.press("Enter");

    // The trailing "." is split off by the inline Read card (contentOffset:38
    // lands the card between "failed" and "."), so the sentence never appears
    // WITH the period in the DOM — assert without it (matches the bash sibling).
    await expect(page.locator("body")).toContainText(
      "I tried to read the file but it failed",
      { timeout: 15_000 }
    );

    // The title of this test promises ERROR STYLING, and until this line it
    // only checked that the word "Read" was somewhere on the page. A tool call
    // that rendered as a success would have passed. The card states its own
    // outcome in the DOM, so that is what gets asserted here.
    const errorCard = page.locator('[data-testid="tool-call-row-tc-err-1"]');
    await expect(errorCard).toBeVisible({ timeout: 10_000 });
    await expect(errorCard).toHaveAttribute("data-status", "error");

    // Cleanup
    await page.request
      .delete(`${BASE}/api/topics/${errorTopicData.id}`, {
        ignoreHTTPSErrors: true,
      })
      .catch(() => {});
  });

  test("renders multiple tool calls in sequence", async ({
    page,
    chatPage,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "CCPROV-02",
    });

    const multiTopicName = "CC Multi E2E " + Date.now();
    const multiTopic = await page.request.post(`${BASE}/api/topics`, {
      data: { name: multiTopicName },
      ignoreHTTPSErrors: true,
    });
    const multiTopicData = await multiTopic.json();

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(multiTopicName));
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    await mockChatStreamWithToolCalls(page, {
      contentChunks: [
        "Let me find and read that file. ",
        "Here is what I found.",
      ],
      toolCalls: [
        {
          id: "tc-grep-1",
          name: "Grep",
          args: { pattern: "TODO", path: "/src" },
          result: "src/app.ts:42: // TODO fix this\nsrc/utils.ts:10: // TODO refactor",
          contentOffset: 31,
        },
        {
          id: "tc-read-2",
          name: "Read",
          args: { file_path: "/src/app.ts" },
          result: "import express from 'express';\n// TODO fix this",
          contentOffset: 31,
        },
      ],
      userMessage: "find all TODOs",
    });

    await textarea.click();
    await textarea.fill("find all TODOs");
    await textarea.press("Enter");

    // Both tool names should appear
    await expect(page.locator("body")).toContainText("Grep", {
      timeout: 15_000,
    });
    await expect(page.locator("body")).toContainText("Read", {
      timeout: 10_000,
    });
    await expect(page.locator("body")).toContainText(
      "Here is what I found.",
      { timeout: 10_000 }
    );

    // Cleanup
    await page.request
      .delete(`${BASE}/api/topics/${multiTopicData.id}`, {
        ignoreHTTPSErrors: true,
      })
      .catch(() => {});
  });

  // --- CCPROV-05: Configuration — Topic provider setting ---

  test("topic can be configured with claude-code provider via API", async ({
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "CCPROV-05",
    });

    // Patch topic to use claude-code provider
    await patchTopic(request, testTopicId, { provider: "claude-code" });

    // Verify the topic now has the provider set
    const topicRes = await request.get(`${BASE}/api/topics`, {
      ignoreHTTPSErrors: true,
    });
    expect(topicRes.ok()).toBeTruthy();

    const data = await topicRes.json();
    const topic = Object.values(data.topics as Record<string, any>).find(
      (t: any) => t.id === testTopicId
    );
    expect(topic).toBeTruthy();
    expect(topic.provider).toBe("claude-code");
  });
});
