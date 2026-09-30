import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { goToApp, ensureTopicVisible } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { hermetic } from "./fixtures/hermetic";
import { EASE, MOTION } from "../../client/src/lib/motion";

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
 *   - the descent starts ON A PAINTED FRAME: no frame shows the composer
 *     further down, or the greeting more faded, than a descent that began on
 *     the first frame painted after Enter could have got by then. The first
 *     frame after the key is therefore still at rest;
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
  /** The frame's own time (`document.timeline.currentTime`, read in its rAF): the clock animations advance on. */
  ft?: number;
  /** The number of the last mutation callback delivered before this sample: the DOM it measured has every batch up to this one and none after. */
  batch: number;
  /** Chat panes on screen: composers with a box that `checkVisibility()` passes. */
  panes: number;
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
/**
 * `batch` numbers the MutationObserver callback that logged the entry: every
 * DOM change made in one task (one React commit) is delivered in ONE callback,
 * and no frame is painted inside a task. Two entries with the same batch are
 * the same mutation; `t` is only for the report. Comparing `t` instead is
 * flaky: a callback that logs across a clock tick (1ms on WebKit, ~0.1ms on
 * Chromium) splits one swap into two instants.
 */
type Mutation = { t: number; batch: number; op: "add" | "remove"; testId: string; id: number; role?: string; mid?: string };
type Probe = { frames: Frame[]; mutations: Mutation[]; running: boolean; nodeId: (el: Element) => number; enterAt?: number; sendBusyMs?: number };

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
    let batchSeq = 0;
    const log = (op: "add" | "remove", root: Node, t: number, batch: number) => {
      if (!(root instanceof Element)) return;
      const hits: Element[] = [];
      if (root.matches("[data-testid]")) hits.push(root);
      hits.push(...root.querySelectorAll("[data-testid]"));
      for (const el of hits) {
        const testId = el.getAttribute("data-testid")!;
        if (!WATCHED.has(testId)) continue;
        p.mutations.push({ t, batch, op, testId, id: nodeId(el), role: el.getAttribute("data-role") ?? undefined, mid: el.getAttribute("data-message-id") ?? undefined });
      }
    };
    // The requests of the gesture, on the same clock: they say WHY a frame changed.
    const origFetch = window.fetch.bind(window);
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (p.running) p.mutations.push({ t: performance.now(), batch: 0, op: "add", testId: `fetch ${method} ${url.replace(location.origin, "")}`, id: 0 });
      return origFetch(input, init);
    }, { preconnect: window.fetch.preconnect });
    // The key itself, on the page's clock: the descent is measured from here.
    document.addEventListener("keydown", (e) => {
      if (p.running && e.key === "Enter" && p.enterAt === undefined) p.enterAt = performance.now();
    }, true);
    // A busy machine: the send's own task takes `sendBusyMs` longer, after the
    // app's handler (a window listener in the bubble phase runs after React's
    // root one). The frame after the key comes that much later.
    window.addEventListener("keydown", (e) => {
      if (!p.running || e.key !== "Enter" || !p.sendBusyMs) return;
      const until = performance.now() + p.sendBusyMs;
      while (performance.now() < until) { /* the busy send path */ }
    });
    new MutationObserver((records) => {
      if (!p.running) return;
      // One clock read and one batch number for the whole callback.
      const t = performance.now();
      const batch = ++batchSeq;
      for (const r of records) {
        r.removedNodes.forEach((n) => log("remove", n, t, batch));
        r.addedNodes.forEach((n) => log("add", n, t, batch));
      }
    }).observe(document, { childList: true, subtree: true });

    /** The chat panes on screen: the visible composers' panes, in DOM order. */
    const visiblePanes = (): Element[] =>
      [...document.querySelectorAll('[data-testid="chat-input-area"]')].flatMap((area) => {
        const r = area.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && area.checkVisibility() && area.parentElement ? [area.parentElement] : [];
      });
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
    let frameTime = 0;
    // The document timeline's time in this frame: the clock animations advance on.
    const tick = () => { frameTime = Number(document.timeline.currentTime ?? performance.now()); channel.port2.postMessage(null); };
    channel.port1.onmessage = () => {
      if (p.running) {
        const onScreen = visiblePanes();
        const root = onScreen[0] ?? null;
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
          ft: frameTime,
          batch: batchSeq,
          panes: onScreen.length,
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

/**
 * What one testId's nodes really did, callback by callback. A node removed and
 * re-added in the same callback was MOVED, never out of the document at a
 * paint: PaneStage parks a released pane body with `moveBefore` on Chromium and
 * with `appendChild` on WebKit, and both are logged as a remove plus an add of
 * the same node. A node shows up once per added ancestor, hence the sets.
 */
function netChanges(mutations: Mutation[], testId: string) {
  const byBatch = new Map<number, { t: number; added: Set<number>; removed: Set<number> }>();
  for (const m of mutations) {
    if (m.testId !== testId) continue;
    const b = byBatch.get(m.batch) ?? { t: m.t, added: new Set<number>(), removed: new Set<number>() };
    byBatch.set(m.batch, b);
    (m.op === "add" ? b.added : b.removed).add(m.id);
  }
  return [...byBatch.entries()].sort(([a], [b]) => a - b).map(([batch, { t, added, removed }]) => ({
    batch,
    t,
    mounted: [...added].filter((id) => !removed.has(id)),
    unmounted: [...removed].filter((id) => !added.has(id)),
  }));
}

/** A CSS `cubic-bezier(...)` easing, evaluated at `x` in [0, 1]. */
function easeAt(bezier: string, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = bezier.match(/-?[\d.]+/g)!.map(Number) as [number, number, number, number];
  const b = (u: number, p1: number, p2: number) => 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u ** 2 * p2 + u ** 3;
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (b(mid, x1, x2) < x) lo = mid; else hi = mid; }
  return b((lo + hi) / 2, y1, y2);
}

/** Clock rounding the start rule forgives (see `aheadOfTheKey`). */
const CLOCK_SLACK_MS = 5;

/**
 * The descent never runs ahead of the key. The latest it may have started is
 * the first frame painted after Enter (`useComposerDock` starts it there, in
 * the draft or, if the promotion lands first, in the promoted pane), so on
 * every later frame the composer is at most `EASE.spring` of the time since
 * then over `MOTION.slow` of the way down, and the greeting has lost at most
 * `EASE.exit` of `MOTION.fast`. The start is the document timeline's time of
 * that frame, the clock `startTime` is set on; the time a frame's position may
 * have reached is counted up to its SAMPLE, taken after the paint: WebKit
 * resolves an animation at the live time of the style update, which trails the
 * frame's timeline time by a few ms (measured +3-4 ms on a quiet run, ~15 under
 * load). Plus {@link CLOCK_SLACK_MS}: WebKit hands out its clocks rounded to
 * the millisecond, and one frame in forty was measured 2 ms past its own
 * sample. A start taken at the key is 60-120 ms early, not 5.
 *
 * Measured on the build this pins (30/09): a promoted pane that took the key's
 * instant as its start painted its first frame 47-86% of the way down, the
 * greeting from 1 to 0.19-0.61.
 */
function aheadOfTheKey(frames: Frame[], restAt: number, enterAt: number, sendT: number): string[] {
  const out: string[] = [];
  const rest = frames[restAt];
  const first = frames.findIndex((f, i) => i > restAt && f.t > enterAt);
  const finalY = [...frames].reverse().find((f) => f.card)?.card?.y;
  if (!rest?.card || first < 0 || finalY === undefined || frames[first]!.ft === undefined) return ["descent: no frame to judge it on"];
  const ft0 = frames[first]!.ft!;
  const descent = finalY - rest.card.y;
  // The first frame ahead, per element, and how many followed: the rest of a
  // descent that started early is ahead on every frame, one line says it.
  const ahead = { composer: [] as string[], "empty state": [] as string[] };
  for (let i = first; i < frames.length; i++) {
    const f = frames[i]!;
    const at = `f${i - restAt} +${Math.round(f.t - sendT)}ms`;
    const elapsed = f.t - ft0 + CLOCK_SLACK_MS;
    if (f.card) {
      const allowed = rest.card.y + descent * easeAt(EASE.spring, elapsed / MOTION.slow);
      if (f.card.y > allowed + 1) ahead.composer.push(`${at} composer: ${(f.card.y - rest.card.y).toFixed(1)}px down ${Math.round(f.t - ft0)}ms after the first frame past the key (a descent started there reaches ${(allowed - rest.card.y).toFixed(1)})`);
    }
    if (f.empty && rest.empty) {
      const floor = rest.empty.o * (1 - easeAt(EASE.exit, elapsed / MOTION.fast));
      if (f.empty.o < floor - 0.02) ahead["empty state"].push(`${at} empty state: opacity ${f.empty.o} ${Math.round(f.t - ft0)}ms after the first frame past the key (a fade started there is at ${floor.toFixed(2)})`);
    }
  }
  for (const lines of Object.values(ahead)) if (lines.length) out.push(lines.length > 1 ? `${lines[0]}, and ${lines.length - 1} frames after it` : lines[0]!);
  return out;
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
  // callback that mounts the promoted pane, never more than half its opacity
  // in one frame.
  const paneChanges = netChanges(mutations, "chat-scroll-container");
  const paneMounts = paneChanges.flatMap((c) => c.mounted.map((id) => ({ id, batch: c.batch, t: c.t })));
  const paneUnmounts = paneChanges.flatMap((c) => c.unmounted.map((id) => ({ id, batch: c.batch, t: c.t })));
  const mountBatches = new Set(paneMounts.map((m) => m.batch));
  for (const c of netChanges(mutations, "chat-empty-state")) {
    for (const id of c.mounted) if (!mountBatches.has(c.batch)) out.push(`+${Math.round(c.t - t0)}ms empty state: replaced by a new node #${id}`);
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
  // `composerHandoff.ts`), mounted once. It has to be a swap, not a gap: the
  // new pane is in the DOM no later than the callback that takes the old one
  // out, so no frame is painted without a chat. The old one may leave later
  // (PaneStage parks it hidden first, then drops it): every frame sampled
  // while both are in the DOM shows exactly one chat pane, with the composer
  // and the greeting where the last frame before the swap had them, or further
  // along the descent: it starts on the key, in the draft, and continues in the
  // promoted pane (30/09), so the composer may only have gone on DOWN and the
  // greeting only have faded further. The checks above prove the same across
  // the swap itself.
  const newPanes = new Set(paneMounts.map((m) => m.id));
  const oldPanes = new Set(paneUnmounts.map((m) => m.id));
  if (newPanes.size > 1 || oldPanes.size > 1) out.push(`pane: remounted ${Math.max(newPanes.size, oldPanes.size)} times, the promotion allows one`);
  for (const gone of paneUnmounts) {
    const successor = paneMounts.find((m) => m.id !== gone.id && m.batch <= gone.batch);
    if (!successor) { out.push(`+${Math.round(gone.t - t0)}ms pane: removed before a new one was mounted`); continue; }
    const between = frames.map((f, i) => ({ f, i })).filter(({ f }) => f.batch >= successor.batch && f.batch < gone.batch);
    const ref = [...frames].reverse().find((f) => f.batch < successor.batch) ?? between[0]?.f;
    for (const { f, i } of between) {
      if (f.panes !== 1) out.push(`${at(i)} pane: ${f.panes} chat panes on screen while the old one was leaving`);
      for (const key of ["card", "empty"] as const) {
        const a = ref?.[key] ?? null, b = f[key];
        const box = !!a && !!b && Math.abs(a.x - b.x) <= TOL && Math.abs(a.h - b.h) <= TOL && b.y >= a.y - TOL;
        const same = !a || !b
          ? a === b || (key === "empty" && !!a && a.o <= 0.05)
          : box && (key === "card" ? Math.abs(a.o - b.o) < 0.01 : b.o <= a.o + 0.01);
        if (!same) out.push(`${at(i)} pane: ${key} changed while the old pane was leaving (${a ? `${a.x},${a.y}/${a.h}@${a.o}` : "none"} -> ${b ? `${b.x},${b.y}/${b.h}@${b.o}` : "none"})`);
      }
    }
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

// The swap rules read the mutation BATCH, never the clock. Pinned on a log
// taken from a real WebKit run (29/09) whose swap callback crossed a
// millisecond: remove at 1119.000, adds at 1120.000, all one callback. Read by
// time it was reported as "removed without a new one" and "empty state:
// replaced", 1 run in 6. And the other way round: two callbacks at the same
// instant are two mutations, and a frame can be painted between them.
//
// And on the log of a red Chromium run in CI (30/09): PaneStage parks the old
// pane with `moveBefore`, logged as a remove plus an add of the SAME nodes in
// the callback that mounts the new pane, and drops it one callback later. Read
// as raw adds and removes that was "remounted 2 times" and "removed without a
// new one", while no frame ever showed anything but one pane.
test("the pane swap is judged by mutation batch, not by timestamp", () => {
  const m = (t: number, batch: number, op: "add" | "remove", testId: string, id: number): Mutation => ({ t, batch, op, testId, id });
  const swapRules = (mutations: Mutation[], frames: Frame[] = []) =>
    analyse(frames, mutations, "draft:x", 1000).filter((l) => /pane:|empty state: replaced/.test(l));
  expect(swapRules([
    m(1119, 7, "remove", "chat-empty-state", 3),
    m(1119, 7, "remove", "chat-scroll-container", 4),
    m(1120, 7, "remove", "composer-card", 5),
    m(1120, 7, "add", "chat-scroll-container", 11),
    m(1121, 7, "add", "chat-empty-state", 12),
  ]), "one callback straddling a clock tick is one swap").toEqual([]);
  expect(swapRules([
    m(1119, 7, "remove", "chat-scroll-container", 4),
    m(1119, 8, "add", "chat-scroll-container", 11),
    m(1119, 9, "add", "chat-empty-state", 12),
  ]), "two callbacks at the same instant are not one swap").toEqual([
    "+119ms empty state: replaced by a new node #12",
    "+119ms pane: removed before a new one was mounted",
  ]);

  // The CI Chromium log, verbatim (the pane's nodes only).
  const ciLog = [
    ...["remove", "add"].flatMap((op) => [1, 2, 3, 4].map((id) => [68, 5, op, id])),
    ...[0, 1, 2].flatMap(() => [5, 6, 7, 8].map((id) => [68, 5, "add", id])),
    ...[1, 2, 3, 4].map((id) => [75, 6, "remove", id]),
  ].map(([ms, batch, op, id]) => {
    const testId = ["chat-scroll-container", "chat-input-area", "chat-empty-state", "composer-card"][((id as number) - 1) % 4]!;
    return m(1000 + (ms as number), batch as number, op as "add" | "remove", testId, id as number);
  });
  const box = (y: number, h: number, id: number): Box => ({ x: 0, y, w: 600, h, o: 1, v: true, id });
  const frame = (t: number, batch: number, panes: number, cardY = 378): Frame => ({
    t, batch, panes,
    card: panes ? box(cardY, 46, batch < 5 ? 4 : 8) : null,
    empty: panes ? box(194, 172, batch < 5 ? 3 : 7) : null,
    bubble: null, bubbleContentY: null, indicator: null, bg: null, skeleton: null, assistant: null,
    assistantHasText: false, scroller: null, tabs: [],
  });
  const ciFrames = [frame(1050, 4, 1), frame(1071, 5, 1), frame(1095, 6, 1)];
  expect(swapRules(ciLog, ciFrames), "a pane parked by a move and dropped later, one pane on screen throughout").toEqual([]);
  expect(swapRules([...ciLog, m(1090, 7, "add", "chat-scroll-container", 13)], ciFrames), "two distinct new panes are a double mount").toEqual([
    "pane: remounted 2 times, the promotion allows one",
  ]);
  expect(swapRules(ciLog, [frame(1050, 4, 1), frame(1071, 5, 0), frame(1095, 6, 1)]), "a frame with no chat pane before the old one leaves").toEqual([
    "f1 +71ms pane: 0 chat panes on screen while the old one was leaving",
    "f1 +71ms pane: card changed while the old pane was leaving (0,378/46@1 -> none)",
    "f1 +71ms pane: empty changed while the old pane was leaving (0,194/172@1 -> none)",
  ]);
  expect(swapRules(ciLog, [frame(1050, 4, 1), frame(1071, 5, 2), frame(1095, 6, 1)]), "both panes on screen at once").toEqual([
    "f1 +71ms pane: 2 chat panes on screen while the old one was leaving",
  ]);
  expect(swapRules(ciLog, [frame(1050, 4, 1), frame(1071, 5, 1, 390), frame(1095, 6, 1)]), "the descent going on while the old pane leaves").toEqual([]);
  expect(swapRules(ciLog, [frame(1050, 4, 1), frame(1071, 5, 1, 366), frame(1095, 6, 1)]), "the composer moving back up before the old pane leaves").toEqual([
    "f1 +71ms pane: card changed while the old pane was leaving (0,378/46@1 -> 0,366/46@1)",
  ]);
});

// The start of the descent, pinned on the frames the verifier measured on a
// loaded Mac (30/09): the first frame after Enter, 118 ms after the key, had the
// card from 378 to 660.4 and the greeting from 1 to 0.225. A descent started on
// that frame shows neither; one frame later it may have moved as far as its
// easing goes in the time up to that frame's sample.
test("the descent may not run ahead of the first frame after the key", () => {
  const box = (y: number, o = 1): Box => ({ x: 0, y, w: 600, h: 46, o, v: true, id: 1 });
  const frame = (t: number, ft: number, cardY: number, emptyO: number): Frame => ({
    t, ft, batch: 1, panes: 1, card: box(cardY), empty: box(194, emptyO),
    bubble: null, bubbleContentY: null, indicator: null, bg: null, skeleton: null, assistant: null,
    assistantHasText: false, scroller: null, tabs: [],
  });
  const enterAt = 1010;
  const settled = [frame(1600, 1598, 704, 0)];
  expect(aheadOfTheKey([frame(1002, 1000, 378, 1), frame(1130, 1128, 660.4, 0.225), frame(1147, 1145, 690, 0), ...settled], 0, enterAt, 1000)).toEqual([
    "f1 +130ms composer: 282.4px down 2ms after the first frame past the key (a descent started there reaches 13.2), and 1 frames after it",
    "f1 +130ms empty state: opacity 0.225 2ms after the first frame past the key (a fade started there is at 1.00), and 1 frames after it",
  ]);
  // Started on that frame: at rest on it, then on the easing.
  expect(aheadOfTheKey([frame(1002, 1000, 378, 1), frame(1130, 1128, 378, 1), frame(1147, 1145, 400, 0.99), ...settled], 0, enterAt, 1000)).toEqual([]);
});

test.describe("First send in a new topic", () => {
  let hostId = "";
  const hostName = `First Send Host ${Date.now()}`;
  let removeCli: (() => void) | null = null;

  test.beforeAll(async ({ request }) => {
    hostId = (await createTopic(request, hostName)).id;
    removeCli = installSlowTurnCli();
  });

  const promotedIds: string[] = [];

  test.afterAll(async ({ request }) => {
    removeCli?.();
    if (hostId) await deleteTopic(request, hostId);
    // The promoted drafts are real topics now: they go with the host.
    for (const id of promotedIds) await deleteTopic(request, id);
  });

  // Once as the machine goes, once with the send's own task 50 ms longer: the
  // descent's start must not depend on how fast the frame after the key comes
  // (verifier, 30/09: green on a quiet Mac, red under load, same build).
  for (const sendBusyMs of [0, 50]) test(sendBusyMs ? `first send in a new topic is smooth with the send path ${sendBusyMs} ms slower` : "first send in a new topic is smooth", async ({ page, request }, testInfo) => {
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
    await page.evaluate((ms) => { (window as unknown as { __firstSend: Probe }).__firstSend.sendBusyMs = ms; }, sendBusyMs);
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

    const { frames, mutations, enterAt } = await page.evaluate(() => {
      const p = (window as unknown as { __firstSend: Probe }).__firstSend;
      p.running = false;
      return JSON.parse(JSON.stringify({ frames: p.frames, mutations: p.mutations, enterAt: p.enterAt })) as { frames: Frame[]; mutations: Mutation[]; enterAt?: number };
    });
    const promotedId = frames[frames.length - 1]?.tabs.find((x) => x.id !== hostId && !x.id.startsWith("draft:"))?.id;
    if (promotedId) promotedIds.push(promotedId);
    const t0 = sendT;
    const mutationLog = mutations.map((m) => `+${Math.round(m.t - t0)}ms b${m.batch} ${m.op} ${m.testId}${m.role ? `[${m.role}]` : ""}${m.mid ? ` ${m.mid}` : ""} #${m.id}`).join("\n");
    // On disk next to the video, so the table survives a red run whole.
    for (const [name, body] of [["frames.tsv", frameTable(frames, t0)], ["mutations.txt", mutationLog], ["frames.json", JSON.stringify({ frames, mutations })]] as const) {
      const path = testInfo.outputPath(name);
      writeFileSync(path, body);
      await testInfo.attach(name, { path });
    }

    expect(frames.length, "the probe sampled the gesture").toBeGreaterThan(60);
    // The composer answers the key: its descent shows on the first or second
    // frame painted after Enter. Measured on the base: 100-140 ms of stillness
    // (the topic's creation on the server plus the remount) before it moved.
    expect(enterAt, "the Enter keydown was seen").toBeDefined();
    const restY = frames[sendAt - 1]?.card?.y ?? 0;
    const afterKey = frames.map((f, i) => ({ f, i })).filter(({ f }) => f.t > enterAt!);
    const moved = afterKey.findIndex(({ f }) => f.card !== null && f.card.y - restY > 0.5);
    console.log(`[first-send] descent visible ${moved < 0 ? "never" : `on frame ${moved + 1} after Enter, +${Math.round(afterKey[moved]!.f.t - enterAt!)}ms`}`);
    expect(moved, "the descent starts on the first or second frame after Enter").toBeGreaterThanOrEqual(0);
    expect(moved, "the descent starts on the first or second frame after Enter").toBeLessThanOrEqual(1);
    // `analyse` starts on the last frame at rest, so the step from it to the
    // first frame after the key is judged too.
    expect([
      ...analyseOpening(frames.slice(0, sendAt)),
      ...aheadOfTheKey(frames, sendAt - 1, enterAt!, sendT),
      ...analyse(frames.slice(sendAt - 1), mutations.filter((m) => m.t >= sendT), draftTabId, sendT),
    ]).toEqual([]);
  });
});
