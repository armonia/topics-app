/**
 * «DA GUARDARE»: THE INBOX OF WHAT IS LIT (notifications-redesign, ATTN-09;
 * tasks.md 5.3).
 *
 * The history button it replaces counted rows, not things: opening it marked
 * everything seen, a question you had not answered went out with the rest, and
 * the number on the bell disagreed with the tabs (client-surfaces-disagree in
 * the change's evidence).
 *
 * The subjects are real: Claude Code terminals driven through the hooks route
 * (one asks a question, the others finish a turn, one leaves a job running in
 * the background), every one of them while the window is behind another app,
 * so nothing is born seen. Everything after that is the keyboard alone on
 * desktop: opening marks nothing, Enter on a «Finite» row opens it and marks it
 * seen, E marks one, ⇧E marks all of «Finite», and the question stays. At 390
 * px the panel is a bottom sheet that scrolls. Screenshots in light and dark,
 * desktop and phone, go to the test's output (`inbox-*.png`).
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTerminalSession, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import {
  createClaudeTerminal, postHook, recordAttentionFrames, setAwake, stubBannersAndWindow, type ClaudeTerminal,
} from "./helpers/attention";
import { E2E_BASE } from "./helpers/test-server";
import { terminalSubject } from "../../shared/attention";

hermetic(test);

/** A turn that ends: the prompt, then the `Stop`. */
async function finishTurn(request: APIRequestContext, t: ClaudeTerminal, prompt: string): Promise<void> {
  await postHook(request, "UserPromptSubmit", { session_id: t.claudeSessionId, cwd: t.cwd, prompt });
  await postHook(request, "Stop", { session_id: t.claudeSessionId, cwd: t.cwd });
}

/** A turn that stops on a question to the person (the Topics question tool). */
async function askQuestion(request: APIRequestContext, t: ClaudeTerminal, question: string): Promise<void> {
  await postHook(request, "UserPromptSubmit", { session_id: t.claudeSessionId, cwd: t.cwd, prompt: "prepare the release" });
  await postHook(request, "PreToolUse", {
    session_id: t.claudeSessionId, cwd: t.cwd, tool_name: "mcp__topics__ask_user_question", tool_use_id: `toolu_ask_${t.id.slice(0, 6)}`,
    tool_input: { questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] },
  });
}

/** A turn that ends leaving a background Bash running. */
async function leaveJobRunning(request: APIRequestContext, t: ClaudeTerminal): Promise<void> {
  const input = { command: "bun run build --watch", run_in_background: true, description: "Build watcher" };
  await postHook(request, "UserPromptSubmit", { session_id: t.claudeSessionId, cwd: t.cwd, prompt: "start the watcher" });
  await postHook(request, "PreToolUse", { session_id: t.claudeSessionId, cwd: t.cwd, tool_name: "Bash", tool_use_id: `toolu_bg_${t.id.slice(0, 6)}`, tool_input: input });
  await postHook(request, "Stop", { session_id: t.claudeSessionId, cwd: t.cwd });
}

interface Scene {
  question: ClaudeTerminal;
  finished: ClaudeTerminal[];
  background: ClaudeTerminal;
  front: { id: string; name: string };
}

const FINISHED = ["Deploy staging", "Fix flaky login test", "Rename the billing module", "Bump dependencies", "Write the migration", "Profile the slow query", "Update the changelog", "Clean old branches"];

async function buildScene(request: APIRequestContext, page: Page, stamp: number): Promise<Scene> {
  const front = await createTopic(request, `Front Chat ${stamp}`, { provider: "topics" });
  const question = await createClaudeTerminal(request, `Release ${stamp}`);
  const finished: ClaudeTerminal[] = [];
  for (const name of FINISHED) finished.push(await createClaudeTerminal(request, `${name} ${stamp}`));
  const background = await createClaudeTerminal(request, `Watcher ${stamp}`);
  await resetPaneStore(request, [front.id]);
  await stubBannersAndWindow(page);
  const frames = recordAttentionFrames(page);
  await goToApp(page);
  await expect(page.getByTestId("inbox-button")).toBeVisible({ timeout: 15_000 });

  for (const [i, t] of finished.entries()) await finishTurn(request, t, FINISHED[i]!);
  await askQuestion(request, question, "Ship 2.3 to production tonight?");
  await leaveJobRunning(request, background);
  await expect
    .poll(() => [...frames.rows().values()].filter((r) => r.lit).length, { timeout: 20_000, message: "the subjects did not all light" })
    .toBe(FINISHED.length + 1);
  await expect.poll(() => frames.rows().get(terminalSubject(background.id))?.state, { timeout: 15_000 }).toBe("background");
  return { question, finished, background, front };
}

async function dropScene(request: APIRequestContext, s: Scene | null): Promise<void> {
  if (!s) return;
  for (const t of [s.question, s.background, ...s.finished]) await deleteTerminalSession(request, t.id);
  await deleteTopic(request, s.front.id);
}

const count = (page: Page) => page.getByTestId("inbox-count");
const panel = (page: Page) => page.getByTestId("inbox-panel");
const focusedSubject = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.subject ?? null);
const focusedTestId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.testid ?? null);

