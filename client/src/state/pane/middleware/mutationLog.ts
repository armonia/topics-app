export interface MutationLogEntry {
  seq: number;
  ts: number;
  action: unknown;
  meta?: unknown;
}

const RING_SIZE = 2000;
const ring: MutationLogEntry[] = [];
const subscribers = new Set<() => void>();

export function recordAction(entry: MutationLogEntry): void {
  ring.push(entry);
  while (ring.length > RING_SIZE) ring.shift();
  for (const fn of subscribers) fn();
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getRing(): MutationLogEntry[] {
  // Return a fresh array so useSyncExternalStore sees a stable-while-equal
  // snapshot. Returning the live internal array appears to satisfy
  // Object.is-based bailout, but its *contents* mutate under React's feet,
  // which risks tearing in concurrent mode. The ring is bounded at
  // RING_SIZE (2000), so the shallow copy is cheap.
  return ring.slice();
}

export function clearRing(): void {
  ring.length = 0;
}

export const RING_BUFFER_SIZE = RING_SIZE;
