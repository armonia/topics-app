/**
 * MUTE + BADGE E2E (task d00294ee): the acceptance flow, end-to-end through the
 * REAL useCompletionNotifier + useTabNotifications hooks.
 *
 * Contract proven here:
 *   1. Two topics finish (session:state running→completed, the Claude-Code
 *      phase machine). One is muted (Topic.muted, migration 073). → EXACTLY
 *      ONE native banner fires.
 *   2. The app badge counts BOTH completions even though one is muted — the
 *      badge rides the mute-blind attention rollup, not the mute gate.
 *   3. Foregrounding the muted topic drops its share of the badge.
 *
 * The native banner and the OS dock badge aren't rendered in a browser, so we
 * stub `window.Notification` and `navigator.setAppBadge` in an init script and
 * assert against the recorded calls. The pure decision behind (1) also has
 * exhaustive unit coverage in client/src/lib/notify/muteGate.test.ts.
 */
import { test, expect } from "@playwright/test";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

const TS = Date.now();
const BASE = E2E_BASE;

/** The server-assigned `sessionKey` of a topic (the notifier keys on it).
 *  Read from the list: there is no GET for a single topic. */
async function sessionKeyOf(page: import("@playwright/test").Page, topicId: string): Promise<string> {
  const res = await page.request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const body = (await res.json()) as { topics?: Record<string, { id: string; sessionKey?: string }> };
  const key = body.topics?.[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey`);
  return key;
}

let mutedTopic: { id: string; name: string };
let loudTopic: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  mutedTopic = await createTopic(request, `Muted-${TS}`);
  loudTopic = await createTopic(request, `Loud-${TS}`);
  // Persist the per-topic mute server-side (migration 073) — this is the flag
  // the notifier reads back through topicsRef.
  const res = await request.patch(`${BASE}/api/topics/${mutedTopic.id}`, {
    data: { muted: true },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
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

    const ws = await interceptWebSocket(page);

    // Open both topics; focus NEITHER completion target — park focus on the
    // board utility pane so both Muted and Loud are inactive and thus banner-
    // eligible (a focused topic is suppressed regardless of mute).
    const AGENTS = "__board__";
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [mutedTopic.id, loudTopic.id, AGENTS] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: {
        order: [mutedTopic.id, loudTopic.id, AGENTS],
        pinned: [mutedTopic.id, loudTopic.id, AGENTS],
      },
    });
    await resetPaneStore(page.request, [mutedTopic.id, loudTopic.id, AGENTS]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });
    await page.locator(`[data-pane-id="${AGENTS}"]`).waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`[data-pane-id="${AGENTS}"]`).click();

    // The notifier resolves a chat by its `sessionKey`, so read the real one
    // back rather than rebuilding the server's `topic:<id8>` convention here.
    const keyMuted = await sessionKeyOf(page, mutedTopic.id);
    const keyLoud = await sessionKeyOf(page, loudTopic.id);

    const phaseFrame = (sessionKey: string, phase: string) => ({
      type: "session:state",
      sessionKey,
      state: { phase, claudeSessionId: `cs-${sessionKey}` },
    });

    // Frame 1 = baseline (both running). The first frame for a session never
    // banners (isRealPhaseTransition): it only records the phase to diff.
    ws.send(phaseFrame(keyMuted, "running"));
    ws.send(phaseFrame(keyLoud, "running"));

    // Frame 2 = both flip running→completed: two completions in the same tick.
    ws.send(phaseFrame(keyMuted, "completed"));
    ws.send(phaseFrame(keyLoud, "completed"));

    // (1) Exactly ONE banner — the Loud one. Muted swallowed its banner.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __banners: string[] }).__banners.length), {
        timeout: 5000,
      })
      .toBe(1);
    const bannerTitles = await page.evaluate(
      () => (window as unknown as { __banners: string[] }).__banners,
    );
    expect(bannerTitles.some((t) => t.includes(loudTopic.name))).toBe(true);
    expect(bannerTitles.some((t) => t.includes(mutedTopic.name))).toBe(false);

    // (2) Badge counts BOTH topics though one is muted. The badge rides the
    // attention rollup (unread + claude-attention), which never consults the
    // mute gate — so marking each topic unread raises setAppBadge by exactly 2.
    // Measure against a baseline to stay immune to any stale attention in the
    // shared test DB.
    const badge = () =>
      page.evaluate(() => (window as unknown as { __badge: number | null }).__badge ?? 0);
    const base = await badge();
    ws.send({ type: "unread:updated", topicId: mutedTopic.id, unreadCount: 1 });
    ws.send({ type: "unread:updated", topicId: loudTopic.id, unreadCount: 1 });
    await expect.poll(badge, { timeout: 5000 }).toBe(base + 2);

    // The muted topic's tab still shows its own on-screen count — muting hides
    // the banner + sound, never the badge.
    const mutedTabBadge = page
      .locator(`[data-pane-id="${mutedTopic.id}"]`)
      .locator("span")
      .filter({ hasText: /^1$/ });
    await expect(mutedTabBadge).toBeVisible({ timeout: 5000 });

    // (3) Foreground the muted topic → the server broadcasts its unread as read
    // (unread:updated → 0) → the badge drops back by one. Its share is gone; the
    // still-backgrounded Loud topic keeps the badge at base+1.
    await page.locator(`[data-pane-id="${mutedTopic.id}"]`).click();
    ws.send({ type: "unread:updated", topicId: mutedTopic.id, unreadCount: 0 });
    await expect.poll(badge, { timeout: 5000 }).toBe(base + 1);
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
    await page.clock.install();
    const ws = await interceptWebSocket(page);
    const AGENTS = "__board__";
    await page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [mutedTopic.id, loudTopic.id, AGENTS] },
    });
    await page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: {
        order: [mutedTopic.id, loudTopic.id, AGENTS],
        pinned: [mutedTopic.id, loudTopic.id, AGENTS],
      },
    });
    await resetPaneStore(page.request, [mutedTopic.id, loudTopic.id, AGENTS]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.locator(`[data-pane-id="${AGENTS}"]`).waitFor({ state: "visible", timeout: 10000 });
    await page.locator(`[data-pane-id="${AGENTS}"]`).click();
    // THE DWELL IS MOVED, NOT WAITED FOR.
    //
    // This step is load-bearing and that was measured, not assumed: taking it
    // out entirely makes the test pass on a build WITHOUT the fix — vacuously
    // green, the worst outcome a regression test can have.
    //
    // But it cannot be an ordinary wait-for-condition either. `isSeen`
    // (client/src/state/signals.ts) is a PREDICATE over `focusedSince` compared
    // against `Date.now()`: no timer fires, no request goes out. "The dwell has
    // elapsed" has no positive observable — and on the FIXED build it never
    // becomes true at all, because the blur resets `focusedSince`, which is the
    // very thing under test. A condition that only exists on the broken build
    // cannot be what the good build waits for.
    //
    // So the clock moves instead: `page.clock` advances what `Date.now()`
    // returns, buying the same fact a 2500 ms sleep bought against a 1200 ms
    // dwell, without spending the seconds. Verified both ways after the change
    // — green with the fix, red without it.
    await page.clock.fastForward(2500);

    const badge = () =>
      page.evaluate(() => (window as unknown as { __badge: number | null }).__badge ?? 0);

    // Wait for the SIGNAL, not for a duration.
    //
    // What is needed is that focus has LEFT the chats: it is the app-level blur
    // (`App.tsx`) that tells the server. The frame fires when the active pane is
    // not a chat, so that is exactly the observable condition — no
    // `waitForTimeout`, which here would be the sleep `check:sleeps` forbids and
    // which on a loaded machine would not be enough anyway.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-pane-id="__board__"]');
        return !!el && el.getAttribute("data-active") === "true";
      },
      undefined,
      { timeout: 10_000, polling: "raf" },
    );

    ws.send({ type: "unread:updated", topicId: mutedTopic.id, unreadCount: 0 });
    ws.send({ type: "unread:updated", topicId: loudTopic.id, unreadCount: 0 });
    // The reset has landed once the badge settles on a value: two equal reads
    // in a row, not a wait on the clock.
    let base = -1;
    await expect
      .poll(
        async () => {
          const a = await badge();
          const b = await badge();
          if (a === b) { base = a; return true; }
          return false;
        },
        { message: "il badge non si e' fermato prima della misura", timeout: 10_000 },
      )
      .toBe(true);

    // The FIRST pane opened: the one the bug left marked as "being read".
    ws.send({ type: "unread:updated", topicId: mutedTopic.id, unreadCount: 1 });
    await expect
      .poll(badge, {
        message: "la chat in secondo piano deve contare: era delta 0 prima del blur",
        timeout: 5000,
      })
      .toBe(base + 1);

    ws.send({ type: "unread:updated", topicId: loudTopic.id, unreadCount: 1 });
    await expect
      .poll(badge, { message: "e la seconda pure", timeout: 5000 })
      .toBe(base + 2);
  });

});
