import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
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
 * can fall in the middle of it. Since T20 the merge waits for a list at rest
 * (`mergeAtRest`), so after each step the reader gives it the frames it needs
 * before the next: nudges a stillView apart never left it 150 ms, and the merge
 * slid up to the top of the list. A merge that is not compensated moves the rows
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
/**
 * A layout shift, with up to three of the nodes it moved (`tag[testid or index] y<before>-><after> h<height>`),
 * and whether any of them shows anywhere else on screen (`seen`): a container taller than the view whose
 * `paddingTop` grows while `scrollTop` makes up for it is reported with the same visible rect before and after.
 */
type Shift = { value: number; t: number; sources: string[]; seen: boolean };

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
          const same = (a: DOMRectReadOnly, b: DOMRectReadOnly) => [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every((d) => Math.abs(d) < 1);
          const seen = (e.sources ?? []).some((src) => !same(src.previousRect, src.currentRect));
          w.__shifts.push({ value: e.value, t: e.startTime, sources, seen });
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

/**
 * One frame as the reader sees it: where the line of text of each seeded
 * message is, which of them are in view, and whether any row is. The text, not
 * the row or the message box: the merge takes away what sits above the first
 * row's text (the divider, the date separator of a first message), and a box
 * that keeps its top while the text in it moves up is still a jump.
 */
type Reading = { state: string | null; msgs: Record<string, number>; vis: string[]; inView: number; st: number };

/**
 * Samples the visible chat twice per frame until `__readingStop`: in the
 * animation frame (`__raf`), and after the frame's layout and the app's own
 * ResizeObservers, before paint (`__ro`). The second is a ResizeObserver on a
 * sentinel resized every frame, created after the app's, so it runs after
 * theirs: a correction they make in the same frame is in it, and a shift they
 * leave is too. A merge that a later observer corrected looked still at rAF.
 */
async function armReadingProbe(page: Page): Promise<void> {
  await page.evaluate(({ sel, rowPattern }) => {
    const w = window as unknown as { __raf: unknown[]; __ro: unknown[]; __readingStop?: boolean };
    w.__raf = [];
    w.__ro = [];
    w.__readingStop = false;
    const pattern = new RegExp(rowPattern);
    const read = (into: unknown[]) => {
      const scroller = [...document.querySelectorAll(sel.replace(":visible", ""))].find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
      if (!scroller) return;
      const view = scroller.getBoundingClientRect();
      const msgs: Record<string, number> = {};
      const vis: string[] = [];
      let inView = 0;
      for (const row of scroller.querySelectorAll("[data-index]")) {
        const box = row.getBoundingClientRect();
        const rowIn = box.bottom > view.top && box.top < view.bottom;
        if (rowIn) inView++;
        for (const m of row.querySelectorAll('[data-testid="chat-message"]')) {
          const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
          let text: Node | null = null;
          while ((text = walker.nextNode()) && !pattern.test(text.nodeValue || ""));
          const n = text && pattern.exec(text.nodeValue || "")?.[1];
          if (!text || !n) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          const r = range.getBoundingClientRect();
          msgs[n] = Math.round((r.top - view.top) * 10) / 10;
          if (r.bottom > view.top && r.top < view.bottom) vis.push(n);
        }
      }
      into.push({ state: scroller.getAttribute("data-history"), msgs, vis, inView, st: Math.round(scroller.scrollTop) });
    };
    const sentinel = document.createElement("div");
    sentinel.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(sentinel);
    let frame = 0;
    let readFrame = -1;
    const ro = new ResizeObserver(() => {
      if (readFrame === frame || w.__readingStop) return;
      readFrame = frame;
      read(w.__ro);
    });
    ro.observe(sentinel);
    const tick = () => {
      if (w.__readingStop) { ro.disconnect(); sentinel.remove(); return; }
      frame++;
      read(w.__raf);
      sentinel.style.width = `${(frame % 2) + 1}px`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { sel: SCROLLER, rowPattern: ROW.source });
}

async function stopReadingProbe(page: Page): Promise<{ raf: Reading[]; ro: Reading[] }> {
  return await page.evaluate(() => {
    const w = window as unknown as { __raf: Reading[]; __ro: Reading[]; __readingStop?: boolean };
    w.__readingStop = true;
    return { raf: w.__raf, ro: w.__ro };
  });
}

/** How far the messages in view in `a` have moved by `b`, rendered there in view or not; null when none is rendered. */
function readMoved(a: Reading, b: Reading): number | null {
  const common = a.vis.filter((k) => k in b.msgs);
  if (common.length === 0) return null;
  return Math.max(...common.map((k) => Math.abs(b.msgs[k] - a.msgs[k])));
}

/** Waits up to `n` frames for the visible chat to hold the whole thread; whether it does. */
async function completeWithin(page: Page, n: number): Promise<boolean> {
  return await page.evaluate(({ sel, count }) => new Promise<boolean>((resolve) => {
    let left = count;
    const tick = (): void => {
      const scroller = [...document.querySelectorAll(sel.replace(":visible", ""))].find((el) => (el as HTMLElement).offsetParent !== null);
      if (scroller?.getAttribute("data-history") === "complete") resolve(true);
      else if (--left <= 0) resolve(false);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { sel: SCROLLER, count: n });
}

/** The first message whose bottom is in view, by its seeded ordinal, and where its line of text is from the viewport's top. */
async function readingAt(list: Locator): Promise<{ n: string; offset: number }> {
  return await list.evaluate((el, rowPattern) => {
    const top = el.getBoundingClientRect().top;
    const pattern = new RegExp(rowPattern);
    for (const m of el.querySelectorAll('[data-testid="chat-message"]')) {
      if (m.getBoundingClientRect().bottom <= top + 2) continue;
      const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
      let text: Node | null = null;
      while ((text = walker.nextNode()) && !pattern.test(text.nodeValue || ""));
      const n = text && pattern.exec(text.nodeValue || "")?.[1];
      if (!text || !n) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      return { n, offset: Math.round((range.getBoundingClientRect().top - top) * 10) / 10 };
    }
    return { n: "", offset: 0 };
  }, ROW.source);
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

  /**
   * The long chat opened on its tail, with a counter of the requests for the rest. With `answer`, the
   * answer to that request waits for it (a delay, a release), as a slow network would.
   */
  async function openOnTail(page: Page, request: APIRequestContext, opts: { tabs?: string[]; answer?: () => Promise<void> } = {}) {
    await resetPaneStore(request, [longTopic.id, ...(opts.tabs ?? [])]);
    let older = 0;
    const isOlder = (url: string, body: string | null) => url.includes(`/api/history/${encodeURIComponent(longKey)}`) && (body || "").includes('"before"');
    const answer = opts.answer;
    if (answer) {
      await page.route(`**/api/history/${encodeURIComponent(longKey)}*`, async (route) => {
        if (isOlder(route.request().url(), route.request().postData())) { older++; await answer(); }
        await route.continue();
      });
    } else {
      page.on("request", (req) => { if (isOlder(req.url(), req.postData())) older++; });
    }
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
      await completeWithin(page, 30);
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
    // Since T20 the merge at rest reports the item list itself (its rect on screen the same before and
    // after, the rows in it still in every frame above): a shift no source of which moved is not counted.
    const cls = mergeShifts.filter((s) => s.seen).reduce((sum, s) => sum + s.value, 0);
    const unseen = mergeShifts.filter((s) => !s.seen).reduce((sum, s) => sum + s.value, 0);
    console.log(`[infinite-scroll:${browserName}] frames=${frames.length} mergeFrame=${at} landed=${landed} step=${lastStep} across=${across} landing=${JSON.stringify(landing)} settling=${JSON.stringify(settling)} blank=${blank} cls=${cls.toFixed(4)} unseen=${unseen.toFixed(4)} (${mergeShifts.length} shifts)${mergeShifts.length ? ` ${JSON.stringify(mergeShifts.map((s) => [Number(s.value.toFixed(4)), s.seen ? "seen" : "unseen", ...s.sources]))}` : ""}`);

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

  // THE MERGE WAITS FOR A STILL LIST (CHAT-HIST-01). Page Up, Shift+Space and Home glide over a dozen
  // frames, and a merge landing in the glide was carried on by the browser from the old offset: the rows
  // read jumped by thousands of px. At the top, with the list already still, the rows prepended in the
  // overscan were measured when Virtuoso no longer compensated, and the divider above the first row went
  // away in view. So: from the frame before the merge to twenty after, the messages in view do not move.
  const KEY_RUNS = [
    { key: "PageUp", delay: 0 },
    { key: "Shift+Space", delay: 0 },
    { key: "Home", delay: 0 },
    { key: "Home", delay: 1500 },
  ] as const;
  for (const { key, delay } of KEY_RUNS) {
    test(`${key}${delay ? `, con il resto in ritardo di ${delay} ms` : ""}: la fusione cade a lista ferma e le righe lette non si muovono`, async ({ page, request, browserName }) => {
      test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
      // A late answer lands on a list at rest at the very top: the case where the rows prepended in the
      // overscan are measured with no scroll going up. Not before the list rests there, and not before `delay`.
      let atTop: () => void = () => {};
      const reachedTop = new Promise<void>((resolve) => (atTop = resolve));
      const late = () => Promise.all([new Promise((r) => setTimeout(r, delay)), reachedTop]).then(() => {});
      const { list, older } = await openOnTail(page, request, delay ? { answer: late } : {});
      // A click on a message gives the list the keyboard, and ends the re-pin of the opening.
      await list.getByText(seededText(SEEDED - 1)).click();
      await stillView(page);
      await armReadingProbe(page);
      let presses = 0;
      // Each press once the list is still and a merge it would wait for has had its time: a press
      // right after the merge would move the rows by itself.
      for (let i = 0; i < 300 && !(await completeWithin(page, 30)); i++) {
        await page.keyboard.press(key);
        presses++;
        if ((await stillView(page)) === 0) atTop();
      }
      await expect(list).toHaveAttribute("data-history", "complete", { timeout: 10000 });
      await afterFrames(page, 30);
      const probe = await stopReadingProbe(page);
      const runs = Object.entries(probe).map(([mode, frames]) => {
        const at = frames.findIndex((f) => f.state === "complete");
        const after = at > 0 ? frames.slice(at, at + 20).map((f) => readMoved(frames[at - 1], f)) : [];
        // Blank frames are counted where the merge is: the glide of Home from the bottom has its own (see the REPORT of T20).
        const blankAt = frames.flatMap((f, i) => (f.inView === 0 ? [`${i - at}@${f.st}`] : []));
        const blank = at > 0 ? frames.slice(at - 1, at + 20).filter((f) => f.inView === 0).length : 0;
        console.log(`[merge-at-rest:${browserName}:${key}:${delay}:${mode}] presses=${presses} older=${older()} frames=${frames.length} mergeFrame=${at} st=${frames[at - 1]?.st}->${frames[at]?.st} moved=${JSON.stringify(after)} blank=${blank}${blankAt.length ? ` (any, frame-from-merge@scrollTop: ${blankAt.join(" ")})` : ""}`);
        return { mode, frames, at, after, blank };
      });
      for (const { mode, frames, at, after, blank } of runs) {
        expect(at, `${mode}: the merge happened while the probe was sampling`).toBeGreaterThan(0);
        expect(frames.length - at, `${mode}: twenty frames sampled after the merge`).toBeGreaterThanOrEqual(20);
        for (const m of after) expect(m ?? Infinity, `${mode}: from the frame before the merge, the messages read do not move`).toBeLessThanOrEqual(STILL_PX);
        expect(blank, `${mode}: around the merge, no frame without a row in view`).toBe(0);
      }
      expect(older(), "one request for the whole rest").toBe(1);
    });
  }

  // A TAB LEFT WITH THE REST IN FLIGHT. The answer lands on a hidden pane: merged there, out of sight, and
  // the row being read is put back where it was when the pane returns. Merged on the network's schedule,
  // it landed with no anchor, and the return found the reader somewhere else.
  test("si sale, il resto e' in volo, si cambia scheda: al ritorno la riga letta e' dov'era", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    const side = await createTopic(request, `infinite-scroll-side-${Date.now()}`);
    try {
      const sideKey = await sessionKeyOf(request, side.id);
      for (let i = 1; i <= 6; i++) await seedMessage(request, { sessionKey: sideKey, role: i % 2 === 1 ? "user" : "assistant", content: `Side message ${i}` });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      const { list, older } = await openOnTail(page, request, { tabs: [side.id], answer: () => released });
      const longList = page.locator(`[data-pane-shell="${longTopic.id}"] [data-testid="chat-message-list"]`);
      await list.getByText(seededText(SEEDED - 1)).click();
      const box = (await list.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const mergeAt = (await viewHeight(page)) * OLDER_MERGE_SCREENS;
      // Up with the wheel into the band where the rest is merged, its answer held.
      let st = await stillView(page);
      for (let i = 0; i < 400 && st > mergeAt - APPROACH_PX; i++) {
        await page.mouse.wheel(0, -Math.min(600, Math.max(NUDGE_PX, st - mergeAt + APPROACH_PX)));
        st = await stillView(page);
      }
      await afterFrames(page, 30);
      expect(older(), "the rest was asked for on the way up").toBe(1);
      await expect(longList).toHaveAttribute("data-history", "partial");
      const reading = await readingAt(longList);
      expect(reading.n, "a seeded message is being read").not.toBe("");

      // Away, the answer lands while the pane is hidden, back.
      await page.getByTestId(`pane-tab-${side.id}`).click();
      await expect(page.locator(SCROLLER).getByText("Side message 6")).toBeVisible();
      await expect.poll(() => longList.evaluate((el) => (el as HTMLElement).clientHeight)).toBe(0);
      release();
      await expect(longList).toHaveAttribute("data-history", "complete", { timeout: 15000 });
      await afterFrames(page, 10);
      await page.getByTestId(`pane-tab-${longTopic.id}`).click();
      await expect.poll(() => longList.evaluate((el) => (el as HTMLElement).clientHeight)).toBeGreaterThan(0);
      for (let i = 0; i < 4; i++) await stillView(page);
      const back = await readingAt(longList);
      console.log(`[merge-hidden] reading=${JSON.stringify(reading)} back=${JSON.stringify(back)} older=${older()}`);
      expect(back.n, "the same message is at the top").toBe(reading.n);
      expect(Math.abs(back.offset - reading.offset), "at the same offset").toBeLessThanOrEqual(2);
      expect(older(), "one request for the whole rest").toBe(1);
    } finally {
      await deleteTopic(request, side.id).catch(() => {});
    }
  });

  // OLD ROWS ARE NOT NEWS. The rest of the history merged above the reader grows the list, and the
  // "↓ N" counted it as messages arrived below, with the "New messages" banner on top.
  test("dopo una fusione con la rotella il ↓ non conta i messaggi vecchi e non c'e' il banner dei nuovi", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    const { list, older } = await openOnTail(page, request);
    await list.getByText(seededText(SEEDED - 1)).click();
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 300 && !(await completeWithin(page, 30)); i++) {
      await page.mouse.wheel(0, -300);
      await stillView(page);
    }
    await expect(list).toHaveAttribute("data-history", "complete");
    await afterFrames(page, 30);
    const pill = page.getByTestId("scroll-to-bottom");
    await expect(pill, "far from the bottom, the arrow is there").toBeVisible();
    expect((await pill.innerText()).trim(), "no message arrived: the arrow carries no number").not.toMatch(/\d/);
    await expect(page.getByRole("button", { name: /New messages/ })).toHaveCount(0);
    expect(older()).toBe(1);
  });
});
