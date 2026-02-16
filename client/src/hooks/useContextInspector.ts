import { useState, useCallback, useEffect } from 'react';
import { contextAnalysisApi, type ContextAnalysis } from '../lib/api';

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
