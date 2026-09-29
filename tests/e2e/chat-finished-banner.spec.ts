/**
 * A CHAT THAT FINISHES BANNERS, AND STAYS MARKED, LIKE A TERMINAL THAT FINISHES.
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
 *
 * The second half is the mark (CHAT-DONE-01): a finished terminal keeps a
 * 'done' tier on its tab until you open it, and a hookless chat had nothing but
 * an unread count, hidden on the active tab. Now the chat's row and tab carry
 * the same `data-attention="done"` a finished terminal's tab carries. The
 * third test is a chat held by ANOTHER window: its row here is the only place
 * the mark shows, and the click that brings that window forward must clear it.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { fakeTauriShell } from "./helpers/fake-tauri-shell";

hermetic(test);

declare global {
  interface Window {
    __bannerLog?: { title: string; body: string }[];
    __shellCalls?: string[];
  }
}

/** Stub the delivery surface and put the window "behind another app" (or, with
 *  `focused`, in front of you). Must run before `goto`: a window that is not
 *  `granted` never builds a Notification. */
async function prepareBackgroundWindow(page: Page, { focused = false }: { focused?: boolean } = {}): Promise<void> {
  await page.addInitScript((hasFocus: boolean) => {
    window.__bannerLog = [];
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.hasFocus = () => hasFocus;
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
  }, focused);
}

function bannerLog(page: Page): Promise<{ title: string; body: string }[]> {
  return page.evaluate(() => window.__bannerLog ?? []);
}

