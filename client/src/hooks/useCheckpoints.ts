import { useState, useCallback, useRef } from 'react';

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

  // Staleness guard: the hosting panel is not remounted per topic, so an
  // async op begun on topic A can resolve after a switch to B — its setState
  // would then mutate B's list (e.g. rollback's truncation slicing B's
  // checkpoints at A's index, leaving a corrupted list until re-navigation).
  // Server calls stay correct (topicId is closed over per-call); only the
  // LOCAL state writes must be gated on "still the same topic".
  const topicIdRef = useRef(topicId);
  topicIdRef.current = topicId;

  const load = useCallback(async () => {
    const id = topicId;
    setLoading(true);
    setError(null);
    try {
      const data = await checkpointRequest<{ checkpoints: Checkpoint[] }>(`/topics/${id}/checkpoints`);
      if (topicIdRef.current !== id) return;
      setCheckpoints(data.checkpoints || []);
    } catch (err) {
      if (topicIdRef.current !== id) return;
      setError(err instanceof Error ? err.message : 'Failed to load checkpoints');
    } finally {
      if (topicIdRef.current === id) setLoading(false);
    }
  }, [topicId]);

  const create = useCallback(async (description?: string) => {
    const id = topicId;
    setError(null);
    try {
      const data = await checkpointRequest<{ checkpoint: Checkpoint }>(`/topics/${id}/checkpoints`, {
        method: 'POST',
        body: JSON.stringify({ description }),
      });
      if (topicIdRef.current === id) setCheckpoints(prev => [...prev, data.checkpoint]);
      return data.checkpoint;
    } catch (err) {
      if (topicIdRef.current === id) setError(err instanceof Error ? err.message : 'Failed to create checkpoint');
      return null;
    }
  }, [topicId]);

  const rollback = useCallback(async (idx: number): Promise<{ ok: boolean; warning?: string }> => {
    const id = topicId;
    setError(null);
    try {
      const data = await checkpointRequest<{ git?: { warning?: string } }>(`/topics/${id}/checkpoints/${idx}/rollback`, {
        method: 'POST',
      });
      if (topicIdRef.current === id) setCheckpoints(prev => prev.slice(0, idx + 1));
      return { ok: true, warning: data.git?.warning };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rollback failed';
      if (topicIdRef.current === id) setError(message);
      return { ok: false, warning: message };
    }
  }, [topicId]);

  return { checkpoints, loading, error, load, create, rollback };
}
