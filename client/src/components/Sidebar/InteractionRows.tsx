import { useEffect, useMemo } from 'react';
import { Gauge } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { refreshTotal, useInteractionTiming } from '@/lib/eventTiming';
import { measureStorageUsage, useStorageDiscards } from '@/lib/storageLedger';
import { SLOW_INTERACTION_MS } from '../../../../shared/interaction-histogram';

/** Past this an interaction is read as a delay, the same ceiling `check:inp-shell` holds the product to. */
const GOOD_MS = 200;

function worstColor(ms: number): string {
  if (ms > GOOD_MS) return 'text-red-500';
  if (ms > 100) return 'text-amber-500';
  return 'text-app-text';
}

/**
 * The rows of the perf panel about the page's own responsiveness: how long the
 * slowest interaction of this session took, the p95 over all of them, and the
 * writes the browser refused. Everything here is a number the page measured on
 * itself since it loaded; `check:inp-shell` is what judges it against a budget.
 */
export function InteractionRows() {
  const tr = useT();
  const timing = useInteractionTiming();
  const discards = useStorageDiscards();
  // The fast interactions only move the total when asked: a panel that just
  // opened divides by a fresh one.
  useEffect(() => { refreshTotal(); }, []);
  const usage = useMemo(() => measureStorageUsage(), [discards]);
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

  const worst = timing.worst;
  const p95 = timing.p95Ms;
  return (
    <div className="space-y-0.5" data-testid="perf-interaction">
      <div className="flex items-center justify-between px-0.5">
        <span className="flex shrink-0 items-center gap-1.5 text-mini text-app-text-muted">
          <Gauge size={12} /> {tr('perf.interaction.heading')}
        </span>
        <span className={`min-w-0 truncate pl-2 text-mini font-medium tabular-nums ${worst ? worstColor(worst.durationMs) : 'text-app-text-muted'}`} data-testid="perf-interaction-worst" title={worst?.target}>
          {!timing.supported ? tr('perf.interaction.unsupported')
            : worst ? tr('perf.interaction.worst', { ms: worst.durationMs, target: worst.target })
            : tr('perf.interaction.none', { ms: SLOW_INTERACTION_MS })}
        </span>
      </div>
      {timing.supported && timing.total > 0 && (
        <div className="px-0.5 text-mini text-app-text-muted tabular-nums" data-testid="perf-interaction-p95">
          {p95 !== null && p95 > SLOW_INTERACTION_MS
            ? tr('perf.interaction.p95', { p95, total: timing.total, slow: timing.slow })
            : tr('perf.interaction.p95Under', { ms: SLOW_INTERACTION_MS, total: timing.total })}
        </div>
      )}
      <div
        className={`px-0.5 text-mini tabular-nums ${discards.userData > 0 ? 'text-red-500' : discards.total > 0 ? 'text-amber-500' : 'text-app-text-muted'}`}
        data-testid="perf-storage"
        title={discards.keys.map((row) => `${row.key}: ${row.quota + row.denied}`).join('\n')}
      >
        {tr('perf.storage.usage', { used: mb(usage.usedBytes), limit: mb(usage.limitBytes) })}
        {discards.total > 0 && ` · ${tr('perf.storage.refused', { n: discards.total })}`}
        {discards.userData > 0 && ` · ${tr('perf.storage.userData', { n: discards.userData })}`}
      </div>
    </div>
  );
}
