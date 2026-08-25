/**
 * @covers FPS-01
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getFps, requestActive, subscribe } from './fpsMonitor';

/**
 * Il monitor FPS è la sonda che l'utente guarda per decidere se l'app va bene:
 * se il numero mente, ogni diagnosi che ci si appoggia parte storta. Qui il loop
 * viene pilotato con un rAF finto a cadenza nota, così si può verificare che
 *
 *  1. il numero riportato sia il frame rate VERO (niente +1 da off-by-one),
 *  2. a riposo il loop DORMA davvero fra una raffica e l'altra — è tutto il
 *     punto di non contare i frame a tempo pieno,
 *  3. in modalità attiva finestre consecutive non perdano un frame al cambio.
 */

const HZ = 60;
const FRAME_MS = 1000 / HZ;

let now = 0;
let pendingRaf: FrameRequestCallback | null = null;
let pendingTimeout: (() => void) | null = null;
let rafSeq = 0;
let docFocused = true;

const real = {
  raf: globalThis.requestAnimationFrame,
  cancelRaf: globalThis.cancelAnimationFrame,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  document: (globalThis as { document?: unknown }).document,
  window: (globalThis as { window?: unknown }).window,
};

/** Avanza il tempo di un frame e consegna il callback in coda, se c'è. */
function frame(dt = FRAME_MS) {
  now += dt;
  const cb = pendingRaf;
  pendingRaf = null;
  cb?.(now);
}

/** Consegna il timer della pausa idle (senza far passare tempo simulato). */
function fireIdleTimer() {
  const fn = pendingTimeout;
  pendingTimeout = null;
  fn?.();
}

beforeEach(() => {
  now = 0;
  pendingRaf = null;
  pendingTimeout = null;
  rafSeq = 0;
  docFocused = true;
  // `hasFocus` matters: the loop parks when the window is visible but NOT
  // focused (another app in front), which `hidden` alone never reports.
  (globalThis as { document?: unknown }).document = {
    hidden: false,
    hasFocus: () => docFocused,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // startLoop also subscribes to window blur/focus — the events that fire in
  // exactly the state visibilitychange stays silent for.
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    pendingRaf = cb;
    return ++rafSeq;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    pendingRaf = null;
  }) as typeof cancelAnimationFrame;
  globalThis.setTimeout = ((fn: () => void) => {
    pendingTimeout = fn;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {
    pendingTimeout = null;
  }) as unknown as typeof clearTimeout;
});

afterEach(() => {
  globalThis.requestAnimationFrame = real.raf;
  globalThis.cancelAnimationFrame = real.cancelRaf;
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  (globalThis as { document?: unknown }).document = real.document;
  (globalThis as { window?: unknown }).window = real.window;
});

/** Fa girare il loop finché non arriva un campione (o si esaurisce la pazienza). */
function runUntilSample(samples: number[], maxFrames = 600) {
  const before = samples.length;
  for (let i = 0; i < maxFrames && samples.length === before; i++) frame();
  return samples.length > before;
}

describe('fpsMonitor', () => {
  it('riporta il frame rate vero, non n+1', () => {
    const seen: number[] = [];
    const stop = subscribe(() => seen.push(now));
    expect(runUntilSample(seen)).toBe(true);

    // A 60Hz esatti il numero deve essere 60. Col vecchio conteggio (che contava
    // anche il frame d'origine) su 400ms sarebbero stati 25/400ms → 63.
    expect(getFps()).toBe(HZ);
    // Prima raffica chiusa al primo frame oltre i 400ms: 24 intervalli.
    expect(seen[0]).toBeGreaterThanOrEqual(400);
    expect(seen[0]).toBeLessThan(400 + FRAME_MS * 2);
    stop();
  });

  it('a riposo dorme fra una raffica e l\'altra invece di contare a tempo pieno', () => {
    const seen: number[] = [];
    const stop = subscribe(() => seen.push(now));
    expect(runUntilSample(seen)).toBe(true);

    // Chiusa la finestra, NIENTE rAF in coda: c'è solo il timer della pausa.
    expect(pendingRaf).toBeNull();
    expect(pendingTimeout).not.toBeNull();

    // Alla sveglia riparte una nuova raffica, non un contatore continuo.
    fireIdleTimer();
    expect(pendingRaf).not.toBeNull();
    stop();
  });

  it('smontato l\'ultimo subscriber non resta nulla in coda', () => {
    const stop = subscribe(() => {});
    expect(pendingRaf).not.toBeNull();
    stop();
    expect(pendingRaf).toBeNull();
    expect(pendingTimeout).toBeNull();
  });

  it('non misura se la finestra è visibile ma NON a fuoco', () => {
    // Lo stato che `document.hidden` non racconta: l'app è a schermo, dietro
    // un'altra. Prima il loop continuava a chiedere frame per un numero che
    // nessuno stava leggendo, trascinandosi dietro tutta la pipeline di
    // updateRendering.
    docFocused = false;
    const stop = subscribe(() => {});
    expect(pendingRaf).toBeNull();
    expect(pendingTimeout).toBeNull();
    stop();
  });

  it('senza document.hasFocus continua a misurare invece di spegnersi in silenzio', () => {
    // Fail-open: in un embedder che non espone l'API, un monitor muto sarebbe
    // peggio di uno che misura di troppo.
    const doc = (globalThis as unknown as { document: Record<string, unknown> }).document;
    delete doc.hasFocus;
    const stop = subscribe(() => {});
    expect(pendingRaf).not.toBeNull();
    stop();
  });

  it('in modalità attiva le finestre si concatenano senza pause', () => {
    const release = requestActive();
    const seen: number[] = [];
    const stop = subscribe(() => seen.push(now));

    expect(runUntilSample(seen)).toBe(true);
    // Finestra attiva: 1s, non 400ms.
    expect(seen[0]).toBeGreaterThanOrEqual(1000);
    expect(seen[0]).toBeLessThan(1000 + FRAME_MS * 2);
    // Nessuna pausa: il frame successivo è già in coda.
    expect(pendingRaf).not.toBeNull();
    expect(pendingTimeout).toBeNull();

    // La seconda finestra dura quanto la prima: il frame di confine fa da
    // terminatore E da origine, quindi non se ne perde uno per giro.
    expect(runUntilSample(seen)).toBe(true);
    const secondWindow = seen[1]! - seen[0]!;
    expect(secondWindow).toBeGreaterThanOrEqual(1000);
    expect(secondWindow).toBeLessThan(1000 + FRAME_MS * 2);

    release();
    stop();
  });
});
