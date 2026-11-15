import type { DashboardKPIs } from '../../lib/api';
import { useT } from '../../hooks/useT';
import { KPICard } from './KPICard';
import {
  CalendarClock,
  CalendarCheck,
  Clock,
  Loader,
  AlertTriangle,
  DollarSign,
  Wallet,
  CheckCircle,
  Timer,
} from 'lucide-react';

interface KPICardGridProps {
  /**
   * `null` = the numbers have not landed yet.
   *
   * The grid is drawn anyway, with every card in the "no source" state the
   * KPICard already speaks (a dash). That is not decoration: it is what keeps
   * the pane from being an empty rectangle until two fetches answer, and then
   * growing nine cards and a chart in a single frame. Same grid, same card
   * heights, only the glyphs change when the data lands.
   */
  kpis: DashboardKPIs | null;
}

/**
 * Cosa NON e' dentro il totale di spesa, detto in una riga.
 *
 * I costi anteriori allo scorporo della cache sono gonfiati di un fattore ignoto
 * (la cache riletta veniva tariffata come input fresco, e in un turno agentico e'
 * la quota schiacciante). Sommarli darebbe un numero che non e' ne' il costo vero
 * ne' una stima; escluderli e basta darebbe un numero che sembra completo. Si
 * escludono e si dice quanti.
 */
function uncertainNote(n: number | undefined): string | null {
  if (!n || n <= 0) return null;
  return `${n} messagg${n === 1 ? 'io' : 'i'} non contati: costo registrato prima che la cache fosse misurata, quindi sovrastimato di un fattore che non e' ricostruibile.`;
}

export function KPICardGrid({ kpis }: KPICardGridProps) {
  const tr = useT();
  // Columns follow the pane, not the window: five fixed columns on a 375px
  // phone left each card 60px wide and clipped every value to «$…» and «0.…».
  // Two per row on a phone, three in a narrow pane, five from 48rem up.
  return (
    <div className="@container">
    <div data-testid="kpi-card-grid" className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-5">
      <KPICard
        label={tr('dashboard.kpi.throughputDay')}
        value={kpis ? kpis.throughputDay : null}
        unit={tr('dashboard.unit.tasks')}
        // Fa FAMIGLIA con la card della settimana qui sotto: i due numeri sono
        // la stessa misura su due finestre, quindi il glifo deve dire la
        // finestra. Il lampo che c'era diceva «veloce», che qui non c'entra —
        // ed è il significato che il lampo tiene nel composer del Fast Mode.
        icon={CalendarClock}
        trend={kpis && kpis.throughputDay > 0 ? 'up' : 'flat'}
      />
      <KPICard
        label={tr('dashboard.kpi.throughputWeek')}
        value={kpis ? kpis.throughputWeek : null}
        unit={tr('dashboard.unit.tasks')}
        icon={CalendarCheck}
        trend={kpis && kpis.throughputWeek > 0 ? 'up' : 'flat'}
      />
      <KPICard
        label={tr('dashboard.kpi.cycleTime')}
        value={kpis ? kpis.avgCycleTimeHours : null}
        unit={tr('dashboard.unit.hours')}
        icon={Clock}
        trend={kpis && kpis.avgCycleTimeHours > 0 ? 'down' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label={tr('dashboard.kpi.wip')}
        value={kpis ? kpis.wipCount : null}
        unit={tr('dashboard.unit.tasks')}
        icon={Loader}
        trend={kpis && kpis.wipCount > 0 ? 'up' : 'flat'}
      />
      <KPICard
        label={tr('dashboard.kpi.errorRate')}
        value={kpis ? `${(kpis.errorRate * 100).toFixed(1)}%` : null}
        icon={AlertTriangle}
        trend={kpis && kpis.errorRate > 0.05 ? 'up' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label={tr('dashboard.kpi.spendDay')}
        value={kpis ? `$${kpis.tokenSpendDay.toFixed(2)}` : null}
        icon={DollarSign}
        trend={kpis && kpis.tokenSpendDay > 0 ? 'up' : 'flat'}
        upIsGood={false}
        partialNote={uncertainNote(kpis?.tokenSpendDayUncertain)}
      />
      <KPICard
        label={tr('dashboard.kpi.spendWeek')}
        value={kpis ? `$${kpis.tokenSpendWeek.toFixed(2)}` : null}
        icon={Wallet}
        trend={kpis && kpis.tokenSpendWeek > 0 ? 'up' : 'flat'}
        upIsGood={false}
        partialNote={uncertainNote(kpis?.tokenSpendWeekUncertain)}
      />
      <KPICard
        label={tr('dashboard.kpi.approvalTurnaround')}
        value={kpis ? kpis.approvalTurnaroundHours : null}
        unit={tr('dashboard.unit.hours')}
        icon={Timer}
        trend={kpis && kpis.approvalTurnaroundHours > 0 ? 'down' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label={tr('dashboard.kpi.pendingApprovals')}
        value={kpis ? kpis.pendingApprovals : null}
        icon={CheckCircle}
        trend={kpis && kpis.pendingApprovals > 0 ? 'up' : 'flat'}
        upIsGood={false}
      />
    </div>
    </div>
  );
}
