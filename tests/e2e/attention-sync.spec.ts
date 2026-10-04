/**
 * SEEN ON ONE PAGE IS SEEN ON EVERY PAGE, AND STAYS SEEN (notifications-redesign,
 * ATTN-06, ATTN-07; tasks.md 5.2).
 *
 * The defect (sync-B, sync-D, D3 in the change's evidence): each window kept
 * its own marks. A chat seen on the Mac stayed blue on the phone, a reload
 * brought back a number nobody could clear, and a socket that dropped while
 * the other window looked never heard about it.
 *
 * Two pages of the same person, in two browser contexts that share nothing
 * but the server. A chat finishes a real turn (the chat route, a fake CLI)
 * while both windows are behind another app, so it lights both. Page A looks
 * at it; page B goes dark, after a reload too. Then the chat finishes again,
 * B's socket stops hearing the server, A looks, and B's socket is closed: the
 * client reconnects on its own and the `attention:init` of the new socket
 * puts B dark, without anybody opening its inbox. The socket of B is routed
 * only to be able to cut it: no frame is ever written by the test.
 */
import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { recordAttentionFrames, runChatTurn, setAwake, stubBannersAndWindow, type AttentionFrames } from "./helpers/attention";
import { E2E_BASE } from "./helpers/test-server";
import { topicSubject } from "../../shared/attention";

hermetic(test);

/** A window's video, when the run films (`E2E_VIDEO=1`): one file per context, final once it closes. */
function videoOptions(): { recordVideo?: { dir: string; size: { width: number; height: number } } } {
  if (process.env.E2E_VIDEO !== "1") return {};
  return { recordVideo: { dir: test.info().outputPath("windows"), size: { width: 1280, height: 800 } } };
}

async function openWindow(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...videoOptions(), baseURL: E2E_BASE, viewport: { width: 1280, height: 800 }, locale: "it-IT" });
  return { ctx, page: await ctx.newPage() };
}

test.describe("seen on one page clears the other", () => {
  test.describe.configure({ timeout: 120_000 });
  let removeCli: (() => void) | null = null;
  test.beforeAll(() => { removeCli = installSlowTurnCli(); });
  test.afterAll(() => { removeCli?.(); removeCli = null; });

  test("a chat seen in window A goes dark in window B, stays dark after B reloads, and after B's socket comes back", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-06" });
    const stamp = Date.now();
    const chat = await createTopic(request, `Synced Chat ${stamp}`, { provider: "claude-code" });
    const other = await createTopic(request, `Other Chat ${stamp}`, { provider: "claude-code" });
    const subject = topicSubject(chat.id);
    await resetPaneStore(request, [other.id, chat.id]);
    const A = await openWindow(browser);
    const B = await openWindow(browser);
    try {
      await stubBannersAndWindow(A.page);
      await stubBannersAndWindow(B.page);
      const framesA = recordAttentionFrames(A.page);
      // B's socket is passed through untouched, except when `deaf` drops what
      // the server says: the socket that is about to die.
      const framesB: AttentionFrames = recordAttentionFrames();
      let deaf = false;
      let socketB: WebSocketRoute | null = null;
      await B.page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
        const server = ws.connectToServer();
        socketB = ws;
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => {
          if (deaf) return;
          if (typeof m === "string") framesB.feed(m);
          ws.send(m);
        });
      });
      await goToApp(A.page);
      await goToApp(B.page);

      const tab = (p: Page, name: string) => p.locator('[role="tab"][data-pane-id]', { hasText: name });
      for (const p of [A.page, B.page]) {
        await expect(tab(p, chat.name)).toBeVisible({ timeout: 15_000 });
        await tab(p, other.name).click();
        await expect(tab(p, other.name)).toHaveAttribute("data-active", "true");
      }

      // The chat finishes while both windows are behind another app: both light it.
      await runChatTurn(request, chat.id, "first turn");
      for (const p of [A.page, B.page]) {
        await expect(tab(p, chat.name), "the finished chat is not lit").toHaveAttribute("data-attention", "done", { timeout: 15_000 });
        await expect(p.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", "1");
      }

      // A looks at it: in front, with the window awake.
      await setAwake(A.page, true);
      await tab(A.page, chat.name).click();
      await expect(tab(A.page, chat.name)).not.toHaveAttribute("data-attention", /.+/, { timeout: 15_000 });
      // B goes dark without anybody touching it.
      await expect(tab(B.page, chat.name), "seen in A, still lit in B").not.toHaveAttribute("data-attention", /.+/, { timeout: 15_000 });
      await expect(B.page.getByTestId("inbox-count")).toHaveCount(0);

      // B reloads: the new socket's snapshot says seen, nothing comes back.
      const initsBefore = framesB.inits();
      await B.page.reload();
      await expect.poll(() => framesB.inits(), { timeout: 15_000, message: "B's new socket got no attention:init" }).toBeGreaterThan(initsBefore);
      expect(framesB.rows().get(subject)?.lit ?? false, "the snapshot after the reload lights the seen chat").toBe(false);
      await expect(tab(B.page, chat.name)).toBeVisible({ timeout: 15_000 });
      await expect(tab(B.page, chat.name)).not.toHaveAttribute("data-attention", /.+/);
      await expect(B.page.getByTestId("inbox-count")).toHaveCount(0);

      // The chat finishes again; A is away from it.
      await tab(A.page, other.name).click();
      await expect(tab(A.page, other.name)).toHaveAttribute("data-active", "true");
      await setAwake(A.page, false);
      await runChatTurn(request, chat.id, "second turn");
      for (const p of [A.page, B.page]) {
        await expect(tab(p, chat.name)).toHaveAttribute("data-attention", "done", { timeout: 15_000 });
      }

      // B's socket stops hearing the server; A looks at the chat meanwhile.
      deaf = true;
      await setAwake(A.page, true);
      await tab(A.page, chat.name).click();
      await expect(tab(A.page, chat.name)).not.toHaveAttribute("data-attention", /.+/, { timeout: 15_000 });
      await expect.poll(() => framesA.rows().get(subject)?.lit, { timeout: 10_000 }).toBe(false);
      // B missed it: it is still lit. This is what the reconnect has to fix.
      await expect(tab(B.page, chat.name)).toHaveAttribute("data-attention", "done");

      // The socket dies; the client opens a new one by itself.
      const initsBeforeDrop = framesB.inits();
      deaf = false;
      socketB!.close({ code: 4000, reason: "e2e: the socket dropped" });
      await expect.poll(() => framesB.inits(), { timeout: 30_000, message: "B never reconnected" }).toBeGreaterThan(initsBeforeDrop);
      await expect(tab(B.page, chat.name), "B reconnected and kept the chat lit").not.toHaveAttribute("data-attention", /.+/, { timeout: 15_000 });
      await expect(B.page.getByTestId("inbox-count")).toHaveCount(0);
      await expect(B.page.getByTestId("inbox-panel")).toHaveCount(0);
    } finally {
      await A.ctx.close().catch(() => {});
      await B.ctx.close().catch(() => {});
      await deleteTopic(request, chat.id);
      await deleteTopic(request, other.id);
    }
  });
});
