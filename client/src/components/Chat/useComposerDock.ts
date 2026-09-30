/**
 * WHERE THE COMPOSER SITS: centred in an empty chat, docked at the bottom once
 * the conversation has begun, and every movement between the two.
 *
 * An empty chat has nothing to read, so its text field sits in the middle of
 * the pane instead of glued to the bottom under half a screen of nothing. At
 * the first message it slides down, where it stays. The movement is a
 * `translateY` only: no layout, no re-measure of the virtualised list.
 *
 * THE RULES, each from a measurement (UI audit 2026-09-29):
 *  - the composer is painted at its place on the FIRST frame. Every height the
 *    centring needs (pane, composer block, greeting) is measured in the layout
 *    phase, before the paint, and again when the pane height changes: the
 *    greeting grows its starters once the pane height is known, and a block
 *    measured before that drifted the composer 29 px after it appeared
 *    (panes:F2);
 *  - it only ever SLIDES DOWN. A saved chat whose emptiness is known only when
 *    its history answers climbed 350-620 px over 420 ms right when you start
 *    typing (core:F06). It now takes the centre in one step and fades in there;
 *  - the first send of a draft starts the descent ON THE KEY, not after the
 *    topic exists: see `state/composerHandoff.ts`;
 *  - the height of the block reaches the list's bottom gutter in the SAME
 *    frame, through a CSS custom property written from the observer, and the
 *    list re-pins from there: on the phone the last message followed a new
 *    line of the composer 28-49 ms late, under it meanwhile (panes:F15).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { animateEl, EASE, MOTION } from '../../lib/motion';
import { hasNoBox } from '../../lib/hiddenBox';
import { beginDescent, cancelDescent, claimDescent } from '../../state/composerHandoff';

/** The composer block's height, read by the list's bottom gutter (`MessageList` Footer). */
export const COMPOSER_HEIGHT_PROPERTY = '--chat-composer-h';

/** Told by the composer observer, in the frame the block changed height. */
export type ComposerResizeHandler = (grew: boolean) => void;

/** How long the greeting's fade outlives the centred state (`ChatEmptyState` fades in 200 ms). */
const GREETING_LINGER_MS = 220;

/** The document timeline's clock, which `Animation.startTime` is expressed in. */
function timelineNow(): number {
  const t = typeof document !== 'undefined' ? document.timeline?.currentTime : null;
  return typeof t === 'number' ? t : performance.now();
}

/**
 * The descent: the block from `offset` px up to its docked place, the greeting
 * fading out as it goes. A `startTime` pins both to one absolute instant, so the
 * promoted pane's copy continues the draft's frame for frame; without one they
 * start together on the next frame, however long the send keeps this one busy
 * (measured: the first frame after Enter lands 60-90 ms later, and a start
 * taken at the key had the greeting lose half its opacity in that one frame).
 */
