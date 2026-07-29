import { useSyncExternalStore } from 'react';

/**
 * "C'è qualcuno che sta guardando questa finestra?"
 *
 * `document.hidden` NON è quella domanda. Con l'app semplicemente DIETRO a
 * un'altra — la finestra ancora sullo schermo, solo non a fuoco — `hidden` è
 * falso, e WebKit continua a servire rAF, timer e observer a piena cadenza per
 * un'immagine che nessuno legge. Nel profilo `sample` del 2026-07-28 quel
 * lavoro c'era tutto: 22% del main thread occupato con l'app in secondo piano,
 * di cui il 12% dentro `updateRendering`.
 *
 * È lo stesso predicato che `useAnimationPause` usa per parcheggiare le
 * animazioni CSS, e sta qui perché i due devono restare in passo: se le
 * animazioni si fermano e i poll no, si è solo spostato il costo.
 *
 * Un solo set di listener per tutta l'app, refcontato, che si spegne quando
 * l'ultimo iscritto se ne va — stesso modello di `useSharedNow`, per la stessa
 * ragione: N componenti non devono costare N listener.
 */

/** Il predicato, sincrono. Usabile anche fuori da React. */
export function isWindowAwake(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.hidden) return false;
  // Fail OPEN se l'API non c'è (embedder vecchi, doppioni nei test): un poll che
  // smette di girare in silenzio è peggio di uno che gira di troppo.
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

let awake = isWindowAwake();
const subscribers = new Set<() => void>();
let wired = false;

function recompute(): void {
  const next = isWindowAwake();
  if (next === awake) return;
  awake = next;
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (!wired) {
    wired = true;
    document.addEventListener('visibilitychange', recompute);
    // `blur`/`focus` sulla finestra, non sul documento: è l'unico segnale che
    // distingue "un'altra app è davanti" da "la finestra è minimizzata".
    window.addEventListener('blur', recompute);
    window.addEventListener('focus', recompute);
  }
  // Ri-allinea alla realtà: chi si iscrive adesso deve leggere lo stato di
  // adesso, non quello dell'ultimo evento visto.
  awake = isWindowAwake();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && wired) {
      wired = false;
      document.removeEventListener('visibilitychange', recompute);
      window.removeEventListener('blur', recompute);
      window.removeEventListener('focus', recompute);
    }
  };
}

function getSnapshot(): boolean {
  return awake;
}

/** Ri-renderizza il chiamante quando la finestra passa a fuoco / fuori fuoco. */
export function useWindowAwake(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
