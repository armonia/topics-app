/**
 * THE OUTPUT OF A RUNNING COMMAND SURVIVES EVERY WAY OF REOPENING THE CHAT.
 *
 * Measured on 04/10 against the real server, with a fake codex whose `bun test`
 * printed r1, r2, r3 and then went quiet: the window that sent the message
 * showed the three lines; a second window opening the topic showed none, and
 * neither did it after a reload, a socket reconnect or a tab switch. Each of
 * those paths gets the `stream:catchup` (which carried the tail) and THEN
 * reads `/api/history`, whose copy of the live row had the running shell
 * without its output and replaced the bubble. Worse, the row then said
 * "no output yet" about a command that had printed three lines.
 *
 * Nothing is injected here: the turn is a real one on the isolated server,
 * driven by `helpers/fake-codex-running-tail.ts` through the codex provider,
 * `onToolUpdate` and `ActiveStream.liveToolTails`. The second window, the
 * reload and the reconnect each wait for the window to have CONSUMED its
 * history read (the event that used to wipe the tail) before they look.
 *
 * @covers CHAT-TOOL-11, CHAT-TOOL-13
 */
import { resolve } from "node:path";
import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { installFakeCodex } from "./helpers/fake-claude-cli";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** `HISTORY_DEDUP_MS` in useChat.ts: a read of the session younger than this is skipped on remount. */
const HISTORY_DEDUP_MS = 5_000;
const TOOL_ID = "tailcmd1";
const TAIL = ["r1", "r2", "r3"];

/** A window's video, when the run films (`E2E_VIDEO=1`). */
function videoOptions(): { recordVideo?: { dir: string; size: { width: number; height: number } } } {
  if (process.env.E2E_VIDEO !== "1") return {};
  return { recordVideo: { dir: test.info().outputPath("second-window"), size: { width: 1280, height: 800 } } };
}

/**
 * Counts the history reads the app has CONSUMED (its own `response.json()`
 * resolved, plus a task for the merge that follows), and keeps the latest
 * socket so the test can drop it.
 */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __historyReads: number; __historyReadAt: number; __lastWs?: WebSocket };
    w.__historyReads = 0;
    w.__historyReadAt = 0;
    const NativeWs = window.WebSocket;
    class TrackedWs extends NativeWs {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        w.__lastWs = this;
      }
    }
    window.WebSocket = TrackedWs;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await nativeFetch(...args);
      const url = String((args[0] as Request)?.url ?? args[0]);
      if (url.includes("/api/history/")) {
        const json = res.json.bind(res);
        res.json = async () => {
          const body = await json();
          setTimeout(() => { w.__historyReads += 1; w.__historyReadAt = Date.now(); }, 0);
          return body;
        };
      }
      return res;
    }) as typeof fetch;
  });
}

const historyReads = (page: Page) => page.evaluate(() => (window as unknown as { __historyReads: number }).__historyReads);

/**
 * Runs `act`, then waits until the window has consumed a history read after it
 * and painted the result. `newDocument`: `act` loads a page, whose count starts
 * from zero again.
 */
async function afterHistoryRead(page: Page, act: () => Promise<unknown>, opts: { newDocument?: boolean } = {}) {
  const before = opts.newDocument ? 0 : await historyReads(page);
  await act();
  await page.waitForFunction((n) => (window as unknown as { __historyReads: number }).__historyReads > n, before, { timeout: 20_000 });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Waits out the dedup window, so the next remount or reconnect reads the history again. */
async function pastHistoryDedup(page: Page) {
  await expect.poll(
    () => page.evaluate(() => Date.now() - (window as unknown as { __historyReadAt: number }).__historyReadAt),
    { timeout: HISTORY_DEDUP_MS + 5_000, intervals: [250] },
  ).toBeGreaterThan(HISTORY_DEDUP_MS + 250);
}

/** The running row shows the three lines and does not call itself silent. */
async function expectTailShown(row: Locator, step: string) {
  await expect(row, step).toHaveAttribute("data-status", "running");
  await expect(row.getByTestId("shell-running-tail-line"), step).toHaveText(TAIL);
  await expect(row.getByTestId("shell-silent-status"), step).toHaveCount(0);
}

async function openSecondWindow(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...videoOptions(), baseURL: E2E_BASE, viewport: { width: 1280, height: 800 }, locale: "it-IT", serviceWorkers: "block" });
  return { ctx, page: await ctx.newPage() };
}

test.describe("the tail of a running command on reopen", () => {
  test.describe.configure({ timeout: 170_000 });
  let removeCodex: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    removeCodex = await installFakeCodex(resolve(__dirname, "helpers/fake-codex-running-tail.ts"), { FAKE_CODEX_SILENCE: "150" });
  });
  test.afterAll(async () => {
    await removeCodex?.();
    removeCodex = null;
  });

  test("second window, reload, reconnect and tab switch keep r1..r3 and no silent status", async ({ page, browser, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-11" }, { type: "spec", description: "CHAT-TOOL-13" });
    const topic = await createTopic(request, `tail-reopen-${Date.now()}`);
    const other = await createTopic(request, `tail-reopen-other-${Date.now()}`);
    await patchTopic(request, topic.id, { provider: "codex" });
    let second: BrowserContext | null = null;
    try {
      await resetPaneStore(request, [topic.id, other.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
      await chatPage.sendMessage("go");
      const rowA = page.getByTestId(`tool-call-row-${TOOL_ID}`);
      await expect(rowA).toHaveAttribute("data-status", "running", { timeout: 30_000 });
      await expect(rowA.getByTestId("shell-running-tail-line")).toHaveText(TAIL, { timeout: 15_000 });
      await expectTailShown(rowA, "sending window");

      // A second window opens the topic mid-command: catch-up, then history.
      const opened = await openSecondWindow(browser);
      second = opened.ctx;
      const pageB = opened.page;
      await instrument(pageB);
      const rowB = pageB.getByTestId(`tool-call-row-${TOOL_ID}`);
      await afterHistoryRead(pageB, async () => {
        await goToApp(pageB);
        await pageB.keyboard.press("Escape");
        await openTopic(pageB, new RegExp(topic.name));
      }, { newDocument: true });
      await expectTailShown(rowB, "second window");
      await pageB.screenshot({ path: test.info().outputPath("B1-second-window.png") });

      // The same window reloads.
      await afterHistoryRead(pageB, () => pageB.reload(), { newDocument: true });
      await expectTailShown(rowB, "after reload");
      await pageB.screenshot({ path: test.info().outputPath("B2-after-reload.png") });

      // Its socket drops and reopens.
      await pastHistoryDedup(pageB);
      await afterHistoryRead(pageB, () => pageB.evaluate(() => (window as unknown as { __lastWs?: WebSocket }).__lastWs?.close()));
      await expectTailShown(rowB, "after reconnect");
      await pageB.screenshot({ path: test.info().outputPath("B3-after-reconnect.png") });

      // A tab switch away and back, past the dedup window. The pane stays
      // alive across the switch here and the return does not always read the
      // history, so this step only asserts what is on screen after it.
      await openTopic(pageB, new RegExp(other.name));
      await pastHistoryDedup(pageB);
      await openTopic(pageB, new RegExp(topic.name));
      await expectTailShown(rowB, "after tab switch");
      await pageB.screenshot({ path: test.info().outputPath("B4-after-tab-switch.png") });

      // And the sending window still has it.
      await expectTailShown(rowA, "sending window, at the end");
    } finally {
      await second?.close();
      await deleteTopic(request, topic.id).catch(() => {});
      await deleteTopic(request, other.id).catch(() => {});
    }
  });
});
