/**
 * The columns row's snap, HELD while something other than a scrolling hand is
 * moving the row, and given back at the next scroll gesture.
 *
 * The row is a `snap-x snap-mandatory` carousel of `snap-center` columns. Two
 * things move it that are not a hand scrolling it, and with the snap on both
 * move it by whole columns:
 *
 *  - the task drawer changing the row's width (see `useDrawerPresence`): the
 *    browser re-snapped to ANOTHER column, 56 px on open and 108 px on close;
 *  - dnd-kit's auto-scroll while a card is in hand near the row's edge. It
 *    scrolls a few pixels every 5 ms, and a mandatory snap turns each of those
 *    nudges into a jump to the next snap point: measured on WebKit with the
 *    pointer resting 44 px inside the edge and the row's scroll instant (reduced
 *    motion), scrollLeft went 0, 56, 768, 936 in three frames, so a card aimed
 *    at In Progress was dropped on Done (BOARD-18, red on Chromium). The
 *    `sm:scroll-smooth` on the row used to hide this by slowing each jump into
 *    an animation, which is not a fix: a reduced-motion scroll is instant, and
 *    the snap still steals the pointer's column, only later.
 *
 * With the snap held, a width change keeps `scrollLeft` and the auto-scroll
 * moves the row by the pixels it asks for. The snap comes back at the next
 * SCROLL gesture on the row (wheel or touch), where a re-snap is the carousel
 * doing its job under a hand that is already scrolling. A drop never gives it
 * back: re-enabling it there would re-snap the row under the card that just
 * landed, and a click never does, because a re-snap under a pointer that is
 * about to press a card would move the card.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface RowSnapHold {
  /** True while the row must not snap. */
  held: boolean;
  /** Hold the snap until the next scroll gesture on the row. Stable. */
  hold: () => void;
}

export function useRowSnapHold(rowRef: RefObject<HTMLElement | null>): RowSnapHold {
  const [held, setHeld] = useState(false);
  const hold = useCallback(() => setHeld(true), []);

  useEffect(() => {
    const row = rowRef.current;
    if (!held || !row) return;
    const release = () => setHeld(false);
    row.addEventListener('wheel', release, { passive: true, once: true });
    row.addEventListener('touchstart', release, { passive: true, once: true });
    return () => {
      row.removeEventListener('wheel', release);
      row.removeEventListener('touchstart', release);
    };
  }, [held, rowRef]);

  return { held, hold };
}
