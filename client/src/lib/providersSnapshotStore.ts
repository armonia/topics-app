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

export interface SnapshotState {
  snapshot: ProvidersSnapshot | null;
  /**
   * Error from the most recent fetch attempt, if any. Cleared as soon as a
   * fresh snapshot arrives (via HTTP or WS push). Consumers use this to show
   * a retry affordance when first-paint fetch fails — without it, the picker
   * would loop on `loading` forever and the user would only get out by full
   * page reload.
   */
  error: Error | null;
}

type Listener = (state: SnapshotState) => void;

let snapshot: ProvidersSnapshot | null = null;
let lastError: Error | null = null;
let inflight: Promise<ProvidersSnapshot | null> | null = null;
const listeners = new Set<Listener>();
let wireUp: (() => void) | null = null;

function publish(): void {
  const state: SnapshotState = { snapshot, error: lastError };
  listeners.forEach((cb) => cb(state));
}

function ensureWired(): void {
  if (wireUp) return;
  const unsubFrames = subscribeFrames(
    (frame) => {
      if (!frame || typeof frame !== 'object') return;
      const f = frame as { type?: string; snapshot?: unknown };
      if (f.type !== 'providers:snapshot') return;
      if (!isProvidersSnapshot(f.snapshot)) return;
      // A WS push resets any prior fetch error — by definition we now have
      // a fresh server-authoritative snapshot.
      snapshot = f.snapshot;
      lastError = null;
      publish();
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
      snapshot = next;
      lastError = null;
      publish();
      return next;
    } catch (err) {
      // Surface the failure so the UI can stop spinning forever and offer a
      // retry. Keep the previous `snapshot` value (may be null on first
      // paint) so consumers can still render an empty state alongside the
      // error banner.
      lastError = err instanceof Error ? err : new Error(String(err));
      publish();
      return snapshot;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getProvidersSnapshotState(): SnapshotState {
  return { snapshot, error: lastError };
}

export function subscribeProvidersSnapshot(cb: Listener): () => void {
  ensureWired();
  listeners.add(cb);
  // Kick off initial fetch on first subscriber if we don't have a value yet.
  // On a previous error, allow the next subscribe to retry.
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
 * Force re-fetch from the server. Serve quando un consumatore vuole un valore
 * prima del prossimo push WS, ed è la via di retry quando la fetch precedente
 * è fallita.
 */
export async function reloadProvidersSnapshot(): Promise<ProvidersSnapshot | null> {
  return fetchOnce({ force: true });
}
