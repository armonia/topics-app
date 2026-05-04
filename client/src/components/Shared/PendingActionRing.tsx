/**
 * PendingActionRing — Things3-style "mark as done" affordance.
 *
 * Two visual states:
 *  - **idle** (no pending entry for the key): empty circle outline. Click
 *    fires `onIdleClick`, which is expected to enqueue a PendingAction
 *    (and auto-tick it, so the countdown starts immediately).
 *  - **pending** (an entry exists, ticked because of auto-tick): filled
 *    circle with a check inside, accented with the topic color when
 *    available. Click cancels.
 *
 * The countdown progress itself is rendered separately by
 * `<PendingActionProgressOverlay>` over the parent row/tab background —
 * not on the icon — so the visual cue scans more like a Things3 task
 * being filled in than a small spinner.
 *
 * Replaces the previous "X close button" + ring affordance: the icon is
 * always semantically "complete this", whether it commits a tab close or
 * archives a topic.
 */
import { Check } from 'lucide-react';
import type { PendingActionStatus } from '../../contexts/PendingActionContext';

interface Props {
  /** Current pending entry for this key, or null when idle. */
  status: PendingActionStatus | null;
  /** Pixel size of the circle. Default 14. */
  size?: number;
  /** Triggered when idle (empty circle clicked). Caller enqueues + auto-ticks. */
  onIdleClick?: () => void;
  /** Override `aria-label` for the idle state. */
  idleAriaLabel?: string;
  /** Override `aria-label` for the pending state. */
  pendingAriaLabel?: string;
  /** Title attribute (tooltip). Per-state defaults supplied if not set. */
  idleTitle?: string;
  pendingTitle?: string;
  /** Extra Tailwind classes for the wrapping <button>. */
  className?: string;
}

const baseBtn =
  'relative inline-flex items-center justify-center flex-shrink-0 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-full';

export function PendingActionRing({
  status,
  size = 14,
  onIdleClick,
  idleAriaLabel = 'Mark as done',
  pendingAriaLabel = 'Annulla',
  idleTitle = 'Done',
  pendingTitle = 'Annulla',
  className,
}: Props) {
  if (!status) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onIdleClick?.(); }}
        aria-label={idleAriaLabel}
        title={idleTitle}
        className={`${baseBtn} ${className ?? ''}`}
        style={{ width: size, height: size }}
      >
        <span
          className="block rounded-full border-[1.5px] border-current opacity-60"
          style={{ width: size, height: size }}
        />
      </button>
    );
  }
  const accent = status.entry.color || 'currentColor';
  const innerCheck = Math.max(8, size - 5);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); status.cancel(); }}
      aria-label={pendingAriaLabel}
      title={pendingTitle}
      className={`${baseBtn} ${className ?? ''}`}
      style={{ width: size, height: size, color: accent }}
    >
      <span
        className="flex items-center justify-center rounded-full"
        style={{ width: size, height: size, backgroundColor: accent }}
      >
        <Check size={innerCheck} strokeWidth={3} className="text-white" />
      </span>
    </button>
  );
}
