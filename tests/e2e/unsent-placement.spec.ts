import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { collapseSidebarSections, countTabBars, splitViaContextMenu } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";
import { seedMessage } from "./helpers/seed-messages";

hermetic(test);

/**
 * WHERE the unsent messages are shown, measured on the DOM (CHAT-QUEUE-06).
 *
 * Reported on 24/09: "1 messaggio non inviato" appeared as a toast at the
 * bottom of whatever pane happened to sit under the centre of the grid, on top
 * of that pane's composer, and cut off. The toast was `absolute` inside the
 * grid, so with three columns it landed on the middle one whatever chat the
 * message belonged to.
 *
 * The contract measured here:
 *   - a message of a chat that is ON SCREEN is shown inside that chat, above
 *     its composer, never over it, and never clipped by an ancestor;
 *   - a message of a chat that is NOT on screen is shown by the global band,
 *     which covers no pane (no chat panel intersects it) and is not clipped.
 *
 * Geometry comes from bounding boxes and the clip of every overflow ancestor,
 * never from a screenshot read by eye.
 */
test.use({ video: "on" });

const BASE = E2E_BASE;
const OUTBOUND_KEY = "messages-outbound-queue";
const EXPIRED_KEY = "messages-expired-queue";
const SHOTS = process.env.UNSENT_SHOTS_DIR ?? "test-results/unsent-placement";

interface Rect { x: number; y: number; w: number; h: number }
interface Measure {
  viewport: { w: number; h: number };
  /** Every element that reports an unsent row, with where it ended up. */
  rows: {
    sessionKey: string;
    rect: Rect;
    /** Area of the row that is actually painted: box ∩ viewport ∩ every overflow clip. */
    visibleRatio: number;
    /** Topic id of the chat panel that contains the row, if any. */
    insideChat: string | null;
    /** Pixels of overlap with ANY composer card on screen. */
    composerOverlap: number;
    /** The topmost element at the row's centre is the row itself: nothing
     *  opaque (a drawer, a modal) lies over it. A box can be fully inside the
     *  viewport and still be hidden, which is what this catches. */
    onTop: boolean;
  }[];
  banner: null | {
    rect: Rect;
    visibleRatio: number;
    /** Pixels of overlap with the visible chat panels: the band must cover none. */
    chatOverlap: number;
    composerOverlap: number;
    onTop: boolean;
  };
}

/** One pass over the DOM: rows, the global band, and what each one overlaps. */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const toRect = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
    const inter = (a: DOMRect, b: { left: number; top: number; right: number; bottom: number }) => {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return w > 0 && h > 0 ? w * h : 0;
    };
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // The painted part of a box: cut by the viewport and by every ancestor
    // that clips (overflow other than visible). A ratio under 1 IS "cut off".
    const visibleRatio = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return 0;
      let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
          const pr = p.getBoundingClientRect();
          clip = {
            left: Math.max(clip.left, pr.left),
            top: Math.max(clip.top, pr.top),
            right: Math.min(clip.right, pr.right),
            bottom: Math.min(clip.bottom, pr.bottom),
          };
        }
      }
      return inter(r, clip) / (r.width * r.height);
    };
    const onTop = (el: Element) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && el.contains(hit);
    };
    const composers = [...document.querySelectorAll('[data-testid="composer-card"]')].filter(shown);
    const chats = [...document.querySelectorAll('[data-testid="chat-panel"]')].filter(shown);
    const overlapWith = (el: Element, others: Element[]) =>
      others.reduce((sum, o) => (o.contains(el) ? sum : sum + inter(el.getBoundingClientRect(), o.getBoundingClientRect())), 0);

    const rows = [...document.querySelectorAll('[data-testid="unsent-row"]')].filter(shown).map((el) => ({
      sessionKey: el.getAttribute("data-session-key") ?? "",
      rect: toRect(el.getBoundingClientRect()),
      visibleRatio: visibleRatio(el),
      insideChat: el.closest('[data-testid="chat-panel"]')?.getAttribute("data-chat-topic-id") ?? null,
      composerOverlap: overlapWith(el, composers),
      onTop: onTop(el),
    }));
    const bannerEl = document.querySelector('[data-testid="unsent-banner"]');
    const banner = bannerEl && shown(bannerEl)
      ? {
          rect: toRect(bannerEl.getBoundingClientRect()),
          visibleRatio: visibleRatio(bannerEl),
          chatOverlap: overlapWith(bannerEl, chats),
          composerOverlap: overlapWith(bannerEl, composers),
          onTop: onTop(bannerEl),
        }
      : null;
    return { viewport: { w: window.innerWidth, h: window.innerHeight }, rows, banner };
  });
}

