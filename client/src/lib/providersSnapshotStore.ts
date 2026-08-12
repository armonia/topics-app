/**
 * Module-level store for the providers snapshot. Single source of truth across
 * every hook that needs it (useProvidersSnapshot, useOpenClawAvailable, etc.).
 *
 * Why this exists: with two hooks each running their own `providersApi.snapshot()`
 * on first paint, we observed 2 HTTP fetches per page even though one is enough
 * — the WS push handles every subsequent change. Centralizing means:
 *   - one HTTP fetch on first paint (single-flight)
 *   - one WS subscription (`providers:snapshot` frame bus filter)
 *   - one reconnect-refetch listener
 *   - any number of consumers
 */
import type { ProvidersSnapshot } from '../types';
import { providersApi, isProvidersSnapshot } from './api';
import { subscribeFrames } from './wsFrameBus';

export interface SnapshotState {
  snapshot: ProvidersSnapshot | null;
  /**
   * Error from the most recent fetch attempt, if any. Cleared as soon as a
   * fresh snapshot arrives (via HTTP or WS push). Consumers use this to show
   * a retry affordance when first-paint fetch fails — without it, the picker
   * would loop on `loading` forever and the user would only get out by full
   * page reload.
   */
  error: Error | null;
}

type Listener = (state: SnapshotState) => void;

/**
 * LA COPIA LOCALE — perché un refresh non deve ridisegnare la barra.
 *
 * Da questo snapshot dipende la FORMA di due superfici: il bottone del modello
 * nel composer (l'etichetta «Opus 5» e il badge della finestra di contesto) e la
 * pillola di stato in fondo alla sidebar (`openclawAvailable`). Senza valore
 * iniziale la prima paint disegna il ripiego — «Model», «≈200K», un pallino da
 * 6px — e quando la risposta arriva quei box cambiano LARGHEZZA, spingendo di
 * lato tutto ciò che hanno accanto: misurato al refresh, il bottone di
 * configurazione della sessione saltava di 40px e la pillola di connessione
 * passava da 14×14 a 100×25.
 *
 * La copia locale è un SEME, non un'autorità: la fetch parte lo stesso (vedi
 * `subscribeProvidersSnapshot`) e la sovrascrive appena risponde, così un
 * provider aggiunto o tolto da un'altra finestra non resta appiccicato qui. Se
 * la forma cambia davvero, un piccolo assestamento è corretto — è il ritorno
 * identico a com'era che non deve costare niente.
 */
const CACHE_KEY = 'providers-snapshot-cache';

function readCache(): ProvidersSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Stessa guardia della risposta HTTP: una cache scritta da una versione
    // precedente con un'altra forma non deve entrare nello store.
    return isProvidersSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(next: ProvidersSnapshot): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage pieno: il prossimo boot riparte dalla rete, come prima */
  }
}

let snapshot: ProvidersSnapshot | null = typeof localStorage === 'undefined' ? null : readCache();
/** Il valore che c'è ora viene dalla cache e non ancora dal server? Serve a
 *  `subscribeProvidersSnapshot`, che senza questo flag salterebbe la fetch
 *  iniziale (la sua condizione era `snapshot === null`) e resterebbe per sempre
 *  sulla fotografia del boot precedente. */
let onlyFromCache = snapshot !== null;
let lastError: Error | null = null;
let inflight: Promise<ProvidersSnapshot | null> | null = null;
const listeners = new Set<Listener>();
let wireUp: (() => void) | null = null;

function publish(): void {
  const state: SnapshotState = { snapshot, error: lastError };
  listeners.forEach((cb) => cb(state));
}

/** Un valore autorevole (HTTP o push WS): entra nello store E nella cache. */
function adopt(next: ProvidersSnapshot): void {
  snapshot = next;
  onlyFromCache = false;
  lastError = null;
  writeCache(next);
  publish();
}

function ensureWired(): void {
  if (wireUp) return;
  const unsubFrames = subscribeFrames(
    (frame) => {
      if (!frame || typeof frame !== 'object') return;
      const f = frame as { type?: string; snapshot?: unknown };
      if (f.type !== 'providers:snapshot') return;
      if (!isProvidersSnapshot(f.snapshot)) return;
      // A WS push resets any prior fetch error — by definition we now have
      // a fresh server-authoritative snapshot.
      adopt(f.snapshot);
    },
    { types: ['providers:snapshot'] },
  );
  // Server-side: the WS `open` handler in `server.ts` pushes a fresh
  // `providers:snapshot` frame to every connecting (or reconnecting) client.
  // That covers both first connect and reconnect — we don't need a parallel
  // HTTP refetch on lifecycle events. The WS broadcast IS the resync channel.
  wireUp = () => {
    unsubFrames();
  };
}

async function fetchOnce(opts: { force?: boolean } = {}): Promise<ProvidersSnapshot | null> {
  if (!opts.force && snapshot !== null && !onlyFromCache) return snapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = await providersApi.snapshot();
      adopt(next);
      return next;
    } catch (err) {
      // Surface the failure so the UI can stop spinning forever and offer a
      // retry. Keep the previous `snapshot` value (may be null on first
      // paint) so consumers can still render an empty state alongside the
      // error banner.
      lastError = err instanceof Error ? err : new Error(String(err));
      publish();
      return snapshot;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getProvidersSnapshotState(): SnapshotState {
  return { snapshot, error: lastError };
}

export function subscribeProvidersSnapshot(cb: Listener): () => void {
  ensureWired();
  listeners.add(cb);
  // Kick off initial fetch on first subscriber if we don't have an
  // AUTHORITATIVE value yet — un seme dalla cache locale non conta, o il boot
  // successivo resterebbe sulla fotografia del precedente per sempre.
  // On a previous error, allow the next subscribe to retry.
  if ((snapshot === null || onlyFromCache) && !inflight) void fetchOnce();
  return () => {
    listeners.delete(cb);
  };
}

export async function refreshProvidersSnapshot(name?: string): Promise<void> {
  // Server broadcasts on completion → publish is driven by the WS frame.
  await providersApi.refreshSnapshot(name);
}

/**
 * Force re-fetch from the server. Serve quando un consumatore vuole un valore
 * prima del prossimo push WS, ed è la via di retry quando la fetch precedente
 * è fallita.
 */
export async function reloadProvidersSnapshot(): Promise<ProvidersSnapshot | null> {
  return fetchOnce({ force: true });
}
