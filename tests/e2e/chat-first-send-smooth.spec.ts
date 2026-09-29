import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { goToApp, ensureTopicVisible } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE FIRST SEND IN A NEW TOPIC IS SMOOTH.
 *
 * Reported on 29/09: "when I send a message in a new topic it makes strange,
 * useless little jerks". The first message is the one moment where the most
 * things change at once: the draft becomes a topic (the pane id is remapped and
 * the ChatPane remounts, see `client/src/state/composerHandoff.ts`), the
 * composer slides from the centre to the bottom, the empty state fades, the
 * transcript is born, the working indicator appears, the reply streams, the tab
 * is renamed. The intended motion is the composer going down, the greeting
 * fading out with it, and each new row's own entrance (`.message-appear`, a
 * 6px rise under a 200ms fade). Nothing else may move or blink.
 *
 * Measured, not eyeballed: an init script samples after every painted frame
 * the rects, effective opacity and visibility of the elements involved, and a
 * MutationObserver logs every add/remove of the nodes that carry them. The
 * rules below are read from those samples:
 *
 *   - opening (⌘T): the draft is painted centred, greeting drawn, no
 *     skeleton, and nothing moves until the send;
 *   - the composer moves only downwards, and once landed it stays (0.5px);
 *   - the user bubble, once painted, never moves inside the transcript
 *     (0.5px) and its node is never removed or re-added;
 *   - nothing flashes: no opacity or visibility dip and back, no skeleton
 *     after the send, the greeting fades (never gone in one frame, never
 *     replaced, never back); the only remount is the promoted pane, as one
 *     atomic swap;
 *   - between the send and the first token the loading is ONE element that,
 *     once drawn, neither moves nor changes height;
 *   - the transcript never stays off the bottom for two frames in a row;
 *   - the other tabs of the strip never move.
 *
 * Measured on the base (29/09, WebKit): the draft painted at the bottom with
 * the loading skeleton and slid up 326px; after the send the user's bubble
 * sat behind a five-bubble skeleton for 1.2s, was mounted, dropped and mounted
 * again, and the greeting vanished in one frame instead of fading.
 *
 * @covers CHAT-01
 */
// The suite runs with `reducedMotion: "reduce"` (playwright.config.ts), where the
// composer has no slide at all. The gesture under test IS the motion, so this
// file puts it back.
test.use({ video: "on", contextOptions: { reducedMotion: "no-preference" } });

const TOL = 0.5;

