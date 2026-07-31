import { useEffect, useState } from 'react';
import type { ProvidersSnapshot } from '../types';
import {
  getProvidersSnapshotState,
  subscribeProvidersSnapshot,
} from '../lib/providersSnapshotStore';

function fromSnapshot(snap: ProvidersSnapshot | null): boolean {
  if (!snap) return false;
  const oc = snap.providers.find((p) => p.name === 'openclaw');
  // "unavailable" = not configured (no GATEWAY_URL/TOKEN). Hide UI.
  // "ready" / "error" / "loading" = configured (even if currently down) — keep UI.
  return !!oc && oc.status !== 'unavailable';
}

/**
 * Returns whether the OpenClaw provider is configured (regardless of current
 * online state). Used to gate OpenClaw-specific UI surfaces (Agents, Cron Jobs,
 * gateway status bar) so they don't show up in standalone setups.
 *
 * Reads from the shared providers snapshot store — same data source as the
 * picker and Settings — so we don't double-fetch on first paint.
 */
export function useOpenClawAvailable(): boolean {
  const [available, setAvailable] = useState<boolean>(() => fromSnapshot(getProvidersSnapshotState().snapshot));

  useEffect(() => {
    const unsub = subscribeProvidersSnapshot((state) => setAvailable(fromSnapshot(state.snapshot)));
    return unsub;
  }, []);

  return available;
}
