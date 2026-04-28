/**
 * useProvidersSnapshot — thin React wrapper over the shared providers
 * snapshot store. The store owns the single HTTP fetch + WS subscription;
 * this hook just observes.
 *
 * All consumers (picker, settings, OpenClaw availability gate) share the same
 * store, so first paint produces exactly one `/api/providers/snapshot` request
 * regardless of how many hooks are mounted.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProvidersSnapshot } from '../types';
import {
  getProvidersSnapshot,
  refreshProvidersSnapshot,
  subscribeProvidersSnapshot,
} from '../lib/providersSnapshotStore';

interface UseProvidersSnapshotResult {
  snapshot: ProvidersSnapshot | null;
  /** True until the first snapshot lands (HTTP or WS, whichever wins). */
  loading: boolean;
  /** Force the server to re-probe (single provider when name supplied). */
  refresh: (name?: string) => Promise<void>;
}

export function useProvidersSnapshot(): UseProvidersSnapshotResult {
  const [snapshot, setSnapshot] = useState<ProvidersSnapshot | null>(getProvidersSnapshot());

  useEffect(() => {
    const unsub = subscribeProvidersSnapshot((next) => setSnapshot(next));
    return unsub;
  }, []);

  const refresh = useCallback(async (name?: string) => {
    await refreshProvidersSnapshot(name);
  }, []);

  return { snapshot, loading: snapshot === null, refresh };
}
