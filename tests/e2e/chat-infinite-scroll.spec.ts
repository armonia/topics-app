import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { didascalia, beat } from "./helpers/evidence";
import { HISTORY_FIRST_PAGE, OLDER_MERGE_SCREENS, OLDER_STAGE_SCREENS } from "../../shared/history-paging";
import { VISIBLE_CHAT_SCROLLER as SCROLLER } from "./helpers/wheel-scroll";

hermetic(test);

/**
 * CHAT-HIST-01 - infinite scroll: heading up a chat opened on its tail, the
 * earlier messages arrive by themselves, and the rows being read do not move.
 *
 * THE CONTRACT THIS REPLACES. Until 2026-10-08 the messages before the first
 * page came only on a click on the row that loads them: prepending under
 * the reader with Virtuoso's `firstItemIndex` cost a blank frame and a CLS of
 * 0.60 on Virtuoso 4.18.1 (tag `archive/experiment-chat-tail-first-virtuoso-
 * prepend`). Virtuoso 4.18.13 lands the compensating scroll in the same paint.
 * This spec is what says so, on both engines.
 *
 * THE METHOD. A probe samples every animation frame: the history state the
 * list carries (`data-history`), the offset of every row in view by its seeded
 * ordinal, and whether any row is in view at all. The reader goes up with the
 * wheel and waits for a still view after each step (WebKit on Linux animates
 * the wheel: a reading taken mid-animation is a lie). Big steps bring it just
 * short of the merge, then steps of `NUDGE_PX` cross it, so from the frame
 * before the merge until the step that crossed it has landed the rows move by
 * at most one nudge, and not at all after. "Landed", not "the next frame": an
 * engine that animates the wheel spreads the step over frames, and the merge
 * can fall in the middle of it. A merge that is not compensated moves the rows
 * by the height of the page it adds, or out of view. CLS is read on Chromium
 * only: WebKit has no Layout Instability API. Its sources are logged, because a
 * shift between a frame's sample and its paint never reaches the probe.
 *
 * @covers CHAT-HIST-01
 */

const SEEDED = HISTORY_FIRST_PAGE * 3;
const NUDGE_PX = 12;
/** Where the big steps stop above the merge: room for the list's own corrections, crossed in nudges. */
const APPROACH_PX = 72;
/** One pixel of rounding on each side of a still row. */
const STILL_PX = 1;
const CLS_BUDGET = 0.01;
const ROW = /Seeded message #(\d{3})/;

