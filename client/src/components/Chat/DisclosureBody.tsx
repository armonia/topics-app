/**
 * THE BODY OF A FOLD, the same for every fold in the transcript.
 *
 * It opens and closes by animating its HEIGHT (a grid track from 0fr to 1fr,
 * `MOTION.base`, `EASE.standard`), from the header down: the header never
 * moves, the content unrolls under it. Height and not a transform, for the
 * reason `transcriptRowResize.ts` records: a translated body enlarges the
 * scroller's overflow, and every geometry read during the slide is false. On
 * close the body stays in the tree for the length of its animation; under
 * reduced motion it comes and goes in one frame. A press while the body is
 * still moving turns it back from where it is.
 *
 * It is mounted only while open or closing, so a closed fold costs nothing,
 * and its children are rendered as soon as it opens: the track animates over
 * the content's real height, never over a box that is still empty.
 *
 * `onMotion` hears the length of the animation in the layout phase of the
 * change (a live tool row tells the transcript, `transcriptRowResize.ts`).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { animateEl, EASE, MOTION } from '../../lib/motion';
import { prefersReducedMotion } from '../../lib/reducedMotion';

export function DisclosureBody({ open, children, className, id, testId, onMotion }: {
  open: boolean;
  children: ReactNode;
  /** Applied to the box that holds the children (indent, padding, border). */
  className?: string;
  id?: string;
  testId?: string;
  onMotion?: (durationMs: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [shownOpen, setShownOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (shownOpen !== open) {
    setShownOpen(open);
    setClosing(!open && !prefersReducedMotion());
  }
  const animatedOpenRef = useRef(open);
  useLayoutEffect(() => {
    if (animatedOpenRef.current === open) return;
    animatedOpenRef.current = open;
    const track = trackRef.current;
    if (!track) {
      onMotion?.(0);
      return;
    }
    // Where the body is now, as a share of its open height. Its opacity runs
    // with its height, so a press that turns back a body still on its way (a
    // quick close and reopen) reads it there and turns it from that point.
    // Restarted from the end it had set out from, the body first jumped shut
    // by all that was left of it, 47-55 px, and only then reopened (08/10).
    const running = track.getAnimations();
    const from = running.length > 0 ? Number(getComputedStyle(track).opacity) : open ? 0 : 1;
    const to = open ? 1 : 0;
    for (const a of running) a.cancel();
    const clip = track.firstElementChild as HTMLElement | null;
    // Filled backwards too. Chromium may start a new animation a tenth of a
    // millisecond after the time of the next frame, and that frame is then
    // before the start: without the fill it painted the track's own style, the
    // body wide open for one frame between two closed ones (08/10, start 13.3
    // and frame 13.2; chat-accordion-no-shift, "2 separate runs").
    const animation = animateEl(
      track,
      [{ gridTemplateRows: `${from}fr`, opacity: from }, { gridTemplateRows: `${to}fr`, opacity: to }],
      { duration: MOTION.base, easing: EASE.standard, fill: open ? 'backwards' : 'both' },
    );
    onMotion?.(animation ? MOTION.base : 0);
    if (clip) {
      // Clipped only while the track is shorter than the content: a menu or a
      // form inside an open body is never cut. Unclipped when this animation
      // finishes, never when a turn cancels it: the cancel is reported a frame
      // later, in the middle of the animation that took over, and the body
      // then unrolled unclipped.
      clip.style.overflow = animation ? 'hidden' : '';
      animation?.addEventListener('finish', () => { clip.style.overflow = ''; });
    }
    if (!open && animation) animation.addEventListener('finish', () => setClosing(false));
  }, [open, onMotion]);

  if (!open && !closing) return null;
  return (
    <div ref={trackRef} className="grid" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
      <div className="min-h-0">
        <div id={id} data-testid={testId} className={className}>
          {children}
        </div>
      </div>
    </div>
  );
}