type Box = { x: number; y: number; w: number; h: number; o: number; v: boolean; id: number } | null;
type Frame = {
  t: number;
  card: Box;
  bubble: Box;
  /** The user bubble's top in CONTENT coordinates: screen top - scroller top + scrollTop. */
  bubbleContentY: number | null;
  indicator: Box;
  bg: Box;
  skeleton: Box;
  empty: Box;
  assistant: Box;
  /** The first token is on screen (the fake model writes `tok-NNN`). */
  assistantHasText: boolean;
  scroller: { top: number; h: number; ch: number; v: boolean } | null;
  tabs: { id: string; x: number; w: number; text: string }[];
};
type Mutation = { t: number; op: "add" | "remove"; testId: string; id: number; role?: string; mid?: string };
type Probe = { frames: Frame[]; mutations: Mutation[]; running: boolean; nodeId: (el: Element) => number };

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const ids = new WeakMap<Element, number>();
    let next = 1;
    const nodeId = (el: Element) => {
      let id = ids.get(el);
      if (id === undefined) { id = next++; ids.set(el, id); }
      return id;
    };
    const p = { frames: [], mutations: [], running: false, nodeId } as unknown as Probe;
    (window as unknown as { __firstSend: Probe }).__firstSend = p;

    const WATCHED = new Set([
      "chat-scroll-container", "chat-input-area", "composer-card", "chat-message",
      "chat-streaming-indicator", "background-work-line", "chat-skeleton", "chat-empty-state",
    ]);
    const log = (op: "add" | "remove", root: Node) => {
      if (!(root instanceof Element)) return;
      const hits: Element[] = [];
      if (root.matches("[data-testid]")) hits.push(root);
      hits.push(...root.querySelectorAll("[data-testid]"));
      for (const el of hits) {
        const testId = el.getAttribute("data-testid")!;
        if (!WATCHED.has(testId)) continue;
        p.mutations.push({ t: performance.now(), op, testId, id: nodeId(el), role: el.getAttribute("data-role") ?? undefined, mid: el.getAttribute("data-message-id") ?? undefined });
      }
    };
    // The requests of the gesture, on the same clock: they say WHY a frame changed.
    const origFetch = window.fetch.bind(window);
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (p.running) p.mutations.push({ t: performance.now(), op: "add", testId: `fetch ${method} ${url.replace(location.origin, "")}`, id: 0 });
      return origFetch(input, init);
    }, { preconnect: window.fetch.preconnect });
    new MutationObserver((records) => {
      if (!p.running) return;
      for (const r of records) {
        r.removedNodes.forEach((n) => log("remove", n));
        r.addedNodes.forEach((n) => log("add", n));
      }
    }).observe(document, { childList: true, subtree: true });

    /** The one chat pane on screen: the visible composer's pane. */
    const pane = (): Element | null => {
      for (const area of document.querySelectorAll('[data-testid="chat-input-area"]')) {
        const r = area.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && area.checkVisibility()) return area.parentElement;
      }
      return null;
    };
    const opacityOf = (el: Element) => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return Math.round(o * 1000) / 1000;
    };
    const box = (el: Element | null | undefined): Box => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const r1 = (n: number) => Math.round(n * 10) / 10;
      return { x: r1(r.x), y: r1(r.y), w: r1(r.width), h: r1(r.height), o: opacityOf(el), v: getComputedStyle(el).visibility !== "hidden", id: nodeId(el) };
    };
    // Sampled right AFTER the frame is painted (a message posted from the
    // animation frame runs as the first task after rendering), not at the start
    // of the next one: there a token already committed but not yet pinned would
    // read as a gap no one ever saw.
    const channel = new MessageChannel();
    const tick = () => channel.port2.postMessage(null);
    channel.port1.onmessage = () => {
      if (p.running) {
        const root = pane();
        const scrollerEl = root?.querySelector<HTMLElement>("[data-virtuoso-scroller]") ?? null;
        // The bubble's ROW, not its wrapper: the entrance animation
        // (`.message-appear`) lives on the row, and the wrapper would read as
        // still and opaque while the row slides in under it.
        const bubbleMsg = root?.querySelector('[data-testid="chat-message"][data-role="user"]');
        const bubbleEl = bubbleMsg?.querySelector(":scope > .group") ?? bubbleMsg;
        const bubble = box(bubbleEl);
        const assistantEl = root?.querySelector('[data-testid="chat-message"][data-role="assistant"]');
        const sr = scrollerEl?.getBoundingClientRect();
        const tabs = [...document.querySelectorAll<HTMLElement>('[data-testid="panel-tab-bar"] [data-testid^="pane-tab-"]')]
          .filter((el) => !/^pane-tab-(slot|label|stop|close|shared-org)$/.test(el.getAttribute("data-testid")!))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.getAttribute("data-testid")!.slice("pane-tab-".length), x: Math.round(r.x * 10) / 10, w: Math.round(r.width * 10) / 10, text: (el.textContent ?? "").trim().slice(0, 30) };
          });
        p.frames.push({
          t: performance.now(),
          card: box(root?.querySelector('[data-testid="composer-card"]')),
          bubble,
          bubbleContentY: bubble && scrollerEl && sr ? Math.round((bubble.y - sr.y + scrollerEl.scrollTop) * 10) / 10 : null,
          indicator: box(root?.querySelector('[data-testid="chat-streaming-indicator"]')),
          bg: box(root?.querySelector('[data-testid="background-work-line"]')),
          skeleton: box(root?.querySelector('[data-testid="chat-skeleton"]')),
          empty: box(root?.querySelector('[data-testid="chat-empty-state"]')),
          assistant: box(assistantEl),
          assistantHasText: !!assistantEl?.textContent?.includes("tok-"),
          scroller: scrollerEl
            ? { top: Math.round(scrollerEl.scrollTop * 10) / 10, h: scrollerEl.scrollHeight, ch: scrollerEl.clientHeight, v: getComputedStyle(scrollerEl).visibility !== "hidden" }
            : null,
          tabs,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Every departure from the rules in the header, one line each, with its frame. */
function analyse(frames: Frame[], mutations: Mutation[], draftTabId: string, t0: number): string[] {
  const out: string[] = [];
  const at = (i: number) => `f${i} +${Math.round(frames[i]!.t - t0)}ms`;

  // ── Composer: monotonic downwards, then still ─────────────────────────
  const cards = frames.map((f) => f.card);
  const finalY = [...cards].reverse().find((c) => c)?.y ?? 0;
  let landed = false;
  for (let i = 1; i < frames.length; i++) {
    const a = cards[i - 1], b = cards[i];
    if (!a || !b) { if (a && !b) out.push(`${at(i)} composer: card gone`); continue; }
    const dy = b.y - a.y;
    if (landed && Math.abs(b.y - finalY) > TOL) out.push(`${at(i)} composer: moved ${dy.toFixed(1)}px after landing (y ${a.y} -> ${b.y})`);
    else if (dy < -TOL) out.push(`${at(i)} composer: moved UP ${(-dy).toFixed(1)}px (y ${a.y} -> ${b.y})`);
    if (Math.abs(b.y - finalY) <= TOL) landed = true;
    if (b.o < 0.99 && a.o >= 0.99) out.push(`${at(i)} composer: opacity dip ${a.o} -> ${b.o}`);
  }

  // ── User bubble: painted once, never moves, never remounted ───────────
  let paintedAt = -1;
  let paintedY = 0;
  let paintedId = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const b = f.bubble;
    const shown = !!b && b.v && b.o >= 0.99 && !!f.scroller?.v;
    if (paintedAt < 0) {
      if (shown && f.bubbleContentY !== null) { paintedAt = i; paintedY = f.bubbleContentY; paintedId = b!.id; }
      continue;
    }
    if (!b) { out.push(`${at(i)} bubble: gone after being painted`); continue; }
    if (!shown) out.push(`${at(i)} bubble: hidden after being painted (o=${b.o} v=${b.v} scroller.v=${f.scroller?.v})`);
    if (b.id !== paintedId) out.push(`${at(i)} bubble: a different node (${paintedId} -> ${b.id})`);
    if (f.bubbleContentY !== null && Math.abs(f.bubbleContentY - paintedY) > TOL) {
      out.push(`${at(i)} bubble: moved ${(f.bubbleContentY - paintedY).toFixed(1)}px in the transcript (${paintedY} -> ${f.bubbleContentY})`);
      paintedY = f.bubbleContentY;
    }
  }
  if (paintedAt < 0) out.push("bubble: never painted");
  const bubbleRemovals = mutations.filter((m) => m.testId === "chat-message" && m.role === "user" && m.op === "remove");
  for (const m of bubbleRemovals) out.push(`+${Math.round(m.t - t0)}ms bubble: node ${m.id} removed from the DOM`);

  // ── Flashes ───────────────────────────────────────────────────────────
  const seenSkeleton = frames.findIndex((f) => f.skeleton);
  if (seenSkeleton >= 0) out.push(`${at(seenSkeleton)} skeleton: shown after the send (${frames.filter((f) => f.skeleton).length} frames)`);
  // The greeting leaves by FADING: never replaced by a new node outside the
  // pane swap, never more than half its opacity in one frame.
  const swapTimes = new Set(mutations.filter((m) => m.testId === "chat-scroll-container").map((m) => m.t));
  for (const m of mutations) {
    if (m.testId === "chat-empty-state" && m.op === "add" && !swapTimes.has(m.t)) out.push(`+${Math.round(m.t - t0)}ms empty state: replaced by a new node #${m.id}`);
  }
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!.empty, b = frames[i]!.empty;
    if (a && a.o > 0.5 && (!b || a.o - b.o > 0.5)) out.push(`${at(i)} empty state: gone in one frame (opacity ${a.o} -> ${b ? b.o : "unmounted"})`);
  }
  const emptyGoneAt = frames.findIndex((f, i) => i > 0 && !f.empty && frames[i - 1]!.empty);
  if (emptyGoneAt >= 0) {
    const back = frames.findIndex((f, i) => i > emptyGoneAt && f.empty);
    if (back >= 0) out.push(`${at(back)} empty state: came back after leaving`);
  }
  for (const key of ["card", "bubble", "indicator", "assistant", "bg"] as const) {
    let high = false, dipped = -1;
    for (let i = 0; i < frames.length; i++) {
      const b = frames[i]![key];
      const vis = b && b.v ? b.o : null;
      if (vis === null) continue;
      if (vis >= 0.99) {
        if (dipped >= 0) { out.push(`${at(dipped)} ${key}: opacity/visibility flash 1 -> <1 -> 1`); dipped = -1; }
        high = true;
      } else if (high && dipped < 0) dipped = i;
    }
  }
  // Remounts of the pieces that are meant to live through the whole gesture.
  for (const testId of ["chat-streaming-indicator", "background-work-line"]) {
    const adds = mutations.filter((m) => m.testId === testId && m.op === "add");
    const removes = mutations.filter((m) => m.testId === testId && m.op === "remove");
    for (const r of removes) {
      const readd = adds.find((a) => a.t >= r.t && a.id !== r.id);
      if (readd) out.push(`+${Math.round(r.t - t0)}ms ${testId}: removed and re-added (node ${r.id} -> ${readd.id})`);
    }
  }
  // The ONE intended remount: the promoted draft's pane (see
  // `composerHandoff.ts`). It has to be a swap, not a gap: the old pane leaves
  // and the new one arrives in the same DOM mutation, so no frame is painted
  // without a chat, and the checks above already prove the composer and the
  // greeting are on the same pixels on both sides of it. Exactly once.
  const paneRemoves = mutations.filter((m) => m.testId === "chat-scroll-container" && m.op === "remove");
  const paneAdds = mutations.filter((m) => m.testId === "chat-scroll-container" && m.op === "add");
  if (paneRemoves.length > 1 || paneAdds.length > 1) out.push(`pane: remounted ${paneRemoves.length} times, the promotion allows one`);
  for (const r of paneRemoves) {
    if (!paneAdds.some((a) => a.t === r.t)) out.push(`+${Math.round(r.t - t0)}ms pane: removed without a new one in the same mutation`);
  }

  // ── Loading between send and first token: one stable element ──────────
  // The working line comes in with the row's entrance (a 6px rise under a
  // 200ms fade, `.message-appear`); from the frame it is fully drawn to the
  // first token it neither moves nor changes height. Its WIDTH follows its own
  // text (the timer ticking, the phrase rotating, the token count that comes
  // with the first event of the stream), and moves nothing: the line is
  // left-aligned and nothing sits after it on the row.
  const firstToken = frames.findIndex((f) => f.assistantHasText);
  if (firstToken < 0) out.push("loading: the first token never arrived");
  const waiting = frames.slice(0, firstToken < 0 ? frames.length : firstToken).map((f, i) => ({ f, i })).filter(({ f }) => f.indicator);
  if (waiting.length === 0) out.push("loading: nothing on screen between the send and the first token");
  const ids = new Set(waiting.map(({ f }) => f.indicator!.id));
  if (ids.size > 1) out.push(`loading: ${ids.size} different indicator nodes before the first token`);
  const drawn = waiting.filter(({ f }) => f.indicator!.o >= 0.99);
  for (let k = 1; k < drawn.length; k++) {
    const a = drawn[k - 1]!.f.indicator!, b = drawn[k]!.f.indicator!;
    if (Math.abs(a.h - b.h) > TOL) out.push(`${at(drawn[k]!.i)} loading: indicator height ${a.h} -> ${b.h}`);
    if (Math.abs(a.x - b.x) > TOL) out.push(`${at(drawn[k]!.i)} loading: indicator moved ${(b.x - a.x).toFixed(1)}px sideways`);
    if (Math.abs(a.y - b.y) > TOL) out.push(`${at(drawn[k]!.i)} loading: indicator moved ${(b.y - a.y).toFixed(1)}px`);
  }

  // ── Pinned to the bottom ──────────────────────────────────────────────
  // A line the reply grows by can be painted once before the view follows it:
  // the streaming pin runs from an effect and lands the frame after the
  // growth (measured: a one-line gap, 20px, on a few frames of a 600-token
  // reply, closed on the next frame). That is the reply advancing, not the
  // view drifting. Two frames in a row off the bottom is.
  const gapOf = (i: number) => {
    const s = frames[i]?.scroller;
    return s ? s.h - s.top - s.ch : 0;
  };
  for (let i = Math.max(1, paintedAt); i < frames.length; i++) {
    if (gapOf(i) > 1 && gapOf(i - 1) > 1) out.push(`${at(i)} scroller: ${gapOf(i).toFixed(1)}px above the bottom for a second frame`);
  }

  // ── Other tabs do not move ────────────────────────────────────────────
  const firstTabs = frames.find((f) => f.tabs.length)?.tabs ?? [];
  for (const tab of firstTabs) {
    if (tab.id === draftTabId) continue;
    let reported = false;
    for (let i = 0; i < frames.length && !reported; i++) {
      const now = frames[i]!.tabs.find((x) => x.id === tab.id);
      if (now && (Math.abs(now.x - tab.x) > TOL || Math.abs(now.w - tab.w) > TOL)) {
        out.push(`${at(i)} tab ${tab.id}: moved x ${tab.x} -> ${now.x}, w ${tab.w} -> ${now.w}`);
        reported = true;
      }
    }
  }
  return out;
}

