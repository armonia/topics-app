/**
 * HOW MANY WORKFLOWS WAIT AT A GATE FOR YOU (HUBBR-13): the tail of the row
 * «Agenti e lavori» in System and the band of the level count them together
 * with the chats waiting on you. The level is a lazy chunk and the row is not,
 * so the number lives here and either side reads the hub's automations into it:
 * the row when System opens and whenever the hub's count of what needs you
 * changes, the level on every read of its own. A hub that does not answer
 * counts zero, never the last number it gave.
 */
import { useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';
import { gateWaitsOf } from '../lib/hubGates';

let count = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function setGateWaits(n: number): void {
  if (n === count) return;
  count = n;
  for (const l of listeners) l();
}

/** Read the hub's automations now and count the gates; one read at a time. */
export function refreshGateWaits(): Promise<void> {
  inFlight ??= apiFetch('/api/hub/automations', { cache: 'no-store' })
    .then(async (r) => { setGateWaits(r.ok ? gateWaitsOf(await r.json()).length : 0); })
    .catch(() => { setGateWaits(0); })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useGateWaits(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => count,
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
