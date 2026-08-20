import type { LucideIcon } from 'lucide-react';
import { useT } from '@/hooks/useT';
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
  /**
   * Il valore c'e' ma NON copre tutto: qui va detto cosa manca e perche'.
   *
   * E' il gradino di mezzo fra "misurato" e `value === null` ("nessuna fonte"),
   * e serve perche' esiste: i costi anteriori allo scorporo della cache sono
   * gonfiati di un fattore ignoto, quindi vengono esclusi dal totale — un totale
   * che li includesse non sarebbe ne' il costo vero ne' una sua stima. Escluderli
   * in silenzio pero' rifarebbe lo stesso danno all'incontrario: un numero che
   * sembra completo e non lo e'.
   */
  partialNote?: string | null;
}

export function KPICard({ label, value, unit, icon: Icon, trend = 'flat', upIsGood = true, partialNote }: KPICardProps) {
  const tr = useT();
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
          className={`text-[18px] font-semibold truncate-tight ${missing ? 'text-app-text-muted' : 'text-app-text'}`}
          title={missing ? tr('kpi.noSource') : undefined}
        >
          {missing ? '-' : value}
        </span>
        {unit && !missing && (
          <span className="text-[11px] text-app-text-muted leading-none flex-shrink-0">
            {unit}
          </span>
        )}
      </div>
      <span className="text-[11px] text-app-text-muted leading-tight truncate" title={partialNote || undefined}>
        {label}
        {/* Un asterisco, non una frase: la card e' larga come un pollice. Il
            perche' sta nel tooltip, dove c'e' lo spazio per dirlo davvero. */}
        {partialNote && <span className="text-amber-500 ml-0.5" aria-label={partialNote}>*</span>}
      </span>
    </div>
  );
}
