/**
 * PendingActionProgressOverlay — Things3-style row/tab "filling up" effect.
 *
 * Renders an absolutely-positioned div over the parent (which MUST be
 * `position: relative`) whose width animates from 0 to 100% over
 * `status.countdownMs`. Tinted with the topic's accent color (or a neutral
 * fallback) at low opacity so the underlying tab/row content stays
 * readable.
 *
 * Mount only when a PendingAction is queued for the relevant key — this is
 * how callsites express "I'm currently in the 3 s soft-destructive window
 * for this row/tab; please show the user what's happening".
 *
 * Why a CSS transition on `width` and not `transform: scaleX`: scaleX
 * looks the same visually but warps the rounded corners of any wrapping
 * border-radius; width-based fill keeps the corner radius inherited from
 * the parent (`rounded-[inherit]` on this element).
 *
 * Two-step paint trick: set `width: 0` on first paint, then bump to 100%
 * on the next animation frame so the CSS transition has a concrete
 * starting value. Without it some browsers collapse the change into the
 * initial layout pass and the bar appears already full.
 */
import { useEffect, useState } from 'react';
import type { PendingActionStatus } from '../../contexts/PendingActionContext';

interface Props {
  status: PendingActionStatus;
  /** Override the overlay opacity (0–1). Default 0.14 — strong enough to
   *  read as a fill, gentle enough that text on top stays legible. */
  opacity?: number;
  /** Optional className passthrough — useful to set `rounded-[inherit]`,
   *  `rounded-md`, etc. when the parent has a non-trivial border radius. */
  className?: string;
}

export function PendingActionProgressOverlay({
  status,
  opacity = 0.14,
  className,
}: Props) {
  const [progress, setProgress] = useState(0);
  // `tickedAt` is set on auto-tick, so progress should start filling on
  // the very next paint after the entry appears in the context. Key the
  // effect on BOTH the entry key AND `tickedAt`: the key handles a fresh
  // pending entry replacing a previous one, and `tickedAt` handles the
  // user-cancel-then-re-click cycle where the same key is re-enqueued
  // and re-ticked at a new timestamp — without depending on tickedAt
  // here the bar would skip the 0→1 ramp and appear already full.
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional two-step paint reset: snap the fill back to 0 on a new/re-ticked entry, then ramp to 1 on the next frame so the CSS width transition has a concrete start value
    setProgress(0);
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setProgress(1));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [status.entry.key, status.entry.tickedAt]);

  const accent = status.entry.color || 'currentColor';

  return (
    <span
      aria-hidden="true"
      className={`absolute inset-y-0 left-0 pointer-events-none ${className ?? 'rounded-[inherit]'}`}
      style={{
        width: `${progress * 100}%`,
        backgroundColor: accent,
        opacity,
        transition: `width ${status.countdownMs}ms linear`,
      }}
    />
  );
}
