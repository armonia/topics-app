/**
 * The band that says a drop did not land where the hand let go ("In progress
 * has no queue: the task works from Todo").
 *
 * It used to be a row in the board's flex column, so its arrival pushed every
 * column and every card 28 px down in one frame (fluidity audit panes:F8). It
 * now floats over the top edge of the columns area: nothing under it moves, and
 * it arrives with a short fade on the motion tokens (none under reduced motion).
 */
import { useLayoutEffect, useRef } from 'react';
import { animateEl, EASE, MOTION } from '../../lib/motion';

export function DropNotice({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    animateEl(ref.current, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: MOTION.fast, easing: EASE.standard });
  }, []);
  return (
    // Zero-height anchor in the flow; the band itself is absolute over the columns.
    <div className="relative z-20 h-0 shrink-0">
      <div ref={ref} role="status" data-testid="board-drop-notice" className="absolute inset-x-0 top-0 bg-app-bg shadow-sm">
        <div className="bg-sky-500/10 px-3 py-1.5 text-compact leading-4 text-sky-300">{text}</div>
      </div>
    </div>
  );
}
