import { useEffect, useSyncExternalStore } from 'react';

// ──────────────────────────────────────────────────────────────────────────
// Shared FPS monitor (singleton).
//
// A naive `requestAnimationFrame` counting loop runs forever at the display
// refresh rate just to count frames — that alone keeps the renderer/compositor
// awake and never lets it idle (it was a measurable chunk of this app's idle
// CPU). So this monitor runs ONE shared loop with two cadences:
//
//   • idle   — measure ~1s, then sleep ~4s. The renderer is free to settle in
//              between, so the status-bar number costs ~80% less than a
//              full-time counter. This is the default.
//   • active — measure continuously and emit ~1Hz. Components opt in via
//              requestActive() (refcounted) — e.g. while the status dropdown is
//              open and the user is actively watching the live FPS history.
//
// Every sample is appended to a bounded ring buffer so the dropdown can draw a
// live sparkline of recent frame rate. One loop, one buffer, shared by every
// subscriber (the status-bar number AND the dropdown read the same data — no
// duplicate rAF loops).
// ──────────────────────────────────────────────────────────────────────────

export interface FpsSample {
  /** epoch ms when the sample was taken */
  t: number;
  fps: number;
}

const MEASURE_MS = 1000;
const IDLE_MS = 4000;
/** ~2 min of history at the 1Hz active cadence — ample for a sparkline. */
const HISTORY_MAX = 120;

let current = 0;
let history: FpsSample[] = [];
let activeRefs = 0;

const listeners = new Set<() => void>();

// rAF loop state
let rafId = 0;
let timeoutId: ReturnType<typeof setTimeout> | undefined;
let frames = 0;
let windowStart = 0;
let running = false;

function emit() {
  for (const l of listeners) l();
}

function pushSample(fps: number) {
  current = fps;
  // Replace the array (not mutate) so useSyncExternalStore sees a new snapshot.
  history = history.length >= HISTORY_MAX
    ? [...history.slice(history.length - HISTORY_MAX + 1), { t: Date.now(), fps }]
    : [...history, { t: Date.now(), fps }];
  emit();
}

function measure(now: number) {
  if (!running) return;
  if (windowStart === 0) windowStart = now;
  frames++;
  const elapsed = now - windowStart;
  if (elapsed >= MEASURE_MS) {
    pushSample(Math.round((frames * 1000) / elapsed));
    frames = 0;
    windowStart = 0;
    if (activeRefs > 0) {
      // Active: keep measuring back-to-back for a live, per-second readout.
      rafId = requestAnimationFrame(measure);
    } else {
      // Idle: let the renderer go quiet, then sample again.
      timeoutId = setTimeout(() => {
        if (running && !document.hidden) rafId = requestAnimationFrame(measure);
      }, IDLE_MS);
    }
    return;
  }
  rafId = requestAnimationFrame(measure);
}

function startLoop() {
  if (running) return;
  running = true;
  frames = 0;
  windowStart = 0;
  if (!document.hidden) rafId = requestAnimationFrame(measure);
  document.addEventListener('visibilitychange', onVisibility);
}

function stopLoop() {
  running = false;
  cancelAnimationFrame(rafId);
  if (timeoutId) clearTimeout(timeoutId);
  timeoutId = undefined;
  document.removeEventListener('visibilitychange', onVisibility);
}

function onVisibility() {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = undefined;
  } else if (running) {
    frames = 0;
    windowStart = 0;
    rafId = requestAnimationFrame(measure);
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) startLoop();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stopLoop();
  };
}

/**
 * Switch the monitor to the continuous (1Hz) cadence for live monitoring.
 * Refcounted — returns a release fn; the monitor reverts to idle bursts once
 * every caller has released. Safe to call before any subscriber exists.
 */
export function requestActive(): () => void {
  activeRefs++;
  // If we were mid-idle-sleep, wake up now so the live view fills in promptly
  // instead of waiting out the remaining idle window.
  if (activeRefs === 1 && running && timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = undefined;
    if (!document.hidden) rafId = requestAnimationFrame(measure);
  }
  return () => {
    if (activeRefs > 0) activeRefs--;
  };
}

// ── React bindings ─────────────────────────────────────────────────────────

/** Current FPS (idle cadence by default). 0 until the first sample lands. */
export function useFps(): number {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Bounded history of recent FPS samples for sparklines. */
export function useFpsHistory(): FpsSample[] {
  return useSyncExternalStore(subscribe, () => history, () => history);
}

/** While `active`, hold the monitor in its continuous live-sampling cadence. */
export function useFpsActive(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return requestActive();
  }, [active]);
}
