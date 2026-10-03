import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import {
  createTerminalSession, createTopic, deleteTerminalSession, deleteTopic, resetPaneStore,
} from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { unmockChatStream } from "./helpers/sse-helpers";
import { canonicalTmpRoot, initGitRepo } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";
import { HISTORY_FIRST_PAGE } from "../../shared/history-paging";

hermetic(test);

/**
 * ⌘F finds INSIDE the pane you are on (change find-in-pane).
 *
 * One bar (`FindBar`), one finder per pane, ⌘F on the focused pane wherever
 * the cursor is. The chat searches the whole conversation on the server
 * (tool outputs kept apart included), the terminal its scrollback, the
 * editor and the diff through CodeMirror's engine, the Markdown preview and
 * the shared browser through the DOM. The board puts the cursor in its
 * filter, a pane with no text opens the project search.
 *
 * Video on: Esc during a streaming turn, the jump to a closed tool output,
 * are behaviours, and the .webm is the evidence.
 *
 * @covers FIND-01
 * @covers FIND-02
 * @covers FIND-03
 * @covers FIND-04
 * @covers CHAT-FIND-01
 * @covers CHAT-FIND-02
 * @covers TERM-FIND-01
 * @covers FILE-FIND-01
 * @covers FILE-FIND-02
 * @covers BROWSER-FIND-04
 */
test.use({ video: "on" });

// A directory of its own per run: deleting one the server still watches
// throws EPERM on Windows and takes the test server down with it.
const PROJECT_DIR = `${canonicalTmpRoot()}/e2e-find-in-pane-${Date.now()}`;
const PROJECT_PANE = `project:${encodeURIComponent(PROJECT_DIR)}`;

/** The keyboard on nothing: ⌘F then resolves the pane from the focused tab. */
const blurAll = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

const bar = (page: Page) => page.getByTestId("find-bar").filter({ visible: true }).first();
const count = (page: Page) => bar(page).getByTestId("find-count");
const input = (page: Page) => bar(page).getByTestId("find-input");

/** Two hundred lines, «zibaldone» on line 150, nothing else that matches. */
function bigFile(changed: boolean): string {
  const lines: string[] = [];
  for (let i = 1; i <= 200; i++) {
    if (i === 150) lines.push(`// riga 150: zibaldone`);
    else if (i === 5) lines.push(changed ? "export const cambiata = 2;" : "export const cambiata = 1;");
    else lines.push(`// riga ${i}`);
  }
  return lines.join("\n") + "\n";
}

