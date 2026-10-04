/**
 * A CHAT THAT FINISHES BANNERS, AND STAYS MARKED, LIKE A TERMINAL THAT FINISHES.
 *
 * The bug (29/09): a chat whose runtime reports no Claude Code hooks (provider
 * `topics`, Topics routing on, codex, jcode, ACP) never raised an OS banner when
 * its turn ended, and its mark lived in each window's memory.
 *
 * Since notifications-redesign the mark and the banner are the server's: the
 * chat route closes the turn, the attention store composes `finished(done)`
 * and announces it on `attention:updated`, and every window paints that frame
 * (CHAT-DONE-01, CHAT-DONE-02, ATTN-11). So the turns here are REAL: the chat
 * route runs them on a fake CLI (`fake-claude-slow-turn.ts`), as the composer
 * would. What is faked is the OS banner (`window.Notification`, a stub that
 * counts and paints), the window being "behind another app" the way macOS
 * reports it to a WKWebView (`visibilityState === 'visible'`, `hasFocus() ===
 * false`), the Badging API (recorded), and, in the last test, the roster of
 * windows (`presence:windows`) and the desktop shell. One frame is staged on
 * the socket: the `attention:updated` with no announce that the server sends
 * for a turn that is not a finished chat (a board agent's, a stopped one), to
 * prove the client rings only on an announce.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { fakeTauriShell } from "./helpers/fake-tauri-shell";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { attentionUpdated, recordAttentionFrames, runChatTurn } from "./helpers/attention";

hermetic(test);

declare global {
  interface Window {
    __bannerLog?: { title: string; body: string }[];
    __shellCalls?: string[];
    __awake?: boolean;
    __badgeLog?: number[];
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

/** Pass the page's socket through and return a way to push frames on it, as
 *  the server would broadcast them. Survives a reload: the route re-catches
 *  the new socket and `send` follows it. With `otherWindow`, every roster the
 *  server sends (`presence:windows`, after each `hello` and announce) arrives
 *  with that window added: a roster injected once loses to the server's next
 *  one (the same reason as `declareOtherWindow` in spaces-switcher.spec.ts). */
