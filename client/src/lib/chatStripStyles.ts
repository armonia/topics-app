/**
 * LE STRISCE SOPRA IL COMPOSER, una geometria sola.
 *
 * Sono cinque cose diverse che dicono «ecco cosa sta per succedere» — l'obiettivo
 * dichiarato, la lista di cose da fare, i sotto-agenti, gli avvisi sul contesto,
 * i messaggi da inviare — e si erano allineate in tre modi diversi: `mx-2` fisso
 * (TodoStrip, GoalBar), `mx-2/mx-3` a seconda della larghezza (gli avvisi, e il
 * composer stesso), più due raggi (`rounded-lg` e `rounded-xl`). Su desktop la
 * differenza è di quattro pixel: abbastanza da vedersi come uno scalino, non
 * abbastanza da sembrare voluto.
 *
 * Qui la geometria è una. `md:` e non una prop `isMobile`: la soglia dell'app è
 * `window.innerWidth < 768`, cioè esattamente il breakpoint `md` di Tailwind, e
 * una classe non va passata di componente in componente per sapere quanto è
 * larga la finestra.
 *
 * Il margine segue il COMPOSER (`m-2` / `m-3`), che è il bordo a cui l'occhio si
 * allinea: le strisce stanno sopra di lui, non sopra la pane.
 */

/** Geometria condivisa: margini, distanza dalla striscia sotto, raggio. */
export const CHAT_STRIP = 'mx-2 md:mx-3 mb-1 rounded-lg';

/**
 * …più la superficie neutra, per le strisce che non hanno un colore proprio.
 * Quelle semantiche (avvisi ambra/rossi, conferme verdi) tengono il loro e
 * prendono solo `CHAT_STRIP`.
 */
export const CHAT_STRIP_NEUTRAL = `${CHAT_STRIP} border border-app-border/60 bg-app-hover/40 text-app-text`;

/** La riga cliccabile che apre/chiude una striscia espandibile. */
export const CHAT_STRIP_ROW = 'flex w-full items-center gap-2 px-2.5 py-1.5 text-left';
