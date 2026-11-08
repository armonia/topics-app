/**
 * Il testo dettato entra AL CURSORE, non in coda.
 *
 * Chi detta a metà di una frase già scritta si aspetta che la voce continui da
 * lì, ed è anche l'unico modo per dettare due volte di seguito senza rimescolare
 * l'ordine: il chiamante rimette il cursore su `caret`, così la seconda
 * dettatura riparte dopo la prima invece di infilarsi davanti.
 *
 * La spaziatura la mette questa funzione perché il motore di trascrizione
 * consegna una frase NUDA, senza spazi ai bordi: incollata addosso alla parola
 * precedente ci si fonderebbe insieme.
 *
 * Vive qui e non dentro un composer perché i composer che dettano sono due (la
 * chat e il campo dei task della board): una seconda copia si sfaserebbe dalla
 * prima al primo ritocco, e sarebbe una differenza che nessuno vede finché non
 * la subisce.
 */
export function insertAtCaret(current: string, at: number, text: string): { next: string; caret: number } {
  // Un cursore fuori scala (campo appena svuotato, indice ricordato da prima)
  // non deve tagliare niente: si stringe ai capi del testo che c'è davvero.
  const pos = Math.max(0, Math.min(at, current.length));
  const before = current.slice(0, pos);
  const after = current.slice(pos);
  const sepBefore = before && !/\s$/.test(before) ? ' ' : '';
  const sepAfter = after && !/^\s/.test(after) ? ' ' : '';
  const head = before + sepBefore + text;
  return { next: head + sepAfter + after, caret: head.length };
}
