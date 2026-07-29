import { useEffect, useSyncExternalStore } from 'react';
import { isWindowAwake } from '../state/windowAwake';

// ──────────────────────────────────────────────────────────────────────────
// Shared FPS monitor (singleton).
//
// A naive `requestAnimationFrame` counting loop runs forever at the display
// refresh rate just to count frames — that alone keeps the renderer/compositor
// awake and never lets it idle (it was a measurable chunk of this app's idle
// CPU). So this monitor runs ONE shared loop with two cadences:
//
//   • idle   — measure ~0.4s, then sleep ~4s. The renderer is free to settle in
//              between, so the status-bar number costs ~90% less than a
//              full-time counter. This is the default.
//   • active — measure continuously and emit ~1Hz. Components opt in via
//              requestActive() (refcounted) — e.g. while the status dropdown is
//              open and the user is actively watching the live FPS history.
//
// Every sample is appended to a bounded ring buffer so the dropdown can draw a
// live sparkline of recent frame rate. One loop, one buffer, shared by every
// subscriber (the status-bar number AND the dropdown read the same data — no
// duplicate rAF loops).
//
// Perché DUE finestre di misura invece di una (2026-07-28). Il costo di questo
// monitor non è la finestra: è il DUTY CYCLE, cioè quanto tempo tiene sveglio il
// renderer chiedendo frame che nessuno userebbe. A riposo misurare 1s ogni 5
// significa il 20% del tempo a frame pieno — su un pannello a 100Hz sono ~100
// rendering update in ogni ciclo solo per stampare un numero. Ridotta a 0.4s la
// misura resta statisticamente solida (24 frame a 60Hz, 40 a 100Hz) e il duty
// cycle scende all'8%. In modalità ATTIVA il loop gira comunque di continuo, lì
// la finestra non cambia il costo — cambia solo quanto è liscia la sparkline —
// quindi resta a 1s (e la history copre ~2 min come prima).
//
// NOTA: non è un cap sugli FPS, ed è una distinzione voluta. Cappare il frame
// rate dell'app (saltare rAF per stare sotto N fps) nasconderebbe il costo per
// frame invece di toglierlo, desincronizzerebbe dal vsync — su 100Hz un cap a 60
// dà intervalli da 1.67 frame, cioè judder VISIBILE — e non toccherebbe le
// animazioni CSS, che stanno sul compositor. La strada giusta è quella presa
// altrove: non chiedere frame quando non c'è niente da disegnare, e non fare
// layout sincroni dentro quelli che si chiedono.
// ──────────────────────────────────────────────────────────────────────────

export interface FpsSample {
  /** epoch ms when the sample was taken */
  t: number;
  fps: number;
}

/** Idle burst: abbastanza frame per una stima solida, il minimo tempo sveglio. */
const MEASURE_MS_IDLE = 400;
/** Active: il loop gira comunque, la finestra decide solo la cadenza di emissione. */
const MEASURE_MS_ACTIVE = 1000;
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

// INVARIANT: at most ONE pending continuation exists at any time — a single
// rafId XOR a single timeoutId, never two. Two concurrent measure loops would
// each increment `frames` on the same frame and DOUBLE the reported FPS (the
// "200fps when I open the status bar" bug: requestActive used to schedule a
// second loop while one was still running). Every (re)start routes through
// scheduleMeasure(), which cancels whatever is pending first.
function cancelPending() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (timeoutId !== undefined) { clearTimeout(timeoutId); timeoutId = undefined; }
}

/** Is anybody actually looking at this window?
 *
 *  `document.hidden` alone is NOT that question: with the app merely BEHIND
 *  another app — its window still on screen, just not focused — `hidden` is
 *  false, so the monitor kept requesting frames to measure a number nobody was
 *  reading. Each burst drags the whole `updateRendering` pipeline (intersection
 *  and resize observations, style, layout) along with it.
 *
 *  La definizione ora vive in `state/windowAwake.ts`, condivisa con i poll
 *  per-pane (`usePaneWatched`) e con `useAnimationPause`: erano tre copie della
 *  stessa domanda, e tre copie divergono. */
const windowAwake = isWindowAwake;

