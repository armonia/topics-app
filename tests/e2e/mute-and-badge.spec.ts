/**
 * MUTE + BADGE E2E (task d00294ee): the acceptance flow, end-to-end through the
 * REAL useCompletionNotifier + useTabNotifications hooks.
 *
 * Contract proven here (since notifications-redesign on REAL turns: the chat
 * route runs them on a fake CLI, the server composes the state and decides the
 * announce, MUTE-01 being one of its gates, ATTN-11):
 *   1. Two topics finish. One is muted (Topic.muted, migration 073). → EXACTLY
 *      ONE native banner fires.
 *   2. The app badge counts BOTH completions even though one is muted — the
 *      badge rides the mute-blind attention rollup, not the mute gate.
 *   3. Foregrounding the muted topic drops its share of the badge.
 *
 * The native banner and the OS dock badge aren't rendered in a browser, so we
 * stub `window.Notification` and `navigator.setAppBadge` in an init script and
 * assert against the recorded calls. The decision behind (1) is the server's
 * `isTopicSilenced` (server/push-triggers.test.ts).
 */
import { test, expect } from "@playwright/test";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { markSeenNow, runChatTurn } from "./helpers/attention";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

const TS = Date.now();
const BASE = E2E_BASE;

let mutedTopic: { id: string; name: string };
let removeCli: (() => void) | null = null;
let loudTopic: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  removeCli = installSlowTurnCli();
  mutedTopic = await createTopic(request, `Muted-${TS}`, { provider: "claude-code" });
  loudTopic = await createTopic(request, `Loud-${TS}`, { provider: "claude-code" });
  // Persist the per-topic mute server-side (migration 073) — this is the flag
  // the notifier reads back through topicsRef.
  const res = await request.patch(`${BASE}/api/topics/${mutedTopic.id}`, {
    data: { muted: true },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  removeCli?.();
  await deleteTopic(request, mutedTopic.id).catch(() => {});
  await deleteTopic(request, loudTopic.id).catch(() => {});
});

