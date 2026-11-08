/**
 * The task drawer's ENTRANCE and EXIT, and the columns that must not move.
 *
 * WHAT WAS WRONG (fluidity audit panes:F6, measured 2026-09-29). On a desktop
 * the drawer is an in-flow sibling of the columns row: it appeared on its final
 * frame at full opacity and vanished in one frame on Escape. Worse, the row is a
 * `snap-x snap-mandatory` carousel of `snap-center` columns, so when its width
 * changed by the drawer's 384 px the browser re-snapped it to ANOTHER column:
 * the whole board lurched 56 px on open and 108 px on close, and after an
 * open-and-close it sat 164 px away from where it started.
 *
 * WHAT THIS DOES.
 *  - Keeps the last task mounted while it leaves, so the exit can be seen, and
 *    fades it in on the way in. Opacity plus a 16 px slide, `MOTION.fast`: the
 *    drawer appears in place, it does not travel, and a card you open must not
 *    feel slower than before. Reduced motion: no animation at all, the exit is
 *    immediate (`animateEl` returns null).
 *  - Holds the carousel snap from the moment the drawer's presence changes the
 *    row's width. With the snap held the width change keeps `scrollLeft`, so
 *    nothing moves. The hold, and when it is given back, belong to the row
 *    (`useRowSnapHold`): a card in hand holds the same snap.
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { animateEl, EASE, MOTION } from '../../lib/motion';
import type { RowSnapHold } from './useRowSnapHold';

const DRAWER_SELECTOR = '[data-testid="task-detail-drawer"]';
const ENTER_OFFSET_PX = 16;

export interface DrawerPresence<T> {
  /** The task the drawer shows: the selection, or the one leaving. */
  shown: T | null;
  /** True while `shown` is on its way out. */
  leaving: boolean;
}

export function useDrawerPresence<T extends { id: string }>(
  selected: T | null,
  hostRef: RefObject<HTMLElement | null>,
  snap: RowSnapHold,
): DrawerPresence<T> {
  const [drawer, setDrawer] = useState<{ task: T; leaving: boolean } | null>(
    selected ? { task: selected, leaving: false } : null,
  );
  const { held: snapHeld, hold: holdSnap } = snap;

  // Derived during render (React's "state from the previous render" pattern),
  // so the leaving drawer and the held snap land in the SAME commit as the
  // selection change: an effect would paint one frame of the old layout first.
  if (selected) {
    if (!drawer || drawer.leaving || drawer.task !== selected) {
      if (!drawer && !snapHeld) holdSnap();
      setDrawer({ task: selected, leaving: false });
    }
  } else if (drawer && !drawer.leaving) {
    setDrawer({ task: drawer.task, leaving: true });
  }

  const wasOpen = useRef(false);
  const generation = useRef(0);
  const exitAnimation = useRef<Animation | null>(null);
  const shownId = drawer?.task.id ?? null;
  const leaving = drawer?.leaving ?? false;

  const finishExit = useCallback((gen: number) => {
    if (generation.current !== gen) return;
    holdSnap();
    setDrawer((d) => (d && d.leaving ? null : d));
  }, [holdSnap]);

  useLayoutEffect(() => {
    const gen = ++generation.current;
    const el = hostRef.current?.querySelector<HTMLElement>(DRAWER_SELECTOR) ?? null;
    // A reopen during the exit: the fade-out holds its last frame (`forwards`),
    // so it must go before anything else is decided.
    exitAnimation.current?.cancel();
    exitAnimation.current = null;
    if (!shownId) { wasOpen.current = false; return; }
    if (leaving) {
      if (!el) { finishExit(gen); return; }
      el.style.pointerEvents = 'none';
      const from = getComputedStyle(el).transform;
      const base = from && from !== 'none' ? `${from} ` : '';
      const animation = animateEl(
        el,
        [{ opacity: 1, transform: base || 'none' }, { opacity: 0, transform: `${base}translateX(${ENTER_OFFSET_PX}px)` }],
        { duration: MOTION.fast, easing: EASE.exit, fill: 'forwards' },
      );
      if (!animation) { finishExit(gen); return; }
      exitAnimation.current = animation;
      animation.onfinish = () => finishExit(gen);
      animation.oncancel = () => finishExit(gen);
      return;
    }
    if (el) el.style.pointerEvents = '';
    if (!wasOpen.current && el) {
      animateEl(
        el,
        [{ opacity: 0, transform: `translateX(${ENTER_OFFSET_PX}px)` }, { opacity: 1, transform: 'none' }],
        { duration: MOTION.fast, easing: EASE.standard },
      );
    }
    wasOpen.current = true;
  }, [shownId, leaving, hostRef, finishExit]);

  return { shown: drawer?.task ?? null, leaving };
}
