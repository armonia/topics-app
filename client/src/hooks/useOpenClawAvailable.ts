import { useEffect, useState } from 'react';
import { providersApi } from '../lib/api';

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;
const subscribers = new Set<(v: boolean) => void>();

async function probe(): Promise<boolean> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await providersApi.diagnoseAll(false);
      const oc = (data.providers ?? []).find((p) => p.name === 'openclaw');
      // "unavailable" = not configured (no GATEWAY_URL/TOKEN). Hide UI.
      // "ready" / "error" / "loading" = configured (even if currently down) — keep UI.
      const available = !!oc && oc.status !== 'unavailable';
      cached = available;
      subscribers.forEach((cb) => cb(available));
      return available;
    } catch {
      cached = false;
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Returns whether the OpenClaw provider is configured (regardless of current
 * online state). Used to gate OpenClaw-specific UI surfaces (Agents, Cron Jobs,
 * gateway status bar) so they don't show up in standalone setups.
 */
export function useOpenClawAvailable(): boolean {
  const [available, setAvailable] = useState<boolean>(cached ?? false);

  useEffect(() => {
    if (cached !== null) setAvailable(cached);
    else probe();
    const cb = (v: boolean) => setAvailable(v);
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }, []);

  return available;
}

export function refreshOpenClawAvailability(): void {
  cached = null;
  void probe();
}
