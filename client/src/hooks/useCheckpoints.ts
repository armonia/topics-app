import { useState, useCallback } from 'react';

export interface Checkpoint {
  idx: number;
  messageCount: number;
  timestamp: string;
  description: string;
  gitHash?: string;
  gitBranch?: string;
}

const API_BASE = '/api';

async function checkpointRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

export function useCheckpoints(topicId: string) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await checkpointRequest<{ checkpoints: Checkpoint[] }>(`/topics/${topicId}/checkpoints`);
      setCheckpoints(data.checkpoints || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load checkpoints');
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  const create = useCallback(async (description?: string) => {
    setError(null);
    try {
      const data = await checkpointRequest<{ checkpoint: Checkpoint }>(`/topics/${topicId}/checkpoints`, {
        method: 'POST',
        body: JSON.stringify({ description }),
      });
      setCheckpoints(prev => [...prev, data.checkpoint]);
      return data.checkpoint;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create checkpoint');
      return null;
    }
  }, [topicId]);

  const rollback = useCallback(async (idx: number): Promise<{ ok: boolean; warning?: string }> => {
    setError(null);
    try {
      const data = await checkpointRequest<{ git?: { warning?: string } }>(`/topics/${topicId}/checkpoints/${idx}/rollback`, {
        method: 'POST',
      });
      setCheckpoints(prev => prev.slice(0, idx + 1));
      return { ok: true, warning: data.git?.warning };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rollback failed';
      setError(message);
      return { ok: false, warning: message };
    }
  }, [topicId]);

  return { checkpoints, loading, error, load, create, rollback };
}
