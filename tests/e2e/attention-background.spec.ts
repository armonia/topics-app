/**
 * A WAIT ON BACKGROUND WORK ASKS NOTHING, AND ITS REAL END ALERTS ONCE
 * (notifications-redesign, ATTN-02, ATTN-03, ATTN-12; tasks.md 5.1).
 *
 * The defect (D1, bgwait-1/2/3 in the change's evidence): a turn that left a
 * background Bash running closed like any finished turn. The tab went blue,
 * the bell counted it, a banner rang, and the same happened again for every
 * turn the CLI opened by itself while the job ran: one wait, several alerts,
 * none of them true.
 *
 * Everything here goes through the real server. A Claude Code terminal is
 * driven by the hooks route (the same POSTs the CLI makes): the prompt, the
 * `PreToolUse`/`PostToolUse` of a `Bash` with `run_in_background`, the `Stop`.
 * The job's return is the `<task-notification>` line the CLI writes into its
 * transcript, appended to the file the server tails. What is faked is the OS
 * banner and the window being behind another app.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTerminalSession, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import {
  appendTranscriptLine, bannerLog, createClaudeTerminal, expectAttention, postHook,
  recordAttentionFrames, runChatTurn, stubBannersAndWindow, taskNotificationLine,
} from "./helpers/attention";
import { installFakeCli } from "./helpers/fake-claude-cli";
import { E2E_BASE } from "./helpers/test-server";
import { terminalSubject, topicSubject } from "../../shared/attention";

/** The phone, on the same server: a context of its own at 390 px. */
async function phoneScreenshots(browser: Browser, open: (page: Page) => Promise<void>, file: string): Promise<void> {
  const ctx = await browser.newContext({ baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "it-IT", reducedMotion: "reduce" });
  try {
    const page = await ctx.newPage();
    await stubBannersAndWindow(page);
    await goToApp(page);
    await open(page);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: test.info().outputPath(`${file}-phone-${scheme}.png`) });
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

hermetic(test);