/**
 * The measure once it stops moving: `rowCount` rows actually seen and two
 * consecutive readings identical. The input area resizes itself after mount,
 * so the first reading can catch a strip mid-layout.
 */
async function settledMeasure(page: Page, rowCount: number): Promise<Measure> {
  let prev = "";
  let last: Measure | null = null;
  await expect
    .poll(async () => {
      last = await measure(page);
      const now = JSON.stringify(last);
      const stable = last.rows.filter((r) => r.onTop).length === rowCount && now === prev;
      prev = now;
      return stable;
    }, { timeout: 20_000, intervals: [250] })
    .toBe(true);
  return last!;
}

async function seedExpiredQueue(page: Page, entries: { sessionKey: string; content: string }[]) {
  await page.addInitScript(
    ([outboundKey, expiredKey, payload]: [string, string, string]) => {
      const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const items = (JSON.parse(payload) as { sessionKey: string; content: string }[]).map(
        (entry, index) => ({ ...entry, timestamp: stale, id: `e2e-unsent-place-${index}` }),
      );
      window.localStorage.setItem(expiredKey, JSON.stringify(items));
      window.localStorage.removeItem(outboundKey);
    },
    [OUTBOUND_KEY, EXPIRED_KEY, JSON.stringify(entries)] as [string, string, string],
  );
}

async function failEverySend(page: Page) {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
}

