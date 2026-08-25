/**
 * Unread badge — regression for "messages to an app in background never go
 * unread" (2026-07-30).
 *
 * The old rule suppressed the unread increment whenever ANY live socket had the
 * topic focused (`isTopicFocused`) — a global, timeless "present = read". A
 * second device (or a forgotten PWA) with the topic focused was enough to kill
 * the badge for EVERYONE. This test pins the new single-policy behaviour: a
 * message to a topic that ANOTHER client holds focused still badges HERE.
 *
 * @covers TAB-BADGE-01
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

async function gotoAndWait(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

test.describe("Unread badge survives another client's focus", () => {
  test("message to a topic focused by ANOTHER client still badges here", async ({ page, request }) => {
    const a = await createTopic(request, "OtherDeviceFocused-A");
    const b = await createTopic(request, "ActiveHere-B");
    try {
      await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [a.id, b.id] } });
      await resetPaneStore(page.request, [a.id, b.id]);
      await gotoAndWait(page);

      // Make B the active pane HERE, so A sits in the background on this client —
      // it never becomes the "seen" topic, so this client won't self-clear A.
      await page.getByRole("treeitem", { name: /ActiveHere-B/ }).first().click().catch(() => {});

      // Another client (a second device / a forgotten PWA) holds A focused. Open a
      // raw WS that sends the same `focus` frame a real client sends, then a `ping`;
      // a `pong` on the same connection proves the server processed `focus` first.
      // Under the OLD global-suppression rule this alone killed the badge for all.
      await page.evaluate(
        (topicId) =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
            (window as unknown as { __otherDeviceWs?: WebSocket }).__otherDeviceWs = ws;
            const timer = setTimeout(() => reject(new Error("focus barrier timeout")), 10000);
            ws.onopen = () => {
              ws.send(JSON.stringify({ type: "focus", topicId }));
              ws.send(JSON.stringify({ type: "ping" }));
            };
            ws.onmessage = (ev) => {
              try {
                if (JSON.parse(ev.data as string)?.type === "pong") { clearTimeout(timer); resolve(); }
              } catch { /* ignore non-JSON frames */ }
            };
            ws.onerror = () => { clearTimeout(timer); reject(new Error("focus barrier ws error")); };
          }),
        a.id,
      );

      // A message lands on A while another client has it focused.
      const msg = await request.post(`${BASE}/api/topics/${a.id}/system-message`, {
        data: { content: "hey from elsewhere" },
      });
      expect(msg.ok()).toBe(true);

      // THIS client must show the unread badge on A's sidebar row.
      const aRow = page.getByRole("treeitem", { name: /OtherDeviceFocused-A/ }).first();
      await expect(aRow.getByLabel(/unread/)).toBeVisible({ timeout: 8000 });
    } finally {
      await page.evaluate(() => (window as unknown as { __otherDeviceWs?: WebSocket }).__otherDeviceWs?.close())
        .catch(() => {});
      await deleteTopic(request, a.id);
      await deleteTopic(request, b.id);
    }
  });
});
