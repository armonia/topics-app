/**
 * PendingActionRing — small inline replacement for an X / archive icon when
 * the action is queued in PendingActionContext. Renders a check inside an
 * SVG ring whose stroke fills over `countdownMs` once `tickedAt` is set.
 *
 * Usage pattern (in PaneTabBar / TopicItem):
 *   const status = usePendingActionStatus(key);
 *   {status
 *     ? <PendingActionRing status={status} onClick={status.cancel} />
 *     : <button onClick={enqueueAction}><X /></button>}
 *
 * The component is intentionally pure-presentational — all state lives in
 * the PendingActionContext. Click hands the `cancel` back to the parent
 * unchanged so the parent can re-render to its idle icon next frame.
 */
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { PendingActionStatus } from '../../contexts/PendingActionContext';

interface Props {
  status: PendingActionStatus;
  /** Pixel size of the icon box. Default 14 — matches the X icon used in
   *  PaneTabBar. Pass 12-16 for tighter affordances. */
  size?: number;
  /** Optional title attribute for the underlying button. */
  title?: string;
  /** aria-label override for screen readers. Defaults to "Annulla chiusura". */
  ariaLabel?: string;
}

export function PendingActionRing({ status, size = 14, title, ariaLabel }: Props) {
  // The ring fills via stroke-dashoffset from `circumference` to 0.
  // Two RAFs on first paint so the CSS transition has a "from" value to
  // interpolate from — without it some browsers collapse the change into
  // the initial layout pass and the ring appears full immediately.
  const [progress, setProgress] = useState(0);
  const ticked = status.entry.tickedAt !== null;

  useEffect(() => {
    if (!ticked) {
      setProgress(0);
      return;
    }
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setProgress(1));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ticked, status.entry.key]);

  const accent = status.entry.color || 'currentColor';
  const stroke = 1.5;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - progress);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        status.cancel();
      }}
      aria-label={ariaLabel ?? 'Annulla chiusura'}
      title={title ?? 'Annulla'}
      className="relative inline-flex items-center justify-center flex-shrink-0 hover:opacity-80 transition-opacity"
      style={{ width: size, height: size, color: accent }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        {/* Track ring (faint) */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          stroke="currentColor"
          strokeWidth={stroke}
          fill="none"
          opacity={0.25}
        />
        {/* Progress ring (fills as countdown elapses) */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          stroke={accent}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: ticked ? `stroke-dashoffset ${status.countdownMs}ms linear` : 'none',
          }}
        />
      </svg>
      <Check size={Math.max(8, size - 6)} strokeWidth={3} className="relative" />
    </button>
  );
}