test.describe.serial("Unsent messages: placement", () => {
  const ids: string[] = [];
  const sessions: Record<string, string> = {};
  let closedId = "";
  let closedName = "";

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    for (const tag of ["a", "b", "c"]) {
      ids.push((await createTopic(request, `unsent-place-${tag}-${stamp}`)).id);
    }
    closedName = `unsent-place-closed-${stamp}`;
    closedId = (await createTopic(request, closedName)).id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    for (const t of Object.values(topics)) {
      if ([...ids, closedId].includes(t.id)) sessions[t.id] = t.sessionKey;
    }
    expect(Object.keys(sessions)).toHaveLength(4);
    // A conversation in every open chat: an EMPTY chat centres its composer
    // under the greeting, and the reported case is a composer docked at the
    // bottom edge, where the old toast landed on top of it.
    for (const id of ids) {
      await seedMessage(request, { sessionKey: sessions[id]!, role: "user", content: "ciao" });
      await seedMessage(request, { sessionKey: sessions[id]!, role: "assistant", content: "ciao, dimmi pure" });
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...ids, closedId]) await deleteTopic(request, id);
  });

  test("three columns: the visible chat shows it above its composer, the closed chat in a band that covers no pane", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-06" });
    // Only the three chats are open: the fourth has a message but no tab.
    await resetPaneStore(request, ids);
    await failEverySend(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await goToApp(page);
    await collapseSidebarSections(page);

    // Three columns, one chat each.
    await expect.poll(() => page.locator('[role="main"] [data-testid="pane-tab-label"]').count(), { timeout: 15_000 }).toBe(3);
    await splitViaContextMenu(page, "Dividi a destra", 0);
    await splitViaContextMenu(page, "Dividi a destra", 1);
    expect(await countTabBars(page)).toBe(3);
    const visibleChats = await page.locator('[data-testid="chat-panel"]').evaluateAll((els) =>
      els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getAttribute("data-chat-topic-id") ?? ""),
    );
    expect(visibleChats).toHaveLength(3);
    // The chat in the RIGHT column, the one the old toast never landed on.
    const rightId = await page.locator('[data-testid="chat-panel"]').evaluateAll((els) => {
      const shownEls = els.filter((e) => e.getBoundingClientRect().width > 0);
      shownEls.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
      return shownEls[0]?.getAttribute("data-chat-topic-id") ?? "";
    });
    expect(ids).toContain(rightId);

    // Seed now and reload, so the layout just built is the one measured.
    await seedExpiredQueue(page, [
      { sessionKey: sessions[rightId]!, content: "messaggio della colonna di destra" },
      { sessionKey: sessions[closedId]!, content: "messaggio di una chat chiusa" },
    ]);
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
    await expect(page.locator('[data-testid="unsent-row"]').first()).toBeVisible({ timeout: 20_000 });
    const m = await settledMeasure(page, 2);
    test.info().annotations.push({ type: "measure", description: JSON.stringify(m) });
    console.log("UNSENT-MEASURE", JSON.stringify(m));
    await page.screenshot({ path: `${SHOTS}/unsent-three-columns.png` });

    const rightRow = m.rows.find((r) => r.sessionKey === sessions[rightId]);
    const closedRow = m.rows.find((r) => r.sessionKey === sessions[closedId]);
    expect(rightRow, "row for the visible chat").toBeTruthy();
    expect(closedRow, "row for the closed chat").toBeTruthy();

    // The visible chat's message is IN that chat, fully painted, off its composer.
    expect(rightRow!.insideChat).toBe(rightId);
    expect(rightRow!.visibleRatio).toBeGreaterThanOrEqual(0.99);
    expect(rightRow!.composerOverlap).toBe(0);
    expect(rightRow!.onTop).toBe(true);

    // The closed chat's message is in the global band: painted in full, over no pane.
    expect(closedRow!.insideChat).toBeNull();
    expect(closedRow!.visibleRatio).toBeGreaterThanOrEqual(0.99);
    expect(closedRow!.onTop).toBe(true);
    expect(m.banner).not.toBeNull();
    expect(m.banner!.visibleRatio).toBeGreaterThanOrEqual(0.99);
    expect(m.banner!.chatOverlap).toBe(0);
    expect(m.banner!.composerOverlap).toBe(0);
    await expect(page.locator(`[data-testid="unsent-row"][data-session-key="${sessions[closedId]}"]`)).toContainText(closedName);
  });

  test("the in-chat strip retries and discards its own chat only", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-06" });
    await resetPaneStore(request, [ids[0]!]);
    const sent: string[] = [];
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await seedExpiredQueue(page, [
      { sessionKey: sessions[ids[0]!]!, content: "da riprovare qui" },
      { sessionKey: sessions[closedId]!, content: "resta nella fascia" },
    ]);
    await goToApp(page);

    const strip = page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${ids[0]}"] [data-testid="unsent-strip"]`);
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(strip).toContainText("da riprovare qui");
    await strip.getByTestId("unsent-row-retry").click();
    await expect.poll(() => sent.join(" | "), { timeout: 15_000 }).toContain("da riprovare qui");
    expect(sent.join(" | ")).not.toContain("resta nella fascia");
    // The band still holds the other chat.
    await expect(page.getByTestId("unsent-banner")).toContainText(closedName);
  });

  test("on a phone: the band sits above the bottom bar, and the opened chat shows its own strip above the composer", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-06" });
    await resetPaneStore(request, [ids[0]!]);
    await failEverySend(page);
    await seedExpiredQueue(page, [
      { sessionKey: sessions[ids[0]!]!, content: "sul telefono, in questa chat" },
      { sessionKey: sessions[closedId]!, content: "sul telefono, in un'altra chat" },
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await goToApp(page);

    const reserved = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return parseFloat(cs.getPropertyValue("--mobile-chrome-h")) || 0;
      });

    // 1. The phone's home screen is the drawer: both chats are listed in the
    //    band, seen (not under the drawer), above the bottom bar.
    const home = await settledMeasure(page, 2);
    console.log("UNSENT-MEASURE-MOBILE-HOME", JSON.stringify(home));
    await page.screenshot({ path: `${SHOTS}/unsent-mobile-home.png` });
    expect(home.banner).not.toBeNull();
    expect(home.banner!.onTop).toBe(true);
    expect(home.banner!.visibleRatio).toBeGreaterThanOrEqual(0.99);
    expect(home.banner!.rect.w).toBeGreaterThan(350);
    expect(home.banner!.rect.y + home.banner!.rect.h).toBeLessThanOrEqual(844 - (await reserved()) + 1);

    // 2. Open the chat from its row: the drawer closes, the chat's message
    //    moves into its own strip above the composer, the band keeps the other.
    await page
      .locator(`[data-testid="unsent-banner"] [data-testid="unsent-row"][data-session-key="${sessions[ids[0]!]}"]`)
      .getByTestId("unsent-row-open")
      .click();
    const chat = await settledMeasure(page, 2);
    console.log("UNSENT-MEASURE-MOBILE-CHAT", JSON.stringify(chat));
    await page.screenshot({ path: `${SHOTS}/unsent-mobile.png` });
    const inChat = chat.rows.find((r) => r.onTop && r.sessionKey === sessions[ids[0]!]);
    expect(inChat?.insideChat).toBe(ids[0]);
    for (const row of chat.rows.filter((r) => r.onTop)) {
      expect(row.visibleRatio).toBeGreaterThanOrEqual(0.99);
      expect(row.composerOverlap).toBe(0);
    }
    expect(chat.banner).not.toBeNull();
    expect(chat.banner!.onTop).toBe(true);
    expect(chat.banner!.composerOverlap).toBe(0);
    expect(chat.banner!.chatOverlap).toBe(0);
    expect(chat.banner!.rect.y + chat.banner!.rect.h).toBeLessThanOrEqual(844 - (await reserved()) + 1);
    await expect(page.getByTestId("unsent-banner")).toContainText(closedName);
  });
});
