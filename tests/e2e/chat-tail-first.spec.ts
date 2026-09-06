import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { HISTORY_FIRST_PAGE } from "../../shared/history-paging";
import { VISIBLE_CHAT_SCROLLER as SCROLLER, wheelUpUntilVisible } from "./helpers/wheel-scroll";
import {
  armFullness,
  armObserver,
  buildReport,
  collectFullness,
  collectShifts,
  settledUntilQuiet,
  summarize,
  waitForLocalCopy,
  writeReport,
} from "./helpers/cls-return";

hermetic(test);

/**
 * CHAT-HIST-01 - the chat opens on its TAIL, and the rest of the history
 * arrives when nobody is looking at the list.
 *
 * THE DEFECT, measured on the desktop's own state on 2026-09-05: after a reload
 * the chat sat behind its skeleton for 500-1200 ms - up to the curtain's hard
 * cap - because the curtain waited for the WHOLE history (`limit: 0`), which
 * weighs 200 KB to 2.6 MB per chat and lands in 0.7-1.7 s. This spec pins the
 * shape that replaces it: one request for the last `HISTORY_FIRST_PAGE`
 * messages, the curtain lifting on THAT page, and the messages before it fetched
 * and merged only while the pane is hidden (a tab behind another) or when the
 * reader clicks the row at the top of the loaded window.
 *
 * THE METHOD is the one of `refresh-cls.spec.ts` (observer armed before any
 * line of the app, second load, web-vitals session windows) plus two probes of
 * its own:
 *
 *  - the REVEAL instant: the first frame in which Virtuoso's item list is
 *    painted AND no longer `visibility: hidden` - that is, the curtain is up.
 *    Reported relative to the app shell's first paint, like `Fullness`.
 *  - the two kinds of history request, counted per session, with the older
 *    page HELD by `page.route` for `OLDER_DELAY_MS`: long enough that a curtain
 *    waiting for it would hit its own hard cap first, which is what the old
 *    shape did and what this spec must be able to tell apart from the new one.
 *
 * Seeded content is three pages long so the second request has two pages to
 * bring, and every message carries its ordinal so the head (`#001`), the first
 * row of the loaded window (`#081`) and the tail (`#120`) can be asked for by
 * name.
 *
 * @covers CHAT-HIST-01
 */

/** Same ceiling as `refresh-cls.spec.ts`: a return has nothing to discover. */
const RETURN_BUDGET = 0.01;
/** The curtain's hard cap (`LIST_REVEAL_HARD_CAP_MS` in MessageList): the tail
 *  must be on screen before it, or the reveal is the cap, not the page. */
const REVEAL_CAP_MS = 1200;
/** Three pages: one answered first, two fetched afterwards. */
const SEEDED = HISTORY_FIRST_PAGE * 3;
/** Fewer than a page: the chat that must keep making ONE request. */
const SHORT = 5;
/** How long the older page is held back once it is asked for. */
const OLDER_DELAY_MS = 2000;
const LABEL = process.env.E2E_CLS_LABEL || "run";
const LIST = '[data-testid="virtuoso-item-list"]';

function seededText(n: number): string {
  return `Seeded message #${String(n).padStart(3, "0")}`;
}

/** The session key of a topic, asked rather than guessed: its shape is the
 *  server's business and it has changed before. */
