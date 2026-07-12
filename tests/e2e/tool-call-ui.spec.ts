import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";

/**
 * Slice 7 verification — tool-call rendering rewrite.
 *
 * The new visual stack: ReasoningRow → ToolCallRow(s) → prose → MetaFooter.
 * The old `ToolCallBadge` (boxed card) is no longer rendered for legacy
 * tool calls; inline tool calls inside the prose still use the badge.
 */
test.describe.serial("Tool-call UI rewrite (Slice 7)", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Tool UI " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    // The server derives sessionKey as `topic:${id.slice(0, 8)}` (see
    // server/routes/topics.ts) — createTopic doesn't return it.
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("renders ReasoningRow + ToolCallRow + footer in order", async ({ page, request }) => {
    // Seed a user message + an assistant message with thinking, two legacy
    // tool calls, prose content, and footer metadata. parentId chains the
    // assistant onto the user so loadActiveThread() returns both.
    const userMsg = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "Show me what files exist",
      timestamp: new Date(Date.now() - 5000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: userMsg.id,
      content: "Here are the files in your project.",
      thinking: "I should list the files using a Bash command.",
      timestamp: new Date(Date.now() - 4000).toISOString(),
      toolCalls: [
        {
          id: "tc-bash-1",
          name: "Bash",
          args: { command: "ls -la" },
          status: "success",
          result: "total 24\ndrwxr-xr-x  3 user  staff   96 Apr 28 10:00 .",
        },
        {
          id: "tc-read-1",
          name: "Read",
          args: { file_path: "/tmp/example.txt" },
          status: "success",
          result: "Hello world",
        },
      ],
      latencyMs: 3900,
      usagePromptTokens: 432,
      usageCompletionTokens: 354,
      costCents: 2, // $0.02
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    // Wait for the assistant message bubble to render.
    const assistant = page.locator('[data-testid="message-content-assistant"]').last();
    await assistant.waitFor({ state: "visible", timeout: 10_000 });

    // Reasoning row is present (collapsed by default).
    const reasoning = assistant.locator('[data-testid="reasoning-row"]');
    await expect(reasoning).toBeVisible();
    await expect(reasoning).toContainText("Reasoning");

    // Both tool-call rows are present, each labelled with the tool name.
    const bashRow = assistant.locator('[data-testid="tool-call-row-tc-bash-1"]');
    const readRow = assistant.locator('[data-testid="tool-call-row-tc-read-1"]');
    await expect(bashRow).toBeVisible();
    await expect(readRow).toBeVisible();
    // A Bash tool call renders under its canonical display label "Shell"
    // (buildToolDisplayLabel → { name: 'Shell' } for a shell detail, toolDetail.ts:195),
    // not the raw tool name "Bash".
    await expect(bashRow).toContainText("Shell");
    await expect(readRow).toContainText("Read");

    // Both finished-state rows show the success check.
    await expect(assistant.locator('[data-testid="tool-call-status-tc-bash-1"][data-status="success"]')).toBeVisible();
    await expect(assistant.locator('[data-testid="tool-call-status-tc-read-1"][data-status="success"]')).toBeVisible();

    // Footer renders with all three metrics.
    const footer = assistant.locator('[data-testid="message-meta-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("3.9s");
    await expect(footer).toContainText("786 tokens");
    await expect(footer).toContainText("$0.02");

    // Old ToolCallBadge cards are NOT rendered for legacy tool calls (the
    // new ToolCallRow replaced them). The badge testid is `tool-call-${id}`.
    const oldBadge = assistant.locator('[data-testid="tool-call-tc-bash-1"]');
    await expect(oldBadge).toHaveCount(0);
  });

  test("footer hidden when no usage data is present", async ({ page, request }) => {
    // Fresh topic so we can seed a footer-less assistant message.
    const fresh = await createTopic(request, "Footer Hidden " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "Hi",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "Plain reply with no tool calls and no metrics.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const assistant = page.locator('[data-testid="message-content-assistant"]').last();
      await assistant.waitFor({ state: "visible", timeout: 10_000 });

      // No footer at all.
      await expect(assistant.locator('[data-testid="message-meta-footer"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("clicking a tool row reveals args + result", async ({ page, request }) => {
    const fresh = await createTopic(request, "Tool Expand " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "Hi",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "Done.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [{
          id: "tc-expand",
          name: "Bash",
          args: { command: "echo hello" },
          status: "success",
          result: "hello",
        }],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const row = page.locator('[data-testid="tool-call-row-tc-expand"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });

      // The collapsed header shows the tool name + a command *preview* ("Shell"
      // + "echo hello", buildToolDisplayLabel summary). The ShellCard body —
      // the "$ command" line + output block (ToolCards.tsx) — only mounts once
      // the row expands, so the pre-expand invariant is "no expanded body".
      await expect(row.locator('[data-testid="tool-call-result"]')).toHaveCount(0);
      await row.locator("button").first().click();
      await expect(row).toContainText("$ echo hello");
      await expect(row.locator('[data-testid="tool-call-result"]')).toContainText("hello");
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });
});
