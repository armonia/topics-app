/**
 * A CHAT THAT FINISHES BANNERS LIKE A TERMINAL THAT FINISHES.
 *
 * The bug (29/09): a chat whose runtime reports no Claude Code hooks (provider
 * `topics`, Topics routing on, codex, jcode, ACP) never raised an OS banner when
 * its turn ended. The only edge every runtime sends is the server's
 * `stream:end { completed: true }`, and the client used it only to re-sort the
 * sidebar. The two paths that did banner needed either a hook phase
 * (`session:state`) or a HIDDEN window (`message:new`), and a Topics window that
 * sits behind another app is `visible`, not `hidden`.
 *
 * What is faked and what is not: the OS banner does not exist in a headless
 * browser, so `window.Notification` is a stub that counts and paints what the
 * app asked for. The window is modelled as "behind another app" the way macOS
 * reports it to a WKWebView: `visibilityState === 'visible'`, `hasFocus() ===
 * false`. The turn end is injected on the real WebSocket through
 * `page.routeWebSocket` (an external boundary), with the exact shape the server
 * broadcasts (`server/routes/chat.ts`). Everything in between is the real code.
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

declare global {
  interface Window {
    __bannerLog?: { title: string; body: string }[];
  }
}

/** Stub the delivery surface and put the window "behind another app". Must run
 *  before `goto`: a window that is not `granted` never builds a Notification. */
async function prepareBackgroundWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__bannerLog = [];
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.hasFocus = () => false;
    class FakeNotification {
      static permission = "granted";
      static requestPermission(): Promise<string> { return Promise.resolve("granted"); }
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: { body?: string }) {
        const body = opts?.body ?? "";
        window.__bannerLog!.push({ title, body });
        const card = document.createElement("div");
        card.setAttribute("data-testid", "fake-os-banner");
        card.style.cssText = [
          "position:fixed", "top:16px", "right:16px", "z-index:2147483647",
          "width:320px", "padding:12px 14px", "border-radius:12px",
          "background:#111", "color:#fff", "font:13px/1.4 -apple-system,system-ui,sans-serif",
          "box-shadow:0 8px 32px rgba(0,0,0,.5)", "border-left:4px solid #60a5fa",
        ].join(";");
        card.innerHTML =
          `<div style="opacity:.55;font-size:10px;letter-spacing:.08em;text-transform:uppercase">OS banner</div>` +
          `<div style="font-weight:600;margin-top:4px"></div><div style="opacity:.8;margin-top:2px"></div>`;
        (card.children[1] as HTMLElement).textContent = title;
        (card.children[2] as HTMLElement).textContent = body;
        document.body.appendChild(card);
      }
      close(): void { /* stays on screen so the video shows it */ }
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });
}

function bannerLog(page: Page): Promise<{ title: string; body: string }[]> {
  return page.evaluate(() => window.__bannerLog ?? []);
}

test.describe.serial("chat turn end → OS banner, whatever the runtime", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("a hookless chat that finishes raises one banner while Topics is behind another app", async ({ page, request }) => {
    const stamp = Date.now();
    const nameA = `Finished Chat ${stamp}`;
    const nameB = `Sentinel Chat ${stamp}`;
    const topicA = await createTopic(request, nameA, { provider: "topics" });
    const topicB = await createTopic(request, nameB, { provider: "topics" });
    const keyOf = async (id: string): Promise<string> => {
      const res = await request.get(`${E2E_BASE}/api/topics/${id}`, { ignoreHTTPSErrors: true });
      const { topic } = await res.json() as { topic: { sessionKey: string } };
      return topic.sessionKey;
    };
    const keyA = await keyOf(topicA.id);
    const keyB = await keyOf(topicB.id);

    try {
      await prepareBackgroundWindow(page);
      let inject: ((data: string) => void) | null = null;
      await page.routeWebSocket(/\/ws/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => ws.send(m));
        inject = (data: string) => ws.send(data);
      });
      const send = (frame: Record<string, unknown>): void => inject!(JSON.stringify({ type: "stream:end", ...frame }));

      await goToApp(page);
      // The banner title is the topic's name: the window must know the topic.
      for (const name of [nameA, nameB]) {
        await expect(page.getByRole("treeitem", { name: new RegExp(name) })).toBeVisible({ timeout: 15_000 });
      }
      expect(inject, "the WS route must have caught the socket").not.toBeNull();

      // Ends that are NOT a finished chat stay silent: a board agent's turn and a
      // turn the user stopped. The clean end right after is the sentinel: frames
      // on one socket arrive in order, so when its banner is there the two
      // before it have been handled.
      send({ sessionKey: keyA, topicId: topicA.id, messageId: "m-agent", completed: true, dispatched: true });
      send({ sessionKey: keyA, topicId: topicA.id, reason: "user_abort" });
      send({ sessionKey: keyA, topicId: topicA.id, messageId: "m-done", completed: true, stopReason: "end_turn", latencyMs: 4200 });

      await expect
        .poll(async () => (await bannerLog(page)).length, { timeout: 10_000, message: "the finished chat raised no banner" })
        .toBeGreaterThan(0);
      expect(await bannerLog(page)).toEqual([{ title: nameA, body: "In attesa di te" }]);
      await expect(page.locator('[data-testid="fake-os-banner"]')).toContainText(nameA);

      // A second end of the same chat within the cooldown does not stack a
      // second banner; another chat's end, sent after it, is the sentinel.
      send({ sessionKey: keyA, topicId: topicA.id, messageId: "m-done-2", completed: true });
      send({ sessionKey: keyB, topicId: topicB.id, messageId: "m-b", completed: true });
      await expect
        .poll(async () => (await bannerLog(page)).length, { timeout: 10_000, message: "the sentinel chat raised no banner" })
        .toBe(2);
      expect((await bannerLog(page)).map((b) => b.title)).toEqual([nameA, nameB]);
    } finally {
      await deleteTopic(request, topicA.id);
      await deleteTopic(request, topicB.id);
    }
  });
});
