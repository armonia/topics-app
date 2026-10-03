/**
 * A `run_command` PROCESS IS VISIBLE WHILE IT RUNS, AND ITS WAKE SAYS WHICH COMMAND ENDED AND HOW (BGVIS-07).
 *
 * On 30/09 an agent started a loop with `run_command`, told the person "this
 * topic gets a message when it ends" and ended its turn; the chat showed
 * nothing at all ("no UI is coming out, I don't know what it is doing"): the
 * background line read only the CLI's own tasks.
 *
 * Real server turns from a fake CLI (`helpers/fake-claude-command.ts`) that
 * calls `run_command` mid-turn through the bridge's own code: the line names
 * the command, with a terminal icon, its running time and that it will wake
 * the chat, while that turn is open and sooner than the 15 s status poll (the
 * command starts right after a poll went out, so only the `background:changed`
 * push can name it in time); the turn ends and the line stays, with no
 * composer Stop that would stop nothing; a click opens the command's log in
 * the project window; the command ends, the line goes, and the answer to its
 * wake carries a banner naming the command, its exit code and its last line.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { installFakeCli } from "./helpers/fake-claude-cli";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";

/** The removal of the fake CLI the running test installed. */
let removeCli: (() => void) | null = null;
// allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
const STOP = 'button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]';
const LINE = '[data-testid="background-work-line"]';

/** Puts the fake CLI in front of the test server's; its switches live in `dir`. */
function installCommandCli(dir: string, cwd: string): void {
  removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-command.ts"), { CMDWATCH_DIR: dir, CMDWATCH_CWD: cwd });
}

hermetic(test);

test.describe("a run_command in the chat", () => {
  test.describe.configure({ timeout: 180_000 });

  let dir = "";
  test.afterEach(() => {
    removeCli?.();
    removeCli = null;
    // The command stops once its folder is gone: it never outlives the test.
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the line names the command during the turn that started it and after, a click opens its log, and its wake names it with its exit code and last line", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-07" });
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cmdwatch-")));
    const project = join(dir, "project");
    mkdirSync(project);
    installCommandCli(dir, project);
    const topic = await createTopic(request, `cmdwatch-${Date.now()}`, { projectPath: project, provider: "claude-code" });
    try {
      await seedProjectPane(request, project);
      await seedProjectInnerChats(request, project, [topic.id]);
      await waitForPaneStoreQuiet(request);
      await goToApp(page);
      const win = page.locator(`[data-testid="project-window"][data-project-path="${project}"]`);
      await expect(win).toHaveCount(1, { timeout: 15_000 });
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      // The turn opens and holds. After the two status reads a send triggers
      // (the `stream:start` refresh and a 15 s poll), the next poll is ~14.5 s
      // away and only a push reads the status again: the command starts now.
      let statusReads = 0;
      page.on("request", (r) => { if (r.url().includes("/api/topics/streaming")) statusReads++; });
      await chatPage.sendMessage("cmdwatch-start");
      await expect(page.getByText("HOLDING").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP).first()).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => statusReads, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
      writeFileSync(join(dir, "run"), "");
      const line = page.locator(LINE);
      const command = line.locator('[data-testid="background-work-task"][data-type="command"]');
      // Named as a command, while its turn is open, sooner than the 15 s poll.
      await expect(command).toContainText("CMDWATCH-JOB", { timeout: 5_000 });
      await expect(page.getByText("STARTED").first()).toBeVisible({ timeout: 30_000 });
      await expect(command.getByRole("img", { name: /^(Command|Comando)$/ })).toHaveCount(1);
      await expect(command.getByTestId("background-work-running")).toHaveText(/^\s*\d+(s|m)$/);
      await expect(command.getByTestId("background-work-wakes")).toHaveText(/(wakes the chat when it ends|sveglia la chat quando finisce)/);
      await expect(page.locator(STOP).first()).toBeVisible();

      // The turn ends; the command still runs, and the composer offers no Stop
      // for it (its Stop is in the Processes pane).
      writeFileSync(join(dir, "release"), "");
      await expect(page.getByText("RUN-DONE").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      await expect(command).toContainText("CMDWATCH-JOB");
      // The running time moves: a clock from the command's start, not a stamp
      // (the line's shared clock ticks every 10 s, `useSharedNow`).
      const running = command.getByTestId("background-work-running");
      const shown = (await running.textContent()) ?? "";
      await expect(running).not.toHaveText(shown, { timeout: 15_000 });

      // A click opens the command's log in the chat's project window.
      const processId = await command.getAttribute("data-process-id");
      expect(processId).toBeTruthy();
      await command.getByTestId("background-work-open").click();
      await expect(win.locator(`[role="tab"][data-pane-id="process-log:${processId}"]`)).toHaveCount(1, { timeout: 10_000 });
      await expect(win.locator('[data-testid="process-log-output"]').last()).toBeVisible({ timeout: 10_000 });
      // Back to the chat, as a person would.
      await win.locator(`[role="tab"][data-pane-id="chat:${topic.id}"]`).click();

      // The command ends: the line goes, and the wake's answer names it, how it ended and its last line.
      writeFileSync(join(dir, "finish"), "");
      await expect(page.locator(LINE)).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText("CMD-WOKEN").first()).toBeVisible({ timeout: 30_000 });
      const banner = page.locator('[data-testid="woken-banner"][data-source="command"]');
      await expect(banner).toHaveCount(1, { timeout: 15_000 });
      await expect(banner).toContainText(/(Command ended|Comando terminato): CMDWATCH-JOB \(exit 0\)/);
      await expect(banner.getByTestId("woken-event")).toHaveText("CMDWATCH-LAST 42");
      await expect(page.locator(LINE)).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