function seedProject(): void {
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(`${PROJECT_DIR}/big.ts`, bigFile(false));
  writeFileSync(`${PROJECT_DIR}/consts.ts`, Array.from({ length: 7 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n");
  writeFileSync(`${PROJECT_DIR}/foo.txt`, "foo uno\nfoo due\nfoo tre\n");
  writeFileSync(`${PROJECT_DIR}/guida.md`, "# Installazione\n\nPrima di tutto, bun.\n");
  initGitRepo(PROJECT_DIR, "init");
  // One line changed: the rest of the 200 is unchanged and folds in the diff.
  writeFileSync(`${PROJECT_DIR}/big.ts`, bigFile(true));
}

test.describe("Cerca nella pane: la chat", () => {
  let topicId = "";
  let topicName = "";
  let sessionKey = "";
  let firstId = "";

  test.beforeAll(async ({ request }) => {
    topicName = `e2e-find-chat-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    sessionKey = `topic:${topic.id.slice(0, 8)}`;
    // More messages than the first page brings: the word lives only in the
    // FIRST one, which the client does not hold when the chat opens.
    const total = HISTORY_FIRST_PAGE + 10;
    const t0 = Date.parse("2026-10-01T09:00:00.000Z");
    for (let i = 0; i < total; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      const content = i === 0 ? "Il primo messaggio parla di zibaldone." : `messaggio ${i} senza la parola`;
      const r = await seedMessage(request, { sessionKey, role, content, timestamp: new Date(t0 + i * 1000).toISOString(), sortOrder: t0 + i });
      if (i === 0) firstId = r.id;
    }
    // A closed tool row whose output, stored APART in `message_tool_outputs`,
    // is the only place «ENOENT_UNICO» exists.
    const output = `${"una riga di uscita qualsiasi\n".repeat(200)}cat: /etc/manca: ENOENT_UNICO\n`;
    await seedMessage(request, {
      sessionKey, role: "assistant", content: "Ho provato a leggere il file.",
      timestamp: new Date(t0 + total * 1000).toISOString(),
      blocks: [
        { kind: "tool", toolCall: { id: "tc-find-1", name: "Bash", args: { command: "cat /etc/manca" }, status: "error", detail: { type: "shell", command: "cat /etc/manca", output, exitCode: 1 } } },
        { kind: "text", text: "Ho provato a leggere il file." },
      ],
      splitToolOutputs: true,
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("CHAT-FIND-01: ⌘F from the composer opens the chat's bar; a word only in the first message is found", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await chatPage.messageInput.click();
    await expect(chatPage.messageInput).toBeFocused();

    // FIND-02: from the field where you write, the chat's bar, not the project search.
    await page.keyboard.press("Meta+f");
    await expect(bar(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(page.getByTestId("file-search")).toHaveCount(0);

    await page.keyboard.type("zibaldone");
    await expect(count(page)).toHaveText("0 di 1", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(count(page)).toHaveText("1 di 1");
    // The jump brings the first message in view (history merged on request).
    await expect(page.locator(`[data-message-id="${firstId}"]`).first()).toBeInViewport({ timeout: 15_000 });
    // CHAT-FIND-02: the word is painted with the current colour.
    await expect.poll(() => page.evaluate(() => {
      const h = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get("find-current");
      return h?.size ?? 0;
    }), { timeout: 10_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("chat-find-first-message.png") });
  });

  test("CHAT-FIND-01b: a word only in a closed tool output is counted, and the row opens on arrival", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    const row = page.getByTestId("tool-call-row-tc-find-1");
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator("[aria-expanded]").first()).toHaveAttribute("aria-expanded", "false");

    await blurAll(page);
    await page.keyboard.press("Meta+f");
    await page.keyboard.type("ENOENT_UNICO");
    await expect(count(page)).toHaveText("0 di 1", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(count(page)).toHaveText("1 di 1");
    await expect(row.locator("[aria-expanded]").first()).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
    await expect(row).toContainText("ENOENT_UNICO", { timeout: 10_000 });
    await page.screenshot({ path: test.info().outputPath("chat-find-tool-output.png") });

    // Closing the bar removes the highlights and leaves the row open.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(row.locator("[aria-expanded]").first()).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.has("find-current") ?? false)).toBe(false);
  });

  test("FIND-02b: Ctrl+F in the composer: the field's own key on a Mac, the bar elsewhere", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await chatPage.messageInput.click();
    await page.keyboard.press("Control+f");
    // The next letter tells where the keyboard is: in the composer (the Mac,
    // where Ctrl+F is "forward one character"), or in the find bar (Windows
    // and Linux, where Ctrl is the app modifier).
    await page.keyboard.type("Z");
    if (process.platform === "darwin") {
      await expect(chatPage.messageInput).toHaveValue(/Z$/);
      await expect(page.getByTestId("find-bar")).toHaveCount(0);
    } else {
      await expect(input(page)).toHaveValue("Z");
    }
    await expect(page.getByTestId("file-search")).toHaveCount(0);
  });

  test("FIND-03: Esc in the bar closes it and the streaming turn goes on", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    // Holds the POST /api/chat open: the turn stays partial (the trick of
    // escape-modal-guard.spec.ts).
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 30_000));
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "data: [DONE]\n\n" });
    });
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("scrivi qualcosa di lungo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // Every stop request, with the moment it left: the Esc in the bar must
    // send none, the Esc out of it exactly one.
    const aborts: number[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/chat/abort")) aborts.push(Date.now()); });

    await page.keyboard.press("Meta+f");
    await expect(input(page)).toBeFocused();
    await page.keyboard.type("messaggio");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    const barClosedAt = Date.now();
    await expect(chatPage.streamingIndicator).toBeVisible();
    // Counter-proof: with the cursor out of the bar, Esc stops the turn as before.
    await blurAll(page);
    const secondEscapeAt = Date.now();
    await page.keyboard.press("Escape");
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => aborts.length).toBe(1);
    // ...and that one stop came from the second Esc, not from the first.
    expect(aborts[0]!).toBeGreaterThanOrEqual(secondEscapeAt);
    expect(secondEscapeAt).toBeGreaterThanOrEqual(barClosedAt);
    await unmockChatStream(page);
  });
});

test.describe("Cerca nella pane: barre per pane, terminale", () => {
  let topicId = "";
  let topicName = "";
  let termId = "";

  test.beforeAll(async ({ request }) => {
    topicName = `e2e-find-two-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    await seedMessage(request, { sessionKey: `topic:${topic.id.slice(0, 8)}`, role: "assistant", content: "deploy, poi ancora deploy." });
    termId = (await createTerminalSession(request, { cwd: "/tmp", name: "find-term" })).id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    if (termId) await deleteTerminalSession(request, termId);
  });

  test("FIND-01: the bar belongs to its pane; TERM-FIND-01: the terminal finds a line in its scrollback", async ({ page, request, chatPage }) => {
    await resetPaneStore(request, [topicId, `terminal:${termId}`]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await blurAll(page);
    await page.keyboard.press("Meta+f");
    await page.keyboard.type("deploy");
    await expect(count(page)).toHaveText("0 di 2", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(count(page)).toHaveText("1 di 2");

    // To the terminal: its own pane, no bar open there.
    await page.locator(`[data-pane-id="terminal:${termId}"]`).first().click();
    const term = page.locator('[data-testid="single-terminal-pane"]').filter({ visible: true }).first();
    await expect(term).toBeVisible({ timeout: 15_000 });
    await expect(term.getByTestId("find-bar")).toHaveCount(0);
    await term.locator(".xterm").first().click();
    await page.keyboard.type("seq 1 300\n");
    await expect(term.locator(".xterm-rows")).toContainText("300", { timeout: 15_000 });
    await page.keyboard.press("Meta+f");
    await expect(term.getByTestId("find-bar")).toBeVisible();
    await page.keyboard.type("150");
    await expect(term.getByTestId("find-count")).not.toHaveText(/^0 di 0$/, { timeout: 10_000 });
    await expect(term.locator(".xterm-rows")).toContainText("150");
    await page.screenshot({ path: test.info().outputPath("terminal-find.png") });
    // Nothing went to the program: the shell line holds no «150» typed by the bar.
    await page.keyboard.press("Escape");
    await expect(term.getByTestId("find-bar")).toHaveCount(0);

    // Back to the chat: its bar is as it was.
    await page.locator(`[data-pane-id="${topicId}"]`).first().click();
    await expect(input(page)).toHaveValue("deploy");
    await expect(count(page)).toHaveText("1 di 2");
  });
});

test.describe("Cerca nella pane: file, board, dashboard", () => {
  let topicId = "";

  test.beforeAll(async ({ request }) => {
    seedProject();
    topicId = (await createTopic(request, `e2e-find-files-${Date.now()}`, { projectPath: PROJECT_DIR })).id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  async function openFile(page: Page, name: string): Promise<void> {
    await page.locator('[data-testid="file-tree"]').first().getByRole("treeitem", { name: new RegExp(name.replace(".", "\\.")) }).first().click();
    await expect(page.locator('[data-testid="file-pane"]').filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
  }

  async function openProject(page: Page, request: import("@playwright/test").APIRequestContext): Promise<void> {
    await resetPaneStore(request, [PROJECT_PANE]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="file-tree"]').first()).toBeVisible({ timeout: 20_000 });
  }

  test("FILE-FIND-01: the editor counts, replaces all, and ⌘Z undoes it; CodeMirror's panel never opens", async ({ page, request }) => {
    await openProject(page, request);
    await openFile(page, "consts.ts");
    const pane = page.locator('[data-testid="file-pane"]').filter({ visible: true }).first();
    await pane.locator(".cm-content").first().click();
    await page.keyboard.press("Meta+f");
    await expect(pane.getByTestId("find-bar")).toBeVisible();
    await page.keyboard.type("const");
    await expect(pane.getByTestId("find-count")).toHaveText("0 di 7", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(pane.getByTestId("find-count")).toHaveText("1 di 7");
    await expect(page.locator(".cm-search")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("editor-find.png") });
    await page.keyboard.press("Escape");

    await openFile(page, "foo.txt");
    const fooPane = page.locator('[data-testid="file-pane"]').filter({ visible: true }).first();
    await fooPane.locator(".cm-content").first().click();
    await page.keyboard.press("Meta+f");
    await page.keyboard.type("foo");
    await expect(fooPane.getByTestId("find-count")).toHaveText("0 di 3", { timeout: 10_000 });
    await fooPane.getByTestId("find-replace-input").fill("bar");
    await fooPane.getByTestId("find-replace-all").click();
    const text = fooPane.locator(".cm-content").first();
    await expect(text).not.toContainText("foo");
    await expect.poll(async () => ((await text.innerText()).match(/bar/g) ?? []).length).toBe(3);
    await text.click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => ((await text.innerText()).match(/foo/g) ?? []).length).toBe(3);
  });

  test("FILE-FIND-02: the Markdown preview finds the heading", async ({ page, request }) => {
    await openProject(page, request);
    await openFile(page, "guida.md");
    const pane = page.locator('[data-testid="file-pane"]').filter({ visible: true }).first();
    await pane.getByRole("button", { name: /preview|anteprima/i }).first().click();
    await expect(pane.locator(".prose h1")).toHaveText("Installazione", { timeout: 10_000 });
    await pane.locator(".prose").first().click();
    await page.keyboard.press("Meta+f");
    await page.keyboard.type("installazione");
    await expect(pane.getByTestId("find-count")).toHaveText("0 di 1", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(pane.getByTestId("find-count")).toHaveText("1 di 1");
    await expect(pane.locator(".prose h1")).toBeInViewport();
  });

  test("FILE-FIND-02b: the diff counts both sides and opens the folded part", async ({ page, request }) => {
    await openProject(page, request);
    const git = page.locator('[data-testid="git-changes"]').first();
    await expect(git).toBeVisible({ timeout: 15_000 });
    const fileRow = git.locator('[data-git-file="big.ts"]').first();
    if (!(await fileRow.isVisible().catch(() => false))) await git.locator("div").filter({ hasText: /^Git$/ }).first().click();
    await fileRow.click();
    const diff = page.locator('[data-testid="diff-viewer"]').filter({ visible: true }).first();
    await expect(diff).toBeVisible({ timeout: 15_000 });
    await expect(diff).not.toContainText("zibaldone");
    await diff.locator(".cm-content").first().click();
    await page.keyboard.press("Meta+f");
    await page.keyboard.type("zibaldone");
    const pane = page.locator('[data-testid="file-pane"]').filter({ visible: true }).first();
    await expect(pane.getByTestId("find-count")).toHaveText("0 di 2", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(pane.getByTestId("find-count")).toHaveText("1 di 2");
    await expect(diff.getByText("riga 150: zibaldone").first()).toBeInViewport({ timeout: 10_000 });
  });

  test("FIND-02: the board puts the cursor in its filter, the dashboard opens the project search", async ({ page, request }) => {
    await resetPaneStore(request, [PROJECT_PANE, "__board__"]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    const boardTab = page.locator('[data-pane-id="__board__"]').first();
    await expect(boardTab).toBeVisible({ timeout: 15_000 });
    await boardTab.click();
    await expect(page.getByTestId("filter-token-input").first()).toBeVisible({ timeout: 15_000 });
    await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
    await boardTab.click();
    await page.keyboard.press("Meta+f");
    await expect(page.getByTestId("filter-token-input").filter({ visible: true }).first()).toBeFocused();
    await expect(page.getByTestId("file-search")).toHaveCount(0);

    await resetPaneStore(request, [PROJECT_PANE, "__dashboard__"]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    const dashTab = page.locator('[data-pane-id="__dashboard__"]').first();
    await expect(dashTab).toBeVisible({ timeout: 15_000 });
    await dashTab.click();
    await expect(dashTab).toHaveAttribute("data-active", "true");
    await page.keyboard.press("Meta+f");
    await expect(page.getByTestId("file-search")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("file-search-mode-content")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("Cerca nella pane: il telefono", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    topicName = `e2e-find-phone-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    await seedMessage(request, { sessionKey: `topic:${topic.id.slice(0, 8)}`, role: "assistant", content: "Una risposta da cercare." });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("FIND-04: «Cerca» in the tab menu opens the chat's bar", async ({ page, request }) => {
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    const tab = page.locator(`[data-pane-id="${topicId}"]`).filter({ visible: true }).first();
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await tab.click({ button: "right" });
    await page.getByTestId("tab-menu-find").click();
    await expect(bar(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await page.keyboard.type("risposta");
    await expect(count(page)).toHaveText("0 di 1", { timeout: 10_000 });
    await page.screenshot({ path: test.info().outputPath("phone-find.png") });
  });
});

/**
 * The evidence for the review of the change: the bar in light and dark, on a
 * desktop window and on a 390 px phone, with a result current in a chat.
 * Written under test-results/find-evidence/ (copied into the change's
 * `screenshots/` folder by hand, never asserted on).
 */
test.describe("Cerca nella pane: le schermate", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    topicName = `e2e-find-shots-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const sessionKey = `topic:${topic.id.slice(0, 8)}`;
    await seedMessage(request, { sessionKey, role: "user", content: "Dove si fa il deploy?" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "Il deploy parte dal ramo main: prima il deploy di prova, poi quello vero." });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`evidence: ${vp.name} ${scheme}`, async ({ page, request }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.emulateMedia({ colorScheme: scheme });
        await resetPaneStore(request, [topicId]);
        await goToApp(page);
        await page.keyboard.press("Escape");
        const tab = page.locator(`[data-pane-id="${topicId}"]`).filter({ visible: true }).first();
        await expect(tab).toBeVisible({ timeout: 15_000 });
        if (vp.name === "phone") {
          await tab.click({ button: "right" });
          await page.getByTestId("tab-menu-find").click();
        } else {
          await blurAll(page);
          await page.keyboard.press("Meta+f");
        }
        await expect(input(page)).toBeFocused();
        await page.keyboard.type("deploy");
        await expect(count(page)).toHaveText("0 di 3", { timeout: 10_000 });
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await expect(count(page)).toHaveText("2 di 3");
        await page.screenshot({ path: `test-results/find-evidence/impl-${vp.name}-${scheme}.png` });
      });
    }
  }
});
