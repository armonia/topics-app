/**
 * THE PROVIDER IS NOT WORTH CALLING UNTIL `untilMs`.
 *
 * Mirror of `server/lib/provider-hold.ts`: the plan's usage window is spent
 * and the server has stopped starting turns until the published reset. The
 * server announces it on every change (`provider:hold`) and again on every
 * connect, so a reload lands on the same banner. Nulls lift it.
 */
import { useSyncExternalStore } from 'react';
import { subscribeFrames } from '../lib/wsFrameBus';

export interface ProviderHold {
  untilMs: number;
  window: 'five_hour' | 'seven_day';
  sinceMs: number;
}

let current: ProviderHold | null = null;
const listeners = new Set<() => void>();
let wired = false;
let expiry: ReturnType<typeof setTimeout> | null = null;

function announce(): void {
  for (const cb of listeners) cb();
}

/**
 * Expiry is an EVENT, not something read while rendering.
 *
 * The deadline passing is a change of state that nothing else announces: the
 * server sends no frame for it. Reading the clock during render looked like it
 * covered that, but it only answered correctly on the renders that happened to
 * occur after `untilMs` - so the banner outlived its own deadline until some
 * unrelated re-render knocked it down. Arming a timer makes the store drop the
 * hold when it actually expires and tell its listeners, which keeps the read
 * pure and the banner honest.
 */
function armExpiry(): void {
  if (expiry !== null) {
    clearTimeout(expiry);
    expiry = null;
  }
  if (!current) return;
  const left = current.untilMs - Date.now();
  if (left <= 0) {
    current = null;
    return;
  }
  expiry = setTimeout(() => {
    expiry = null;
    current = null;
    announce();
  }, left);
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
  // A hold that arrives already past its deadline is adopted as nothing at all.
  armExpiry();
  announce();
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

/**
 * Test seam: the snapshot a mounted component would read, without React.
 *
 * `useProviderHold` is `useSyncExternalStore` over `subscribe` and this value
 * and nothing else, so reading it here is reading exactly what the banner sees.
 */
export const _readForTests = (): ProviderHold | null => current;

/** Test seam: subscribe as the hook does, to watch the store announce a change. */
export const _subscribeForTests = subscribe;

/** Test seam: drop any hold and its timer, so one test cannot leak into the next. */
export function _resetForTests(): void {
  if (expiry !== null) {
    clearTimeout(expiry);
    expiry = null;
  }
  current = null;
}
