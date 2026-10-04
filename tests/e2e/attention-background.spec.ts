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
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTerminalSession, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import {
  appendTranscriptLine, bannerLog, createClaudeTerminal, expectAttention, postHook,
  recordAttentionFrames, stubBannersAndWindow, taskNotificationLine,
} from "./helpers/attention";
import { terminalSubject } from "../../shared/attention";

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

      // In background: no fill, no number, nothing in the inbox, the grey glyph.
      await expectAttention(frames, subject, { state: "background", lit: false }, "the turn that left a job running did not go to background");
      await expect(tabT).not.toHaveAttribute("data-attention", /.+/);
      await expect(tabT.locator("[data-notification-count]")).toHaveCount(0);
      await expect(tabT.locator('[data-loader-state="background"]'), "the terminal tab has no grey glyph").toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("inbox-count")).toHaveCount(0);
      await page.getByTestId("inbox-button").click();
      const panel = page.getByTestId("inbox-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("inbox-row")).toHaveCount(0);
      await expect(panel.getByTestId("inbox-quiet"), "the quiet line does not count the terminal in background").toHaveAttribute("data-background", "1");
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
});
