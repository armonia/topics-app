import { useDashboard } from '../../hooks/useDashboard';
import { KPICardGrid } from './KPICardGrid';
import { TimeSeriesChart } from './TimeSeriesChart';
import { RangeSelector } from './RangeSelector';
import { AgentLeaderboard } from './AgentLeaderboard';
import { Loader2, RefreshCw, BarChart3 } from 'lucide-react';

const METRIC_OPTIONS = [
  { value: 'throughput', label: 'Throughput' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
  { value: 'errors', label: 'Errors' },
];

interface DashboardPaneProps {
  onMessage?: (handler: (msg: any) => void) => () => void;
}

export function DashboardPane({ onMessage }: DashboardPaneProps) {
  const {
    kpis,
    timeSeries,
    agentStats,
    loading,
    error,
    selectedMetric,
    setSelectedMetric,
    range,
    setRange,
  } = useDashboard(onMessage);

  // First load spinner
  if (loading && !kpis) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-app-text-muted" />
      </div>
    );
  }

  if (error && !kpis) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-[12px]">
        {error}
      </div>
    );
  }

  return (
    <div data-testid="dashboard-pane" className="flex-1 flex flex-col min-h-0 overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-app-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-app-text-muted" />
          <span className="text-[13px] font-semibold text-app-text">Dashboard</span>
        </div>
        <div className="flex items-center gap-1.5">
          {loading && (
            <RefreshCw size={12} className="animate-spin text-app-text-muted" />
          )}
          <span className="text-[10px] text-app-text-muted">Auto-refresh 60s</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* Error banner (shown even after prior successful load) */}
        {error && kpis && (
          <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-1.5">
            Refresh failed: {error}
          </div>
        )}

        {/* KPI Cards */}
        {kpis && <KPICardGrid kpis={kpis} />}

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

        {/* Agent Leaderboard */}
        <div className="bg-surface border border-app-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-app-border">
            <span className="text-[12px] font-semibold text-app-text">Agent Leaderboard</span>
          </div>
          <AgentLeaderboard agents={agentStats} />
        </div>
      </div>
    </div>
  );
}
