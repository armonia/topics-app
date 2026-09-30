/**
 * THE BACKGROUND WORK STAYS NAMED WHILE A NEW TURN IS OPEN (BGVIS-05).
 *
 * On 29/09 chat 33966f4e launched a background Bash at 20:57:54Z; its turn
 * closed and the chat's last row named the job. At 21:17:15Z a "?" reopened
 * the chat and the row went away, while the job ran until 21:23:29Z: the
 * status route gave the session a turn row and dropped its background one.
 *
 * Real server turns from a fake CLI (`helpers/fake-claude-background-job.ts`):
 * a turn launches a job and ends, the line names it; a message from the
 * composer opens a turn and the line stays, sampled in the page for the whole
 * turn and past a poll of the status route answered while the turn is open;
 * the turn ends and the line is still there; the job ends and the line goes.
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, type Response } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";

const VERSIONS_DIR = join(E2E_HOME, ".local", "share", "claude", "versions");
/** Sorted above any real version: the server resolves the CLI at every spawn and takes the highest. */
const CLI_ENTRY = join(VERSIONS_DIR, "999.0.2-e2e-background-job");
// allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
const STOP = 'button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]';
const LINE = '[data-testid="background-work-line"]';

/** Puts the fake CLI in front of the test server's, its switches in `dir`. */
function installBackgroundJobCli(dir: string): void {
  // The server spawns the CLI with a trimmed environment: bun by absolute path.
  const bun = execSync("command -v bun").toString().trim();
  mkdirSync(VERSIONS_DIR, { recursive: true });
  const script = resolve(__dirname, "helpers/fake-claude-background-job.ts");
  writeFileSync(CLI_ENTRY, `#!/usr/bin/env bash\nexport BGKEEP_DIR="${dir}"\nexec "${bun}" "${script}" "$@"\n`);
  chmodSync(CLI_ENTRY, 0o755);
}

/** A poll of the status route that answers this session's turn as open. */
function turnRowPoll(page: Page, sessionKey: string): Promise<Response> {
  return page.waitForResponse(async (r) => {
    if (!r.url().includes("/api/topics/streaming")) return false;
    const body = await r.json().catch(() => null) as { sessions?: Array<{ sessionKey?: string; state?: string }> } | null;
    return !!body?.sessions?.some((s) => s.sessionKey === sessionKey && s.state === "streaming");
  }, { timeout: 40_000 });
}

hermetic(test);

test.describe("background work across a new turn", () => {
  test.describe.configure({ timeout: 180_000 });

  let dir = "";
  test.afterEach(() => {
    rmSync(CLI_ENTRY, { force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the line naming a job stays while a new turn is open, and goes when the job ends", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-05" });
    dir = mkdtempSync(join(tmpdir(), "bgkeep-"));
    installBackgroundJobCli(dir);
    const topic = await createTopic(request, `bgkeep-${Date.now()}`);
    try {
      await patchTopic(request, topic.id, { provider: "claude-code" });
      const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      // A turn launches the job and ends: the line names it.
      await chatPage.sendMessage("bgkeep-start");
      await expect(page.getByText("BG-LAUNCHED").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      const line = page.locator(LINE);
      await expect(line).toContainText("BGKEEP-JOB", { timeout: 20_000 });

      // From here on the page records every moment the line is missing.
      await page.evaluate((sel) => {
        const w = window as unknown as { __bgkeepGaps: number[] };
        w.__bgkeepGaps = [];
        const start = performance.now();
        setInterval(() => {
          if (!document.querySelector(sel)?.textContent?.includes("BGKEEP-JOB")) w.__bgkeepGaps.push(Math.round(performance.now() - start));
        }, 50);
      }, LINE);
      const gaps = () => page.evaluate(() => (window as unknown as { __bgkeepGaps: number[] }).__bgkeepGaps);

      // A message from the composer opens a turn, as the "?" of 29/09 did.
      const firstPoll = turnRowPoll(page, sessionKey);
      await chatPage.sendMessage("bgkeep-hold");
      await expect(page.getByText("HOLDING").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP).first()).toBeVisible({ timeout: 10_000 });
      await firstPoll;
      // A later poll answered with the turn still open: the first one has been drawn by then.
      await turnRowPoll(page, sessionKey);
      await expect(line).toContainText("BGKEEP-JOB");
      expect(await gaps(), "the line went away while the new turn was open").toEqual([]);

      // The turn ends; the job still runs.
      writeFileSync(join(dir, "release"), "");
      await expect(page.getByText("HOLD-DONE").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      await expect(line).toContainText("BGKEEP-JOB");
      expect(await gaps(), "the line went away when the turn ended").toEqual([]);

      // The job ends: the line goes.
      writeFileSync(join(dir, "end-job"), "");
      await expect(page.getByText("BG-JOB-REPORTED").first()).toBeVisible({ timeout: 30_000 });
      await expect(line).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
