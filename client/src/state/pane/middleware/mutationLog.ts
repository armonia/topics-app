export interface MutationLogEntry {
  seq: number;
  ts: number;
  action: unknown;
  meta?: unknown;
}

const RING_SIZE = 2000;
const ring: MutationLogEntry[] = [];
const subscribers = new Set<() => void>();

// Cached shallow copy handed to useSyncExternalStore. Invalidated on every
// mutation; getRing() rebuilds lazily. The cache is what makes the snapshot
// stable-while-equal: useSyncExternalStore compares snapshots with Object.is,
// so returning a fresh ring.slice() per call made every render look like a
// store change — "Maximum update depth exceeded" as soon as the dev overlay
// mounted.
let snapshot: MutationLogEntry[] | null = null;

export function recordAction(entry: MutationLogEntry): void {
  ring.push(entry);
  while (ring.length > RING_SIZE) ring.shift();
  snapshot = null;
  for (const fn of subscribers) fn();
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getRing(): MutationLogEntry[] {
  // Shallow copy (not the live array): the ring's contents mutate under
  // React's feet, which risks tearing in concurrent mode. Bounded at
  // RING_SIZE (2000), so the occasional rebuild is cheap; the cache keeps
  // the reference stable between mutations.
  if (!snapshot) snapshot = ring.slice();
  return snapshot;
}

export function clearRing(): void {
  ring.length = 0;
  snapshot = null;
  for (const fn of subscribers) fn();
}

export const RING_BUFFER_SIZE = RING_SIZE;