test.describe("Mute gate + app badge", () => {
  test("MUTE-01: two finish, one muted → one banner, badge counts 2, foreground drops it", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "MUTE-01" });

    // Stub the two OS surfaces the browser can't render: native banners and the
    // app badge. Both land on the window so the test can read them back.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __banners: string[];
        __badge: number | null;
        Notification: unknown;
      };
      w.__banners = [];
      w.__badge = null;
      class FakeNotification {
        static permission = "granted";
        static requestPermission() {
          return Promise.resolve("granted");
        }
        onclick: (() => void) | null = null;
        constructor(title: string) {
          w.__banners.push(title);
        }
        close() {}
      }
      w.Notification = FakeNotification;
      const nav = navigator as unknown as {
        setAppBadge: (n?: number) => Promise<void>;
        clearAppBadge: () => Promise<void>;
      };
      nav.setAppBadge = (n?: number) => {
        w.__badge = n ?? 0;
        return Promise.resolve();
      };
      nav.clearAppBadge = () => {
        w.__badge = 0;
        return Promise.resolve();
      };
    });

    // Open both topics; focus NEITHER completion target — park focus on the
    // board utility pane so both Muted and Loud are not in front, thus not
    // born seen, and banner-eligible.
    const AGENTS = "__board__";
    await resetPaneStore(page.request, [mutedTopic.id, loudTopic.id, AGENTS]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await page.locator(`[data-pane-id="${AGENTS}"]`).waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`[data-pane-id="${AGENTS}"]`).click();

    const badge = () =>
      page.evaluate(() => (window as unknown as { __badge: number | null }).__badge ?? 0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __badge: number | null }).__badge), { timeout: 10_000 }).not.toBeNull();
    const base = await badge();

    // Both finish, on the real route.
    await runChatTurn(page.request, mutedTopic.id, "finish muted");
    await runChatTurn(page.request, loudTopic.id, "finish loud");

    // (1) Exactly ONE banner — the Loud one. The muted chat has no announce.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __banners: string[] }).__banners.length), {
        timeout: 10_000,
      })
      .toBe(1);
    const bannerTitles = await page.evaluate(
      () => (window as unknown as { __banners: string[] }).__banners,
    );
    expect(bannerTitles.some((t) => t.includes(loudTopic.name))).toBe(true);
    expect(bannerTitles.some((t) => t.includes(mutedTopic.name))).toBe(false);

    // (2) Badge counts BOTH topics though one is muted: muting hides the
    // banner and the sound, never the count.
    await expect.poll(badge, { timeout: 10_000 }).toBe(base + 2);
    const mutedTabBadge = page.locator(`[data-pane-id="${mutedTopic.id}"]`).locator("[data-notification-count]");
    await expect(mutedTabBadge).toBeVisible({ timeout: 5000 });

    // (3) Foreground the muted topic → seen after the dwell → the badge drops
    // back by one. The still-backgrounded Loud topic keeps it at base+1.
    await page.locator(`[data-pane-id="${mutedTopic.id}"]`).click();
    await expect.poll(badge, { timeout: 10_000 }).toBe(base + 1);
  });

  // REGRESSION: the focus that LEAVES a chat must reach the server.
  //
  // `sendFocusTopic` fires when a chat becomes active; its twin `sendBlur` only
  // existed inside `ProjectWindow`. At app level, moving from a chat to a
  // non-chat pane (board, terminal, browser) sent nothing: for the server the
  // last chat looked at stayed in front, and after `SEEN_DWELL_MS` it landed in
  // `seenTopicRef` — from there every `unread:updated{n>0}` about it was
  // re-marked read on the spot and never reached the badge.
  //
  // Measured before the fix: with two chats open and focus on the board, the
  // FIRST chat never raised the badge (delta 0) and the second did (delta 1).
  // After: 1 and 1, and the `focus{topicId: null}` frame that was missing shows
  // up between the frames.
  //
  // The test watches the COUNT, not the frame: the wrong badge is the thing the
  // user actually sees.
  test("MUTE-02: una chat non guardata conta sul badge anche col fuoco altrove", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "MUTE-02" });
    await page.addInitScript(() => {
      const w = window as unknown as { __badge: number | null };
      w.__badge = null;
      const nav = navigator as unknown as {
        setAppBadge: (n?: number) => Promise<void>;
        clearAppBadge: () => Promise<void>;
      };
      nav.setAppBadge = (n?: number) => { w.__badge = n ?? 0; return Promise.resolve(); };
      nav.clearAppBadge = () => { w.__badge = 0; return Promise.resolve(); };
    });
    // MUTE-01 leaves the loud chat lit: both start SEEN here (the seen door,
    // up to now), so each turn below is a new count.
    await markSeenNow(page.request, [mutedTopic, loudTopic].map((t) => `topic:${t.id}`));
    const AGENTS = "__board__";
    await resetPaneStore(page.request, [mutedTopic.id, loudTopic.id, AGENTS]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    // The FIRST chat is the one in front, for longer than the dwell: it is
    // seen, and the server knows this window holds it.
    await page.locator(`[data-pane-id="${mutedTopic.id}"]`).click();
    await expect(page.locator(`[data-pane-id="${mutedTopic.id}"]`)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect(page.locator(`[data-pane-id="${mutedTopic.id}"]`)).not.toHaveAttribute("data-attention", /.+/, { timeout: 10_000 });
    // Then the focus LEAVES the chats for the board.
    await page.locator(`[data-pane-id="${AGENTS}"]`).click();
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-pane-id="__board__"]');
        return !!el && el.getAttribute("data-active") === "true";
      },
      undefined,
      { timeout: 10_000, polling: "raf" },
    );

    const badge = () =>
      page.evaluate(() => (window as unknown as { __badge: number | null }).__badge ?? 0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __badge: number | null }).__badge), { timeout: 10_000 }).not.toBeNull();
    const base = await badge();

    // The chat the window USED to hold finishes: had the focus not left it on
    // the server, its epoch would be born seen and never count.
    await runChatTurn(page.request, mutedTopic.id, "finish after the blur");
    await expect
      .poll(badge, {
        message: "la chat in secondo piano deve contare: era delta 0 prima del blur",
        timeout: 10_000,
      })
      .toBe(base + 1);

    await runChatTurn(page.request, loudTopic.id, "and the other");
    await expect
      .poll(badge, { message: "e la seconda pure", timeout: 10_000 })
      .toBe(base + 2);
  });

});
