import { useState, useCallback, useRef } from 'react';

// Forma del checkpoint: `shared/types.ts` (la scrive `server/routes/checkpoints.ts`).
export type { Checkpoint } from '../../../shared/types';
import type { Checkpoint } from '../../../shared/types';

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

/** The automatic per-turn checkpoint, as it comes off the wire. */
export interface TurnCheckpointWire {
  commit: string;
  seq: number;
  label: string;
  createdAt: string;
}

export interface TurnRestoreWire {
  ok: true;
  checkpoint: TurnCheckpointWire;
  restored: number;
  removed: number;
  branch: string | null;
  /** Always false. Files come back; the conversation does not, and the caller
   *  is expected to SAY so rather than let the user assume otherwise. */
  conversationRewound: false;
}

/** `/rewind`: put the tree back the way it was before the last turn.
 *
 *  Standalone rather than part of `useCheckpoints` because it is a different
 *  list on a different store (git refs, not the JSON file) and the strip above
 *  the composer must not show the two mixed: half of those entries rewind the
 *  conversation and half do not. */
export async function restoreLastTurnCheckpoint(topicId: string): Promise<TurnRestoreWire> {
  return checkpointRequest<TurnRestoreWire>(`/topics/${topicId}/turn-checkpoints/restore`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

