/**
 * The band that says a drop did not land where the hand let go ("In progress
 * has no queue: the task works from Todo").
 *
 * It used to be a row in the board's flex column, so its arrival pushed every
 * column and every card 28 px down in one frame (fluidity audit panes:F8). A
 * first fix floated it over the top edge of the columns, where it covered the
 * column headers until the next drag. It is now a pill at the bottom of the
 * columns area, stacked above the floating task composer: it covers no header
 * and not the card that just landed at the top of Todo, it takes no pointer
 * input (a card under it stays clickable), and it leaves by itself after
 * `DROP_NOTICE_MS`. It arrives and leaves on the motion tokens (no motion
 * under reduced motion).
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { animateEl, EASE, MOTION } from '../../lib/motion';

/** Long enough to read the sentence twice, short enough not to become furniture. */
export const DROP_NOTICE_MS = 8000;
/** The composer's own offset from the bottom of the area (`bottom-6`). */
const BASE_OFFSET = 24;
const GAP = 8;

export function DropNotice({ text, onDone }: { text: string; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    // Stack above the composer pill when it is on screen (display:none reads
    // as 0 and the notice takes the composer's place). Read once: the notice
    // lives a few seconds, and a drop is not a moment the composer grows.
    // Written to the node before the first paint, so the pill never shows at
    // the wrong height for a frame.
    const composer = anchor.parentElement?.querySelector<HTMLElement>('[data-testid="board-task-composer"]');
    const h = composer?.getBoundingClientRect().height ?? 0;
    anchor.style.bottom = `${h > 0 ? BASE_OFFSET + h + GAP : BASE_OFFSET}px`;
    animateEl(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: MOTION.fast, easing: EASE.standard });
  }, []);
  // `onDone` is a stable callback in the board: the timer starts once per notice.
  useEffect(() => {
    let exit: Animation | null = null;
    const t = window.setTimeout(() => {
      exit = ref.current ? animateEl(ref.current, [{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.fast, easing: EASE.exit, fill: 'forwards' }) : null;
      if (exit) exit.onfinish = onDone;
      else onDone();
    }, DROP_NOTICE_MS);
    return () => { window.clearTimeout(t); exit?.cancel(); };
  }, [onDone]);
  return (
    <div ref={anchorRef} className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4" style={{ bottom: BASE_OFFSET }}>
      <div
        ref={ref}
        role="status"
        data-testid="board-drop-notice"
        className="max-w-xl rounded-lg border border-sky-400/30 bg-app-bg px-3 py-1.5 text-compact leading-4 text-sky-300 shadow-lg shadow-black/40"
      >{text}</div>
    </div>
  );
}
