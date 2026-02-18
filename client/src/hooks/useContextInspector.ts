import { useState, useCallback, useEffect, useRef } from 'react';
import { contextAnalysisApi, type ContextAnalysis } from '../lib/api';

/**
 * Lightweight hook that fetches budgetPercent for multiple topics.
 * Returns a Record<paneId, percent> suitable for PaneTabBar's contextPercent prop.
 */
export function useMultiContextPercent(
  paneToTopicId: Record<string, string>,
): Record<string, number> {
  const [percents, setPercents] = useState<Record<string, number>>({});

  // Stable serialization for dependency tracking
  const key = Object.entries(paneToTopicId).map(([p, t]) => `${p}:${t}`).sort().join(',');

  useEffect(() => {
    const entries = Object.entries(paneToTopicId);
    if (!entries.length) return;

    let cancelled = false;

    async function fetchAll() {
      const results: Record<string, number> = {};
      await Promise.all(
        entries.map(async ([paneId, topicId]) => {
          try {
            const analysis = await contextAnalysisApi.analyze(topicId);
            results[paneId] = analysis.budgetPercent || 0;
          } catch {
            results[paneId] = 0;
          }
        }),
      );
      if (!cancelled) setPercents(results);
    }

    fetchAll();

    // Refresh every 30 seconds
    const interval = setInterval(fetchAll, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [key]);

  return percents;
}

export function useContextInspector(topicId: string | null) {
  const [analysis, setAnalysis] = useState<ContextAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!topicId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await contextAnalysisApi.analyze(topicId);
      setAnalysis(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze context');
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    sources: analysis?.sources || [],
    totalTokens: analysis?.totalTokens || 0,
    budgetLimit: analysis?.budgetLimit || 200000,
    budgetPercent: analysis?.budgetPercent || 0,
    warnings: analysis?.warnings || [],
    loading,
    error,
    reload: load,
  };
}
