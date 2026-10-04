/**
 * Unread badge — regression for "messages to an app in background never go
 * unread" (2026-07-30).
 *
 * The old rule suppressed the unread increment whenever ANY live socket had the
 * topic focused (`isTopicFocused`) — a global, timeless "present = read". A
 * second device (or a forgotten PWA) with the topic focused was enough to kill
 * the badge for EVERYONE. This test pins the new single-policy behaviour: a
 * turn that finishes on a topic that ANOTHER client holds focused, but not
 * awake (a forgotten PWA, a window behind another app), still badges HERE.
 * Since notifications-redesign the rule is the server's born-seen (ATTN-06):
 * only a socket of the person, awake AND focused on the subject, makes the
 * epoch born seen; the second test pins that half. The turns are real (the
 * chat route, a fake CLI), the other client is a raw socket of the same
 * person sending the `focus` frame a real client sends.
 *
 * @covers TAB-BADGE-01
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { recordAttentionFrames, runChatTurn, stubBannersAndWindow } from "./helpers/attention";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

async function gotoAndWait(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

/** Another client of the same person holding `topicId` in front, awake or not; resolves once the server processed the frame. */
function otherClientFocus(page: Page, topicId: string, awake: boolean): Promise<void> {
  return page.evaluate(
    ({ topicId, awake }) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
        (window as unknown as { __otherDeviceWs?: WebSocket }).__otherDeviceWs = ws;
        const timer = setTimeout(() => reject(new Error("focus barrier timeout")), 10000);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "focus", topicId, subject: `topic:${topicId}`, awake }));
          ws.send(JSON.stringify({ type: "ping" }));
        };
        ws.onmessage = (ev) => {
          try {
            if (JSON.parse(ev.data as string)?.type === "pong") { clearTimeout(timer); resolve(); }
          } catch { /* ignore non-JSON frames */ }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error("focus barrier ws error")); };
      }),
    { topicId, awake },
  );
}

test.describe("Unread badge survives another client's focus", () => {
  let removeCli: (() => void) | null = null;
  test.beforeAll(() => { removeCli = installSlowTurnCli(); });
  test.afterAll(() => { removeCli?.(); removeCli = null; });

  for (const awake of [false, true]) {
    test(awake
      ? "a turn on a topic another client holds in front, AWAKE, is born seen: no badge here either"
      : "a turn on a topic focused by ANOTHER client that is not awake still badges here", async ({ page, request }) => {
      test.info().annotations.push({ type: "spec", description: "ATTN-06" });
      const a = await createTopic(request, `OtherDeviceFocused-A-${awake ? "awake" : "asleep"}`, { provider: "claude-code" });
      const b = await createTopic(request, "ActiveHere-B", { provider: "claude-code" });
      try {
        await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [a.id, b.id] } });
        await resetPaneStore(page.request, [a.id, b.id]);
        // This window is behind another app: nothing here is born seen.
        await stubBannersAndWindow(page);
        const frames = recordAttentionFrames(page);
        await gotoAndWait(page);
        // B is the active pane HERE, so A never becomes the "seen" topic on this client.
        await page.getByRole("treeitem", { name: /ActiveHere-B/ }).first().click().catch(() => {});

        await otherClientFocus(page, a.id, awake);
        await runChatTurn(request, a.id, "hey from elsewhere");
        // The sentinel: B's turn, after A's. Frames are applied in order, so
        // once B's state is here, A's has been applied too.
        await runChatTurn(request, b.id, "sentinel");
        await expect.poll(() => frames.rows().get(`topic:${b.id}`)?.lit ?? false, { timeout: 8000 }).toBe(true);

        const aRow = page.getByRole("treeitem", { name: new RegExp(a.name) }).first();
        if (awake) await expect(aRow.locator("[data-notification-count]")).toHaveCount(0);
        else await expect(aRow.locator("[data-notification-count]")).toBeVisible({ timeout: 8000 });
      } finally {
        await page.evaluate(() => (window as unknown as { __otherDeviceWs?: WebSocket }).__otherDeviceWs?.close())
          .catch(() => {});
        await deleteTopic(request, a.id);
        await deleteTopic(request, b.id);
      }
    });
  }
});
