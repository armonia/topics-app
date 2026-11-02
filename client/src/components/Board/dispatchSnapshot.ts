import { useSyncExternalStore } from 'react';
import { req } from '../../lib/board';
import type { DispatchMemoryQueueSnapshot } from '../../../../shared/board';

// ── the memory-queue snapshot: ONE read every 15 s for every surface ──
let snap: DispatchMemoryQueueSnapshot | null = null;
/** When the last good read arrived: without it, the live dot would be a promise. */
let snapAt = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function loadSnapshot() {
  req<DispatchMemoryQueueSnapshot>('/dispatch/memory-queue').then(
    (s) => { snap = s; snapAt = Date.now(); listeners.forEach((l) => l()); },
    () => { /* without a dispatcher the dashboard shows capacity only */ },
  );
}
function subscribeSnapshot(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) { loadSnapshot(); timer = setInterval(loadSnapshot, 15_000); }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}
/** The read is live if it arrived within the last two rounds (15 s each) plus margin. */
export const snapshotIsLive = (now: number) => snap !== null && now - snapAt < 45_000;
export function useMemoryQueueSnapshot(): DispatchMemoryQueueSnapshot | null {
  return useSyncExternalStore(subscribeSnapshot, () => snap, () => null);
}

