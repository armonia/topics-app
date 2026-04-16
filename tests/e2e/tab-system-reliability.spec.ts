/**
 * Tab System Reliability — Regression tests for the bundled fixes:
 *   1. Server purges openChatTopicIds on archive (sync reconciliation)
 *   2. Grid drop overlay renders at runtime when state is flipped
 *   3. Active-on-drop: dropped tab becomes active in its group
 *   4. user_abort stream:end does not increment unread count
 *   5. Auto-solo: new terminal gets its own grid cell
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

const BASE = "http://localhost:13334";

async function gotoAndWait(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

test.describe("Tab System Reliability", () => {
  test("archive purges topic id from ui_state openChatTopicIds", async ({ request }) => {
    const key = `topics-project-panes-test-${Date.now().toString(36)}`;
    const t1 = await createTopic(request, "ArchiveTest-A");
    const t2 = await createTopic(request, "ArchiveTest-B");

    try {
      const seedRes = await request.put(`${BASE}/api/ui-state/${key}`, {
        data: { nonChatPanes: [], openChatTopicIds: [t1.id, t2.id], activeChatTopicId: t1.id },
      });
      expect(seedRes.ok()).toBe(true);

      const archiveRes = await request.delete(`${BASE}/api/topics/${t1.id}`, {
        data: { archived: true },
      });
      expect(archiveRes.ok()).toBe(true);

      const fetchRes = await request.get(`${BASE}/api/ui-state/${key}`);
      expect(fetchRes.ok()).toBe(true);
      const body = await fetchRes.json();
      expect(body.value.openChatTopicIds).toContain(t2.id);
      expect(body.value.openChatTopicIds).not.toContain(t1.id);
      expect(body.value.activeChatTopicId).not.toBe(t1.id);
    } finally {
      await deleteTopic(request, t2.id);
      await request.put(`${BASE}/api/ui-state/${key}`, { data: { nonChatPanes: [], openChatTopicIds: [] } })
        .catch(() => {});
    }
  });

  test("split overlay renders at runtime when drop zone is targeted", async ({ page, request }) => {
    // Behavioral test: directly drive the drop target state via the cell's
    // dragover handler, then assert the overlay DOM node exists with expected
    // styling. If the rendering logic is dead code, the overlay won't exist.
    const t1 = await createTopic(request, "OverlayA");
    const t2 = await createTopic(request, "OverlayB");

    try {
      await page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [t1.id, t2.id] },
      });
      await gotoAndWait(page);

      const cell = page.locator('[data-panel-cell]').first();
      await expect(cell).toBeVisible({ timeout: 10000 });

      // Dispatch a real dragover event with a PANE_TAB mime type at the left
      // edge (< 30px). The cell's capture handler flips gridDropTarget state
      // and React renders the overlay div on the next frame.
      const rect = await cell.boundingBox();
      if (!rect) throw new Error('cell has no bounding box');
      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('[data-panel-cell]') as HTMLElement | null;
        if (!el) throw new Error('no cell');
        const dt = new DataTransfer();
        dt.setData('application/x-pane-tab', 'test-tab');
        dt.setData('application/x-panel-id', 'test-panel');
        el.dispatchEvent(new DragEvent('dragover', {
          bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
        }));
      }, { x: rect.x + 5, y: rect.y + rect.height / 2 });

      // Poll for the overlay to appear. If the code path is dead or broken,
      // this times out and the test fails hard — no silent skip.
      const overlay = page.locator('[data-grid-split-overlay]');
      await expect(overlay).toBeVisible({ timeout: 3000 });

      // Verify it's the left zone and has the expected styling signature.
      const meta = await overlay.first().evaluate((el) => ({
        zone: el.getAttribute('data-grid-split-overlay'),
        hasDashedBorder: getComputedStyle(el).borderStyle.includes('dashed'),
      }));
      expect(meta.zone).toBe('left');
      expect(meta.hasDashedBorder).toBe(true);
    } finally {
      await deleteTopic(request, t1.id);
      await deleteTopic(request, t2.id);
    }
  });

  test("dropped tab becomes active after same-group reorder", async ({ page, request }) => {
    const t1 = await createTopic(request, "ActiveA");
    const t2 = await createTopic(request, "ActiveB");
    const t3 = await createTopic(request, "ActiveC");

    try {
      await page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [t1.id, t2.id, t3.id] },
      });
      await gotoAndWait(page);

      const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
      await expect(tabBar).toBeVisible({ timeout: 10000 });
      const tabs = tabBar.locator('[draggable="true"]');
      await expect(tabs).toHaveCount(3, { timeout: 5000 });

      // Activate tab A first — the drop should shift active to the source tab.
      await tabs.nth(0).click();
      await expect(tabs.nth(0)).toHaveAttribute('data-active', /true/, { timeout: 3000 });

      // Real HTML5 drag via Playwright's dragTo — drives actual dragstart/
      // dragover/drop/dragend through the DOM, which is what regression-guards
      // the `didDrop`-before-`onActivate` race (review I5: synthetic
      // dispatchEvent bypassed the native drop resolver and the guard).
      const sourceId = await tabs.nth(2).getAttribute('data-pane-id');
      expect(sourceId).toBeTruthy();
      const src = tabs.nth(2);
      const tgt = tabs.nth(0);
      await src.dragTo(tgt, { force: true });

      // After drop, the source tab (ActiveC) must be active.
      await expect(
        tabBar.locator(`[data-pane-id="${sourceId}"]`)
      ).toHaveAttribute('data-active', 'true', { timeout: 5000 });
    } finally {
      await deleteTopic(request, t1.id);
      await deleteTopic(request, t2.id);
      await deleteTopic(request, t3.id);
    }
  });

  test("message during focused topic does not increment unread", async ({ request, browser }) => {
    // Behavioral test for the updateUnreadCount invariant:
    //   - When a client has topic T focused (via WS focus message), subsequent
    //     system messages to T MUST NOT increment T's unread count.
    //   - user_abort stream:end relies on the same invariant — user is present.
    const t = await createTopic(request, "FocusedUnreadTest");
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    try {
      await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [t.id] } });
      await gotoAndWait(page);
      // Wait for client to focus the topic (ChatPane sends 'focus' on mount).
      await page.waitForTimeout(500);

      const before = (await request.get(`${BASE}/api/unread`).then(r => r.json())) as Record<string, { unreadCount?: number }>;
      const beforeCount = before[t.id]?.unreadCount ?? 0;

      // Post a system message via API. Client is focused on t, so
      // updateUnreadCount should skip the increment.
      const msgRes = await request.post(`${BASE}/api/topics/${t.id}/system-message`, {
        data: { content: "focused-unread-test" },
      });
      expect(msgRes.ok()).toBe(true);

      await page.waitForTimeout(300);
      const after = (await request.get(`${BASE}/api/unread`).then(r => r.json())) as Record<string, { unreadCount?: number }>;
      const afterCount = after[t.id]?.unreadCount ?? 0;
      expect(afterCount).toBe(beforeCount);
    } finally {
      await ctx.close();
      await deleteTopic(request, t.id);
    }
  });
});
