/**
 * RUN A COMMAND THE AGENT WROTE, AND READ THE RESULT UNDER IT (chat-inline-command-run).
 *
 * A finished reply of the agent with five `bash` blocks, seeded, no provider:
 * Run on each, as a person would. A slow loop shows its lines while it runs and
 * closes green; a failure closes red with its code; Stop ends `sleep 60`; an
 * `rm -rf` asks first and Cancel runs nothing; a reload finds every outcome
 * where it was; «Send to agent» appends to the draft and sends nothing; «Open
 * in terminal» types two lines in a new shell and runs neither. The person's
 * own message never offers Run.
 *
 * A behaviour in time, so the video is the proof: `video: "on"`.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 120_000, mode: "serial" });

const SLOW = "for i in 1 2 3; do echo L$i; sleep 1; done";
const FAIL = "echo boom >&2; exit 3";
const LONG = "sleep 60";
const RISKY = "rm -rf ./e2e-command-run-nothing-here";
const TWO_LINES = "cd /tmp\necho two-lines-not-run";
const REPLY = [
  "Prova questo:", "```bash", SLOW, "```",
  "Questo fallisce:", "```bash", FAIL, "```",
  "Questo dura:", "```bash", LONG, "```",
  "Questo cancella:", "```bash", RISKY, "```",
  "Due righe:", "```bash", TWO_LINES, "```",
].join("\n");

/** The code block whose text is `command`, with whatever runs under it. */
const block = (page: Page, command: string): Locator =>
  page.locator(".code-block-wrapper").filter({ has: page.locator("pre", { hasText: command.split("\n")[0]! }) });
const runOf = (b: Locator) => b.locator('[data-testid="command-run"]');

test.describe("Run under a code block of a reply", () => {
  let topicId = "";
  let topicName = "";
  let sessionKey = "";

  test.beforeAll(async ({ request }) => {
    topicName = `cmd-run-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    sessionKey = `topic:${topic.id.slice(0, 8)}`;
    await seedMessage(request, { sessionKey, role: "user", content: "```bash\necho mine\n```" });
    await seedMessage(request, { sessionKey, role: "assistant", content: REPLY });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("run, watch, fail, stop, confirm, reload, send to the draft", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-RUN-01, CHAT-RUN-02, CHAT-RUN-03, CHAT-RUN-04" });
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const slow = block(page, SLOW);
    await expect(slow.locator('[data-testid="code-run"]')).toBeVisible({ timeout: 15_000 });
    // Nothing ran by itself, and the person's own message offers nothing.
    await expect(page.locator('[data-testid="command-run"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="message-content-user"] [data-testid="code-run"]')).toHaveCount(0);

    // A slow loop: its first line while it runs, with Stop; then green.
    await slow.locator('[data-testid="code-run"]').click();
    await expect(runOf(slow)).toHaveAttribute("data-status", "running", { timeout: 5_000 });
    await expect(runOf(slow).locator('[data-testid="command-run-output"]')).toContainText("L1", { timeout: 3_000 });
    await expect(runOf(slow).locator('[data-testid="command-run-stop"]')).toBeVisible();
    await expect(runOf(slow)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(runOf(slow).locator('[data-testid="command-run-outcome"]')).toHaveText("exit 0");
    await expect(runOf(slow).locator('[data-testid="command-run-output"]')).toContainText("L3");

    // A failure: red, with its code and its stderr.
    const fail = block(page, FAIL);
    await fail.locator('[data-testid="code-run"]').click();
    await expect(runOf(fail)).toHaveAttribute("data-status", "error", { timeout: 15_000 });
    await expect(runOf(fail).locator('[data-testid="command-run-outcome"]')).toHaveText("exit 3");
    await expect(runOf(fail).locator('[data-testid="command-run-output"]')).toContainText("boom");

    // Stop.
    const long = block(page, LONG);
    await long.locator('[data-testid="code-run"]').click();
    await expect(runOf(long)).toHaveAttribute("data-status", "running", { timeout: 5_000 });
    await runOf(long).locator('[data-testid="command-run-stop"]').click();
    await expect(runOf(long)).toHaveAttribute("data-status", "stopped", { timeout: 5_000 });

    // rm -rf asks first, and Cancel runs nothing.
    const risky = block(page, RISKY);
    await risky.locator('[data-testid="code-run"]').click();
    const strip = risky.locator('[data-testid="command-run-confirm"]');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("rm -rf");
    await expect(risky.locator('[data-testid="command-run-confirm-cancel"]')).toBeFocused();
    await risky.locator('[data-testid="command-run-confirm-cancel"]').click();
    await expect(strip).toHaveCount(0);
    await expect(runOf(risky)).toHaveCount(0);
    const listed = await (await request.get(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/command-runs?messageId=${encodeURIComponent(await replyId(request, sessionKey))}`)).json() as { runs: Array<{ command: string }> };
    expect(listed.runs.map((r) => r.command)).not.toContain(RISKY);

    // A reload finds every outcome under its block.
    await page.reload();
    await expect(runOf(slow)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(runOf(slow).locator('[data-testid="command-run-outcome"]')).toHaveText("exit 0");
    await expect(runOf(slow).locator('[data-testid="command-run-output"]')).toContainText("L3");
    await expect(runOf(fail).locator('[data-testid="command-run-outcome"]')).toHaveText("exit 3");
    await expect(runOf(long)).toHaveAttribute("data-status", "stopped");

    // Send to agent: appended to the draft, nothing sent.
    const bubbles = await page.locator('[data-testid="message-content-assistant"], [data-testid="message-content-user"]').count();
    await chatPage.messageInput.fill("guarda qui:");
    await runOf(slow).locator('[data-testid="command-run-send"]').click();
    const draft = await chatPage.messageInput.inputValue();
    expect(draft.startsWith("guarda qui:\n\n```console\n$ for i in 1 2 3; do echo L$i; sleep 1; done\n(exit 0, ")).toBe(true);
    expect(draft).toContain("\nL1\nL2\nL3\n```");
    await expect(chatPage.messageInput).toBeFocused();
    expect(await page.locator('[data-testid="message-content-assistant"], [data-testid="message-content-user"]').count()).toBe(bubbles);
  });

  test("open in terminal: two lines typed in a new shell, neither run", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-RUN-05" });
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    const two = block(page, TWO_LINES);
    await expect(two.locator('[data-testid="code-open-terminal"]')).toBeVisible({ timeout: 15_000 });
    await two.locator('[data-testid="code-open-terminal"]').click();
    const rows = page.locator(".xterm-rows").last();
    await expect(rows).toContainText("echo two-lines-not-run", { timeout: 20_000 });
    await expect(rows).toContainText("cd /tmp");
    // Typed, not run: no line is the echo's output on its own.
    const lines = (await rows.innerText()).split("\n").map((l) => l.trim());
    expect(lines).not.toContain("two-lines-not-run");
  });
});

/** The id of the seeded reply: the last assistant row of the session. */
async function replyId(request: import("@playwright/test").APIRequestContext, sessionKey: string): Promise<string> {
  const body = await (await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`)).json() as { messages: Array<{ id: string; role: string }> };
  return [...body.messages].reverse().find((m) => m.role === "assistant")!.id;
}
