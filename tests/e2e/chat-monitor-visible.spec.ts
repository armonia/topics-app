/**
 * A MONITOR IS VISIBLE WHILE IT RUNS, AND ITS EVENT SAYS WHERE IT CAME FROM (BGVIS-06, MONITOR-03).
 *
 * Real server turns from a fake CLI (`helpers/fake-claude-monitor.ts`) that
 * prints what Claude Code 2.1.285 prints: a turn arms a Monitor and stays open;
 * the chat's background line names it as a Monitor, with its running time,
 * while that turn is open, well before the status poll's 15 s; the turn ends
 * and the line stays; the Monitor delivers an event (on the CLI's transcript
 * only, as the real CLI does) and the answer carries a banner naming that
 * Monitor and the event's text; the Monitor ends and the line goes.
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";

const VERSIONS_DIR = join(E2E_HOME, ".local", "share", "claude", "versions");
/** Sorted above any real version: the server resolves the CLI at every spawn and takes the highest. */
const CLI_ENTRY = join(VERSIONS_DIR, "999.0.3-e2e-monitor");
// allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
const STOP = 'button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]';
const LINE = '[data-testid="background-work-line"]';
const SESSION_ID = "00000000-0000-4000-8000-0000000000b7";

/** Puts the fake CLI in front of the test server's; its switches live in `dir`, its transcript where the server looks for it. */
function installMonitorCli(dir: string, cwd: string): void {
  // The server spawns the CLI with a trimmed environment: bun by absolute path.
  const bun = execSync("command -v bun").toString().trim();
  mkdirSync(VERSIONS_DIR, { recursive: true });
  const script = resolve(__dirname, "helpers/fake-claude-monitor.ts");
  // The server finds the transcript under ITS home, from the cwd and session id of the CLI's init.
  const transcript = join(E2E_HOME, ".claude", "projects", claudeProjectDirName(cwd), `${SESSION_ID}.jsonl`);
  writeFileSync(CLI_ENTRY, `#!/usr/bin/env bash\nexport MONWATCH_DIR="${dir}"\nexport MONWATCH_CWD="${cwd}"\nexport MONWATCH_TRANSCRIPT="${transcript}"\nexec "${bun}" "${script}" "$@"\n`);
  chmodSync(CLI_ENTRY, 0o755);
}

hermetic(test);

test.describe("a Monitor in the chat", () => {
  test.describe.configure({ timeout: 180_000 });

  let dir = "";
  test.afterEach(() => {
    rmSync(CLI_ENTRY, { force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the line names the Monitor during the turn that armed it and after, its event is shown as its own, and it goes when the Monitor ends", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-06" });
    dir = realpathSync(mkdtempSync(join(tmpdir(), "monwatch-")));
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    installMonitorCli(dir, cwd);
    const topic = await createTopic(request, `monwatch-${Date.now()}`);
    try {
      await patchTopic(request, topic.id, { provider: "claude-code" });
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      // The turn arms the Monitor and stays open.
      await chatPage.sendMessage("monwatch-start");
      await expect(page.getByText("ARMED").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP).first()).toBeVisible({ timeout: 10_000 });
      const line = page.locator(LINE);
      const monitor = line.locator('[data-testid="background-work-task"][data-type="monitor"]');
      // Named as a Monitor, while its turn is open, sooner than the 15 s poll.
      await expect(monitor).toContainText("MONWATCH-JOB", { timeout: 5_000 });
      await expect(monitor.getByRole("img", { name: /Monitor/ })).toHaveCount(1);
      await expect(monitor.getByTestId("background-work-running")).toHaveText(/^\s*\d+(s|m)$/);
      await expect(page.locator(STOP).first()).toBeVisible();

      // The turn ends; the Monitor still runs.
      writeFileSync(join(dir, "release"), "");
      await expect(page.getByText("ARM-DONE").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      await expect(monitor).toContainText("MONWATCH-JOB");

      // An event wakes the chat: the answer says it is that Monitor's event, with the event.
      writeFileSync(join(dir, "event"), "");
      await expect(page.getByText("GOT-EVENT").first()).toBeVisible({ timeout: 30_000 });
      const banner = page.locator('[data-testid="woken-banner"][data-source="monitor"]');
      await expect(banner).toHaveCount(1, { timeout: 15_000 });
      await expect(banner).toContainText("MONWATCH-JOB");
      await expect(banner.getByTestId("woken-event")).toHaveText("EVT-LINE-42 build step 3 ok");
      await expect(monitor).toContainText("MONWATCH-JOB");

      // The Monitor ends: the line goes.
      writeFileSync(join(dir, "end"), "");
      await expect(page.getByText("MON-ENDED").first()).toBeVisible({ timeout: 30_000 });
      await expect(line).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
