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
  getProvidersSnapshotState,
  refreshProvidersSnapshot,
  reloadProvidersSnapshot,
  subscribeProvidersSnapshot,
} from '../lib/providersSnapshotStore';

interface UseProvidersSnapshotResult {
  snapshot: ProvidersSnapshot | null;
  /** True while waiting for the first snapshot AND no error has been raised. */
  loading: boolean;
  /**
   * Most recent fetch error (cleared by any successful HTTP/WS response).
   * Consumers should expose a retry button when this is set instead of
   * showing an indefinite loading state.
   */
  error: Error | null;
  /** Force the server to re-probe (single provider when name supplied). */
  refresh: (name?: string) => Promise<void>;
  /**
   * Re-run the GET fetch that failed on first paint. Different from `refresh`,
   * which asks the server to re-probe; this just re-fetches whatever the
   * server currently has cached. Use it from a retry button.
   */
  retry: () => Promise<void>;
}

export function useProvidersSnapshot(): UseProvidersSnapshotResult {
  const [state, setState] = useState(getProvidersSnapshotState);

  useEffect(() => {
    const unsub = subscribeProvidersSnapshot(setState);
    return unsub;
  }, []);

  const refresh = useCallback(async (name?: string) => {
    await refreshProvidersSnapshot(name);
  }, []);

  const retry = useCallback(async () => {
    await reloadProvidersSnapshot();
  }, []);

  return {
    snapshot: state.snapshot,
    loading: state.snapshot === null && state.error === null,
    error: state.error,
    refresh,
    retry,
  };
}
