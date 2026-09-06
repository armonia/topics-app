import { useDashboard } from '../../hooks/useDashboard';
import { KPICardGrid } from './KPICardGrid';
import { TimeSeriesChart } from './TimeSeriesChart';
import { RangeSelector } from './RangeSelector';
import { RefreshCw, BarChart3 } from 'lucide-react';
import type { WSMessage } from '../../types';

const METRIC_OPTIONS = [
  { value: 'throughput', label: 'Throughput' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
  { value: 'errors', label: 'Errors' },
];

interface DashboardPaneProps {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function DashboardPane({ onMessage }: DashboardPaneProps) {
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
    <div data-testid="dashboard-pane" className="flex-1 flex flex-col min-h-0 overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-app-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-app-text-muted" />
          <span className="text-[13px] font-semibold text-app-text">Dashboard</span>
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
          <span className="text-[11px] text-app-text-muted">Auto-refresh 60s</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* The one banner, whether or not numbers had landed before the failure. */}
        {error && (
          <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-1.5">
            {kpis ? `Refresh failed: ${error}` : error}
          </div>
        )}

        {/* KPI Cards */}
        <KPICardGrid kpis={kpis} />

        {/* Time Series Chart */}
        <div data-testid="dashboard-chart" className="bg-surface border border-app-border rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              {METRIC_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSelectedMetric(opt.value)}
                  className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                    selectedMetric === opt.value
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <RangeSelector value={range} onChange={setRange} />
          </div>
          <TimeSeriesChart points={timeSeries} metric={selectedMetric} height={200} />
        </div>
      </div>
    </div>
  );
}