async function sessionKeyOf(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics/${id}`, { ignoreHTTPSErrors: true });
  const { topic } = await res.json() as { topic: { sessionKey: string } };
  return topic.sessionKey;
}

/** Pass the page's socket through and return a way to push frames on it, as
 *  the server would broadcast them. Survives a reload: the route re-catches
 *  the new socket and `send` follows it. With `otherWindow`, every roster the
 *  server sends (`presence:windows`, after each `hello` and announce) arrives
 *  with that window added: a roster injected once loses to the server's next
 *  one (the same reason as `declareOtherWindow` in spaces-switcher.spec.ts). */
async function routeStreamFrames(
  page: Page,
  { otherWindow }: { otherWindow?: Record<string, unknown> } = {},
): Promise<(frame: Record<string, unknown>) => void> {
  let inject: ((data: string) => void) | null = null;
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (otherWindow && typeof m === "string" && m.includes('"presence:windows"')) {
        const roster = JSON.parse(m) as { windows?: unknown[] };
        ws.send(JSON.stringify({ ...roster, windows: [...(roster.windows ?? []), otherWindow] }));
        return;
      }
      ws.send(m);
    });
    inject = (data: string) => ws.send(data);
  });
  return (frame) => {
    if (!inject) throw new Error("the WS route has not caught the socket");
    inject(JSON.stringify(frame));
  };
}

test.describe.serial("chat turn end → OS banner, whatever the runtime", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("a hookless chat that finishes raises one banner while Topics is behind another app", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DONE-02" });
    const stamp = Date.now();
    const nameA = `Finished Chat ${stamp}`;
    const nameB = `Sentinel Chat ${stamp}`;
    const nameC = `Gate Chat ${stamp}`;
    const topicA = await createTopic(request, nameA, { provider: "topics" });
    const topicB = await createTopic(request, nameB, { provider: "topics" });
    const topicC = await createTopic(request, nameC, { provider: "topics" });
    const keyA = await sessionKeyOf(request, topicA.id);
    const keyB = await sessionKeyOf(request, topicB.id);
    const keyC = await sessionKeyOf(request, topicC.id);

    try {
      await prepareBackgroundWindow(page);
      const push = await routeStreamFrames(page);
      const send = (frame: Record<string, unknown>): void => push({ type: "stream:end", ...frame });

      await goToApp(page);
      // The banner title is the topic's name: the window must know the topic.
      for (const name of [nameA, nameB, nameC]) {
        await expect(page.getByRole("treeitem", { name: new RegExp(name) })).toBeVisible({ timeout: 15_000 });
      }

      // Ends that are NOT a finished chat stay silent: a board agent's turn and a
      // turn the user stopped. They go to ANOTHER chat than the clean end, so a
      // banner leaking from them cannot hide behind the per-topic cooldown the
      // clean end would then hit. The clean end right after is the sentinel:
      // frames on one socket arrive in order, so when its banner is there the
      // two before it have been handled.
      send({ sessionKey: keyC, topicId: topicC.id, messageId: "m-agent", completed: true, dispatched: true });
      send({ sessionKey: keyC, topicId: topicC.id, reason: "user_abort" });
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
      await deleteTopic(request, topicC.id);
    }
  });

  test("a hookless chat that finishes behind another tab is marked 'done' on its row and its tab until you open it", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DONE-01" });
    const stamp = Date.now();
    const nameA = `Marked Chat ${stamp}`;
    const nameO = `Other Chat ${stamp}`;
    const topicA = await createTopic(request, nameA, { provider: "topics" });
    const topicO = await createTopic(request, nameO, { provider: "topics" });
    const keyA = await sessionKeyOf(request, topicA.id);
    await resetPaneStore(request, [topicA.id, topicO.id]);

    try {
      // The window is in FRONT of you here: the mark must not depend on the
      // window being away, only on this chat not being the one you look at.
      await prepareBackgroundWindow(page, { focused: true });
      const push = await routeStreamFrames(page);
      const finish = (messageId: string): void =>
        push({ type: "stream:end", sessionKey: keyA, topicId: topicA.id, messageId, completed: true, stopReason: "end_turn" });

      await goToApp(page);
      const tabA = page.locator('[role="tab"][data-pane-id]', { hasText: nameA });
      const tabO = page.locator('[role="tab"][data-pane-id]', { hasText: nameO });
      const rowA = page.getByRole("treeitem", { name: nameA, exact: true });
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      await expect(rowA).toBeVisible({ timeout: 15_000 });

      // Another pane is the one you are looking at.
      await tabO.click();
      await expect(tabO).toHaveAttribute("data-active", "true");
      await expect(tabA).not.toHaveAttribute("data-attention", /done|input/);

      finish("m-1");

      // The mark, on both surfaces, through the tier a finished terminal uses.
      await expect(tabA, "the finished chat's tab carries no 'done' mark").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      await expect(rowA, "the finished chat's sidebar row carries no 'done' mark").toHaveAttribute("data-attention", "done");
      await expect(page.getByRole("tab", { name: new RegExp(`${nameA}.*turno finito`) })).toBeVisible();
      // And the banner, in the same breath.
      await expect.poll(async () => (await bannerLog(page)).map((b) => b.title), { timeout: 10_000 }).toEqual([nameA]);
      // It is a mark, not a flash: still there after the other surfaces settle.
      await page.waitForTimeout(1_500);
      await expect(tabA).toHaveAttribute("data-attention", "done");

      // Opening the chat is having seen it: the mark goes from both surfaces.
      await tabA.click();
      await expect(tabA).toHaveAttribute("data-active", "true");
      await expect(tabA).not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
      await expect(rowA).not.toHaveAttribute("data-attention", /done|input/);

      // A chat that finishes while you are looking at it gets no mark.
      finish("m-2");
      await page.waitForTimeout(1_000);
      await expect(tabA).not.toHaveAttribute("data-attention", /done|input/);
      await expect(rowA).not.toHaveAttribute("data-attention", /done|input/);

      // A new turn drops the mark too: finish behind another tab, then start.
      await tabO.click();
      await expect(tabO).toHaveAttribute("data-active", "true");
      finish("m-3");
      await expect(tabA).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      push({ type: "stream:start", sessionKey: keyA, topicId: topicA.id, messageId: "m-next" });
      // The turn this start opened ends, so no spinner outlives the check below.
      push({ type: "stream:end", sessionKey: keyA, topicId: topicA.id, messageId: "m-next", reason: "user_abort" });
      await expect(tabA).not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });

      // Reload: the terminal mark (`terminalFinishedIds`) lives in memory and a
      // reload starts without it; the chat mark mirrors it, so it does not
      // come back either.
      finish("m-4");
      await expect(tabA).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      await page.reload();
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      await expect(rowA).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1_000);
      await expect(tabA).not.toHaveAttribute("data-attention", /done|input/);
      await expect(rowA).not.toHaveAttribute("data-attention", /done|input/);
    } finally {
      await deleteTopic(request, topicA.id);
      await deleteTopic(request, topicO.id);
    }
  });

  test("the row of a chat held by another window drops its 'done' mark when clicked, though the chat opens over there", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DONE-01" });
    const stamp = Date.now();
    const nameX = `Detached Chat ${stamp}`;
    const nameO = `Here Chat ${stamp}`;
    const topicX = await createTopic(request, nameX, { provider: "topics" });
    const topicO = await createTopic(request, nameO, { provider: "topics" });
    const keyX = await sessionKeyOf(request, topicX.id);
    // Only the other chat is open HERE: X lives in the detached window.
    await resetPaneStore(request, [topicO.id]);

    try {
      await prepareBackgroundWindow(page, { focused: true });
      // The desktop shell, faked through the one helper that keeps its network
      // on the test server. Its only job here: say the other window came
      // forward, and record that the row asked for it.
      await fakeTauriShell(page, () => {
        window.__shellCalls = [];
        return (cmd: string) => {
          window.__shellCalls!.push(cmd);
          return cmd === "window_focus_label" ? true : null;
        };
      });
      // Another window holds X. X has no tab here, so being held elsewhere is
      // also what gives it a row.
      const push = await routeStreamFrames(page, {
        otherWindow: {
          windowId: "e2e-other-window", clientId: "e2e-c1", windowLabel: "detach-e2e", detached: true,
          topicIds: [topicX.id], tabs: [{ id: topicX.id, type: "chat", title: nameX }],
        },
      });

      await goToApp(page);
      await expect(page.locator('[role="tab"][data-pane-id]', { hasText: nameO })).toBeVisible({ timeout: 15_000 });
      const rowX = page.getByRole("treeitem", { name: nameX, exact: true });
      await expect(rowX.locator("[data-elsewhere]"), "the row does not know another window holds the chat").toBeVisible({ timeout: 10_000 });

      push({ type: "stream:end", sessionKey: keyX, topicId: topicX.id, messageId: "dx-1", completed: true, stopReason: "end_turn" });
      await expect(rowX, "the finished chat's row carries no 'done' mark").toHaveAttribute("data-attention", "done", { timeout: 10_000 });

      // The click brings the other window forward and opens nothing here: the
      // chat never mounts a pane in this window, and the mark still goes.
      await rowX.click();
      await expect.poll(() => page.evaluate(() => window.__shellCalls ?? []), { timeout: 10_000 }).toContain("window_focus_label");
      await expect(rowX, "the row kept its 'done' mark after the click").not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
      await expect(page.locator('[role="tab"][data-pane-id]', { hasText: nameX })).toHaveCount(0);
    } finally {
      await deleteTopic(request, topicX.id);
      await deleteTopic(request, topicO.id);
    }
  });
});
