import { useState, useCallback, useEffect } from 'react';
import { openclawContextApi, type OpenClawContextResponse } from '../lib/api';

export function useOpenClawContext() {
  const [data, setData] = useState<OpenClawContextResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await openclawContextApi.getAll();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load OpenClaw context');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Refresh every 60s — these files change infrequently
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  const readFile = useCallback(async (path: string) => {
    try {
      return await openclawContextApi.readFile(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
      return null;
    }
  }, []);

  return {
    data,
    loading,
    error,
    reload: load,
    readFile,
  };
}
