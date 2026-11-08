/**
 * HOW FULL THE PLAN'S WINDOW IS, which is not the same as "it is spent".
 *
 * `providerHold.ts` next door carries the wall: nothing starts until `untilMs`.
 * This carries the reading on the way there — the percentage the CLI publishes
 * on every turn (`provider:usage`) — so the status bar can say "five-hour
 * window at 82%, reset at 20:49" while everything is still working. On a
 * subscription that is the number that matters: the constraint is not the
 * dollar, it is the window.
 *
 * Same shape as its sibling on purpose, including the expiry rule of USAGE-20:
 * a window past its reset is not news the server sends, so the store drops it
 * on a timer instead of asking the clock while rendering.
 */
import { useSyncExternalStore } from 'react';
import { subscribeFrames } from '../lib/wsFrameBus';

import type { PlanUsage, PlanUsageWindow } from '../../../shared/provider-hold';
export type { PlanUsage };

let current: PlanUsage | null = null;
const listeners = new Set<() => void>();
let wired = false;
let expiry: ReturnType<typeof setTimeout> | null = null;

function announce(): void {
  for (const cb of listeners) cb();
}

/** A window past its own reset stops being a reading. */
function live(w: PlanUsageWindow | null): PlanUsageWindow | null {
  if (!w) return null;
  if (w.resetsAtMs != null && w.resetsAtMs <= Date.now()) return null;
  return w;
}

/** Drop the windows that have already reset; null once nothing is left. */
function prune(usage: PlanUsage | null): PlanUsage | null {
  if (!usage) return null;
  const fiveHour = live(usage.fiveHour);
  const sevenDay = live(usage.sevenDay);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, observedAtMs: usage.observedAtMs };
}

/**
 * Expiry is an EVENT, exactly as for the hold: the server sends no frame for a
 * window turning over, and reading the clock during render only answers on the
 * renders that happen to come after it. The timer is armed on the EARLIEST of
 * the two resets, because the five-hour one goes first and dropping it changes
 * what the bar says even while the week's window is still there.
 */
function armExpiry(): void {
  if (expiry !== null) {
    clearTimeout(expiry);
    expiry = null;
  }
  if (!current) return;
  const deadlines = [current.fiveHour?.resetsAtMs, current.sevenDay?.resetsAtMs]
    .filter((t): t is number => typeof t === 'number');
  if (deadlines.length === 0) return;
  const left = Math.min(...deadlines) - Date.now();
  if (left <= 0) {
    current = prune(current);
    return;
  }
  expiry = setTimeout(() => {
    expiry = null;
    current = prune(current);
    announce();
    armExpiry();
  }, left);
}

function readWindow(raw: unknown): PlanUsageWindow | null {
  const w = raw as { utilization?: unknown; resetsAtMs?: unknown } | null;
  if (!w || typeof w.utilization !== 'number') return null;
  return { utilization: w.utilization, resetsAtMs: typeof w.resetsAtMs === 'number' ? w.resetsAtMs : null };
}

function adopt(frame: unknown): void {
  const f = frame as { type?: string; fiveHour?: unknown; sevenDay?: unknown; observedAtMs?: unknown } | null;
  if (!f || f.type !== 'provider:usage') return;
  const fiveHour = readWindow(f.fiveHour);
  const sevenDay = readWindow(f.sevenDay);
  current = prune(
    fiveHour || sevenDay
      ? { fiveHour, sevenDay, observedAtMs: typeof f.observedAtMs === 'number' ? f.observedAtMs : Date.now() }
      : null,
  );
  armExpiry();
  announce();
}

function wire(): void {
  if (wired) return;
  wired = true;
  subscribeFrames(adopt, { types: ['provider:usage'] });
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The reading in force, or null. Windows past their reset read as null. */
export function usePlanUsage(): PlanUsage | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Test seam: feed a frame as the socket would. */
export const _adoptForTests = adopt;

/** Test seam: the snapshot a mounted component would read, without React. */
export const _readForTests = (): PlanUsage | null => current;

/** Test seam: subscribe as the hook does, to watch the store announce a change. */
export const _subscribeForTests = subscribe;

/** Test seam: drop the reading and its timer, so one test cannot leak into the next. */
export function _resetForTests(): void {
  if (expiry !== null) {
    clearTimeout(expiry);
    expiry = null;
  }
  current = null;
}
