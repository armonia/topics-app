import { useSyncExternalStore } from 'react';

/**
 * One shared wall-clock for every "elapsed" readout in the app. A single module
 * interval ticks while ≥1 component subscribes and stops the moment the last one
 * unmounts — so N live rows cost ONE timer, not N (cf. the "FPS intermittente"
 * regression from per-item intervals). Granularity is coarse on purpose: the
 * sidebar shows minute-level durations, so a 10s tick is imperceptible and cheap.
 *
 * Only mount a subscriber where an elapsed is actually shown (e.g. gate the
 * subscribing component behind `streaming` so it isn't ticking for idle rows).
 */
const TICK_MS = 10_000;

let now = Date.now();
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function start() {
  if (timer) return;
  timer = setInterval(() => {
    now = Date.now();
    for (const notify of subscribers) notify();
  }, TICK_MS);
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  start();
  // Fresh subscriber: re-baseline `now` so a component mounting mid-interval reads
  // a current-enough value on its first paint rather than one up to TICK_MS stale.
  now = Date.now();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// Cached snapshot (NOT Date.now() per call — useSyncExternalStore requires a stable
// value between ticks or it loops).
function getSnapshot(): number {
  return now;
}

/** Current epoch-ms, re-rendering the caller ~every 10s. */
export function useSharedNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
