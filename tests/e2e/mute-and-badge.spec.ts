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
 *  Letta dall'elenco: non esiste un GET per singolo topic. */
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
});
