import type { ContextSource } from '../../lib/api';

const CATEGORY_COLORS: Record<string, string> = {
  openclaw: '#3b82f6',   // blue
  memory: '#8b5cf6',     // purple
  prompt: '#f59e0b',     // amber
  template: '#22c55e',   // green
  file: '#ef4444',       // red
  pinned: '#06b6d4',     // cyan
};

interface ContextBudgetBarProps {
  sources: ContextSource[];
  totalTokens: number;
  budgetLimit: number;
  budgetPercent: number;
}

export function ContextBudgetBar({ sources, totalTokens, budgetLimit, budgetPercent }: ContextBudgetBarProps) {
  const isCritical = budgetPercent > 90;
  const isWarning = budgetPercent > 70;

  const enabledSources = sources.filter(s => s.enabled && s.tokens > 0 && s.countInBudget);

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  return (
    <div data-testid="context-budget-bar" className="px-4 py-3 border-b border-app-border">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12px] font-medium text-app-text">Context Budget</span>
        <span data-testid="budget-percent" className={`text-[12px] font-semibold tabular-nums ${isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-app-text-secondary'}`}>
          {formatTokens(totalTokens)} / {formatTokens(budgetLimit)} ({budgetLimit > 0 ? budgetPercent : 0}%)
        </span>
      </div>
      {/* Stacked bar */}
      <div className="h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden flex">
        {enabledSources.map(source => {
          const widthPercent = budgetLimit > 0 ? (source.tokens / budgetLimit) * 100 : 0;
          if (widthPercent < 0.3) return null;
          return (
            <div
              key={source.id}
              className="h-full transition-all duration-300"
              style={{
                width: `${Math.min(widthPercent, 100)}%`,
                backgroundColor: CATEGORY_COLORS[source.category] || '#6b7280',
              }}
              title={`${source.label}: ${formatTokens(source.tokens)} tokens`}
            />
          );
        })}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => {
          const catSources = enabledSources.filter(s => s.category === cat);
          if (catSources.length === 0) return null;
          const catTokens = catSources.reduce((sum, s) => sum + s.tokens, 0);
          return (
            <div key={cat} className="flex items-center gap-1 text-[11px] text-app-text-secondary">
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <span className="capitalize">{cat === 'openclaw' ? 'OpenClaw' : cat}</span>
              <span className="text-app-text-muted">{formatTokens(catTokens)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
