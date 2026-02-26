import { useState, useEffect, useCallback, useRef } from 'react';
import { dashboardApi, type DashboardKPIs, type TimeSeriesPoint, type AgentStat } from '../lib/api';

const REFRESH_INTERVAL_MS = 15_000;

export function useDashboard() {
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  const [agentStats, setAgentStats] = useState<AgentStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState('throughput');
  const [range, setRange] = useState('7d');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const [kpiData, tsData, agentData] = await Promise.all([
        dashboardApi.getKPIs(),
        dashboardApi.getTimeSeries(selectedMetric, range),
        dashboardApi.getAgentStats(),
      ]);
      if (!mountedRef.current) return;
      setKpis(kpiData);
      setTimeSeries(tsData);
      setAgentStats(agentData);
      setError(null);
    } catch (err: any) {
      if (!mountedRef.current) return;
      console.error('[Dashboard] Fetch error:', err);
      setError(err.message || 'Failed to load dashboard data');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedMetric, range]);

  // Initial load + refresh
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    fetchAll();

    intervalRef.current = setInterval(fetchAll, REFRESH_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchAll]);

  return {
    kpis,
    timeSeries,
    agentStats,
    loading,
    error,
    selectedMetric,
    setSelectedMetric,
    range,
    setRange,
  };
}