function scheduleMeasure() {
  cancelPending();
  if (!running || !windowAwake()) return;
  frames = 0;
  windowStart = 0;
  rafId = requestAnimationFrame(measure);
}

function measure(now: number) {
  rafId = 0; // this callback has fired; nothing is pending until we reschedule
  if (!running) return;
  // Il PRIMO callback è l'ORIGINE della finestra, non un frame misurato: fra lui
  // e `windowStart` non è passato nulla. Contarlo (come si faceva prima) gonfia
  // la stima di (n+1)/n — +1fps su una finestra da 1s a 60Hz, e il 6% su una da
  // 400ms. Contando solo gli intervalli, `frames/elapsed` è il frame rate vero e
  // la finestra si può accorciare senza spostare il numero.
  if (windowStart === 0) {
    windowStart = now;
    rafId = requestAnimationFrame(measure);
    return;
  }
  frames++;
  const elapsed = now - windowStart;
  if (elapsed >= (activeRefs > 0 ? MEASURE_MS_ACTIVE : MEASURE_MS_IDLE)) {
    pushSample(Math.round((frames * 1000) / elapsed));
    frames = 0;
    if (activeRefs > 0) {
      // Active: keep measuring back-to-back for a live, per-second readout.
      // Questo stesso frame chiude la finestra ED È l'origine della prossima —
      // così finestre consecutive non perdono un frame ciascuna al cambio.
      windowStart = now;
      rafId = requestAnimationFrame(measure);
    } else {
      windowStart = 0;
      // Idle: let the renderer go quiet, then sample again. Null timeoutId the
      // instant it fires so requestActive can't mistake a fired timer for a
      // sleeping loop and spin up a duplicate.
      timeoutId = setTimeout(() => {
        timeoutId = undefined;
        scheduleMeasure();
      }, IDLE_MS);
    }
    return;
  }
  rafId = requestAnimationFrame(measure);
}

function startLoop() {
  if (running) return;
  running = true;
  document.addEventListener('visibilitychange', onVisibility);
  // blur/focus, not just visibilitychange: an unfocused-but-visible window
  // never fires visibilitychange, which is exactly the state the monitor used
  // to keep measuring through.
  window.addEventListener('blur', onVisibility);
  window.addEventListener('focus', onVisibility);
  scheduleMeasure();
}

function stopLoop() {
  running = false;
  cancelPending();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('blur', onVisibility);
  window.removeEventListener('focus', onVisibility);
}

function onVisibility() {
  if (!windowAwake()) cancelPending();
  else if (running) scheduleMeasure();
}

/**
 * Store primitive: registra un listener e avvia/ferma il loop condiviso. È ciò a
 * cui `useFps`/`useFpsHistory` si agganciano via `useSyncExternalStore`; è
 * esportata anche per poter pilotare il loop nei test senza montare React.
 */
export function subscribe(cb: () => void): () => void {
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
  // If the loop is idling between bursts, wake it now so the live view fills in
  // promptly. scheduleMeasure() cancels any pending timer/frame first, so this
  // cannot create a second concurrent loop even if the idle timer already fired.
  if (activeRefs === 1 && running && timeoutId !== undefined) {
    scheduleMeasure();
  }
  return () => {
    if (activeRefs > 0) activeRefs--;
  };
}

// ── React bindings ─────────────────────────────────────────────────────────

/** Snapshot: ultimo FPS misurato. 0 finché non arriva il primo campione. */
export function getFps(): number {
  return current;
}

/** Snapshot: history limitata dei campioni recenti (stessa identità finché non cambia). */
export function getFpsHistory(): FpsSample[] {
  return history;
}

/** Current FPS (idle cadence by default). 0 until the first sample lands. */
export function useFps(): number {
  return useSyncExternalStore(subscribe, getFps, getFps);
}

/** Bounded history of recent FPS samples for sparklines. */
export function useFpsHistory(): FpsSample[] {
  return useSyncExternalStore(subscribe, getFpsHistory, getFpsHistory);
}

/** While `active`, hold the monitor in its continuous live-sampling cadence. */
export function useFpsActive(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return requestActive();
  }, [active]);
}
