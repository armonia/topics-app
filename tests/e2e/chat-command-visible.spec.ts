/**
 * A `run_command` PROCESS IS VISIBLE WHILE IT RUNS, AND ITS WAKE SAYS WHICH COMMAND ENDED AND HOW (BGVIS-07).
 *
 * On 30/09 an agent started a loop with `run_command`, told the person "this
 * topic gets a message when it ends" and ended its turn; the chat showed
 * nothing at all ("no UI is coming out, I don't know what it is doing"): the
 * background line read only the CLI's own tasks.
 *
 * Real server turns from a fake CLI (`helpers/fake-claude-command.ts`) that
 * calls `run_command` mid-turn through the bridge's own code: the command is a
 * row of the strip under the chat, saying that its end will wake the chat,
 * while that turn is open and sooner than the 15 s status poll (the command
 * starts right after a poll went out, so only a push can show it in time), and
 * the background line does not name it a second time (chat-live-work); the
 * turn ends and the row stays, with its own Stop and no composer Stop that
 * would stop nothing; a click on the row opens the card of the `run_command`
 * that started it, with the command's live log (SUBSTRIP-02); the command ends,
 * the row goes, and the answer to its wake carries a banner naming the
 * command, its exit code and its last line.
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

  test("the strip shows the command during the turn that started it and after, a click opens its card with its live log, and its wake names it with its exit code and last line", async ({ page, request, chatPage }) => {
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
      const strip = page.getByTestId("subagents-strip");
      const command = strip.locator('[data-testid="live-command-row"]').filter({ hasText: "CMDWATCH-JOB" });
      // A row of the strip, while its turn is open, sooner than the 15 s poll,
      // saying that its end wakes the chat.
      await expect(command).toHaveCount(1, { timeout: 5_000 });
      await expect(page.getByText("STARTED").first()).toBeVisible({ timeout: 30_000 });
      await expect(command.getByTestId("live-work-wakes")).toHaveAttribute("aria-label", /^(wakes the chat when it ends|sveglia la chat quando finisce)$/);
      await expect(page.locator(STOP).first()).toBeVisible();
      // Named once: the background line does not list it again.
      await expect(page.locator(LINE)).toHaveCount(0);

      // The turn ends; the command still runs, its row has its own Stop, and
      // the composer offers none that would stop nothing.
      writeFileSync(join(dir, "release"), "");
      await expect(page.getByText("RUN-DONE").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      await expect(command).toHaveCount(1);
      await expect(command.getByTestId("live-work-stop")).toBeVisible();

      // A click on the row opens the card that started it, with the command's live log: no second log over the strip.
      await command.getByRole("button").first().click();
      const card = page.getByTestId("tool-call-row-toolu_cmdwatch");
      await expect(card.getByTestId("shell-live-status")).toHaveAttribute("data-status", "running", { timeout: 10_000 });
      await expect(strip.getByTestId("process-log-output")).toHaveCount(0);

      // The command ends: its row goes, and the wake's answer names it, how it ended and its last line.
      writeFileSync(join(dir, "finish"), "");
      await expect(command).toHaveCount(0, { timeout: 10_000 });
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
