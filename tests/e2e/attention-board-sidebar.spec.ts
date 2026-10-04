/**
 * A WAIT IN THE MIDDLE OF A TURN, A CARD IN REVIEW, A CHAT READ ELSEWHERE
 * (notifications-redesign, ATTN-04, ATTN-14, ATTN-16; tasks.md 5.6).
 *
 * The defects (D6, F5 in the change's evidence): a permission asked in the
 * middle of a turn read as "working", with no wait anywhere; the board tab
 * counted only reviews, from a cache; a chat read on the Mac kept the top of
 * the phone's sidebar because its old unread count still sorted it there.
 *
 * Real server paths throughout. The permission is the bridge's own route, the
 * legs the CLI's permission tool makes (`POST /api/sessions/:key/permission`)
 * on a turn row seeded with the tool waiting, and it is answered from the
 * chat's panel; the card is put in review and decided through the board's
 * routes; the chats finish real turns on the chat route (a fake CLI answers).
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { seedMessage } from "./helpers/seed-messages";
import { postHook, recordAttentionFrames, runChatTurn, sessionKeyOf, setAwake, stubBannersAndWindow } from "./helpers/attention";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { taskSubject, topicSubject } from "../../shared/attention";

hermetic(test);

const TOOL = "mcp__gateway__kiwi__search-flight";
const TOOL_INPUT = { flyFrom: "NAP", flyTo: "RAK" };

/** The bridge's legs, as the CLI's permission tool makes them, until somebody decides. */
function askPermission(request: APIRequestContext, sessionKey: string, toolUseId: string): Promise<{ decision?: string; cancelled?: boolean }> {
  return (async () => {
    for (let legs = 0; legs < 120; legs++) {
      const r = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
        data: { toolName: TOOL, input: TOOL_INPUT, toolUseId, legMs: 1000 }, timeout: 30_000,
      });
      const body = (await r.json()) as { decision?: string; cancelled?: boolean; pending?: boolean };
      if (!body.pending) return body;
    }
    throw new Error("nobody decided the permission");
  })();
}

const tabOf = (page: Page, name: string) => page.locator('[role="tab"][data-pane-id]', { hasText: name });
const count = (page: Page) => page.getByTestId("inbox-count");

