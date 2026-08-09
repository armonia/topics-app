/**
 * QUANTO È ALTA UNA SEZIONE APERTA della colonna di progetto.
 *
 * Sta fuori da `ProjectSidebar.tsx` per la stessa ragione di
 * `pinnedTileMetrics.ts`: un file che esporta un componente E altro spegne il
 * fast refresh di Vite per quel file — ogni ritocco alla colonna diventerebbe un
 * ricarico pieno invece di uno scambio a caldo.
 */

/** Le sezioni della colonna, in ordine. Il numero serve al tetto qui sotto. */
export const SEZIONI = ['files', 'git', 'processes'] as const;

/**
 * IL TETTO DI UNA SEZIONE IN ALTEZZA AUTOMATICA — `1/N` della colonna.
 *
 * Aperte, Git e Processi prendono l'altezza del loro CONTENUTO, non più un
 * numero fisso. «Fai in modo che gli accordion quando aperti si adattino al
 * contenuto per quanto riguarda l'altezza, fino a un massimo tipo di 1 / numero
 * di accordion» (Attilio, 10/08). Prima erano 200 e 150 px scritti a mano: due
 * file modificati lasciavano ~160px di vuoto sotto, e un repo con quaranta ne
 * mostrava sei.
 *
 * Il tetto non è prudenza: senza, una sezione piena si prende tutto e le altre
 * due diventano intestazioni impilate in fondo — il difetto opposto, con lo
 * stesso effetto (una sola sezione utile per volta). A `1/N`, Files — che è
 * `flex-1` e assorbe il resto — non scende mai sotto un terzo nemmeno con le
 * altre due piene.
 *
 * È una PERCENTUALE, e vuole che il contenitore delle sezioni abbia un'altezza
 * definita: ce l'ha (`flex-1` dentro una colonna a altezza fissa). Senza, una
 * `max-height` in percentuale non si risolve e la sezione crescerebbe senza
 * fermo — il caso che questa funzione esiste per non avere.
 *
 * Derivato dalla lista, non scritto a mano: se le sezioni diventano quattro il
 * tetto scende da sé.
 */
export function capSezione(n: number = SEZIONI.length): string {
  return `calc(100% / ${n})`;
}