async function routeStreamFrames(
  page: Page,
  { otherWindow, onServerFrame }: { otherWindow?: Record<string, unknown>; onServerFrame?: (m: string) => void } = {},
): Promise<(frame: Record<string, unknown>) => void> {
  let inject: ((data: string) => void) | null = null;
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (onServerFrame && typeof m === "string") onServerFrame(m);
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
  test.describe.configure({ timeout: 90_000 });
  let removeCli: (() => void) | null = null;
  test.beforeAll(() => { removeCli = installSlowTurnCli(); });
  test.afterAll(() => { removeCli?.(); removeCli = null; });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("a hookless chat that finishes raises one banner while Topics is behind another app", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DONE-02" });
    const stamp = Date.now();
    const nameA = `Finished Chat ${stamp}`;
    const nameC = `Gate Chat ${stamp}`;
    const topicA = await createTopic(request, nameA, { provider: "claude-code" });
    const topicC = await createTopic(request, nameC, { provider: "claude-code" });
    await resetPaneStore(request, [topicA.id, topicC.id]);

    try {
      await prepareBackgroundWindow(page);
      const frames = recordAttentionFrames();
      const push = await routeStreamFrames(page, { onServerFrame: frames.feed });
      await goToApp(page);
      for (const name of [nameA, nameC]) {
        await expect(page.getByRole("treeitem", { name: new RegExp(name) })).toBeVisible({ timeout: 15_000 });
      }
      await expect.poll(() => frames.inits(), { timeout: 15_000 }).toBeGreaterThan(0);

      // A turn that is NOT a finished chat (a board agent's, a stopped one):
      // the server sends its state with no announce, and nothing rings.
      push(attentionUpdated(`topic:${topicC.id}`, { state: "finished" }));
      // The clean end of A, on the real chat route: one banner, the server's words.
      await runChatTurn(request, topicA.id, "finish please");
      await expect
        .poll(async () => (await bannerLog(page)).length, { timeout: 10_000, message: "the finished chat raised no banner" })
        .toBeGreaterThan(0);
      expect((await bannerLog(page)).map((b) => b.title)).toEqual([`💬 ${nameA}`]);
      await expect(page.locator('[data-testid="fake-os-banner"]')).toContainText(nameA);
    } finally {
      await deleteTopic(request, topicA.id);
      await deleteTopic(request, topicC.id);
    }
  });

  test("a hookless chat that finishes behind another tab is marked 'done' on its row and its tab until you open it", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DONE-01" });
    const stamp = Date.now();
    const nameA = `Marked Chat ${stamp}`;
    const nameO = `Other Chat ${stamp}`;
    const topicA = await createTopic(request, nameA, { provider: "claude-code" });
    const topicO = await createTopic(request, nameO, { provider: "claude-code" });
    await resetPaneStore(request, [topicA.id, topicO.id]);
    const subjectA = `topic:${topicA.id}`;

    try {
      // The window is in FRONT of you here: the mark must not depend on the
      // window being away, only on this chat not being the one you look at.
      await prepareBackgroundWindow(page, { focused: true });
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const tabA = page.locator('[role="tab"][data-pane-id]', { hasText: nameA });
      const tabO = page.locator('[role="tab"][data-pane-id]', { hasText: nameO });
      const rowA = page.getByRole("treeitem", { name: nameA, exact: true });
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      await expect(rowA).toBeVisible({ timeout: 15_000 });

      // Another pane is the one you are looking at.
      await tabO.click();
      await expect(tabO).toHaveAttribute("data-active", "true");
      await expect(tabA).not.toHaveAttribute("data-attention", /.+/);

      await runChatTurn(request, topicA.id, "first");
      // The mark, on both surfaces, through the tier a finished terminal uses.
      await expect(tabA, "the finished chat's tab carries no 'done' mark").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      await expect(rowA, "the finished chat's sidebar row carries no 'done' mark").toHaveAttribute("data-attention", "done");
      await expect(page.getByRole("tab", { name: new RegExp(`${nameA}.*turno finito`) })).toBeVisible();
      // And the banner, in the same breath.
      await expect.poll(async () => (await bannerLog(page)).map((b) => b.title), { timeout: 10_000 }).toEqual([`💬 ${nameA}`]);

      // Opening the chat is having seen it: the mark goes from both surfaces.
      await tabA.click();
      await expect(tabA).toHaveAttribute("data-active", "true");
      await expect(tabA).not.toHaveAttribute("data-attention", /.+/, { timeout: 10_000 });
      await expect(rowA).not.toHaveAttribute("data-attention", /.+/);

      // A chat that finishes while you are looking at it is born seen: no mark.
      const epochBefore = frames.rows().get(subjectA)?.epoch ?? 0;
      await runChatTurn(request, topicA.id, "second");
      await expect.poll(() => {
        const r = frames.rows().get(subjectA);
        return r && r.epoch > epochBefore ? r.seenEpoch === r.epoch : null;
      }, { timeout: 10_000, message: "the turn finished in front was not born seen" }).toBe(true);
      await expect(tabA).not.toHaveAttribute("data-attention", /.+/);
      await expect(rowA).not.toHaveAttribute("data-attention", /.+/);

      // A new turn drops the mark: finish behind another tab, then start one.
      await tabO.click();
      await expect(tabO).toHaveAttribute("data-active", "true");
      await runChatTurn(request, topicA.id, "third");
      await expect(tabA).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      const slow = runChatTurn(request, topicA.id, "SLOW:4:next");
      await expect.poll(() => frames.rows().get(subjectA)?.state, { timeout: 10_000 }).toBe("working");
      await expect(tabA).not.toHaveAttribute("data-attention", /.+/, { timeout: 10_000 });
      await slow;

      // The mark is the server's: a reload paints it again, unseen as it was.
      await expect(tabA).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      await page.reload();
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      await expect(tabA).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      await expect(rowA).toHaveAttribute("data-attention", "done");
    } finally {
      await deleteTopic(request, topicA.id);
      await deleteTopic(request, topicO.id);
    }
  });

  test("a chat that finishes in front of you never moves the Dock number; behind another app it counts until you come back", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DONE-01" });
    const stamp = Date.now();
    const nameA = `Front Chat ${stamp}`;
    const topicA = await createTopic(request, nameA, { provider: "claude-code" });
    await resetPaneStore(request, [topicA.id]);

    try {
      // The window is in front, and a switch puts it behind another app the
      // way macOS reports it to a WKWebView (visible, no focus). The Badging
      // API records every value the app paints, in order.
      await page.addInitScript(() => {
        window.__awake = true;
        window.__badgeLog = [];
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        document.hasFocus = () => window.__awake === true;
        const nav = navigator as unknown as { setAppBadge: (n?: number) => Promise<void>; clearAppBadge: () => Promise<void> };
        nav.setAppBadge = (n?: number) => { window.__badgeLog!.push(n ?? 0); return Promise.resolve(); };
        nav.clearAppBadge = () => { window.__badgeLog!.push(0); return Promise.resolve(); };
      });
      const frames = recordAttentionFrames(page);
      // Consecutive repeats are the same paint: the history is the values it went through.
      const badgeHistory = async (): Promise<number[]> =>
        (await page.evaluate(() => window.__badgeLog ?? [])).filter((n, i, all) => i === 0 || n !== all[i - 1]);

      await goToApp(page);
      const tabA = page.locator('[role="tab"][data-pane-id]', { hasText: nameA });
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      await tabA.click();
      await expect(tabA).toHaveAttribute("data-active", "true");
      await expect.poll(async () => (await badgeHistory()).length, { timeout: 10_000, message: "the badge was never painted" }).toBeGreaterThan(0);
      const history0 = await badgeHistory();
      const base = history0[history0.length - 1]!;

      // Five turns end on the chat in front of you: each is born seen.
      for (let i = 1; i <= 5; i++) await runChatTurn(request, topicA.id, `front-${i}`);
      await expect.poll(() => {
        const r = frames.rows().get(`topic:${topicA.id}`);
        return r ? r.epoch >= 5 && r.seenEpoch === r.epoch : false;
      }, { timeout: 10_000, message: "the five turns in front were not all born seen" }).toBe(true);
      // Their rows are in the history, already seen, and the Dock never moved.
      const rows = ((await (await request.get(`${E2E_BASE}/api/notifications?limit=50`)).json()) as {
        rows: { targetId: string | null; seenAt: string | null }[];
      }).rows.filter((r) => r.targetId === topicA.id);
      expect(rows.length, "no history row for the chat in front").toBeGreaterThan(0);
      expect(rows.every((r) => r.seenAt !== null), "a turn finished in front was recorded unseen").toBe(true);
      expect(await badgeHistory()).toEqual(history0);
      await expect(tabA).not.toHaveAttribute("data-attention", /.+/);

      // Behind another app nobody is looking: the same chat's end counts...
      await page.evaluate(() => { window.__awake = false; window.dispatchEvent(new Event("blur")); });
      await runChatTurn(request, topicA.id, "behind-1");
      await expect.poll(badgeHistory, { timeout: 10_000, message: "a chat finished while you were away does not count" }).toEqual([...history0, base + 1]);
      // ...until the window comes back to the front, which is having seen it.
      await page.evaluate(() => { window.__awake = true; window.dispatchEvent(new Event("focus")); });
      await expect.poll(badgeHistory, { timeout: 10_000 }).toEqual([...history0, base + 1, base]);
    } finally {
      await deleteTopic(request, topicA.id);
    }
  });

  test("the row of a chat held by another window drops its 'done' mark when clicked, though the chat opens over there", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DONE-01" });
    const stamp = Date.now();
    const nameX = `Detached Chat ${stamp}`;
    const nameO = `Here Chat ${stamp}`;
    const topicX = await createTopic(request, nameX, { provider: "claude-code" });
    const topicO = await createTopic(request, nameO, { provider: "claude-code" });
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
      await routeStreamFrames(page, {
        otherWindow: {
          windowId: "e2e-other-window", clientId: "e2e-c1", windowLabel: "detach-e2e", detached: true,
          topicIds: [topicX.id], tabs: [{ id: topicX.id, type: "chat", title: nameX }],
        },
      });

      await goToApp(page);
      await expect(page.locator('[role="tab"][data-pane-id]', { hasText: nameO })).toBeVisible({ timeout: 15_000 });
      const rowX = page.getByRole("treeitem", { name: nameX, exact: true });
      await expect(rowX.locator("[data-elsewhere]"), "the row does not know another window holds the chat").toBeVisible({ timeout: 10_000 });

      await runChatTurn(request, topicX.id, "finish over there");
      await expect(rowX, "the finished chat's row carries no 'done' mark").toHaveAttribute("data-attention", "done", { timeout: 10_000 });

      // The click brings the other window forward and opens nothing here: the
      // chat never mounts a pane in this window, and the mark still goes.
      await rowX.click();
      await expect.poll(() => page.evaluate(() => window.__shellCalls ?? []), { timeout: 10_000 }).toContain("window_focus_label");
      await expect(rowX, "the row kept its 'done' mark after the click").not.toHaveAttribute("data-attention", /.+/, { timeout: 10_000 });
      await expect(page.locator('[role="tab"][data-pane-id]', { hasText: nameX })).toHaveCount(0);
    } finally {
      await deleteTopic(request, topicX.id);
      await deleteTopic(request, topicO.id);
    }
  });
});
