/**
 * CLOSING OR REQUEUEING SWITCHES THE SUBJECT OFF WHERE IT IS WRITTEN
 * (notifications-redesign, ATTN-13, T13-T15; tasks.md 5.4).
 *
 * The defects (ARCH-1, D4, F3 in the change's evidence): a finished chat
 * closed before it was read went on counting on the Dock, the badge and the
 * tray, because its unseen row stayed in the registry; a parked card put back
 * in the queue kept its «parked» row, and the bell kept it.
 *
 * Real server paths: the chats finish real turns on the chat route (a fake
 * CLI answers), the tab is closed with its own X (the deferred close that
 * archives the chat), the card is parked by the dispatcher's own service
 * (`setDispatchState`, through the test seam that is the only way to reach it
 * without an agent) and put back in the queue with the board's PATCH. The PWA
 * badge is the Badging API, recorded.
 */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { closeTabViaX } from "./helpers/multi-client";
import { recordAttentionFrames, runChatTurn, stubBannersAndWindow } from "./helpers/attention";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { taskSubject, topicSubject } from "../../shared/attention";

hermetic(test);

declare global {
  interface Window { __badgeLog?: number[] }
}

/** Records every number the app writes on the PWA badge. Before `goto`. */
async function recordBadge(page: Page): Promise<() => Promise<number | undefined>> {
  await page.addInitScript(() => {
    window.__badgeLog = [];
    const nav = navigator as unknown as { setAppBadge: (n?: number) => Promise<void>; clearAppBadge: () => Promise<void> };
    nav.setAppBadge = (n?: number) => { window.__badgeLog!.push(n ?? 0); return Promise.resolve(); };
    nav.clearAppBadge = () => { window.__badgeLog!.push(0); return Promise.resolve(); };
  });
  return () => page.evaluate(() => window.__badgeLog?.at(-1));
}

const count = (page: Page) => page.getByTestId("inbox-count");

test.describe("closing a finished chat, requeueing a parked card", () => {
  test.describe.configure({ timeout: 120_000 });

  test("closing the tab of a finished chat takes it off the bell, the badge and the inbox", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-13" });
    const removeCli = installSlowTurnCli();
    const stamp = Date.now();
    const closing = await createTopic(request, `Closing Chat ${stamp}`, { provider: "claude-code" });
    const staying = await createTopic(request, `Staying Chat ${stamp}`, { provider: "claude-code" });
    const front = await createTopic(request, `Front Chat ${stamp}`, { provider: "topics" });
    try {
      await resetPaneStore(request, [front.id, closing.id, staying.id]);
      await stubBannersAndWindow(page);
      const badge = await recordBadge(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const tab = (name: string) => page.locator('[role="tab"][data-pane-id]', { hasText: name });
      await expect(tab(closing.name)).toBeVisible({ timeout: 15_000 });
      await tab(front.name).click();

      await runChatTurn(request, closing.id, "finish one");
      await runChatTurn(request, staying.id, "finish two");
      await expect(tab(closing.name)).toHaveAttribute("data-attention", "done", { timeout: 15_000 });
      await expect(tab(staying.name)).toHaveAttribute("data-attention", "done", { timeout: 15_000 });
      await expect(count(page)).toHaveAttribute("data-notification-count", "2");
      await expect.poll(badge, { timeout: 10_000, message: "the PWA badge does not count the two chats" }).toBe(2);

      // Closed before it was read: the chat archives, and it stops counting everywhere.
      await closeTabViaX(page, closing.id);
      await expect(tab(closing.name)).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => frames.rows().get(topicSubject(closing.id))?.lit ?? false, { timeout: 15_000, message: "the closed chat is still lit on the server" }).toBe(false);
      await expect(count(page)).toHaveAttribute("data-notification-count", "1", { timeout: 10_000 });
      await expect.poll(badge, { timeout: 10_000 }).toBe(1);
      await page.getByTestId("inbox-button").click();
      const rows = page.getByTestId("inbox-panel").getByTestId("inbox-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toHaveAttribute("data-subject", topicSubject(staying.id));
      await page.keyboard.press("Escape");
    } finally {
      removeCli();
      await deleteTopic(request, closing.id);
      await deleteTopic(request, staying.id);
      await deleteTopic(request, front.id);
    }
  });

  test("a parked card put back in the queue leaves the inbox", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-13" });
    const projectPath = canonicalTmpDir("e2e-attention-park");
    mkdirSync(projectPath, { recursive: true });
    const projectId = projectIdForPath(projectPath);
    const anchor = await createTopic(request, `Park Board ${Date.now()}`, { projectPath, provider: "topics" });
    let taskId = "";
    try {
      // No agent may take the card when it goes back to the queue.
      expect((await request.patch(`${E2E_BASE}/api/all-boards/settings`, { data: { autoDispatch: false } })).ok()).toBe(true);
      const created = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, { data: { text: "Migrate the photo bucket", status: "backlog" } });
      expect(created.ok(), await created.text()).toBe(true);
      taskId = ((await created.json()) as { id: string }).id;

      await resetPaneStore(request, [anchor.id]);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      await expect(page.getByTestId("inbox-button")).toBeVisible({ timeout: 15_000 });

      // The dispatcher parks it: the launch failed.
      const parked = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/dispatch-state`, { data: { state: "failed", error: "The worktree could not be created" } });
      expect(parked.ok(), await parked.text()).toBe(true);
      await expect.poll(() => frames.rows().get(taskSubject(taskId))?.reason ?? null, { timeout: 15_000, message: "the parked card is not needs-you(parked)" }).toBe("parked");
      await expect(count(page)).toHaveAttribute("data-notification-count", "1", { timeout: 10_000 });
      await page.getByTestId("inbox-button").click();
      const waiting = page.getByTestId("inbox-panel").getByTestId("inbox-waiting").getByTestId("inbox-row");
      await expect(waiting).toHaveCount(1);
      await expect(waiting.first()).toHaveAttribute("data-subject", taskSubject(taskId));
      await page.keyboard.press("Escape");

      // Put back in the queue: the wait is over, the row goes, the bell is empty.
      const requeued = await request.patch(`${E2E_BASE}/api/boards/${projectId}/tasks/${taskId}`, { data: { status: "todo" } });
      expect(requeued.ok(), await requeued.text()).toBe(true);
      await expect.poll(() => frames.rows().get(taskSubject(taskId))?.lit ?? false, { timeout: 15_000, message: "the requeued card is still lit" }).toBe(false);
      await expect(count(page)).toHaveCount(0, { timeout: 10_000 });
      await page.getByTestId("inbox-button").click();
      await expect(page.getByTestId("inbox-panel").getByTestId("inbox-row")).toHaveCount(0);
      await expect(page.getByTestId("inbox-panel").getByTestId("inbox-empty")).toBeVisible();
    } finally {
      if (taskId) await deleteTask(request, projectId, taskId).catch(() => {});
      await deleteTopic(request, anchor.id);
      removeTmpDir(projectPath);
    }
  });
});
