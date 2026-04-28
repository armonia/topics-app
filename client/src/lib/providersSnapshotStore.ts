/**
 * Module-level store for the providers snapshot. Single source of truth across
 * every hook that needs it (useProvidersSnapshot, useOpenClawAvailable, etc.).
 *
 * Why this exists: with two hooks each running their own `providersApi.snapshot()`
 * on first paint, we observed 2 HTTP fetches per page even though one is enough
 * — the WS push handles every subsequent change. Centralizing means:
 *   - one HTTP fetch on first paint (single-flight)
 *   - one WS subscription (`providers:snapshot` frame bus filter)
 *   - one reconnect-refetch listener
 *   - any number of consumers
 */
import type { ProvidersSnapshot } from '../types';
import { providersApi, isProvidersSnapshot } from './api';
import { subscribeFrames } from './wsFrameBus';

type Listener = (snap: ProvidersSnapshot | null) => void;

let snapshot: ProvidersSnapshot | null = null;
let inflight: Promise<ProvidersSnapshot | null> | null = null;
const listeners = new Set<Listener>();
let wireUp: (() => void) | null = null;

function publish(next: ProvidersSnapshot | null): void {
  snapshot = next;
  listeners.forEach((cb) => cb(next));
}

function ensureWired(): void {
  if (wireUp) return;
  const unsubFrames = subscribeFrames(
    (frame) => {
      if (!frame || typeof frame !== 'object') return;
      const f = frame as { type?: string; snapshot?: unknown };
      if (f.type !== 'providers:snapshot') return;
      if (!isProvidersSnapshot(f.snapshot)) return;
      publish(f.snapshot);
    },
    { types: ['providers:snapshot'] },
  );
  // Server-side: the WS `open` handler in `server.ts` pushes a fresh
  // `providers:snapshot` frame to every connecting (or reconnecting) client.
  // That covers both first connect and reconnect — we don't need a parallel
  // HTTP refetch on lifecycle events. The WS broadcast IS the resync channel.
  wireUp = () => {
    unsubFrames();
  };
}

async function fetchOnce(opts: { force?: boolean } = {}): Promise<ProvidersSnapshot | null> {
  if (!opts.force && snapshot !== null) return snapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = await providersApi.snapshot();
      publish(next);
      return next;
    } catch {
      return snapshot;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getProvidersSnapshot(): ProvidersSnapshot | null {
  return snapshot;
}

export function subscribeProvidersSnapshot(cb: Listener): () => void {
  ensureWired();
  listeners.add(cb);
  // Kick off initial fetch on first subscriber if we don't have a value yet.
  if (snapshot === null && !inflight) void fetchOnce();
  return () => {
    listeners.delete(cb);
  };
}

export async function refreshProvidersSnapshot(name?: string): Promise<void> {
  // Server broadcasts on completion → publish is driven by the WS frame.
  await providersApi.refreshSnapshot(name);
}

/**
 * Force re-fetch from the server. Used when a consumer (e.g. legacy
 * `refreshOpenClawAvailability`) wants a value sooner than the next WS push.
 */
export async function reloadProvidersSnapshot(): Promise<ProvidersSnapshot | null> {
  return fetchOnce({ force: true });
}