/**
 * The opening of the draft, before the send: the composer is born centred and
 * stays there. Whatever card is on screen when ⌘T is pressed belongs to the
 * chat left behind; the draft's is the one on screen at the end.
 */
function analyseOpening(frames: Frame[]): string[] {
  const out: string[] = [];
  const draftCard = frames[frames.length - 1]?.card?.id;
  const own = frames.map((f, i) => ({ f, i })).filter(({ f }) => f.card && f.card.id === draftCard);
  const first = own[0];
  if (!first) return ["opening: the draft composer was never sampled"];
  const t0 = frames[0]!.t;
  const at = (i: number) => `opening f${i} +${Math.round(frames[i]!.t - t0)}ms`;
  for (const { f, i } of own) {
    const dy = f.card!.y - first.f.card!.y;
    if (Math.abs(dy) > TOL) { out.push(`${at(i)} composer: ${dy.toFixed(1)}px from where it was first painted (y ${first.f.card!.y} -> ${f.card!.y})`); break; }
  }
  // A draft has no history: nothing to load, so no skeleton, and its greeting
  // is drawn from the first frame instead of fading in.
  for (const { f, i } of own) {
    if (f.skeleton) { out.push(`${at(i)} skeleton: shown on a chat with no history`); break; }
  }
  for (const { f, i } of own) {
    if (f.empty && f.empty.o < 0.99) { out.push(`${at(i)} empty state: at opacity ${f.empty.o}, not drawn from the first frame`); break; }
  }
  return out;
}

