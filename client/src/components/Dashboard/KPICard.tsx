import type { LucideIcon } from 'lucide-react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export type Trend = 'up' | 'down' | 'flat';

interface KPICardProps {
  label: string;
  value: string | number;
  unit?: string;
  icon: LucideIcon;
  trend?: Trend;
  /** Is "up" good for this metric? Default true. Used to color the trend arrow. */
  upIsGood?: boolean;
}

export function KPICard({ label, value, unit, icon: Icon, trend = 'flat', upIsGood = true }: KPICardProps) {
  const trendColor =
    trend === 'flat' ? 'text-app-text-muted'
    : (trend === 'up') === upIsGood ? 'text-emerald-500'
    : 'text-red-500';

  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;

  return (
    <div data-testid="kpi-card" className="bg-surface border border-app-border rounded-lg px-3 py-2.5 flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between">
        <Icon size={14} className="text-app-text-muted flex-shrink-0" />
        <TrendIcon size={12} className={`${trendColor} flex-shrink-0`} />
      </div>
      <div className="flex items-baseline gap-1 min-w-0">
        <span className="text-[18px] font-semibold text-app-text leading-none truncate">
          {value}
        </span>
        {unit && (
          <span className="text-[11px] text-app-text-muted leading-none flex-shrink-0">
            {unit}
          </span>
        )}
      </div>
      <span className="text-[11px] text-app-text-muted leading-tight truncate">
        {label}
      </span>
    </div>
  );
}
