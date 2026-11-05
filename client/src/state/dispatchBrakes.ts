/**
 * WHO THE DISPATCHER KEEPS IN TODO, for the board's «Frenato» chip (HUBBR-20).
 *
 * Read from `GET /api/dispatch/brakes`, which applies the dispatcher's rule on
 * the server: Claude's hold or its five-hour window past the dispatch line,
 * and Codex's hold, which the socket does not announce. So the store reads
 * again on the frames that move Claude's side (`provider:hold`,
 * `provider:usage`), every minute for Codex's, and when the first brake is due
 * to end. It reads only while a board is on screen: the last subscriber that
 * leaves stops the timers.
 */
import { useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';
import { subscribeFrames } from '../lib/wsFrameBus';
import type { DispatchBrake } from '../../../shared/provider-hold';


const POLL_MS = 60_000;
const EMPTY: readonly DispatchBrake[] = [];

let current: readonly DispatchBrake[] = EMPTY;
const listeners = new Set<() => void>();
let poll: ReturnType<typeof setInterval> | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
let unsubscribeFrames: (() => void) | null = null;
let seq = 0;

function announce(): void {
  for (const cb of listeners) cb();
}

function isBrake(raw: unknown): raw is DispatchBrake {
  const b = raw as Partial<DispatchBrake> | null;
  return !!b && (b.provider === 'claude' || b.provider === 'codex') && typeof b.window === 'string'
    && (b.utilization === null || typeof b.utilization === 'number')
    && (b.untilMs === null || typeof b.untilMs === 'number');
}

/** The brakes still in force at `nowMs`: one past its end is dropped without asking the server. */
export function liveBrakes(brakes: readonly DispatchBrake[], nowMs: number): readonly DispatchBrake[] {
  const live = brakes.filter((b) => b.untilMs === null || b.untilMs > nowMs);
  return live.length === brakes.length ? brakes : live;
}

function adopt(next: readonly DispatchBrake[]): void {
  const live = liveBrakes(next, Date.now());
  if (JSON.stringify(live) === JSON.stringify(current)) return;
  current = live.length === 0 ? EMPTY : live;
  armExpiry();
  announce();
}

/** The end of a brake is an event the server sends no frame for: a timer reads again then. */
function armExpiry(): void {
  if (expiry !== null) { clearTimeout(expiry); expiry = null; }
  const ends = current.map((b) => b.untilMs).filter((t): t is number => t !== null);
  if (ends.length === 0 || listeners.size === 0) return;
  expiry = setTimeout(() => { expiry = null; adopt(current); void read(); }, Math.max(0, Math.min(...ends) - Date.now()) + 1_000);
}

async function read(): Promise<void> {
  const mine = ++seq;
  try {
    const res = await apiFetch('/api/dispatch/brakes');
    if (!res.ok) return;
    const body = (await res.json()) as { brakes?: unknown };
    if (mine !== seq) return;
    adopt(Array.isArray(body.brakes) ? body.brakes.filter(isBrake) : EMPTY);
  } catch {
    // A failed read keeps the last answer: the timer still drops a brake past its end.
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    void read();
    poll = setInterval(() => { void read(); }, POLL_MS);
    unsubscribeFrames = subscribeFrames(() => { void read(); }, { types: ['provider:hold', 'provider:usage'] });
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size > 0) return;
    if (poll !== null) { clearInterval(poll); poll = null; }
    if (expiry !== null) { clearTimeout(expiry); expiry = null; }
    unsubscribeFrames?.();
    unsubscribeFrames = null;
  };
}

/** The providers held right now, empty when none is. */
export function useDispatchBrakes(): readonly DispatchBrake[] {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