/** A compact per-frame table for the report: one row per frame where something changed. */
function frameTable(frames: Frame[], t0: number): string {
  const cell = (b: Box) => (b ? `${b.y}/${b.h}${b.o < 1 ? `@${b.o}` : ""}${b.v ? "" : "!v"}#${b.id}` : "-");
  const rows = ["frame\tms\tcard y/h\tbubble y/h\tbubbleContentY\tscroller top/h/ch\tindicator\tassistant\tbg\tskeleton\tempty\ttabs"];
  let prev = "";
  frames.forEach((f, i) => {
    const s = f.scroller ? `${f.scroller.top}/${f.scroller.h}/${f.scroller.ch}${f.scroller.v ? "" : "!v"}` : "-";
    const tabs = f.tabs.map((t) => `${t.text}@${t.x}+${t.w}`).join(" ");
    const row = [cell(f.card), cell(f.bubble), f.bubbleContentY ?? "-", s, cell(f.indicator), cell(f.assistant), cell(f.bg), cell(f.skeleton), cell(f.empty), tabs].join("\t");
    if (row !== prev) rows.push(`${i}\t${Math.round(f.t - t0)}\t${row}`);
    prev = row;
  });
  return rows.join("\n");
}

test.describe("First send in a new topic", () => {
  let hostId = "";
  const hostName = `First Send Host ${Date.now()}`;
  let removeCli: (() => void) | null = null;

  test.beforeAll(async ({ request }) => {
    hostId = (await createTopic(request, hostName)).id;
    removeCli = installSlowTurnCli();
  });

  let promotedId = "";

  test.afterAll(async ({ request }) => {
    removeCli?.();
    if (hostId) await deleteTopic(request, hostId);
    // The promoted draft is a real topic now: it goes with the host.
    if (promotedId) await deleteTopic(request, promotedId);
  });

  test("first send in a new topic is smooth", async ({ page, request }, testInfo) => {
    await resetPaneStore(request, [hostId]);
    await installProbe(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await ensureTopicVisible(page, new RegExp(hostName));
    await page.getByRole("treeitem", { name: new RegExp(hostName) }).first().dblclick();
    await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10_000 });

    // ⌘T: a new chat, the composer centred with the focus in it. Sampled
    // from here, the opening is part of the measure too.
    await page.evaluate(() => {
      const p = (window as unknown as { __firstSend: Probe }).__firstSend;
      p.frames = []; p.mutations = []; p.running = true;
    });
    await page.keyboard.press("Meta+t");
    const composer = page.getByRole("textbox", { name: /Campo del messaggio per New Chat/ });
    await expect(composer).toBeFocused({ timeout: 10_000 });
    const block = page.locator('[data-testid="chat-input-area"]').filter({ has: composer });
    await expect(block).toHaveAttribute("data-composer-centered", "true");
    const draftTabId = await page
      .locator('[data-testid="panel-tab-bar"] [data-testid^="pane-tab-draft:"]')
      .first()
      .getAttribute("data-testid")
      .then((s) => s!.slice("pane-tab-".length));

    // A model that thinks for 1.2s, then writes enough to overflow the view.
    await composer.fill("THINK:1200 FAST:600:4:tok");
    // The draft at rest: twenty frames in a row with the composer where it is.
    await page.waitForFunction(() => {
      const f = (window as unknown as { __firstSend: Probe }).__firstSend.frames.slice(-20);
      return f.length === 20 && f.every((x) => x.card && Math.abs(x.card.y - f[0]!.card!.y) <= 0.5);
    });
    const { sendAt, sendT } = await page.evaluate(() => ({
      sendAt: (window as unknown as { __firstSend: Probe }).__firstSend.frames.length,
      sendT: performance.now(),
    }));
    await composer.press("Enter");

    // The reply has streamed to its end and the turn is over.
    const assistant = page.locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: "tok-600" });
    await expect(assistant).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="chat-streaming-indicator"]')).toHaveCount(0, { timeout: 15_000 });
    // …and the tab has its real name: the rename is part of the gesture.
    await expect(page.locator('[data-testid="panel-tab-bar"]').first().getByText(/^New Chat$/)).toHaveCount(0, { timeout: 15_000 });
    // Sixty more frames at rest: whatever settles late is inside the window.
    const n = await page.evaluate(() => (window as unknown as { __firstSend: Probe }).__firstSend.frames.length);
    await page.waitForFunction((k) => (window as unknown as { __firstSend: Probe }).__firstSend.frames.length >= k + 60, n);

    const { frames, mutations } = await page.evaluate(() => {
      const p = (window as unknown as { __firstSend: Probe }).__firstSend;
      p.running = false;
      return JSON.parse(JSON.stringify({ frames: p.frames, mutations: p.mutations })) as { frames: Frame[]; mutations: Mutation[] };
    });
    promotedId = frames[frames.length - 1]?.tabs.find((x) => x.id !== hostId && !x.id.startsWith("draft:"))?.id ?? "";
    const t0 = sendT;
    const mutationLog = mutations.map((m) => `+${Math.round(m.t - t0)}ms ${m.op} ${m.testId}${m.role ? `[${m.role}]` : ""}${m.mid ? ` ${m.mid}` : ""} #${m.id}`).join("\n");
    // On disk next to the video, so the table survives a red run whole.
    for (const [name, body] of [["frames.tsv", frameTable(frames, t0)], ["mutations.txt", mutationLog], ["frames.json", JSON.stringify({ frames, mutations })]] as const) {
      const path = testInfo.outputPath(name);
      writeFileSync(path, body);
      await testInfo.attach(name, { path });
    }

    expect(frames.length, "the probe sampled the gesture").toBeGreaterThan(60);
    expect([
      ...analyseOpening(frames.slice(0, sendAt)),
      ...analyse(frames.slice(sendAt), mutations.filter((m) => m.t >= sendT), draftTabId, sendT),
    ]).toEqual([]);
  });
});
