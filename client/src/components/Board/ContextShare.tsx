import { Gauge } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { sessionWeight, type ContextMeasure } from '../../../../shared/task-countdown';
import { fmtTok } from './format';
import { contextLevelInk } from './SessionWeight';

/**
 * The share of the model window a session fills, as one chip. The one place
 * that draws it: the card, a sub-agent's row, its tab, the lists. Nothing
 * without a measure from the provider: no percent is better than a guessed one.
 */
export function ContextShare({ measure, className = '' }: { measure: ContextMeasure | null; className?: string }) {
  const tr = useT();
  if (!measure) return null;
  const w = sessionWeight({ ...measure, billableTokens: 0, cacheReadTokens: 0, costCents: 0 });
  if (w.percent == null || w.usedTokens == null) return null;
  return (
    <span
      data-testid="context-share"
      title={tr('board.weight.contextTitle', { used: fmtTok(w.usedTokens), pct: w.percent })}
      className={`inline-flex items-center gap-1 whitespace-nowrap tabular-nums ${contextLevelInk(w.level) || 'text-app-text-secondary'} ${className}`}
    >
      <Gauge size={11} aria-hidden="true" />{w.estimated ? '≈ ' : ''}{w.percent}%
    </span>
  );
}
