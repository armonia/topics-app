/**
 * scrollDelta.ts — di quanto va scorsa una finestra perché una cosa ci entri.
 *
 * Un asse alla volta, e con i numeri di `getBoundingClientRect`: chi chiama
 * decide QUALE contenitore scorre e su quale asse, perché `scrollIntoView()`
 * non lo lascia decidere. Quella risale gli antenati da sola e può uscire dalla
 * preoccupazione di chi l'ha chiamata — sulla board è già costata il drawer
 * intero scrollato via su mobile mentre si voleva muovere solo la riga delle
 * colonne (vedi la nota sull'effetto della selezione in KanbanBoardPane).
 *
 * Il valore torna nell'unità dei rettangoli (px) ed è pronto per `scrollBy`:
 * negativo = indietro (su / a sinistra), positivo = avanti, `0` = c'è già.
 */

/** Un segmento su un asse: `left`/`right` oppure `top`/`bottom` di un rect. */
export interface Span {
  start: number;
  end: number;
}

/**
 * `scrollBy` da applicare al contenitore perché `target` sia dentro `container`.
 *
 * `margin` stacca il bersaglio dal bordo: appoggiato al filo è tecnicamente in
 * vista e sembra tagliato.
 *
 * Bersaglio PIÙ ALTO (o più largo) della finestra: non può starci tutto, quindi
 * si allinea l'INIZIO. Di una card lunga conta il titolo, che sta in cima; il
 * ramo generico avrebbe inquadrato il fondo, cioè l'unica parte che non dice
 * quale card è.
 */
export function scrollDelta(container: Span, target: Span, margin = 0): number {
  const start = container.start + margin;
  const end = container.end - margin;
  if (target.end - target.start >= end - start) return target.start - start;
  if (target.start < start) return target.start - start;
  if (target.end > end) return target.end - end;
  return 0;
}
