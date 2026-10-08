/**
 * The transcript's half of `transcriptDisclosure.ts`: holds the row a person
 * clicked at the height it had, until the fold under it has settled.
 *
 * WHERE THE CORRECTION RUNS. In a ResizeObserver callback on a 1px marker that
 * a requestAnimationFrame resizes on every frame of the hold. That callback is
 * the last code before the paint (observers run after layout, in the order they
 * were created, and this one is created after Virtuoso's and the list's own),
 * so whatever moved the row in that frame (the list's bottom pin, the browser
 * clamping a list that got shorter, Virtuoso's compensation for a row above the
 * fold that changed size) is undone before anybody sees it. Correcting in the
 * next frame's animation callback, or on the `scroll` event, paints the jump
 * once and then the return: the two-frame wobble this exists to remove.
 *
 * WHEN IT ENDS. Not on a fixed clock: a body can wait for its content (a tool's
 * output fetched on first open) or keep growing for a while (a long run of rows
 * mounting). It lasts at least the fold's animation plus a margin, and ends
 * once the content has kept the same height for a few frames in a row; a hard
 * stop bounds it. A gesture (wheel, finger, scrollbar, scroll keys) ends it at
 * once: from then on the view is the reader's. A press on the transcript's
 * content is not one: a second click on the same header while it is still
 * closing (a quick close and reopen) would otherwise end the hold mid-way, and
 * the list, shorter for an instant, was clamped under the pointer.
 *
 * THE ROOM BELOW THE LAST ROW. Closing near the end keeps the missing height as
 * empty room under the last row (`--chat-anchor-slack`). It is given back as
 * soon as it is out of sight (a scroll up, new output, a fold reopened), on a
 * send or the back-to-bottom button, and by scrolling DOWN past the end: a
 * wheel or a finger there takes the room away by the same amount, and the
 * transcript settles back onto the composer under the reader's own hand.
 *
 * WHAT THE LIST DOES WITH IT (`MessageList`). While a hold runs, every pin to
 * the bottom stands down, forced ones included (`holdingRef`, read by
 * `pinToBottom`): whoever moves the view on purpose (back to the bottom, a
 * send, a topic switch) releases the hold first. Virtuoso's own follow of a
 * grown row (`followOutput`, its `scrollTo` towards the bottom) is refused too,
 * and so is its other scroll, the "upward scrolling compensation": after a
 * scroll up it reads ANY change of the list's height as rows measured above the
 * view and `scrollBy`s it away, which moved a header opened in the middle of a
 * history by its whole body. The toggle itself counts as a hand on the chat:
 * the authority holds the view (`disclosure-toggled`) and the opening's forced
 * recovery pins stand down, as they do for a wheel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react';
import { MOTION } from '../../lib/motion';
import { ANCHOR_SLACK_PROPERTY, type TranscriptDisclosure } from './transcriptDisclosure';

export { ANCHOR_SLACK_PROPERTY, TranscriptDisclosureContext } from './transcriptDisclosure';

/** The shortest hold: the fold's height animation plus the frame its last measure lands in. */
export const DISCLOSURE_MIN_HOLD_MS = MOTION.base + 200;
/** Frames in a row with the content at the same height before the hold lets go. */
export const DISCLOSURE_SETTLE_FRAMES = 8;
/** Past this, whatever is still moving is not the toggle any more. */
export const DISCLOSURE_HARD_STOP_MS = 3000;

interface Hold {
  anchor: Element;
  /** The anchor's top, measured from the scroller's top, when it was clicked. */
  y0: number;
  minUntil: number;
  hardStop: number;
  lastContent: number;
  stillFrames: number;
}

/**
 * The room to keep below the last row, given the view and the content: what
 * keeps `scrollTop` valid without moving it, never more than `current` (room is
 * only ever given back here; it is added by the hold alone). Pure, for a test.
 */
export function slackAfter(current: number, scrollTop: number, clientHeight: number, scrollHeight: number): number {
  if (current <= 0) return 0;
  const contentBottom = scrollHeight - current;
  const needed = Math.ceil(scrollTop + clientHeight - contentBottom);
  return Math.max(0, Math.min(current, needed));
}