function playDescent(area: HTMLElement, greeting: HTMLElement | null, offset: number, startTime: number | null, fill: FillMode): Animation[] {
  const slide = animateEl(area, [{ transform: `translateY(-${offset}px)` }, { transform: 'translateY(0px)' }], { duration: MOTION.slow, easing: EASE.spring, fill });
  const face = greeting?.firstElementChild;
  const fade = face ? animateEl(face, [{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.fast, easing: EASE.exit, fill }) : null;
  const played = [slide, fade].filter((a): a is Animation => a !== null);
  if (startTime !== null) for (const a of played) a.startTime = startTime;
  return played;
}

interface ComposerDockArgs {
  topicId: string;
  paneRootRef: RefObject<HTMLDivElement | null>;
  inputAreaRef: RefObject<HTMLDivElement | null>;
  greetingRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  isFocused: boolean;
  /** The history has answered once (a draft has none to ask for). */
  historyProbed: boolean;
  loading: boolean;
  messageCount: number;
}

export function useComposerDock({ topicId, paneRootRef, inputAreaRef, greetingRef, textareaRef, isFocused, historyProbed, loading, messageCount }: ComposerDockArgs) {
  const [inputAreaHeight, setInputAreaHeight] = useState(0);
  const [paneHeight, setPaneHeight] = useState(0);
  const [greetingHeight, setGreetingHeight] = useState(0);
  /** Filled by `MessageList`: re-pins the list in the frame the composer grows. */
  const composerResizeRef = useRef<ComposerResizeHandler | null>(null);

  // The composer block's height (multiline, attachments, strips above it).
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;
    // Only a new HEIGHT goes on: dragging a divider narrows or widens the pane
    // on every frame, and each notification would hand React a setState to
    // bail out of (SPLITPERF-01).
    let last: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      // A pane hidden behind another tab (`display: none`) reports a 0x0 box.
      // That is the absence of a box, not a height: taking it shrank the list's
      // footer while hidden, and on the way back the first frame painted the
      // list 107 px too low (tab-switch audit 2026-09-29, PERF-01).
      if (hasNoBox(entry.contentRect)) return;
      const h = entry.contentRect.height;
      if (h === last) return;
      // Rounded: `contentRect.height` is a float, and subpixel noise pinned.
      const grew = Math.round(h) > Math.round(last ?? 0);
      last = h;
      // Between layout and paint: the gutter and the pin land in this frame.
      paneRootRef.current?.style.setProperty(COMPOSER_HEIGHT_PROPERTY, `${h}px`);
      composerResizeRef.current?.(grew);
      setInputAreaHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inputAreaRef, paneRootRef]);

  // The pane's height: the centre is `(pane - bar) / 2`, and it decides how
  // much of the greeting fits. Observed on the root, which the block is
  // positioned against.
  useEffect(() => {
    const el = paneRootRef.current;
    if (!el) return;
    let last: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (hasNoBox(entry.contentRect)) return;
      const h = entry.contentRect.height;
      if (h === last) return;
      last = h;
      setPaneHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [paneRootRef]);

  const claimed = useState(() => claimDescent(topicId))[0];
  const composerCentered = historyProbed && !loading && messageCount === 0;
  // It is THE BAR that is centred, not the block: centring greeting plus
  // composer put the bar below the middle by half the greeting's height. The
  // greeting stays above as an overhang and does not count.
  const barHeight = Math.max(0, inputAreaHeight - greetingHeight);
  const composerOffset = composerCentered && paneHeight > 0 && barHeight > 0
    ? Math.max(0, Math.round((paneHeight - barHeight) / 2))
    : 0;
  const offsetRef = useRef(composerOffset);
  const topicIdRef = useRef(topicId);
  useLayoutEffect(() => {
    offsetRef.current = composerOffset;
    topicIdRef.current = topicId;
  }, [composerOffset, topicId]);

  // The greeting stays mounted for its fade, OUT of the flow (`ChatEmptyState`).
  // The flag flips DURING the render that un-centres: set from an effect, that
  // render unmounted the block and the fade never played (chat-first-send-smooth).
  const [greetingLeaving, setGreetingLeaving] = useState(() => claimed !== null && timelineNow() - claimed.at < MOTION.fast);
  const [wasCentered, setWasCentered] = useState(composerCentered);
  if (wasCentered !== composerCentered) {
    setWasCentered(composerCentered);
    setGreetingLeaving(!composerCentered);
  }
  useEffect(() => {
    if (!greetingLeaving) return;
    const t = setTimeout(() => setGreetingLeaving(false), GREETING_LINGER_MS);
    return () => clearTimeout(t);
  }, [greetingLeaving]);
  const showGreeting = composerCentered || greetingLeaving;

  // Measured SYNCHRONOUSLY, before the paint: at mount, when the pane height
  // changes (the greeting shows its starters only once it is known) and when
  // the greeting comes or goes. The observers above report a frame later.
  useLayoutEffect(() => {
    const root = paneRootRef.current;
    if (!root) return;
    const rootBox = root.getBoundingClientRect();
    if (hasNoBox(rootBox)) return;
    setPaneHeight(rootBox.height);
    const block = inputAreaRef.current;
    if (block) {
      const h = block.getBoundingClientRect().height;
      root.style.setProperty(COMPOSER_HEIGHT_PROPERTY, `${h}px`);
      setInputAreaHeight(h);
    }
    setGreetingHeight(greetingRef.current?.getBoundingClientRect().height ?? 0);
  }, [paneHeight, showGreeting, paneRootRef, inputAreaRef, greetingRef]);
  // The greeting re-wraps with the pane's width: followed by an observer,
  // re-attached as it comes and goes (an observer on an unmounted node keeps
  // its last value, which would hold the bar too low forever).
  useLayoutEffect(() => {
    const el = greetingRef.current;
    if (!el) return;
    let last: number | null = null;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      if (h === last) return;
      last = h;
      setGreetingHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showGreeting, greetingRef]);

  // A pane born of a promoted draft continues the draft's descent from the
  // frame it had reached, before its own first paint.
  useLayoutEffect(() => {
    const area = inputAreaRef.current;
    const root = paneRootRef.current;
    if (!claimed || !area || !root) return;
    const offset = claimed.offset ?? Math.max(0, Math.round((root.getBoundingClientRect().height - area.getBoundingClientRect().height) / 2));
    if (offset > 0) playDescent(area, greetingRef.current, offset, claimed.at, 'none');
    // Runs once: `claimed` is fixed at mount and the refs never change.
  }, [claimed, inputAreaRef, paneRootRef, greetingRef]);

  // Centred AFTER the first paint (the history of a saved chat answered empty):
  // placed in one step, never glided up, and it enters where it lands.
  const prevCenteredRef = useRef(composerCentered);
  useLayoutEffect(() => {
    const was = prevCenteredRef.current;
    prevCenteredRef.current = composerCentered;
    const area = inputAreaRef.current;
    if (was || !composerCentered || !area || offsetRef.current <= 0) return;
    animateEl(area, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fast });
  }, [composerCentered, inputAreaRef]);

  // The draft's first send: the descent starts on the key.
  const descentRef = useRef<{ draftId: string; played: Animation[] } | null>(null);
  const startDescent = useCallback(() => {
    const area = inputAreaRef.current;
    const offset = offsetRef.current;
    if (!area || offset <= 0) return;
    const descent = beginDescent(topicId, timelineNow(), offset);
    const played = playDescent(area, greetingRef.current, offset, null, 'forwards');
    // The instant it really started is the one the promoted pane continues from.
    played[0]?.ready.then((a) => { if (typeof a.startTime === 'number') descent.at = a.startTime; }, () => {});
    descentRef.current = { draftId: topicId, played };
  }, [topicId, inputAreaRef, greetingRef]);
  /** After the send: the same draft still on screen was not promoted, so its composer goes back to the centre. */
  const settleDescent = useCallback(() => {
    const d = descentRef.current;
    descentRef.current = null;
    if (!d || !inputAreaRef.current || topicIdRef.current !== d.draftId) return;
    cancelDescent(d.draftId);
    for (const a of d.played) a.cancel();
  }, [inputAreaRef]);

  // A NEW chat is born to be written in: focusing its field steals nothing, an
  // empty chat has nothing else the user could have focused on purpose.
  useEffect(() => {
    if (!isFocused || !composerCentered) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [isFocused, composerCentered, textareaRef]);

  return { inputAreaHeight, paneHeight, composerCentered, composerOffset, showGreeting, composerResizeRef, startDescent, settleDescent, bornFromDraft: claimed !== null };
}
