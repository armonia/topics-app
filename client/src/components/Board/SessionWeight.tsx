import { Gauge } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { sessionWeight, type SessionWeightInput } from '../../../../shared/task-countdown';
import { contextLevelInk } from '../../lib/contextLevelInk';
import { fmtTok, fmtUsd } from './format';

/**
 * The exact weight of a session: the provider's own token counts, the share
 * of the model window, the spend and the room left before compaction. A figure
 * the provider did not measure is not drawn (no percent without a context).
 */
export function SessionWeight(props: SessionWeightInput & { locale?: string }) {
  const tr = useT();
  const w = sessionWeight(props);
  if (w.billableTokens <= 0 && w.cacheReadTokens <= 0 && w.usedTokens == null) return null;
  const locale = props.locale ?? 'it-IT';
  const level = contextLevelInk(w.level);
  return (
    <div data-testid="session-weight" className="rounded-lg bg-black/[0.12] px-2.5 py-1.5 text-compact text-app-text-secondary tabular-nums dark:bg-white/[0.16]">
      <div className="flex items-center gap-2">
        <Gauge size={13} aria-hidden="true" className="flex-none" />
        <span className="font-semibold text-app-text-heading">{tr('board.weight.title')}</span>
        {w.percent != null && w.usedTokens != null && (
          <span data-testid="session-weight-context" className={`ml-auto ${level}`}>
            {w.estimated ? '≈ ' : ''}{fmtTok(w.usedTokens)} · {w.percent}%
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{tr('board.weight.tokens', { n: w.billableTokens.toLocaleString(locale) })}</span>
        {w.cacheReadTokens > 0 && <span>{tr('board.weight.cache', { n: fmtTok(w.cacheReadTokens) })}</span>}
        {w.costCents > 0 && <span data-testid="session-weight-cost">{fmtUsd(w.costCents, locale)}</span>}
        {w.untilCompactionTokens != null && <span data-testid="session-weight-compaction">{tr('board.weight.compaction', { n: fmtTok(w.untilCompactionTokens) })}</span>}
        {w.childCount > 0 && <span>{tr('board.weight.children', { n: w.childCount, tok: fmtTok(w.totalBillableTokens), usd: fmtUsd(w.totalCostCents, locale) })}</span>}
      </div>
    </div>
  );
}