test.describe("background work: no alert while it runs, one when it returns", () => {
  test.describe.configure({ timeout: 90_000 });

  test("a terminal whose turn leaves a background Bash stays quiet, and alerts once when the job returns", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-02" });
    const stamp = Date.now();
    const front = await createTopic(request, `Front Chat ${stamp}`, { provider: "topics" });
    const term = await createClaudeTerminal(request, `bgwait-${stamp}`);
    const subject = terminalSubject(term.id);
    const sid = term.claudeSessionId;
    try {
      await resetPaneStore(request, [front.id, `terminal:${term.id}`]);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);

      const tabT = page.locator('[role="tab"][data-pane-id]', { hasText: `bgwait-${stamp}` });
      const tabF = page.locator('[role="tab"][data-pane-id]', { hasText: front.name });
      await expect(tabT).toBeVisible({ timeout: 15_000 });
      await tabF.click();
      await expect(tabF).toHaveAttribute("data-active", "true");

      // The turn: a prompt, a Bash launched in the background, the end.
      await postHook(request, "UserPromptSubmit", { session_id: sid, cwd: term.cwd, prompt: "run the build in the background" });
      await expectAttention(frames, subject, { state: "working" }, "the prompt did not put the terminal to work");
      const input = { command: "sleep 600 && echo built", run_in_background: true, description: "BGWAIT-JOB" };
      await postHook(request, "PreToolUse", { session_id: sid, cwd: term.cwd, tool_name: "Bash", tool_use_id: "toolu_bgwait", tool_input: input });
      await postHook(request, "PostToolUse", {
        session_id: sid, cwd: term.cwd, tool_name: "Bash", tool_use_id: "toolu_bgwait", tool_input: input,
        tool_response: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bgwait1" },
      });
      await postHook(request, "Stop", { session_id: sid, cwd: term.cwd });

      // At work: no fill, no number, nothing lit in the inbox, the working ring.
      await expectAttention(frames, subject, { state: "working", lit: false }, "the turn that left a job running is not at work");
      await expect(tabT).not.toHaveAttribute("data-attention", /.+/);
      await expect(tabT.locator("[data-notification-count]")).toHaveCount(0);
      await expect(tabT.locator('[data-loader-state="working"]'), "the terminal tab has no working ring").toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("inbox-count")).toHaveCount(0);
      await page.getByTestId("inbox-button").click();
      const panel = page.getByTestId("inbox-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("inbox-row")).toHaveCount(0);
      await expect(panel.getByTestId("inbox-quiet"), "the quiet line does not count the terminal at work").toHaveAttribute("data-working", "1");
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      expect(await bannerLog(page), "a banner rang while the job was still running").toEqual([]);

      // The job returns: the CLI writes the report into its transcript and
      // closes the turn it opens to answer it.
      appendTranscriptLine(term, taskNotificationLine("bgwait1", 'Background command "BGWAIT-JOB" completed (exit code 0)'));
      await expect
        .poll(() => frames.rows().get(subject)?.background.length ?? -1, { timeout: 15_000, message: "the report did not close the task" })
        .toBe(0);
      await postHook(request, "Stop", { session_id: sid, cwd: term.cwd });

      // Finished: blue, one in the inbox, one banner.
      await expectAttention(frames, subject, { state: "finished", outcome: "done", lit: true }, "the real end did not light the terminal");
      await expect(tabT).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", "1");
      await page.getByTestId("inbox-button").click();
      await expect(panel.getByTestId("inbox-row")).toHaveCount(1);
      await expect(panel.getByTestId("inbox-row").first()).toHaveAttribute("data-subject", subject);
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await bannerLog(page)).length, { timeout: 10_000, message: "the real end raised no banner" }).toBe(1);
      expect(frames.announces().filter((s) => s === subject), "the whole wait was announced more than once").toEqual([subject]);
    } finally {
      await deleteTerminalSession(request, term.id);
      await deleteTopic(request, front.id);
    }
  });

  test("a chat whose turn leaves a background job shows the working ring and the line, and alerts once when the job returns", async ({ page, request, browser }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-02" });
    const dir = mkdtempSync(join(tmpdir(), "bgwait-chat-"));
    const removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-background-job.ts"), { BGKEEP_DIR: dir });
    const stamp = Date.now();
    const chat = await createTopic(request, `Build Chat ${stamp}`, { provider: "claude-code" });
    const subject = topicSubject(chat.id);
    try {
      await resetPaneStore(request, [chat.id]);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const tab = page.locator('[role="tab"][data-pane-id]', { hasText: chat.name });
      await expect(tab).toBeVisible({ timeout: 15_000 });
      await tab.click();

      // The turn launches a background Bash and ends: at work, not finished.
      await runChatTurn(request, chat.id, "bgkeep-start");
      await expectAttention(frames, subject, { state: "working", lit: false }, "the turn that left the job running is not at work");
      const line = page.getByTestId("background-work-line");
      await expect(line).toContainText("BGKEEP-JOB", { timeout: 20_000 });
      await expect(tab.locator('[data-loader-state="working"]'), "the chat tab has no working ring").toBeVisible({ timeout: 10_000 });
      await expect(tab).not.toHaveAttribute("data-attention", /.+/);
      await expect(page.getByTestId("inbox-count")).toHaveCount(0);
      expect(await bannerLog(page), "a banner rang while the job was running").toEqual([]);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: test.info().outputPath(`pane-background-desktop-${scheme}.png`) });
      }
      await page.emulateMedia({ colorScheme: "light" });
      await phoneScreenshots(browser, async (p) => {
        await p.getByRole("treeitem", { name: new RegExp(chat.name) }).first().tap();
        await expect(p.getByTestId("background-work-line")).toContainText("BGKEEP-JOB", { timeout: 20_000 });
      }, "pane-background");

      // The job ends: the CLI reports it and wakes with a turn of its own.
      writeFileSync(join(dir, "end-job"), "");
      await expect(page.getByText("BG-JOB-REPORTED").first()).toBeVisible({ timeout: 30_000 });
      await expectAttention(frames, subject, { state: "finished", outcome: "done", lit: true }, "the real end did not light the chat");
      await expect(line).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(async () => (await bannerLog(page)).length, { timeout: 10_000, message: "the real end raised no banner" }).toBe(1);
      expect(frames.announces().filter((x) => x === subject), "the wait was announced more than once").toEqual([subject]);
    } finally {
      removeCli();
      rmSync(dir, { recursive: true, force: true });
      await deleteTopic(request, chat.id);
    }
  });
});
