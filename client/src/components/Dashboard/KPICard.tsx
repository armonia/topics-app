import type { LucideIcon } from 'lucide-react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export type Trend = 'up' | 'down' | 'flat';

interface KPICardProps {
  label: string;
  /**
   * `null` = dato NON DISPONIBILE, disegnato come "—".
   *
   * Diverso da 0, e la differenza conta: un cruscotto che mostra "0%" dove non
   * ha una fonte sta affermando un fatto ("nessun errore", "agenti fermi") che
   * non ha misurato.
   */
  value: string | number | null;
  unit?: string;
  icon: LucideIcon;
  trend?: Trend;
  /** Is "up" good for this metric? Default true. Used to color the trend arrow. */
  upIsGood?: boolean;
}

export function KPICard({ label, value, unit, icon: Icon, trend = 'flat', upIsGood = true }: KPICardProps) {
  const missing = value === null;
  const trendColor =
    trend === 'flat' ? 'text-app-text-muted'
    : (trend === 'up') === upIsGood ? 'text-emerald-500'
    : 'text-red-500';

  const TrendIcon = missing ? Minus : trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;

  return (
    <div data-testid="kpi-card" className="bg-surface border border-app-border rounded-lg px-3 py-2.5 flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between">
        <Icon size={14} className="text-app-text-muted flex-shrink-0" />
        <TrendIcon size={12} className={`${trendColor} flex-shrink-0`} />
      </div>
      <div className="flex items-baseline gap-1 min-w-0">
        <span
          className={`text-[18px] font-semibold leading-none truncate ${missing ? 'text-app-text-muted' : 'text-app-text'}`}
          title={missing ? 'Dato non disponibile: nessuna fonte per questa metrica' : undefined}
        >
          {missing ? '—' : value}
        </span>
        {unit && !missing && (
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