export interface DisclosureAnchor extends TranscriptDisclosure {
  /** A hold is running: nobody else may move the view. */
  holding(): boolean;
  /** Ends the hold at once (a gesture, an explicit jump, a topic switch). */
  release(): void;
  /** Gives back the room kept below the last row once it is out of sight. */
  consumeSlack(el: HTMLElement): void;
  /** Drops the room entirely: the view is about to be moved on purpose. */
  clearSlack(el: HTMLElement | null): void;
}

export function useDisclosureAnchor({ scrollerElRef, scrollerEl, holdingRef, onHold, onSettled }: {
  scrollerElRef: RefObject<HTMLElement | null>;
  /** The same scroller, as state: its `scrollBy` is guarded while it lives. */
  scrollerEl: HTMLElement | null;
  /** Where the list's pins, declared before this hook, read whether a hold runs. */
  holdingRef: MutableRefObject<() => boolean>;
  /** A toggle started a hold: the scroll authority hears it. */
  onHold: () => void;
  /** The hold ended by itself; `distanceFromBottom` is measured on the settled list. */
  onSettled: (distanceFromBottom: number) => void;
}): DisclosureAnchor {
  const holdRef = useRef<Hold | null>(null);
  const slackRef = useRef(0);
  const markerRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef(0);
  const onHoldRef = useRef(onHold);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onHoldRef.current = onHold;
    onSettledRef.current = onSettled;
  }, [onHold, onSettled]);

  const writeSlack = useCallback((el: HTMLElement, px: number) => {
    if (px === slackRef.current) return;
    slackRef.current = px;
    el.style.setProperty(ANCHOR_SLACK_PROPERTY, `${px}px`);
  }, []);

  const stopLoop = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  const release = useCallback(() => {
    holdRef.current = null;
    stopLoop();
  }, [stopLoop]);

  /** One frame of the hold, between layout and paint. */
  const step = useCallback(() => {
    const hold = holdRef.current;
    const el = scrollerElRef.current;
    if (!hold) return;
    const now = Date.now();
    if (!el || el.clientHeight === 0 || !hold.anchor.isConnected) {
      release();
      return;
    }
    const y = hold.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const dy = y - hold.y0;
    if (Math.abs(dy) >= 0.5) {
      const target = el.scrollTop + dy;
      const max = el.scrollHeight - el.clientHeight;
      // The list got shorter than the place the anchor needs: the missing
      // height becomes room below the last row, or the browser's clamp would
      // pull every row down by it.
      if (target > max) writeSlack(el, slackRef.current + Math.ceil(target - max));
      el.scrollTop = Math.max(0, target);
    }
    // A body that grows back (the same fold reopened while it was closing)
    // fills the room it had left: what the view no longer needs goes now.
    if (slackRef.current > 0) writeSlack(el, slackAfter(slackRef.current, el.scrollTop, el.clientHeight, el.scrollHeight));
    const content = el.scrollHeight - slackRef.current;
    // Under a pixel is not movement: scroll offsets snap to device pixels, so an anchor half a pixel
    // off stays there. A strip row under its 321.5 px log (08/10) did, and every hold ran to its hard
    // stop: three seconds of pins standing down after each click.
    hold.stillFrames = content === hold.lastContent && Math.abs(dy) < 1 ? hold.stillFrames + 1 : 0;
    hold.lastContent = content;
    if ((now >= hold.minUntil && hold.stillFrames >= DISCLOSURE_SETTLE_FRAMES) || now >= hold.hardStop) {
      release();
      onSettledRef.current(Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight));
    }
  }, [scrollerElRef, release, writeSlack]);

  // A plain function kept in a ref: it schedules itself, which a `useCallback`
  // cannot name before it is declared.
  const tickRef = useRef<() => void>(() => {});
  useEffect(() => {
    tickRef.current = () => {
      frameRef.current = 0;
      const marker = markerRef.current;
      if (!holdRef.current || !marker) return;
      // Any change of size will do: the observer below fires after this frame's layout.
      marker.style.width = marker.style.width === '2px' ? '1px' : '2px';
      frameRef.current = requestAnimationFrame(tickRef.current);
    };
  }, []);

  const toggled = useCallback((anchor: Element) => {
    const el = scrollerElRef.current;
    if (!el || !el.contains(anchor)) return;
    if (!markerRef.current) {
      // Created on the first toggle, so after every observer the list owns.
      const marker = document.createElement('div');
      marker.setAttribute('aria-hidden', 'true');
      marker.dataset.disclosureAnchorMarker = 'true';
      marker.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none;visibility:hidden';
      document.body.appendChild(marker);
      const observer = new ResizeObserver(() => step());
      observer.observe(marker);
      markerRef.current = marker;
      observerRef.current = observer;
    }
    const now = Date.now();
    holdRef.current = {
      anchor,
      y0: anchor.getBoundingClientRect().top - el.getBoundingClientRect().top,
      minUntil: now + DISCLOSURE_MIN_HOLD_MS,
      hardStop: now + DISCLOSURE_HARD_STOP_MS,
      lastContent: el.scrollHeight - slackRef.current,
      stillFrames: 0,
    };
    onHoldRef.current();
    if (!frameRef.current) frameRef.current = requestAnimationFrame(tickRef.current);
  }, [scrollerElRef, step]);

  const consumeSlack = useCallback((el: HTMLElement) => {
    if (slackRef.current <= 0 || holdRef.current) return;
    writeSlack(el, slackAfter(slackRef.current, el.scrollTop, el.clientHeight, el.scrollHeight));
  }, [writeSlack]);

  /** A scroll down of `px` past the end: the room below the last row shrinks by as much. */
  const scrollPastEnd = useCallback((el: HTMLElement, px: number) => {
    if (slackRef.current <= 0 || holdRef.current || px <= 0) return;
    // Only at the end: above it a scroll down is an ordinary scroll.
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) return;
    writeSlack(el, Math.max(0, Math.round(slackRef.current - px)));
  }, [writeSlack]);

  const clearSlack = useCallback((el: HTMLElement | null) => {
    if (slackRef.current <= 0) return;
    if (el) writeSlack(el, 0);
    else slackRef.current = 0;
  }, [writeSlack]);

  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current);
    observerRef.current?.disconnect();
    markerRef.current?.remove();
    holdRef.current = null;
  }, []);

  const holding = useCallback(() => holdRef.current !== null, []);
  useLayoutEffect(() => {
    holdingRef.current = holding;
  }, [holdingRef, holding]);

  // Virtuoso's compensation `scrollBy`, refused while a fold holds its header.
  // Keyed on the element as state, written through the ref: the list owns it.
  useEffect(() => {
    const el = scrollerElRef.current;
    if (!el || el !== scrollerEl) return;
    const native = el.scrollBy.bind(el);
    const guarded = (optionsOrX?: ScrollToOptions | number, y?: number): void => {
      if (holdRef.current) return;
      if (typeof optionsOrX === 'object' || optionsOrX === undefined) native(optionsOrX);
      else native(optionsOrX, y ?? 0);
    };
    el.scrollBy = guarded as typeof el.scrollBy;
    return () => {
      // The own property goes, and the prototype's `scrollBy` is back.
      delete (el as { scrollBy?: unknown }).scrollBy;
    };
  }, [scrollerEl, scrollerElRef]);

  // A wheel down, or a finger dragging up, at the end: the room goes with it.
  useEffect(() => {
    const el = scrollerElRef.current;
    if (!el || el !== scrollerEl) return;
    let touchY: number | null = null;
    const onWheel = (e: WheelEvent) => { if (e.deltaY > 0) scrollPastEnd(el, e.deltaY); };
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y == null) return;
      if (touchY != null) scrollPastEnd(el, touchY - y);
      touchY = y;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [scrollerEl, scrollerElRef, scrollPastEnd]);

  return useMemo(
    () => ({ toggled, holding, release, consumeSlack, clearSlack }),
    [toggled, holding, release, consumeSlack, clearSlack],
  );
}
