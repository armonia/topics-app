import { useState, useCallback, useRef } from 'react';

// Forma del checkpoint: `shared/types.ts` (la scrive `server/routes/checkpoints.ts`).
export type { Checkpoint } from '../../../shared/types';
import type { Checkpoint } from '../../../shared/types';
import type { RestoreBlockerCode, RestorePlan, RestoreVerdict } from '../../../shared/checkpoint-plan';
import type { CheckpointPreflight } from '../components/Chat/checkpointPlan';

const API_BASE = '/api';

/**
 * A restore the server refused (409): the plan travels with the error so the
 * caller can name the blocker in the user's language instead of showing the
 * server's English sentence.
 */
export class RestoreRefusedError extends Error {
  constructor(message: string, readonly blockedBy: RestoreBlockerCode | undefined, readonly plan: RestorePlan | undefined) {
    super(message);
    this.name = 'RestoreRefusedError';
  }
}

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
    let payload: { error?: string; plan?: RestorePlan; blockedBy?: RestoreBlockerCode } | null = null;
    try { payload = JSON.parse(text); } catch { /* not JSON: the text is the message */ }
    if (response.status === 409 && payload?.plan) {
      throw new RestoreRefusedError(payload.error || response.statusText, payload.blockedBy, payload.plan);
    }
    throw new Error(payload?.error || text || response.statusText);
  }
  return response.json();
}

/** What the manual rollback answers on success. */
export interface CheckpointRollbackWire extends RestoreVerdict {
  ok: true;
  messageCount: number;
  removed: number;
  plan: RestorePlan;
  /** The files outcome, `null` when nothing on disk was touched. */
  files: { restored: number; removed: number; branch: string | null; skipped: RestorePlan['skipped'] } | null;
}

export interface RollbackResult {
  ok: boolean;
  /** Something the user should read after a success, or the failure text. */
  warning?: string;
  /** The blocker the server refused on, for the caller to translate. */
  blockedBy?: RestoreBlockerCode;
  outcome?: CheckpointRollbackWire;
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
      setPlans({});
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
      if (topicIdRef.current === id) {
        setCheckpoints(prev => [...prev, data.checkpoint]);
        setPlans({});
      }
      return data.checkpoint;
    } catch (err) {
      if (topicIdRef.current === id) setError(err instanceof Error ? err.message : 'Failed to create checkpoint');
      return null;
    }
  }, [topicId]);

  // The preflight per checkpoint, cached so a hover asks once. The cache is
  // dropped whenever the list changes (load, create, rollback): a plan
  // describes the worktree against a checkpoint, and a rollback moves the
  // worktree.
  const [plans, setPlans] = useState<Record<number, CheckpointPreflight>>({});
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const inflight = useRef<Map<number, Promise<CheckpointPreflight | null>>>(new Map());

  const fetchPlan = useCallback(async (idx: number): Promise<CheckpointPreflight | null> => {
    const id = topicId;
    const cached = plansRef.current[idx];
    if (cached) return cached;
    const pending = inflight.current.get(idx);
    if (pending) return pending;
    const p = (async () => {
      try {
        const data = await checkpointRequest<CheckpointPreflight>(`/topics/${id}/checkpoints/${idx}/plan`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (topicIdRef.current === id) setPlans(prev => ({ ...prev, [idx]: data }));
        return data;
      } catch {
        // A preflight that fails is not a lock: the button stays enabled and
        // the server still refuses on its own at rollback time.
        return null;
      } finally {
        inflight.current.delete(idx);
      }
    })();
    inflight.current.set(idx, p);
    return p;
  }, [topicId]);

  const rollback = useCallback(async (idx: number): Promise<RollbackResult> => {
    const id = topicId;
    setError(null);
    try {
      const data = await checkpointRequest<CheckpointRollbackWire>(`/topics/${id}/checkpoints/${idx}/rollback`, {
        method: 'POST',
      });
      if (topicIdRef.current === id) {
        setCheckpoints(prev => prev.slice(0, idx + 1));
        setPlans({});
      }
      return { ok: true, outcome: data };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rollback failed';
      if (topicIdRef.current === id) {
        setError(message);
        setPlans({});
      }
      return { ok: false, warning: message, blockedBy: err instanceof RestoreRefusedError ? err.blockedBy : undefined };
    }
  }, [topicId]);

  return { checkpoints, loading, error, load, create, rollback, fetchPlan, plans };
}

/** The automatic per-turn checkpoint, as it comes off the wire. */
export interface TurnCheckpointWire {
  commit: string;
  seq: number;
  label: string;
  createdAt: string;
}

export interface TurnRestoreWire extends RestoreVerdict {
  ok: true;
  checkpoint: TurnCheckpointWire;
  plan: RestorePlan;
  restored: number;
  removed: number;
  branch: string | null;
  /** Always false. Files come back; the conversation does not, and the caller
   *  is expected to SAY so rather than let the user assume otherwise. */
  conversationRewound: false;
  /** Paths somebody else changed since the turn: left alone, and named. */
  skipped: RestorePlan['skipped'];
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

