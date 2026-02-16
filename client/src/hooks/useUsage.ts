import { useState, useEffect, useCallback } from 'react';
import { usageApi, type DaySummary, type UsageSummary } from '../lib/api';

export function useUsage() {
  const [todaySummary, setTodaySummary] = useState<DaySummary | null>(null);
  const [fullSummary, setFullSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchToday = useCallback(async () => {
    try {
      const data = await usageApi.getToday();
      setTodaySummary(data.summary);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch usage data');
    }
  }, []);

  const fetchFull = useCallback(async () => {
    try {
      setLoading(true);
      const data = await usageApi.getSummary();
      setFullSummary(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch usage summary');
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh today's usage every 30 seconds
  useEffect(() => {
    fetchToday();
    const interval = setInterval(fetchToday, 30000);
    return () => clearInterval(interval);
  }, [fetchToday]);

  return {
    todaySummary,
    fullSummary,
    loading,
    error,
    fetchToday,
    fetchFull,
  };
}
