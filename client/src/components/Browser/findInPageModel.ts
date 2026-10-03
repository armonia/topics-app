/**
 * Il contatore «n/m» della barra Trova, senza React intorno.
 *
 * `window.find` (l'unico find-in-page che una WKWebView espone da dentro la
 * pagina) non restituisce niente di utile: sposta la selezione e torna un
 * booleano. Non dice quante corrispondenze ci sono e non dice su quale sei. Il
 * totale lo conta `countMatches` camminando il testo della pagina; l'INDICE non
 * ha nessuna sorgente, quindi lo tiene il client, e allora è qui che può
 * sbagliare in silenzio: fuori scala, senza ciclo, o con un «0/12» che non si
 * corregge più. Sta in una funzione pura per la stessa ragione delle regole di
 * `downloadsModel.ts`, e si testa senza montare una webview nativa.
 *
 * Contratto:
 *  - l'indice è 1-based, come il testo che l'utente legge. `0` = nessuna
 *    posizione ancora, cioè la barra ha un totale ma nessun ⏎ è stato premuto;
 *  - CICLA in entrambi i versi, come `window.find(…, wrap=true)`: dopo m si
 *    torna a 1, e indietro da 1 si va a m. Il ciclo del client e quello di
 *    WebKit devono essere lo stesso, altrimenti il numero mostrato e la
 *    corrispondenza evidenziata divergono al primo giro completo;
 *  - da fermo (indice 0) il primo passo avanti è 1 e il primo passo indietro è
 *    m: è dove atterra `window.find` partendo da una selezione vuota;
 *  - zero risultati = `0/0`, e nessun passo può portare l'indice sopra lo zero.
 */

/** Il prossimo indice, 1-based e ciclico. `total <= 0` resta 0: senza
 *  corrispondenze non esiste una posizione, e mostrarne una sarebbe inventata.
 *
 *  Un indice FUORI SCALA riparte dal bordo verso cui si sta andando invece di
 *  essere corretto di uno: succede quando la pagina cambia sotto la barra (m
 *  era 12, un re-render lo porta a 3) e da 12 il passo avanti deve tornare a 1,
 *  non a 13. */
export function stepMatchIndex(current: number, total: number, forward: boolean): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const t = Math.floor(total);
  const raw = Number.isFinite(current) ? Math.floor(current) : 0;
  const at = raw >= 1 && raw <= t ? raw : 0;
  if (at === 0) return forward ? 1 : t;
  if (forward) return at === t ? 1 : at + 1;
  return at === 1 ? t : at - 1;
}

/** The counter's two numbers, the index always brought inside the total: the
 *  bar must not say «14 of 12» even for one frame after the count dropped. */
export function clampMatchCounter(index: number, total: number): { index: number; total: number } {
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const raw = Number.isFinite(index) ? Math.floor(index) : 0;
  const i = t === 0 ? 0 : Math.max(0, Math.min(t, raw));
  return { index: i, total: t };
}

/** «3/12», e «0/0» quando non c'è niente da trovare. L'indice viene sempre
 *  riportato dentro il totale: la barra non deve poter dire «14/12» nemmeno per
 *  un giro, se il conteggio è appena scesso. */
export function formatMatchCounter(index: number, total: number): string {
  const c = clampMatchCounter(index, total);
  return `${c.index}/${c.total}`;
}

/** What the find bar shows (FIND-01): «3 di 12» / «3 of 12» from the i18n key
 *  `find.counter`, and «oltre 1000» / «over 1000» (`find.counter.over`) when
 *  the engine stopped counting positions past its limit. */
export function formatFindCounter(
  index: number,
  total: number,
  tr: (key: string, vars?: Record<string, string | number>) => string,
  overLimit: number | null = null,
): string {
  if (overLimit !== null && overLimit > 0) return tr('find.counter.over', { n: overLimit });
  const c = clampMatchCounter(index, total);
  return tr('find.counter', { i: c.index, t: c.total });
}
