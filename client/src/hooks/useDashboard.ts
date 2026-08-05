import { useState, useEffect, useCallback, useRef } from 'react';
import { dashboardApi, type DashboardKPIs, type TimeSeriesPoint } from '../lib/api';
import type { WSMessage } from '../types';

const REFRESH_INTERVAL_MS = 60_000;

export function useDashboard(onMessage?: (handler: (msg: WSMessage) => void) => () => void) {
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState('throughput');
  const [range, setRange] = useState('7d');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const [kpiData, tsData] = await Promise.all([
        dashboardApi.getKPIs(),
        dashboardApi.getTimeSeries(selectedMetric, range),
      ]);
      if (!mountedRef.current) return;
      setKpis(kpiData);
      setTimeSeries(tsData);
      setError(null);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      console.error('[Dashboard] Fetch error:', err);
      setError((err instanceof Error ? err.message : null) || 'Failed to load dashboard data');
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

  // WS subscription for real-time dashboard updates
  useEffect(() => {
    if (!onMessage) return;
    let debounceTimer: ReturnType<typeof setTimeout>;
    const unsub = onMessage((msg: WSMessage) => {
      if (msg.type === 'dashboard:updated' || msg.type === 'cron:updated') {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fetchAll, 500);
      }
    });
    return () => { unsub(); clearTimeout(debounceTimer); };
  }, [onMessage, fetchAll]);

  return {
    kpis,
    timeSeries,
    loading,
    error,
    selectedMetric,
    setSelectedMetric,
    range,
    setRange,
  };
}
