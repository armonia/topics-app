/**
 * Tab System Reliability — Regression tests for the bundled fixes:
 *   1. Server purges openChatTopicIds on archive (sync reconciliation)
 *   2. Grid drop overlay renders at runtime when state is flipped
 *   3. Active-on-drop: dropped tab becomes active in its group
 *   4. user_abort stream:end does not increment unread count
 *   5. Auto-solo: new terminal gets its own grid cell
 *
 * @covers LAYOUT-01
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

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
        // PanelGrid dragover bails unless the standalone scope marker is present.
        dt.setData('application/x-pane-scope-yiyksu', '1');
        el.dispatchEvent(new DragEvent('dragover', {
          bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
        }));
      }, { x: rect.x + 5, y: rect.y + rect.height / 2 });

      // Poll for the overlay to appear. If the code path is dead or broken,
      // this times out and the test fails hard — no silent skip.
      const overlay = page.locator('[data-grid-split-overlay]');
      await expect(overlay).toBeVisible({ timeout: 3000 });

      // Verify it's the left zone and carries the split-region visual signature:
      // a single translucent FILL — NO dashed perimeter and NO seam line. The
      // fill alone is the indicator; a border or seam line reads as a SECOND
      // preview ("a line in the middle + an area on the side"), the double-
      // indicator we removed.
      const meta = await overlay.first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          zone: el.getAttribute('data-grid-split-overlay'),
          hasFill: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent',
          hasDashedBorder: cs.borderStyle.includes('dashed'),
        };
      });
      expect(meta.zone).toBe('left');
      expect(meta.hasFill).toBe(true);
      expect(meta.hasDashedBorder).toBe(false);
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
      // Reset the authoritative pane-store so hydrate unions to exactly these 3.
      await resetPaneStore(page.request, [t1.id, t2.id, t3.id]);
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

  // CAMBIO DI POLITICA DELIBERATO (2026-07-30). Questo test asseriva la vecchia
  // regola: "un client con la topic focussata SOPPRIME l'incremento del non-letto".
  // Quella regola era il difetto — vedi il task "I messaggi ad app in background
  // non diventano mai non-letti": la soppressione era senza nozione di tempo
  // ("presente = letto") e GLOBALE su tutti i client (una qualsiasi socket, anche
  // un altro device o una PWA dimenticata, con la topic focussata bastava a
  // sopprimere il badge per tutti). Ora vige UNA sola politica di lettura: il
  // server incrementa SEMPRE; solo un `read` esplicito (POST .../read, che il
  // client manda dopo la soglia di sguardo continuo) azzera. Il test e' stato
  // riscritto per fissare la NUOVA regola, non cancellato.
  test("system message always increments unread; only an explicit read clears it", async ({ request, browser }) => {
    const t = await createTopic(request, "FocusedUnreadTest");
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    try {
      await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [t.id] } });
      // Reset the authoritative pane-store so hydrate unions to exactly this topic.
      await resetPaneStore(page.request, [t.id]);
      await gotoAndWait(page);

      // Mount t's ChatPane (so a real client has it focused) — opening the tab
      // from the sidebar if hydrate didn't auto-activate it. Under the NEW policy
      // this focus must NOT suppress the increment; the barrier below makes the
      // "a client is focused" precondition deterministic so the assertion is
      // meaningful rather than accidentally passing on an un-focused topic.
      const input = page.getByRole("textbox", { name: /Message input/ });
      if (!(await input.isVisible().catch(() => false))) {
        await page.getByRole("treeitem", { name: /FocusedUnreadTest/ }).first().click().catch(() => {});
      }
      await expect(input).toBeVisible({ timeout: 15000 });

      // Deterministic focus barrier: open a test-owned WS that sends the SAME
      // `focus` frame a real client sends, then a `ping`; a `pong` on the SAME
      // connection proves the server processed `focus` first (frames are handled
      // in-order per connection). The socket stays open (stashed on window) so this
      // client keeps t focused across the POST — establishing the precondition
      // (a client IS focused on t) under which we assert the increment still fires.
      await page.evaluate(
        (topicId) =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
            (window as unknown as { __focusWs?: WebSocket }).__focusWs = ws;
            const timer = setTimeout(() => reject(new Error("focus barrier timeout")), 10000);
            ws.onopen = () => {
              ws.send(JSON.stringify({ type: "focus", topicId }));
              ws.send(JSON.stringify({ type: "ping" }));
            };
            ws.onmessage = (ev) => {
              try {
                if (JSON.parse(ev.data as string)?.type === "pong") {
                  clearTimeout(timer);
                  resolve();
                }
              } catch { /* ignore non-JSON frames */ }
            };
            ws.onerror = () => { clearTimeout(timer); reject(new Error("focus barrier ws error")); };
          }),
        t.id,
      );

      const before = (await request.get(`${BASE}/api/unread`).then(r => r.json())) as Record<string, { unreadCount?: number }>;
      const beforeCount = before[t.id]?.unreadCount ?? 0;

      // Post a system message via API. A client (the focus-barrier WS above) has
      // t focused, yet updateUnreadCount MUST still increment — no more "presente =
      // letto". The server mutates unread synchronously inside the POST handler, so
      // once this resolves the count is final — no post-hoc wait needed.
      const msgRes = await request.post(`${BASE}/api/topics/${t.id}/system-message`, {
        data: { content: "focused-unread-test" },
      });
      expect(msgRes.ok()).toBe(true);

      const after = (await request.get(`${BASE}/api/unread`).then(r => r.json())) as Record<string, { unreadCount?: number }>;
      const afterCount = after[t.id]?.unreadCount ?? 0;
      expect(afterCount).toBe(beforeCount + 1);

      // Only an explicit read clears it — this is the single read policy. (This is
      // exactly the POST the client fires after SEEN_DWELL_MS of continuous focus.)
      const readRes = await request.post(`${BASE}/api/topics/${t.id}/read`);
      expect(readRes.ok()).toBe(true);
      const afterRead = (await request.get(`${BASE}/api/unread`).then(r => r.json())) as Record<string, { unreadCount?: number }>;
      expect(afterRead[t.id]?.unreadCount ?? 0).toBe(0);
    } finally {
      await ctx.close();
      await deleteTopic(request, t.id);
    }
  });
});