test.describe("the inbox: opening marks nothing, the keyboard does the rest", () => {
  test.describe.configure({ timeout: 120_000 });

  test("desktop, keyboard only: open, Enter on a finished row, E, shift-E; the question stays", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    let scene: Scene | null = null;
    try {
      scene = await buildScene(request, page, Date.now());
      const total = FINISHED.length + 1;
      await expect(count(page)).toHaveAttribute("data-notification-count", String(total));
      await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-waiting", "true");
      // The person is back at the window: from here on, nothing but keys.
      await setAwake(page, true);
      await page.getByTestId("inbox-button").focus();

      await page.keyboard.press("Meta+Shift+I");
      await expect(panel(page)).toBeVisible();
      const waiting = panel(page).getByTestId("inbox-waiting").getByTestId("inbox-row");
      const finished = panel(page).getByTestId("inbox-finished").getByTestId("inbox-row");
      await expect(waiting).toHaveCount(1);
      await expect(waiting.first()).toHaveAttribute("data-subject", terminalSubject(scene.question.id));
      await expect(finished).toHaveCount(FINISHED.length);
      await expect(panel(page).getByTestId("inbox-quiet")).toHaveAttribute("data-background", "1");
      // The focus is on the first row: the oldest wait.
      await expect.poll(() => focusedSubject(page)).toBe(terminalSubject(scene.question.id));
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: test.info().outputPath(`inbox-desktop-${scheme}.png`) });
      }
      await page.emulateMedia({ colorScheme: "light" });

      // Opening marked nothing: closed and open again, the same number.
      await page.keyboard.press("Escape");
      await expect(panel(page)).toBeHidden();
      await expect.poll(() => focusedTestId(page), { message: "Esc did not give the focus back to the button" }).toBe("inbox-button");
      await expect(count(page)).toHaveAttribute("data-notification-count", String(total));
      await page.keyboard.press("Meta+Shift+I");
      await expect(panel(page)).toBeVisible();
      await expect(finished).toHaveCount(FINISHED.length);

      // ↓ to the first «Finite» row (the most recent), Enter: it opens and is seen.
      await page.keyboard.press("ArrowDown");
      const opened = await focusedSubject(page);
      expect(opened, "the arrow did not land on a finished row").toBe(await finished.first().getAttribute("data-subject"));
      await page.keyboard.press("Enter");
      await expect(panel(page)).toBeHidden();
      await expect(page.locator(`[role="tab"][data-pane-id="${opened}"]`), "Enter did not open the terminal").toHaveAttribute("data-active", "true", { timeout: 15_000 });
      await expect(count(page)).toHaveAttribute("data-notification-count", String(total - 1), { timeout: 10_000 });

      // E marks the row in focus, and the focus stays in the list. (The
      // terminal that opened holds the keyboard; the chord reaches the app
      // from any element, but the focus is put back on the bell first so the
      // terminal does not receive the keys typed after it.)
      await page.getByTestId("inbox-button").focus();
      await page.keyboard.press("Meta+Shift+I");
      await expect(panel(page)).toBeVisible();
      await expect(finished).toHaveCount(FINISHED.length - 1);
      await page.keyboard.press("ArrowDown");
      const marked = await focusedSubject(page);
      await page.keyboard.press("e");
      await expect(panel(page).locator(`[data-testid="inbox-row"][data-subject="${marked}"]`)).toHaveCount(0, { timeout: 10_000 });
      await expect(count(page)).toHaveAttribute("data-notification-count", String(total - 2), { timeout: 10_000 });
      await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-inbox-row") ?? false), { message: "E took the focus out of the list" }).toBe(true);

      // ⇧E marks every «Finite» row; the question stays, amber, and counts.
      await page.keyboard.press("Shift+E");
      await expect(finished).toHaveCount(0, { timeout: 10_000 });
      await expect(waiting).toHaveCount(1);
      await expect(waiting.first()).toHaveAttribute("data-tier", "needs-you");
      await expect(count(page)).toHaveAttribute("data-notification-count", "1", { timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(panel(page)).toBeHidden();
      await expect.poll(() => focusedTestId(page)).toBe("inbox-button");
    } finally {
      await dropScene(request, scene);
    }
  });

  test("phone, 390 px: the inbox is a bottom sheet, and it scrolls", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "it-IT",
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    let scene: Scene | null = null;
    try {
      scene = await buildScene(request, page, Date.now());
      await expect(count(page)).toHaveAttribute("data-notification-count", String(FINISHED.length + 1));
      await page.getByTestId("inbox-button").tap();
      const sheet = panel(page);
      await expect(sheet).toBeVisible();
      // A sheet: it rests on the bottom edge and spans the screen.
      const box = (await sheet.boundingBox())!;
      expect(Math.round(box.y + box.height), "the panel does not rest on the bottom edge").toBeGreaterThanOrEqual(844 - 2);
      expect(box.width, "the panel does not span the phone").toBeGreaterThanOrEqual(390 - 2);
      // Rows are a finger's size.
      const row = (await sheet.locator("[data-inbox-row]").first().boundingBox())!;
      expect(row.height).toBeGreaterThanOrEqual(44);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: test.info().outputPath(`inbox-phone-${scheme}.png`) });
      }
      await page.emulateMedia({ colorScheme: "light" });

      // More rows than the sheet holds: the list scrolls to its last line.
      const list = sheet.getByTestId("inbox-panel-now");
      const overflow = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(overflow, "the rows fit: nothing to scroll, the case is not measured").toBeGreaterThan(0);
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(sheet.getByTestId("inbox-quiet")).toBeInViewport();
      await expect(sheet.getByTestId("inbox-mark-all")).toBeInViewport();
      // «Segna visto» is always there under the finger, on every «Finite» row.
      await expect(sheet.getByTestId("inbox-finished").getByTestId("inbox-mark-seen").first()).toHaveCSS("opacity", "1");
      await page.screenshot({ path: test.info().outputPath("inbox-phone-scrolled.png") });
    } finally {
      await ctx.close().catch(() => {});
      await dropScene(request, scene);
    }
  });
});
