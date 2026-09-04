/**
 * THE PROVIDER IS NOT WORTH CALLING UNTIL `untilMs`.
 *
 * Mirror of `server/lib/provider-hold.ts`: the plan's usage window is spent
 * and the server has stopped starting turns until the published reset. The
 * server announces it on every change (`provider:hold`) and again on every
 * connect, so a reload lands on the same banner. Nulls lift it.
 */
import { useSyncExternalStore } from 'react';
import { subscribeFrames } from '@/lib/wsFrameBus';

export interface ProviderHold {
  untilMs: number;
  window: 'five_hour' | 'seven_day';
  sinceMs: number;
}

let current: ProviderHold | null = null;
const listeners = new Set<() => void>();
let wired = false;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The hold lifts by itself at `untilMs`.
 *
 * Reading the clock while rendering would be two bugs in one: it is impure,
 * and nothing re-renders when the deadline passes, so a spent hold would stay
 * on screen until the next frame happened to arrive. The store owns the
 * expiry instead and tells the listeners, exactly as a frame would.
 */
function armExpiry(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  if (!current) return;
  const delay = current.untilMs - Date.now();
  if (delay <= 0) {
    current = null;
    return;
  }
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    current = null;
    for (const cb of listeners) cb();
  }, delay);
}

function adopt(frame: unknown): void {
  const f = frame as { type?: string; untilMs?: number | null; window?: string | null; sinceMs?: number | null } | null;
  if (!f || f.type !== 'provider:hold') return;
  const next: ProviderHold | null =
    typeof f.untilMs === 'number' && (f.window === 'five_hour' || f.window === 'seven_day')
      ? { untilMs: f.untilMs, window: f.window, sinceMs: typeof f.sinceMs === 'number' ? f.sinceMs : Date.now() }
      : null;
  if ((current?.untilMs ?? null) === (next?.untilMs ?? null) && current?.window === next?.window) return;
  current = next;
  armExpiry();
  for (const cb of listeners) cb();
}

function wire(): void {
  if (wired) return;
  wired = true;
  subscribeFrames(adopt, { types: ['provider:hold'] });
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The hold in force, or null. Expired holds read as null without a frame. */
export function useProviderHold(): ProviderHold | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Test seam: feed a frame as the socket would. */
export const _adoptForTests = adopt;
