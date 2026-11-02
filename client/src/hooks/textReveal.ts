/**
 * GRADUAL REVEAL OF STREAMED TEXT.
 *
 * The provider hands over cumulative snapshots, so a paragraph used to appear
 * whole in one frame. The client now writes the newly arrived text a few
 * characters per frame instead. The reveal never trails the real text by more
 * than `MAX_REVEAL_LAG_MS`: the per-frame step grows with the backlog, so a big
 * burst drains in the same time as a small one.
 */
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/reducedMotion';

/** Hard ceiling on how far the written text may trail the arrived text. */
export const MAX_REVEAL_LAG_MS = 600;
/** Budget used for the drain maths: leaves headroom under the ceiling for frame jitter. */
const DRAIN_BUDGET_MS = 450;
/** Characters written per frame when the backlog is small. */
const MIN_STEP = 2;
/** A frame gap longer than this (a throttled tab) counts as this long. */
const MAX_FRAME_MS = 100;

/**
 * Length to show after one frame.
 * `shown` is what is written now, `target` the length that has arrived,
 * `frameMs` the time since the previous frame, `msLeft` the time left until the
 * oldest unwritten character is due (arrival plus `DRAIN_BUDGET_MS`). The step
 * is the backlog spread over the frames that remain, so the deadline holds.
 */
export function nextRevealLength(shown: number, target: number, frameMs: number, msLeft: number): number {
  const backlog = target - shown;
  if (backlog <= 0) return target;
  const frame = Math.min(Math.max(frameMs, 1), MAX_FRAME_MS);
  const framesLeft = Math.max(1, Math.floor(msLeft / frame));
  const step = Math.max(MIN_STEP, Math.ceil(backlog / framesLeft));
  return Math.min(target, shown + step);
}

/** True when the text must be drawn whole: not live, or reduced motion asked for. */
export function isRevealOff(enabled: boolean): boolean {
  return !enabled || prefersReducedMotion();
}

/**
 * The text to draw. `enabled` false (history, finished turns) or a reduced
 * motion preference returns the full text with no state of its own.
 */
export function useRevealedText(text: string, enabled: boolean): string {
  const off = isRevealOff(enabled);
  const [shown, setShown] = useState(off ? text.length : 0);
  const shownRef = useRef(shown);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (off) return;
    let raf = 0;
    let last = performance.now();
    let deadline = 0;
    const tick = (now: number) => {
      const target = textRef.current.length;
      const from = Math.min(shownRef.current, target);
      if (from === target) deadline = 0;
      else if (deadline === 0) deadline = now + DRAIN_BUDGET_MS;
      const next = nextRevealLength(from, target, now - last, deadline - now);
      last = now;
      if (next !== shownRef.current) {
        shownRef.current = next;
        setShown(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [off]);

  if (off) return text;
  let end = Math.min(shown, text.length);
  // Never cut a surrogate pair in half.
  const code = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && code >= 0xd800 && code <= 0xdbff) end += 1;
  return text.slice(0, end);
}
