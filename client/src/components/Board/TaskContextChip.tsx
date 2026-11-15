import { Gauge } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useTaskContext } from '../../hooks/useTaskContext';
import { sessionWeight } from '../../../../shared/task-countdown';
import { fmtTok } from './format';
import { contextLevelInk } from './SessionWeight';

/**
 * The context share of the session behind a card in progress, as one chip.
 * Nothing without a provider measure: no percent is better than a guessed one.
 */
export function TaskContextChip({ assignedTopicId }: { assignedTopicId: string | null | undefined }) {
  const tr = useT();
  const m = useTaskContext(assignedTopicId);
  if (!m) return null;
  const w = sessionWeight({ ...m, billableTokens: 0, cacheReadTokens: 0, costCents: 0 });
  if (w.percent == null || w.usedTokens == null) return null;
  return (
    <span
      data-testid="card-context"
      title={tr('board.weight.contextTitle', { used: fmtTok(w.usedTokens), pct: w.percent })}
      className={`inline-flex items-center gap-1 whitespace-nowrap tabular-nums ${contextLevelInk(w.level) || 'text-app-text-secondary'}`}
    >
      <Gauge size={11} aria-hidden="true" />{w.estimated ? '≈ ' : ''}{w.percent}%
    </span>
  );
}
