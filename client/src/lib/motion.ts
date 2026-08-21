/**
 * motion.ts — le DURATE e le CURVE dell'app, in un posto solo.
 *
 * PERCHE' ESISTE. Prima di questo file il movimento era scritto una volta per
 * punto: 0.15s qui, 200ms là, `ease-out` in un keyframe e
 * `cubic-bezier(0.4, 0, 0.2, 1)` in quello accanto. Nessuno di quei numeri era
 * sbagliato da solo; insieme non facevano un sistema, e si vedeva: due cose che
 * succedono per lo stesso motivo (una card che si sposta, una riga che le fa
 * spazio) si muovevano a velocita' diverse, quindi sembravano due meccanismi.
 *
 * LE QUATTRO DURATE, e cosa distingue una dall'altra. Non sono una scala
 * geometrica scelta a tavolino: sono i quattro compiti che il movimento fa in
 * questa app.
 *  · `instant` (90ms) — un riscontro sotto il dito: uno stato :active, un chip
 *    che si accende. Piu' lungo si sente come ritardo.
 *  · `fast` (150ms) — qualcosa appare o sparisce sul posto: un popover, una
 *    dissolvenza, uno scheletro che lascia il posto al contenuto.
 *  · `base` (240ms) — qualcosa ATTRAVERSA dello spazio restando piccolo: una
 *    riga che scorre in su perche' un'altra le ha fatto spazio.
 *  · `slow` (400ms) — un viaggio vero, da una parte all'altra dello schermo: la
 *    card che cambia colonna. Sotto i 300 l'occhio non riesce a seguirla e
 *    torna a essere un salto; sopra i 450 si aspetta.
 *
 * LE CURVE. `standard` e' una decelerazione pura (parte subito, si posa senza
 * spigolo) e vale per tutto cio' che ARRIVA da qualche parte; `exit` e' la sua
 * gemella al contrario, per cio' che se ne va (accelera e sparisce, non ha
 * bisogno di posarsi); `spring` ha una coda lunghissima ed e' quella dei
 * pannelli che scorrono, gia' usata dal dock del composer.
 *
 * REGOLA UNICA DI QUESTO FILE: i numeri non si copiano, si importano. La stessa
 * tabella vive anche come custom property CSS in `index.css` (`--motion-fast` e
 * compagnia) perche' un keyframe non puo' importare un modulo TS, e
 * `motion.test.ts` confronta le due copie riga per riga: se qui cambia un
 * numero e la' no, il test diventa rosso.
 */

import { prefersReducedMotion } from './reducedMotion';

/** Le quattro durate, in millisecondi. */
export const MOTION = {
  instant: 90,
  fast: 150,
  base: 240,
  slow: 400,
} as const;

/** Le tre curve. Stringhe pronte per `animation-timing-function` e per WAAPI. */
export const EASE = {
  /** Arriva: parte subito, si posa con pendenza zero. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** Se ne va: parte piano e accelera fuori, non deve posarsi da nessuna parte. */
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  /** Scorre: coda lunga, la stessa del dock del composer. */
  spring: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;

/**
 * Anima un elemento, oppure NON lo anima e basta.
 *
 * Il ramo che conta e' il secondo: con `prefers-reduced-motion` attivo questa
 * funzione torna `null` senza toccare l'elemento. Chi chiama non deve
 * ricordarsi di chiederlo, e soprattutto non deve avere un ramo "senza
 * animazione" da tenere allineato: lo stato finale e' gia' quello che il DOM ha
 * adesso, quindi non animare significa esattamente "e' gia' arrivato".
 *
 * Torna `null` anche dove `Element.animate` non esiste (i test in node, un
 * browser vecchio): stessa conseguenza, nessun ramo in piu'.
 */
export function animateEl(
  el: Element,
  keyframes: Keyframe[],
  opts: { duration: number; easing?: string; delay?: number; fill?: FillMode },
): Animation | null {
  if (prefersReducedMotion()) return null;
  if (typeof (el as HTMLElement).animate !== 'function') return null;
  return (el as HTMLElement).animate(keyframes, {
    duration: opts.duration,
    easing: opts.easing ?? EASE.standard,
    delay: opts.delay ?? 0,
    fill: opts.fill ?? 'none',
  });
}
