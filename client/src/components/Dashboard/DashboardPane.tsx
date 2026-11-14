import { lazy, Suspense, useState } from 'react';
import { useDashboard } from '../../hooks/useDashboard';
import { useHubEverRead } from '../../state/hubLive';
import { useT } from '../../hooks/useT';
import type { UsageRange } from '../../hooks/useProjectUsage';
import { KPICardGrid } from './KPICardGrid';
import { TimeSeriesChart } from './TimeSeriesChart';
import { RangeSelector } from './RangeSelector';
import { RefreshCw, BarChart3, Coins } from 'lucide-react';
import type { WSMessage } from '../../types';

// The hub's half of «Consumi» and the usage per project: chunks of their own,
// fetched only where they are drawn (HUBBR-12).
const HubUsageSection = lazy(async () => {
  const { HubUsageSection: Section } = await import('./HubUsageSection');
  return { default: Section };
});
const ProjectUsagePanel = lazy(async () => {
  const { ProjectUsagePanel: Panel } = await import('../Sidebar/ProjectUsagePanel');
  return { default: Panel };
});

const METRIC_OPTIONS = ['throughput', 'tokens', 'cost', 'errors'] as const;

interface DashboardPaneProps {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function DashboardPane({ onMessage }: DashboardPaneProps) {
  const tr = useT();
  const hubPresent = useHubEverRead();
  // The usage per project's window outlives a refresh of the numbers: it is the person's choice.
  const [usageRange, setUsageRange] = useState<UsageRange>('all');
  const {
    kpis,
    timeSeries,
    loading,
    error,
    selectedMetric,
    setSelectedMetric,
    range,
    setRange,
  } = useDashboard(onMessage);

  const chartCard = (
    <div data-testid="dashboard-chart" className="bg-surface border border-app-border rounded-lg p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          {METRIC_OPTIONS.map((metric) => (
            <button
              key={metric}
              onClick={() => setSelectedMetric(metric)}
              className={`tap-expand-y px-2 py-0.5 text-mini rounded transition-colors ${
                selectedMetric === metric
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
              }`}
            >
              {tr(`dashboard.metric.${metric}`)}
            </button>
          ))}
        </div>
        <RangeSelector value={range} onChange={setRange} />
      </div>
      <TimeSeriesChart points={timeSeries} metric={selectedMetric} height={200} />
    </div>
  );
  // WHAT EACH PROJECT HAS COST in Topics' own chats and board: it left the
  // System level and lives here, hub or not (HUBBR-12).
  const projectUsage = (
    <section data-testid="dashboard-project-usage" className="bg-surface border border-app-border rounded-lg">
      <div className="flex items-center gap-[7px] border-b border-app-border-subtle px-3 py-[9px]">
        <Coins size={13} className="text-app-text-muted" aria-hidden="true" />
        <h2 className="m-0 flex-1 text-compact font-semibold text-app-text">{tr('usage.perProject')}</h2>
      </div>
      <Suspense fallback={<div className="p-3 text-mini text-app-text-muted">{tr('common.loading')}</div>}>
        <ProjectUsagePanel range={usageRange} onRange={setUsageRange} />
      </Suspense>
    </section>
  );

  // WITH THE HUB the Dashboard is «Consumi»: the hub's sections first, the
  // board's numbers in one compact box, then the two cards above.
  if (hubPresent) {
    return (
      <div data-testid="dashboard-pane" className="scroll-under-chrome flex-1 flex flex-col min-h-0 overflow-auto">
        <Suspense fallback={null}>
          <HubUsageSection kpis={kpis}>
            {chartCard}
            {projectUsage}
          </HubUsageSection>
        </Suspense>
      </div>
    );
  }

  // NO FIRST-LOAD SPINNER, AND NO FULL-PANE ERROR SCREEN.
  //
  // Both used to replace the whole body, so the pane was one small glyph in an
  // empty rectangle until two fetches answered and then grew nine KPI cards and
  // a 200px chart in a single frame. The layout is now always the same layout:
  // the cards draw the dash that `KPICard` already means by "no source", the
  // chart box keeps its height, and the numbers land inside a geometry that
  // never moved. `useDashboard` seeds them from the local snapshot, so on a
  // return they are there on the first frame.
  return (
    <div data-testid="dashboard-pane" className="scroll-under-chrome flex-1 flex flex-col min-h-0 overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-app-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-app-text-muted" />
          <span className="text-prose font-semibold text-app-text">{tr('usage.open')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* The refresh glyph keeps its box when it is not spinning. Mounting
              it only while loading pushed the label sideways every 60 seconds,
              and again on every WS update: a shift the size of an icon,
              repeated for as long as the pane stays open. */}
          <RefreshCw
            size={12}
            aria-hidden={!loading}
            className={`text-app-text-muted ${loading ? 'animate-spin' : 'opacity-0'}`}
          />
          <span className="text-mini text-app-text-muted">{tr('dashboard.autoRefresh')}</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* The one banner, whether or not numbers had landed before the failure. */}
        {error && (
          <div className="text-mini text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-1.5">
            {kpis ? tr('dashboard.refreshFailed', { error }) : error}
          </div>
        )}

        {/* KPI Cards */}
        <KPICardGrid kpis={kpis} />

        {chartCard}
        {projectUsage}
      </div>
    </div>
  );
}
