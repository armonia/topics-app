/**
 * The usage hub's live data (quotas, Mac, services, waiting items, alerts,
 * gates, automations) as the server pushes it
 * on `hub:live` frames (server/lib/hub-live.ts). No polling here: the first
 * paint reads `GET /api/hub-live`, every change after that arrives on the
 * socket. The snapshot is read again on every socket RE-open (a frame sent
 * while this window was disconnected is lost for good: the server pushes only
 * on change, and an error only once per transition) and after a write of this
 * window (`refreshHubLive`), so neither leaves the window on an old list.
 *
 * A topic carries either `data` or `error`, never both: when the hub stops
 * answering, the old numbers are dropped so nothing shows them as current.
 */
import { subscribeFrames, subscribeReconnect } from '../lib/wsFrameBus';
import { apiFetch } from '../lib/shell/net';

import type { HubLiveTopic, HubLiveEntry } from '../../../shared/hub-live';
export type { HubLiveTopic, HubLiveEntry };

export type HubLiveState = Partial<Record<HubLiveTopic, HubLiveEntry>>;

const TOPICS: readonly HubLiveTopic[] = ['pace', 'mac', 'services', 'attesa', 'alerts', 'gates', 'automations']; // allow-italian: hub topic names

let current: HubLiveState = {};
// Whether ANY topic ever carried data in this window. It tells "the hub is not
// part of this installation" (never read: nothing to show) from "the hub
// stopped answering" (read once: say so).
let everRead = false;
const listeners = new Set<() => void>();
let wired = false;
let seeded = false;

function announce(): void {
  for (const cb of listeners) cb();
}

function isTopic(t: unknown): t is HubLiveTopic {
  return typeof t === 'string' && (TOPICS as readonly string[]).includes(t);
}

function entryOf(raw: { data?: unknown; error?: unknown; at?: unknown }): HubLiveEntry | null {
  if (typeof raw.at !== 'number') return null;
  if (typeof raw.error === 'string') return { error: raw.error, at: raw.at };
  return { data: raw.data, at: raw.at };
}

function adopt(frame: unknown): void {
  const f = frame as { type?: string; topic?: unknown; data?: unknown; error?: unknown; at?: unknown } | null;
  if (!f || f.type !== 'hub:live' || !isTopic(f.topic)) return;
  const entry = entryOf(f);
  if (!entry) return;
  // An older reading never replaces a newer one (the seed can land after a frame).
  const prev = current[f.topic];
  if (prev && prev.at > entry.at) return;
  current = { ...current, [f.topic]: entry };
  if (entry.data !== undefined) everRead = true;
  announce();
}

type SnapshotFetch = (path: string) => Promise<Response>;
let snapshotFetch: SnapshotFetch = apiFetch;

async function seed(fetchImpl: SnapshotFetch = snapshotFetch): Promise<void> {
  try {
    const resp = await fetchImpl('/api/hub-live');
    if (!resp.ok) return;
    const snap = (await resp.json()) as Record<string, { data?: unknown; error?: unknown; at?: unknown }>;
    for (const t of TOPICS) {
      const raw = snap?.[t];
      if (raw) adopt({ type: 'hub:live', topic: t, ...raw });
    }
  } catch {
    // The socket will bring the next reading; a failed seed is not an error state.
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  subscribeFrames(adopt, { types: ['hub:live'] });
  subscribeReconnect(() => { void seed(); });
}

/**
 * Read the snapshot now, after a write this window made (closing a waiting
 * item): the server answers that write only after reading the hub back, so
 * the snapshot already holds the new list even if the socket missed the push.
 */
export function refreshHubLive(): Promise<void> {
  return seed();
}

function subscribe(cb: () => void): () => void {
  wire();
  if (!seeded) {
    seeded = true;
    void seed();
  }
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Test seam: subscribe as a mounted component would, without React. */
export const _subscribeForTests = subscribe;

/** Test seam: feed a frame as the socket would. */
export const _adoptForTests = adopt;

/** Test seam: seed from a stubbed fetch. */
export const _seedForTests = seed;

/** Test seam: the state a mounted component would read, without React. */
export const _readForTests = (): HubLiveState => current;

/** Test seam: where the snapshot is read from (null = the real `apiFetch`). */
export function _setSnapshotFetchForTests(f: SnapshotFetch | null): void {
  snapshotFetch = f ?? apiFetch;
}

/** Test seam: forget everything, so one test cannot leak into the next. */
export function _resetForTests(): void {
  current = {};
  seeded = false;
  everRead = false;
}

/** Test seam: the ever-read flag without React. */
export const _everReadForTests = (): boolean => everRead;