async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  expect(res.ok()).toBe(true);
  const { topics } = (await res.json()) as { topics: Record<string, { sessionKey: string }> };
  const key = topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey: nothing to seed into`);
  return key;
}

/** A reply of the weight real ones have: about 4 KB of prose, so three pages
 *  weigh a few hundred KB on the wire like the chats measured on the desktop,
 *  and not the few KB of a one-line seed that would prove nothing. */
const REPLY_PROSE = "The agent explains what it did, quotes a path, and moves on to the next step. ".repeat(50);

/** Sequential on purpose: the seed endpoint links each row to the session's
 *  current last message, and parallel POSTs would fork the thread. */
async function seedThread(request: APIRequestContext, sessionKey: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const user = i % 2 === 1;
    await seedMessage(request, {
      sessionKey,
      role: user ? "user" : "assistant",
      content: user ? `${seededText(i)}\n\nA short question.` : `${seededText(i)}\n\n${REPLY_PROSE}`,
    });
  }
}

/** The seeded row in the TRANSCRIPT. `page.getByText` alone also matches the
 *  sidebar preview, which quotes the last message. */
function rowOf(page: Page, n: number) {
  return page.locator(LIST).getByText(seededText(n));
}

/** When the curtain went up: the item list painted and no longer hidden. */
async function armReveal(page: Page): Promise<void> {
  await page.addInitScript((sel: string) => {
    const w = window as unknown as { __revealAt: number | null };
    w.__revealAt = null;
    const tick = () => {
      if (w.__revealAt !== null) return;
      const list = document.querySelector(sel);
      if (list && list.childElementCount > 0 && getComputedStyle(list).visibility !== "hidden") {
        w.__revealAt = performance.now();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, LIST);
}

async function revealAfterShellMs(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const w = window as unknown as { __revealAt?: number | null; __shellAt?: number | null };
    if (w.__revealAt == null || w.__shellAt == null) return null;
    return Math.max(0, Math.round(w.__revealAt - w.__shellAt));
  });
}

type Probe = {
  /** Requests for the tail (no `before`), and for the messages before it. */
  firstPage: number;
  older: number;
  /** Older answers RELEASED so far (the hold is over, the bytes are on their way). */
  olderReleased: number;
};

/** Counts the two kinds of history request for ONE session and holds the older
 *  page back, so "not asked for while on screen" is a fact and not a race. */
async function probeHistoryRequests(page: Page, sessionKey: string): Promise<Probe> {
  const probe: Probe = { firstPage: 0, older: 0, olderReleased: 0 };
  await page.route(`**/api/history/${encodeURIComponent(sessionKey)}*`, async (route) => {
    let body: { before?: string } = {};
    try {
      body = JSON.parse(route.request().postData() || "{}") as { before?: string };
    } catch {
      body = {};
    }
    if (body.before) {
      probe.older += 1;
      await new Promise((r) => setTimeout(r, OLDER_DELAY_MS));
      probe.olderReleased += 1;
      await route.continue();
      return;
    }
    probe.firstPage += 1;
    await route.continue();
  });
  return probe;
}

test.describe("La chat si apre sulla coda", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  let longTopic: { id: string; name: string };
  let shortTopic: { id: string; name: string };
  /** The tab to switch to, so the long chat goes behind it. */
  let otherTopic: { id: string; name: string };
  let longKey = "";
  let shortKey = "";

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    longTopic = await createTopic(request, `tail-first-long-${stamp}`);
    shortTopic = await createTopic(request, `tail-first-short-${stamp}`);
    otherTopic = await createTopic(request, `tail-first-other-${stamp}`);
    longKey = await sessionKeyOf(request, longTopic.id);
    shortKey = await sessionKeyOf(request, shortTopic.id);
    await seedThread(request, longKey, SEEDED);
    await seedThread(request, shortKey, SHORT);
    await seedMessage(request, { sessionKey: await sessionKeyOf(request, otherTopic.id), role: "user", content: "The other tab" });
  });

  test.afterAll(async ({ request }) => {
    for (const t of [longTopic, shortTopic, otherTopic]) {
      if (t) await deleteTopic(request, t.id).catch(() => {});
    }
  });

  test("il sipario si alza sulla coda senza chiedere il resto; il resto arriva dietro la scheda e al ritorno la chat e' intera", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    // A dedicated browser, a seeded return, a two-second hold and two tab
    // switches: the 30s default is the suite's, not this test's.
    test.setTimeout(120_000);
    await resetPaneStore(request, [longTopic.id, otherTopic.id]);

    const LONG_TAB = `pane-tab-${longTopic.id}`;
    const OTHER_TAB = `pane-tab-${otherTopic.id}`;
    let probe: Probe = { firstPage: 0, older: 0, olderReleased: 0 };
    let reveal: number | null = null;
    let cls = 0;
    let summary = "";

    await clipDiConsegna({
      nome: "chat-tail-first",
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 720 },
        reducedMotion: "reduce",
      },
      // 1) The departure: only there to warm the local copy of the long chat.
      prologo: async (p) => {
        await p.goto("/");
        await p.getByTestId(LONG_TAB).click();
        await expect(rowOf(p, SEEDED)).toBeVisible({ timeout: 15000 });
        await waitForLocalCopy(p, "messages-cache-", seededText(SEEDED));
      },
      // 2) The return. Same context, so the same localStorage: the first frame
      //    comes from the device. No interaction until the page is quiet.
      scena: async (p) => {
        await armObserver(p);
        await armFullness(p, LIST);
        await armReveal(p);
        probe = await probeHistoryRequests(p, longKey);
        await p.goto("/");

        await expect(rowOf(p, SEEDED)).toBeVisible({ timeout: 15000 });
        await settledUntilQuiet(p, { quietMs: 1500, timeout: 30000 });
        await didascalia(p, "Ricarico: la chat si apre sulla coda, il resto non viene nemmeno chiesto");
        await beat(p, 1200);

        const shifts = await collectShifts(p);
        const fullness = await collectFullness(p, LIST);
        reveal = await revealAfterShellMs(p);
        const report = buildReport(shifts, {
          fullness,
          geometry: { revealAfterShellMs: reveal, olderDelayMs: OLDER_DELAY_MS, ...probe },
        });
        cls = report.cls;
        summary = summarize(report);
        const file = writeReport(LABEL, "tail-first-1280x720", report);
        console.log(
          `\n[tail-first:${LABEL}] reveal=${reveal}ms after shell · CLS=${report.cls.toFixed(4)} total=${report.total.toFixed(4)} shifts=${report.count}` +
            `\n[tail-first:${LABEL}] requests while on screen: firstPage=${probe.firstPage} older=${probe.older}` +
            `\n${summary}\n-> ${file}\n`,
        );
        // The tail, once; the rest, never - nobody looked away yet.
        expect(probe.firstPage, "requests for the tail").toBe(1);
        expect(probe.older, "requests for the messages before the tail while the pane is on screen").toBe(0);
        expect(reveal, "the reveal instant was never recorded").not.toBeNull();
        expect(reveal ?? Infinity, "the curtain lifted at its hard cap, not on the page").toBeLessThan(REVEAL_CAP_MS);
        expect(report.cls, `who moved:\n${summary}`).toBeLessThanOrEqual(RETURN_BUDGET);
        // Partial, and honest about it. The row at the top is virtualised away
        // while the viewport rests at the bottom, so the list says it itself.
        await expect(p.locator(SCROLLER)).toHaveAttribute("data-history", "partial");

        // 3) Look away: the long chat goes behind the other tab, and THAT is
        //    when the rest is asked for.
        await p.getByTestId(OTHER_TAB).click();
        await expect(p.getByText("The other tab").first()).toBeVisible({ timeout: 15000 });
        await didascalia(p, "Cambio scheda: adesso, dietro, si chiede il resto della storia");
        await expect.poll(() => probe.older, { timeout: 10000, message: "the older page was never asked for while hidden" }).toBe(1);
        await expect.poll(() => probe.olderReleased, { timeout: 10000 }).toBe(1);
        // The merge happened out of sight: both mounted transcripts (the
        // other tab's chat is whole on its own) now say so, and the long one
        // says it while nobody can see a row of it.
        await expect(p.locator('[data-testid="chat-message-list"][data-history="complete"]')).toHaveCount(2, { timeout: 15000 });
        await beat(p, 800);

        // 4) Come back: the chat rests where it was, on its tail, and is whole.
        await p.getByTestId(LONG_TAB).click();
        await expect(rowOf(p, SEEDED)).toBeVisible({ timeout: 15000 });
        await didascalia(p, "Al ritorno la chat e' in fondo, e la storia e' intera");
        await beat(p, 1200);
        await expect(p.locator(SCROLLER)).toHaveAttribute("data-history", "complete");
        expect(probe.older, "the messages before the tail were asked for more than once").toBe(1);

        // 5) The head is reachable: the first seeded message is up there, and
        //    the row that offered to load it is gone (here, at the top, item 0
        //    is mounted, so the count means something).
        await wheelUpUntilVisible(p, rowOf(p, 1), 120);
        await expect(p.getByTestId("chat-load-older")).toHaveCount(0);
        await didascalia(p, "Scorrendo in alto si arriva al primo messaggio");
        await beat(p, 1500);
      },
    });
  });

  test("chi scorre in alto prima del completamento trova la riga «Carica i messaggi precedenti», e il click lo porta al primo messaggio", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    test.setTimeout(120_000);
    await resetPaneStore(request, [longTopic.id]);
    const LONG_TAB = `pane-tab-${longTopic.id}`;
    const MISSING = SEEDED - HISTORY_FIRST_PAGE;
    let probe: Probe = { firstPage: 0, older: 0, olderReleased: 0 };

    await clipDiConsegna({
      nome: "chat-tail-first-load-earlier",
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 720 },
        reducedMotion: "reduce",
      },
      prologo: async (p) => {
        await p.goto("/");
        await p.getByTestId(LONG_TAB).click();
        await expect(rowOf(p, SEEDED)).toBeVisible({ timeout: 15000 });
        await waitForLocalCopy(p, "messages-cache-", seededText(SEEDED));
      },
      scena: async (p) => {
        probe = await probeHistoryRequests(p, longKey);
        await p.goto("/");
        await expect(rowOf(p, SEEDED)).toBeVisible({ timeout: 15000 });

        // Straight up, before anything else: the loaded window begins at #081,
        // and above it sits the row, naming the eighty messages it hides.
        const divider = p.getByTestId("chat-load-older");
        await wheelUpUntilVisible(p, divider);
        await expect(rowOf(p, HISTORY_FIRST_PAGE * 2 + 1)).toBeVisible();
        await expect(divider).toContainText(`(${MISSING})`);
        expect(probe.older, "scrolling to the top must not load anything by itself").toBe(0);
        await didascalia(p, `In cima alla finestra caricata: «Carica i messaggi precedenti (${MISSING})»`);
        await beat(p, 1500);

        // The click is the request. The list re-anchors on the row that was
        // first, so the reader keeps reading upwards from where they were.
        await p.getByTestId("chat-load-older-button").click();
        await expect.poll(() => probe.older, { timeout: 10000 }).toBe(1);
        await expect(p.locator(SCROLLER)).toHaveAttribute("data-history", "complete", { timeout: 15000 });
        await expect(divider).toHaveCount(0);
        await expect(rowOf(p, HISTORY_FIRST_PAGE * 2 + 1)).toBeVisible({ timeout: 10000 });
        await didascalia(p, "Il click carica il resto e riancora sul messaggio che era il primo");
        await beat(p, 1500);

        // And the head is now reachable by scrolling on.
        await wheelUpUntilVisible(p, rowOf(p, 1), 120);
        await didascalia(p, "Scorrendo ancora, il primo messaggio della chat");
        await beat(p, 1500);
        expect(probe.firstPage, "requests for the tail").toBe(1);
      },
    });
  });

  test("una chat piu' corta di una pagina fa UNA richiesta sola", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    await resetPaneStore(request, [shortTopic.id]);

    await goToApp(page);
    await page.getByTestId(`pane-tab-${shortTopic.id}`).click();
    await expect(rowOf(page, SHORT)).toBeVisible({ timeout: 15000 });
    await waitForLocalCopy(page, "messages-cache-", seededText(SHORT));

    await armObserver(page);
    const probe = await probeHistoryRequests(page, shortKey);
    await page.reload({ waitUntil: "commit" });
    await expect(rowOf(page, SHORT)).toBeVisible({ timeout: 15000 });
    await settledUntilQuiet(page, { quietMs: 1500, timeout: 30000 });

    expect(probe.firstPage, "requests for the tail").toBe(1);
    expect(probe.older, "a chat shorter than a page has nothing before its tail").toBe(0);
    await expect(page.getByTestId("chat-load-older")).toHaveCount(0);
  });
});
