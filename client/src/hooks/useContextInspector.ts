import { useState, useCallback, useEffect } from 'react';
import { contextAnalysisApi, type ContextAnalysis } from '../lib/api';
import type { WSMessage } from '../types';

/**
 * Lightweight hook that fetches budgetPercent for multiple topics.
 * Returns a Record<paneId, percent> suitable for PaneTabBar's contextPercent prop.
 */
export function useMultiContextPercent(
  paneToTopicId: Record<string, string>,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): Record<string, number> {
  const [percents, setPercents] = useState<Record<string, number>>({});

  // Stable serialization for dependency tracking
  const key = Object.entries(paneToTopicId).map(([p, t]) => `${p}:${t}`).sort().join(',');

  const fetchAll = useCallback(async () => {
    const entries = Object.entries(paneToTopicId);
    if (!entries.length) return;
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
    setPercents(results);
  }, [key]);

  useEffect(() => {
    fetchAll();
    // Reduced from 30s to 60s — WS events trigger immediate refresh
    const interval = setInterval(fetchAll, 60000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Listen for WS events that indicate context may have changed
  useEffect(() => {
    if (!onMessage) return;
    const topicIds = new Set(Object.values(paneToTopicId));
    const unsub = onMessage((msg: WSMessage) => {
      if (
        (msg.type === 'stream:end' && topicIds.has(msg.topicId)) ||
        (msg.type === 'topic:updated' && topicIds.has(msg.topic?.id))
      ) {
        // Debounce slightly to avoid fetching mid-update
        setTimeout(fetchAll, 500);
      }
    });
    return unsub;
  }, [onMessage, key, fetchAll]);

  return percents;
}

export function useContextInspector(
  topicId: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
) {
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

  // Listen for WS events that indicate context may have changed
  useEffect(() => {
    if (!onMessage || !topicId) return;
    const unsub = onMessage((msg: WSMessage) => {
      if (
        (msg.type === 'stream:end' && msg.topicId === topicId) ||
        (msg.type === 'topic:updated' && msg.topic?.id === topicId)
      ) {
        setTimeout(load, 500);
      }
    });
    return unsub;
  }, [onMessage, topicId, load]);

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