test.describe("a wait in the middle of a turn, a card in review, a chat read elsewhere", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a permission asked in the middle of a turn is «waiting for you» on the tab and in the inbox, and the answer switches it off", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-04" });
    const stamp = Date.now();
    const chat = await createTopic(request, `Asking Chat ${stamp}`, { provider: "claude-code" });
    const front = await createTopic(request, `Front Chat ${stamp}`, { provider: "topics" });
    const sessionKey = await sessionKeyOf(request, chat.id);
    const toolCallId = `toolu_attn_perm_${stamp}`;
    try {
      await request.delete(`${E2E_BASE}/api/tool-grants/${encodeURIComponent(TOOL)}`);
      await request.patch(`${E2E_BASE}/api/topics/${chat.id}`, { data: { autonomyLevel: "auto-apply" } });
      // The turn as the route paints it: the tool on the row, waiting on the person.
      const tc = {
        id: toolCallId, name: TOOL, args: TOOL_INPUT, status: "awaiting_permission" as const, startedAt: Date.now(),
        permissionRequest: { toolName: TOOL, input: TOOL_INPUT, requestedAt: Date.now() },
      };
      await seedMessage(request, { sessionKey, role: "user", content: "find a flight" });
      await seedMessage(request, { sessionKey, role: "assistant", content: "Searching:", toolCalls: [tc], blocks: [{ kind: "text", text: "Searching:" }, { kind: "tool", toolCall: tc }] });
      await resetPaneStore(request, [front.id, chat.id]);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      await expect(tabOf(page, chat.name)).toBeVisible({ timeout: 15_000 });
      await tabOf(page, front.name).click();

      const decided = askPermission(request, sessionKey, toolCallId);
      await expect.poll(() => frames.rows().get(topicSubject(chat.id))?.reason ?? null, { timeout: 15_000, message: "the permission is not needs-you(permission)" }).toBe("permission");
      await expect(tabOf(page, chat.name)).toHaveAttribute("data-attention", "needs-you", { timeout: 10_000 });
      await expect(count(page)).toHaveAttribute("data-notification-count", "1");
      await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-waiting", "true");
      await page.getByTestId("inbox-button").click();
      const waiting = page.getByTestId("inbox-panel").getByTestId("inbox-waiting").getByTestId("inbox-row");
      await expect(waiting).toHaveCount(1);
      await expect(waiting.first()).toHaveAttribute("data-subject", topicSubject(chat.id));
      await page.screenshot({ path: test.info().outputPath("needs-you-permission.png") });
      // The row opens the chat where it waits: the panel of the permission.
      await setAwake(page, true);
      await waiting.first().locator("[data-inbox-row]").click();
      const panel = page.locator(`[data-testid="tool-permission-${toolCallId}"]`);
      await expect(panel).toBeVisible({ timeout: 15_000 });
      // Seen is not answered: the wait stays amber while the panel is open.
      await expect(tabOf(page, chat.name)).toHaveAttribute("data-attention", "needs-you");
      await panel.locator(`[data-testid="tool-permission-allow-${toolCallId}"]`).click();
      expect((await decided).decision).toBe("allow");
      await expect.poll(() => frames.rows().get(topicSubject(chat.id))?.lit ?? false, { timeout: 15_000, message: "the answer did not switch the wait off" }).toBe(false);
      await expect(tabOf(page, chat.name)).not.toHaveAttribute("data-attention", /.+/, { timeout: 10_000 });
      await expect(count(page)).toHaveCount(0);
    } finally {
      await deleteTopic(request, chat.id);
      await deleteTopic(request, front.id);
    }
  });

  test("a card in review counts on the board tab and in the inbox, and the decision switches it off", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-16" });
    const projectPath = canonicalTmpDir("e2e-attention-board");
    mkdirSync(projectPath, { recursive: true });
    const projectId = projectIdForPath(projectPath);
    const anchor = await createTopic(request, `Review Board ${Date.now()}`, { projectPath, provider: "topics" });
    let taskId = "";
    try {
      expect((await request.patch(`${E2E_BASE}/api/all-boards/settings`, { data: { autoDispatch: false } })).ok()).toBe(true);
      await resetPaneStore(request, ["__board__"]);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const boardTab = page.locator('[role="tab"][data-pane-id="__board__"]');
      await expect(boardTab).toBeVisible({ timeout: 15_000 });
      await expect(boardTab.getByTestId("tab-board-count-review")).toHaveCount(0);

      const created = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, { data: { text: "Rewrite the product page", status: "review" } });
      expect(created.ok(), await created.text()).toBe(true);
      taskId = ((await created.json()) as { id: string }).id;
      await expect.poll(() => frames.rows().get(taskSubject(taskId))?.reason ?? null, { timeout: 15_000 }).toBe("review");
      await expect(boardTab.getByTestId("tab-board-count-review"), "the board tab does not count the card in review").toHaveAttribute("data-notification-count", "1", { timeout: 10_000 });
      await expect(count(page)).toHaveAttribute("data-notification-count", "1");
      await page.getByTestId("inbox-button").click();
      const waiting = page.getByTestId("inbox-panel").getByTestId("inbox-waiting").getByTestId("inbox-row");
      await expect(waiting).toHaveCount(1);
      await expect(waiting.first()).toHaveAttribute("data-subject", taskSubject(taskId));
      await page.keyboard.press("Escape");

      const decided = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks/${taskId}/review`, { data: { decision: "approve" } });
      expect(decided.ok(), await decided.text()).toBe(true);
      await expect.poll(() => frames.rows().get(taskSubject(taskId))?.lit ?? false, { timeout: 15_000, message: "the decision did not switch the card off" }).toBe(false);
      await expect(boardTab.getByTestId("tab-board-count-review")).toHaveCount(0, { timeout: 10_000 });
      await expect(count(page)).toHaveCount(0);
    } finally {
      if (taskId) await deleteTask(request, projectId, taskId);
      await deleteTopic(request, anchor.id);
      removeTmpDir(projectPath);
    }
  });

  test("a chat read in one page drops from the top of the sidebar in both pages", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-14" });
    const removeCli = installSlowTurnCli();
    const stamp = Date.now();
    const lit = await createTopic(request, `Lit Chat ${stamp}`, { provider: "claude-code" });
    const fresh = await createTopic(request, `Fresh Chat ${stamp}`, { provider: "claude-code" });
    const front = await createTopic(request, `Front Chat ${stamp}`, { provider: "topics" });
    await resetPaneStore(request, [front.id, lit.id, fresh.id]);
    const open = async (b: Browser): Promise<{ ctx: BrowserContext; page: Page }> => {
      const ctx = await b.newContext({ baseURL: E2E_BASE, viewport: { width: 1280, height: 800 }, locale: "it-IT", reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await stubBannersAndWindow(page);
      await goToApp(page);
      await expect(tabOf(page, lit.name)).toBeVisible({ timeout: 15_000 });
      await tabOf(page, front.name).click();
      return { ctx, page };
    };
    const A = await open(browser);
    const B = await open(browser);
    /** Where a chat's row sits among the rows of the sidebar. */
    const rowIndex = (page: Page, name: string) =>
      page.getByRole("treeitem").evaluateAll((els, n) => els.findIndex((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").includes(n)), name);
    try {
      // `lit` finishes while nobody looks: it lights and goes to the top. Its
      // CLI reports the end through the hooks too (`Stop`), as a Claude Code
      // chat with hooks does: the phase `awaiting-user` is what used to keep
      // a read chat counted and floating on top (F5).
      await runChatTurn(request, lit.id, "finish behind");
      const litKey = await sessionKeyOf(request, lit.id);
      let litCli = "";
      await expect.poll(async () => {
        const { sessions } = (await (await request.get(`${E2E_BASE}/api/claude-sessions`)).json()) as { sessions: { sessionKey: string | null; claudeSessionId: string }[] };
        litCli = sessions.find((x) => x.sessionKey === litKey)?.claudeSessionId ?? "";
        return litCli;
      }, { timeout: 10_000, message: "the chat's CLI session is not tracked" }).not.toBe("");
      await postHook(request, "Stop", { session_id: litCli });
      // `fresh` finishes after it, in front of A, awake: born seen, newer activity.
      await setAwake(A.page, true);
      await tabOf(A.page, fresh.name).click();
      await expect(tabOf(A.page, fresh.name)).toHaveAttribute("data-active", "true");
      await runChatTurn(request, fresh.id, "finish in front");
      for (const p of [A.page, B.page]) {
        await expect(p.getByRole("treeitem", { name: lit.name, exact: true })).toHaveAttribute("data-attention", "done", { timeout: 15_000 });
        await expect.poll(async () => (await rowIndex(p, lit.name)) < (await rowIndex(p, fresh.name)), { timeout: 10_000, message: "the lit chat is not above the newer one" }).toBe(true);
      }

      // A reads it: in both pages it goes back to its place by activity.
      await tabOf(A.page, lit.name).click();
      for (const p of [A.page, B.page]) {
        await expect(p.getByRole("treeitem", { name: lit.name, exact: true })).not.toHaveAttribute("data-attention", /.+/, { timeout: 15_000 });
        await expect.poll(async () => (await rowIndex(p, lit.name)) > (await rowIndex(p, fresh.name)), { timeout: 10_000, message: "the read chat kept the top" }).toBe(true);
      }
    } finally {
      removeCli();
      await A.ctx.close().catch(() => {});
      await B.ctx.close().catch(() => {});
      await deleteTopic(request, lit.id);
      await deleteTopic(request, fresh.id);
      await deleteTopic(request, front.id);
    }
  });
});
