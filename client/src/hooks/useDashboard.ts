import { useState, useEffect, useCallback, useRef } from 'react';
import { dashboardApi, type DashboardKPIs, type TimeSeriesPoint } from '../lib/api';
import { readDashboardSnapshot, writeDashboardSnapshot } from '../lib/dashboardSnapshotCache';
import type { WSMessage } from '../types';

const REFRESH_INTERVAL_MS = 60_000;

/** What the pane shows before anyone has ever opened it. */
const DEFAULT_METRIC = 'throughput';
const DEFAULT_RANGE = '7d';

export function useDashboard(onMessage?: (handler: (msg: WSMessage) => void) => () => void) {
  // Read ONCE, in the initialiser of the first state: a second read after the
  // first fetch has landed would restore stale numbers over fresh ones.
  const seedRef = useRef<ReturnType<typeof readDashboardSnapshot> | undefined>(undefined);
  if (seedRef.current === undefined) seedRef.current = readDashboardSnapshot();
  const seed = seedRef.current;

  const [kpis, setKpis] = useState<DashboardKPIs | null>(seed?.kpis ?? null);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>(seed?.points ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The selection travels with the numbers: a seeded series belongs to the
  // metric and range it was drawn for, and restoring one without the other
  // would label the chart with something it does not show.
  const [selectedMetric, setSelectedMetric] = useState(seed?.metric ?? DEFAULT_METRIC);
  const [range, setRange] = useState(seed?.range ?? DEFAULT_RANGE);
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
      writeDashboardSnapshot({ metric: selectedMetric, range, kpis: kpiData, points: tsData });
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
