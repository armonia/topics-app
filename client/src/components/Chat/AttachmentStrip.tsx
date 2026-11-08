/**
 * THE COMPOSER'S ATTACHMENT ROW, which opens and closes instead of snapping.
 *
 * Measured in the UI audit of 2026-09-29 (core:F13): two attachments grew the
 * composer card 46 -> 125 px in one frame, pushing the conversation with it,
 * and each removal was another one-frame snap. The row keyed its chips by
 * position, so removing the first one handed its node to the next: the chip
 * left behind changed shape (a pill became a thumbnail) in the same frame.
 *
 * The row now animates its height over `MOTION.fast`, from wherever it is to
 * its new natural height, starting in the layout phase of the change so the
 * first painted frame already shows the start of the animation. It is a
 * height and not a transform for the same reason as a tool body
 * (`transcriptRowResize.ts`): the card, the composer block and the list's
 * bottom gutter all follow the real height on every frame, and a transform
 * would leave them at the final size from the first. Chips are keyed by
 * identity (`attachmentKey`) and fade in (`.reveal-in`); under reduced motion
 * nothing animates.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { animateEl, MOTION } from '../../lib/motion';

/** `count`: how many chips the row holds. `children`: the row itself, or nothing when empty. */
export function AttachmentStrip({ count, children }: { count: number; children: ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(0);
  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const to = outer.firstElementChild?.getBoundingClientRect().height ?? 0;
    // Mid-animation the row starts from where it is drawn, not from where it was going.
    const running = outer.getAnimations();
    const from = running.length > 0 ? outer.getBoundingClientRect().height : settledRef.current;
    settledRef.current = to;
    for (const a of running) a.cancel();
    if (Math.abs(to - from) < 0.5) return;
    // Clipped only while it moves: the corner remove buttons reach past the row at rest.
    animateEl(outer, [{ height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' }], { duration: MOTION.fast });
  }, [count]);
  return <div ref={outerRef}>{children}</div>;
}
