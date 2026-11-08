/**
 * The two pieces a Plan tile adds over its content: the header state (what the
 * group is doing) and the «waiting for you» box. Both only show what the
 * server computed (`activity`, `needsYou` in `/api/plan`).
 *
 * Kept apart from PlanView so they can be mounted in a test without the view's
 * fetches.
 */
import { CircleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { SEGNALE_ATTESA } from '../Sidebar/chromeSignals';
import { StatusIcon } from './atoms';
import type { PlanActivity, PlanNeed } from '../../../../shared/plan';

/** The card status whose glyph stands for a non-working state. */
const ICON_OF = { review: 'review', todo: 'todo', stale: 'backlog', done: 'done' } as const;

export function ActivityBadge({ activity }: { activity: PlanActivity }) {
  const tr = useT();
  if (activity.state === 'empty') return null;
  const label = tr(`plan.activity.${activity.state}`, { n: activity.count });
  return (
    <span data-testid="plan-activity" data-state={activity.state} title={label}
      className={`flex shrink-0 items-center gap-1 text-mini tabular-nums ${activity.state === 'working' ? 'text-app-text' : 'text-app-text-muted'}`}>
      {/* The same loader a card at work shows on the Board (CardLive). */}
      {activity.state === 'working'
        ? <SparkLoader className="shrink-0" state="working" />
        : <StatusIcon status={ICON_OF[activity.state]} className="h-3 w-3" />}
      {label}
    </span>
  );
}

export function NeedsYouBox({ needs, onOpenTask }: { needs: readonly PlanNeed[]; onOpenTask: (id: string) => void }) {
  const tr = useT();
  if (needs.length === 0) return null;
  return (
    <div data-testid="plan-needs-you" className="flex flex-col gap-0.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
      <span className={`flex items-center gap-1 text-mini font-medium ${SEGNALE_ATTESA}`}>
        <CircleAlert className="h-3 w-3 shrink-0" aria-hidden />{tr('plan.needsYou.title', { n: needs.length })}
      </span>
      {needs.map((n) => (
        <button key={n.taskId} type="button" data-testid="plan-need" onClick={() => onOpenTask(n.taskId)}
          title={n.detail ? `${n.text}\n${n.detail}` : n.text}
          className="flex min-w-0 items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-amber-500/15">
          <span className={`shrink-0 text-mini ${SEGNALE_ATTESA}`}>{tr(`plan.needsYou.${n.reason}`)}</span>
          <span className="min-w-0 flex-1 truncate text-compact text-app-text">{n.detail ?? n.text}</span>
        </button>
      ))}
    </div>
  );
}
