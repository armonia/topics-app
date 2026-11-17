import { useSharedNow } from '../../state/useSharedNow';
import type { LiveAgentRow } from '../../../../shared/live-work';
import { ContextShare } from './ContextShare';
import { TaskCountdown } from './TaskCountdown';
import { childBasis } from '../../lib/workLine';
import { fmtTok } from './format';

/**
 * Countdown and weight of work in progress, the same pair wherever it shows:
 * a sub-agent's row under its chat, its own tab, the agents list, the sidebar.
 * The countdown exists only with an estimate (from the children that already
 * finished) and the percent only with a context the provider measured;
 * with neither, the tokens spent so far, and with nothing at all, nothing.
 */
export function WorkMeter({ startedAt, estimateMs, estimateHistoryMs, weight, className = '' }: Pick<LiveAgentRow, 'startedAt' | 'estimateMs' | 'estimateHistoryMs' | 'weight'> & { className?: string }) {
  const now = useSharedNow();
  const started = Date.parse(startedAt);
  const measure = weight && weight.usedTokens != null && weight.windowTokens != null
    ? { usedTokens: weight.usedTokens, windowTokens: weight.windowTokens, estimated: weight.estimated }
    : null;
  const spent = weight && weight.billableTokens > 0 ? weight.billableTokens : 0;
  const countdown = estimateMs && Number.isFinite(started) ? <TaskCountdown basis={childBasis(estimateMs, estimateHistoryMs)} elapsedMs={Math.max(0, now - started)} /> : null;
  if (!countdown && !measure && !spent) return null;
  return (
    <span data-testid="work-meter" className={`inline-flex flex-shrink-0 items-center gap-2 text-mini ${className}`}>
      {countdown}
      {measure ? <ContextShare measure={measure} /> : spent > 0 && <span data-testid="work-meter-tokens" className="tabular-nums text-app-text-secondary">{fmtTok(spent)}</span>}
    </span>
  );
}
