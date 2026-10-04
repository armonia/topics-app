/**
 * THE TOOL ROW IN THE WINDOW YOU SENT FROM: its clock, its duration, why it
 * failed, and what a silent command is doing.
 *
 * Diagnosis of 04/10 (S2, S4a): in the window that sent the message a `sleep 30`
 * showed `$ sleep 30` and a spinner for thirty seconds, with no clock on the
 * row (`tool-elapsed` null for the whole turn), while a second window watching
 * the same turn counted from 1.1 s to 10 s. That window reads only its own SSE,
 * and the SSE carried neither `startedAt` nor `endedAt` nor the error of a cut
 * turn. The row also had nothing to say about a command that prints nothing.
 *
 * Real server turns from a fake CLI (`helpers/fake-claude-silent-tool.ts`):
 * "silent 30" runs a Bash `sleep 30`, "die N" exits with code 3 under a running
 * Bash. The history read that follows the end of the turn is held: what the row
 * shows then came from the SSE alone, which is the path under test.
 *
 * @covers CHAT-TOOL-10, CHAT-TOOL-13
 */
import { resolve } from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { installFakeCli } from "./helpers/fake-claude-cli";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

/** The removal of the fake CLI the running test installed. */
let removeCli: (() => void) | null = null;

/** A topic on the fake CLI, open in the page. */
async function openChat(page: Page, request: APIRequestContext, chatPage: { messageInput: Locator }, name: string) {
  removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-silent-tool.ts"));
  const topic = await createTopic(request, `${name}-${Date.now()}`);
  await patchTopic(request, topic.id, { provider: "claude-code" });
  const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;
  await resetPaneStore(request, [topic.id]);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(topic.name));
  await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  return { topic, sessionKey };
}

/**
 * Every history read of the session after `arm()` waits until `release()`. The
 * send reloads the history once its reply closes, and that reload brings the
 * database's copy of the row: holding it leaves on screen what the SSE said.
 */
async function holdHistory(page: Page, sessionKey: string) {
  let armed = false;
  let released: () => void = () => {};
  const gate = new Promise<void>((r) => { released = r; });
  let held = 0;
  await page.route((url) => url.pathname === `/api/history/${encodeURIComponent(sessionKey)}`, async (route) => {
    if (!armed) return route.continue();
    held += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  return { arm: () => { armed = true; }, held: () => held, release: () => released() };
}

/** The seconds a countdown reads (`19s`, `1m 05s`). */
async function secondsLeftShown(shown: Locator): Promise<number> {
  const text = (await shown.textContent()) ?? "";
  const m = /(?:(\d+)m )?(\d+)s/.exec(text);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
}

hermetic(test);

test.describe("the tool row of the window that sent the message", () => {
  test.describe.configure({ timeout: 150_000 });
  // The app's service worker has a fetch handler: a page it controls sends
  // `/api/history` through it, where `page.route` never sees the request.
  test.use({ serviceWorkers: "block" });

  test.afterEach(() => {
    removeCli?.();
    removeCli = null;
  });

  test("a silent sleep 30: the row counts, says it has no output, counts the sleep down, and keeps its duration", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-13" });
    const { topic, sessionKey } = await openChat(page, request, chatPage, "row-sleep30");
    try {
      const history = await holdHistory(page, sessionKey);
      await chatPage.sendMessage("silent 30");
      const row = page.getByTestId("tool-call-row-toolu_silent");
      await expect(row).toHaveAttribute("data-status", "running", { timeout: 30_000 });

      // CHAT-TOOL-10: the clock, within 2 s of the row, in this window.
      await expect(row.getByTestId("tool-elapsed")).toBeVisible({ timeout: 2_000 });

      // CHAT-TOOL-13: what the silent command is doing.
      const silent = row.getByTestId("shell-silent-status");
      await expect(silent).toBeVisible({ timeout: 5_000 });
      await expect(silent).toContainText("nessun output visibile");
      const sleepLeft = row.getByTestId("shell-sleep-countdown");
      await expect(sleepLeft).toBeVisible();
      const first = await secondsLeftShown(sleepLeft);
      expect(first).toBeGreaterThan(20);
      expect(first).toBeLessThanOrEqual(30);
      await expect.poll(() => secondsLeftShown(sleepLeft), { timeout: 5_000 }).toBeLessThan(first);
      await row.screenshot({ path: test.info().outputPath("sleep30-running.png") });

      // The end, as the SSE delivers it: the history reload stays held.
      history.arm();
      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 60_000 });
      await expect(row).toHaveAttribute("data-status", "success");
      const duration = row.getByTestId("tool-duration");
      await expect(duration).toBeVisible({ timeout: 5_000 });
      await expect(duration).toHaveText(/^(29|30|31)s$/);
      await expect(silent).toHaveCount(0);
      history.release();
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a turn cut under a running Bash: the row is red and says why, before the history is read again", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-10" });
    const { topic, sessionKey } = await openChat(page, request, chatPage, "row-cut");
    try {
      const history = await holdHistory(page, sessionKey);
      await chatPage.sendMessage("die 4");
      const row = page.getByTestId("tool-call-row-toolu_dying");
      await expect(row).toHaveAttribute("data-status", "running", { timeout: 30_000 });
      await expect(row.getByTestId("tool-elapsed")).toBeVisible({ timeout: 2_000 });
      history.arm();

      await expect(row).toHaveAttribute("data-status", "error", { timeout: 30_000 });
      // A cut row has an end too: its duration, from the SSE.
      await expect(row.getByTestId("tool-duration")).toBeVisible({ timeout: 5_000 });
      // The body the run auto-opened closes after its dwell; then it is opened by hand.
      await expect(row.getByTestId("tool-call-args")).toHaveCount(0, { timeout: 10_000 });
      await row.getByRole("button").first().click();
      const error = row.getByTestId("tool-call-error");
      await expect(error).toBeVisible({ timeout: 5_000 });
      await expect(error).toContainText(/code 3/);
      await row.screenshot({ path: test.info().outputPath("cut-row.png") });
      history.release();
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