function seededText(n: number): string {
  return `Seeded message #${String(n).padStart(3, "0")}`;
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  expect(res.ok()).toBe(true);
  const { topics } = (await res.json()) as { topics: Record<string, { sessionKey: string }> };
  const key = topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey: nothing to seed into`);
  return key;
}

/** Replies of a real weight (about 4 KB), so three pages span many screens. */
const REPLY_PROSE = "The agent explains what it did, quotes a path, and moves on to the next step. ".repeat(50);

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

type Frame = { t: number; state: string | null; rows: Record<string, number>; inView: number; st: number };
/** A layout shift, with up to three of the nodes it moved (`tag[testid or index] y<before>-><after> h<height>`). */
type Shift = { value: number; t: number; sources: string[] };

/** Samples every frame of the visible chat scroller until `__probeStop`. */
async function armFrameProbe(page: Page): Promise<void> {
  await page.evaluate(({ sel, rowPattern }) => {
    const w = window as unknown as { __frames: unknown[]; __probeStop?: boolean; __shifts: Shift[] };
    w.__frames = [];
    w.__shifts = [];
    w.__probeStop = false;
    const pattern = new RegExp(rowPattern);
    const named = (node: Node | null): string => {
      if (!(node instanceof Element)) return node?.nodeName ?? "?";
      const id = node.getAttribute("data-testid") ?? node.getAttribute("data-index");
      return id ? `${node.tagName.toLowerCase()}[${id}]` : node.tagName.toLowerCase();
    };
    type Source = { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Source[] })[]) {
          if (e.hadRecentInput) continue;
          const sources = (e.sources ?? []).slice(0, 3).map((src) =>
            `${named(src.node)} y${Math.round(src.previousRect.y)}->${Math.round(src.currentRect.y)} h${Math.round(src.currentRect.height)}`);
          w.__shifts.push({ value: e.value, t: e.startTime, sources });
        }
      }).observe({ type: "layout-shift" });
    } catch { /* WebKit: no Layout Instability API */ }
    const tick = () => {
      if (w.__probeStop) return;
      const scroller = [...document.querySelectorAll(sel.replace(":visible", ""))].find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
      if (scroller) {
        const view = scroller.getBoundingClientRect();
        const rows: Record<string, number> = {};
        let inView = 0;
        for (const row of scroller.querySelectorAll("[data-index]")) {
          const box = row.getBoundingClientRect();
          if (box.bottom <= view.top || box.top >= view.bottom) continue;
          inView++;
          const n = pattern.exec(row.textContent || "")?.[1];
          if (n) rows[n] = Math.round((box.top - view.top) * 10) / 10;
        }
        w.__frames.push({ t: performance.now(), state: scroller.getAttribute("data-history"), rows, inView, st: Math.round(scroller.scrollTop) });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { sel: SCROLLER, rowPattern: ROW.source });
}

async function stopProbe(page: Page): Promise<{ frames: Frame[]; shifts: Shift[] }> {
  return await page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __probeStop?: boolean; __shifts: Shift[] };
    w.__probeStop = true;
    return { frames: w.__frames, shifts: w.__shifts };
  });
}

/** Waits until `scrollTop` has not changed for a few frames: the wheel has landed. */
async function stillView(page: Page): Promise<number> {
  return await page.evaluate(async (sel) => {
    const scroller = [...document.querySelectorAll(sel.replace(":visible", ""))].find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement;
    let last = -1;
    let still = 0;
    for (let i = 0; i < 120 && still < 4; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const st = scroller.scrollTop;
      still = st === last ? still + 1 : 0;
      last = st;
    }
    return scroller.scrollTop;
  }, SCROLLER);
}

/** Waits `n` painted frames: time as the page lives it, not a fixed sleep. */
async function afterFrames(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => new Promise<void>((resolve) => {
    let left = count;
    const tick = (): void => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), n);
}

async function viewHeight(page: Page): Promise<number> {
  return await page.locator(SCROLLER).evaluate((el) => (el as HTMLElement).clientHeight);
}

/** The largest move of a row seen in both frames, or null when no row is shared. */
function moved(a: Frame, b: Frame): number | null {
  const common = Object.keys(a.rows).filter((k) => k in b.rows);
  if (common.length === 0) return null;
  return Math.max(...common.map((k) => Math.abs(b.rows[k] - a.rows[k])));
}

test.describe("Infinite scroll della chat", () => {
  // Seeding three pages and reading a chat from its tail to its head with the wheel takes its time.
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: 1280, height: 720 } });
  // The app's service worker takes control from the second load on, and on WebKit a request from a
  // controlled page escapes the page's own request events: counting the fetch needs it out of the way.
  test.use({ serviceWorkers: "block" });

  let longTopic: { id: string; name: string };
  let longKey = "";

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    longTopic = await createTopic(request, `infinite-scroll-${Date.now()}`);
    longKey = await sessionKeyOf(request, longTopic.id);
    await seedThread(request, longKey, SEEDED);
  });

  test.afterAll(async ({ request }) => {
    if (longTopic) await deleteTopic(request, longTopic.id).catch(() => {});
  });

  /** The long chat opened on its tail, with a counter of the requests for the rest. */
  async function openOnTail(page: Page, request: APIRequestContext) {
    await resetPaneStore(request, [longTopic.id]);
    let older = 0;
    page.on("request", (req) => {
      if (req.url().includes(`/api/history/${encodeURIComponent(longKey)}`) && (req.postData() || "").includes('"before"')) older++;
    });
    await page.goto("/");
    await page.getByTestId(`pane-tab-${longTopic.id}`).click();
    const list = page.locator(SCROLLER);
    await expect(list.getByText(seededText(SEEDED))).toBeVisible({ timeout: 15000 });
    await expect(list).toHaveAttribute("data-history", "partial");
    return { list, older: () => older };
  }

  // The wheel is not the only way up. A key that pages up, and a press held while the list moves (its
  // scrollbar dragged), outlast the 400 ms an input counts for: each must count on its own (`readerGesture`).
  test("Shift+Spazio, un passo per volta, porta il resto da solo", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    const { list, older } = await openOnTail(page, request);
    // A click on a message gives the list the keyboard, and ends the re-pin of the opening.
    await list.getByText(seededText(SEEDED - 1)).click();
    let st = await stillView(page);
    for (let i = 0; i < 300 && st > 0 && (await list.getAttribute("data-history")) !== "complete"; i++) {
      await afterFrames(page, 30); // past the window of the key before
      await page.keyboard.press("Shift+Space");
      st = await stillView(page);
    }
    await expect(list).toHaveAttribute("data-history", "complete", { timeout: 10000 });
    expect(older(), "one request, asked by the keys").toBe(1);
  });

  test("una pressione tenuta mentre la lista sale, come la barra trascinata, porta il resto da solo", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    const { list, older } = await openOnTail(page, request);
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // What a scrollbar drag hands the page: the press, then scroll events only. Eight frames apart, so
    // neither the press's own window nor a run of events carries them: only the press still held does.
    await list.evaluate(async (el) => {
      const frames = (n: number) => new Promise<void>((resolve) => {
        let left = n;
        const tick = (): void => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      for (let i = 0; i < 400 && el.scrollTop > 0 && el.getAttribute("data-history") !== "complete"; i++) {
        el.scrollTop = Math.max(0, el.scrollTop - 240);
        await frames(8);
      }
    });
    await page.mouse.up();
    await expect(list).toHaveAttribute("data-history", "complete", { timeout: 10000 });
    expect(older(), "one request, asked by the drag").toBe(1);
  });

  test("salendo, i messaggi precedenti arrivano da soli e le righe lette restano ferme", async ({ page, request, browserName }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    await resetPaneStore(request, [longTopic.id]);
    let older = 0;
    page.on("request", (req) => {
      if (req.url().includes(`/api/history/${encodeURIComponent(longKey)}`) && (req.postData() || "").includes('"before"')) older++;
    });

    await page.goto("/");
    await page.getByTestId(`pane-tab-${longTopic.id}`).click();
    const list = page.locator(SCROLLER);
    await expect(list.getByText(seededText(SEEDED))).toBeVisible({ timeout: 15000 });
    await expect(list).toHaveAttribute("data-history", "partial");
    await didascalia(page, "Una chat lunga, aperta sulla coda: le prime pagine non sono ancora caricate");
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const screen = await viewHeight(page);
    const mergeAt = screen * OLDER_MERGE_SCREENS;

    // Up in big steps until just short of the merge: on the way the rest is fetched and held.
    let st = await stillView(page);
    for (let i = 0; i < 400 && st > mergeAt + APPROACH_PX; i++) {
      await page.mouse.wheel(0, -Math.min(600, Math.max(NUDGE_PX, st - mergeAt - APPROACH_PX)));
      st = await stillView(page);
    }
    expect(st, "the reader must be placed just short of the merge").toBeLessThanOrEqual(screen * OLDER_STAGE_SCREENS);
    await expect(list).toHaveAttribute("data-history", "staged", { timeout: 10000 });
    expect(older, "the rest is fetched by scrolling up, with no click").toBe(1);

    // Across the merge in nudges, every frame sampled. The threshold recedes as the rows above get
    // measured (Virtuoso grows `scrollTop` by what its estimates missed): a big step brings it back.
    await armFrameProbe(page);
    let lastStep = 0;
    for (let i = 0; i < 600 && (await list.getAttribute("data-history")) !== "complete"; i++) {
      const gap = st - mergeAt;
      lastStep = gap > APPROACH_PX + NUDGE_PX ? Math.min(600, gap - APPROACH_PX) : NUDGE_PX;
      await page.mouse.wheel(0, -lastStep);
      st = await stillView(page);
    }
    for (let i = 0; i < 10; i++) await stillView(page);
    const { frames, shifts } = await stopProbe(page);
    await expect(list).toHaveAttribute("data-history", "complete");

    const at = frames.findIndex((f) => f.state === "complete");
    expect(at, "the merge happened while the probe was sampling").toBeGreaterThan(0);
    // Where the step that crossed the merge has landed: the first frame whose `scrollTop` the next one keeps.
    let landed = at;
    while (landed + 1 < frames.length && frames[landed + 1].st !== frames[landed].st) landed++;
    const across = moved(frames[at - 1], frames[landed]);
    const landing = frames.slice(at, landed + 1).map((f, i) => moved(frames[at + i - 1], f));
    const settling = frames.slice(landed, landed + 8).map((f, i, all) => (i === 0 ? 0 : moved(all[i - 1], f)));
    const blank = frames.filter((f) => f.inView === 0).length;
    const mergeShifts = shifts.filter((s) => s.t >= frames[at - 1].t - 50 && s.t <= frames[Math.min(landed + 8, frames.length - 1)].t + 50);
    const cls = mergeShifts.reduce((sum, s) => sum + s.value, 0);
    console.log(`[infinite-scroll:${browserName}] frames=${frames.length} mergeFrame=${at} landed=${landed} step=${lastStep} across=${across} landing=${JSON.stringify(landing)} settling=${JSON.stringify(settling)} blank=${blank} cls=${cls.toFixed(4)} (${mergeShifts.length} shifts)${mergeShifts.length ? ` ${JSON.stringify(mergeShifts.map((s) => [Number(s.value.toFixed(4)), ...s.sources]))}` : ""}`);

    expect(across, "a row read before the merge is still in view once the step has landed").not.toBeNull();
    expect(across!, "from the merge until the step lands, the rows move by at most that step").toBeLessThanOrEqual(lastStep + STILL_PX);
    for (const m of landing) expect(m ?? Infinity, "no frame of the landing moves the rows by more than the step").toBeLessThanOrEqual(lastStep + STILL_PX);
    for (const m of settling) expect(m ?? Infinity, "once the step has landed the rows stay still").toBeLessThanOrEqual(STILL_PX);
    expect(blank, "no frame without a row in view").toBe(0);
    if (browserName === "chromium") expect(cls, "CLS of the merge").toBeLessThanOrEqual(CLS_BUDGET);
    await didascalia(page, "Sopra la soglia i messaggi precedenti entrano da soli, e la riga letta non si muove");
    await beat(page, 1200);

    // And the head is reached by scrolling on, still without a click.
    for (let i = 0; i < 300 && !(await list.getByText(seededText(1)).isVisible()); i++) {
      await page.mouse.wheel(0, -900);
      await stillView(page);
    }
    await expect(list.getByText(seededText(1))).toBeVisible();
    await expect(page.getByTestId("chat-load-older")).toHaveCount(0);
    expect(older, "one fetch for the whole rest").toBe(1);
    await didascalia(page, "Scorrendo ancora, il primo messaggio della chat: nessun click");
    await beat(page, 1200);
  });

  test("scrivere nel composer o girare la rotella in giù non scarica niente: solo chi sale", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    // Short rows: the first page is short, so its tail already sits where heading up would fetch.
    const quiet = await createTopic(request, `infinite-scroll-quiet-${Date.now()}`);
    try {
      const key = await sessionKeyOf(request, quiet.id);
      const last = HISTORY_FIRST_PAGE + 30;
      for (let i = 1; i <= last; i++) {
        await seedMessage(request, { sessionKey: key, role: i % 2 === 1 ? "user" : "assistant", content: `${seededText(i)} short` });
      }
      await resetPaneStore(request, [quiet.id]);
      let older = 0;
      page.on("request", (req) => {
        if (req.url().includes(`/api/history/${encodeURIComponent(key)}`) && (req.postData() || "").includes('"before"')) older++;
      });
      await page.goto("/");
      await page.getByTestId(`pane-tab-${quiet.id}`).click();
      const list = page.locator(SCROLLER);
      await expect(list.getByText(seededText(last))).toBeVisible({ timeout: 15000 });
      await expect(list).toHaveAttribute("data-history", "partial");
      const screen = await viewHeight(page);
      expect(await stillView(page), "the tail sits inside the band where heading up fetches").toBeLessThan(screen * OLDER_STAGE_SCREENS);

      // Caret keys in the composer, then lines that grow it: the list re-pins itself under it.
      const input = page.getByTestId("chat-input-area").locator("textarea").first();
      await input.focus();
      await page.keyboard.type("ciao");
      for (const k of ["ArrowLeft", "ArrowUp", "Home"]) await page.keyboard.press(k);
      for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+Enter");
      await stillView(page);
      // Emptied right after a caret key, the composer shrinks and the list climbs by itself.
      await page.keyboard.press("ArrowLeft");
      await input.fill("");
      await stillView(page);
      expect(older, "typing fetched nothing").toBe(0);
      await expect(list).toHaveAttribute("data-history", "partial");

      // Higher in the list, a wheel turned DOWN: a gesture, but not one that goes up. The list is put
      // there without a gesture, and put again until it stays: right after opening, the chat pins
      // itself to the bottom for a few seconds, and keys typed in a field no longer cut that short.
      const high = Math.round(screen / 2);
      let before = await stillView(page);
      for (let i = 0; i < 40 && before > high + 24; i++) {
        await list.evaluate((el, top) => { (el as HTMLElement).scrollTop = top; }, high);
        before = await stillView(page);
      }
      expect(before, "the list holds inside the band where heading up merges").toBeLessThan(screen * OLDER_MERGE_SCREENS);
      const box = (await list.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 120);
      expect(await stillView(page), "the wheel moved the list down").toBeGreaterThan(before);
      expect(older, "a wheel turned down fetched nothing").toBe(0);
      await expect(list).toHaveAttribute("data-history", "partial");

      // The control: the same wheel turned up brings the rest in, with one request.
      for (let i = 0; i < 20 && (await list.getAttribute("data-history")) !== "complete"; i++) {
        await page.mouse.wheel(0, -120);
        await stillView(page);
      }
      await expect(list).toHaveAttribute("data-history", "complete", { timeout: 10000 });
      expect(older).toBe(1);
    } finally {
      await deleteTopic(request, quiet.id).catch(() => {});
    }
  });
});
