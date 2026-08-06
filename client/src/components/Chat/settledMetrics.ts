/**
 * Quando si vedono i numeri di un'azione FINITA.
 *
 * Vive in un modulo suo, non dentro `ToolCallRow`: sono due costanti, e un file
 * di componenti che esporta anche costanti spegne il fast refresh di Vite —
 * ogni salvataggio su quel file rimonterebbe l'albero invece di aggiornarlo in
 * posto (`react-refresh/only-export-components`). Il posto giusto di una
 * costante condivisa fra due componenti è fuori da entrambi.
 */

/**
 * Un puntatore c'è davvero? Stessa prova che usano `MessageBubble` e
 * `TopicItem` — su un touch il passaggio del mouse non esiste, e nascondere
 * qualcosa dietro di esso vuol dire nasconderlo per sempre.
 */
const isTouchDevice = typeof window !== 'undefined' && (
  'ontouchstart' in window || navigator.maxTouchPoints > 0
);

/**
 * I NUMERI A CONSUNTIVO si mostrano quando li cerchi.
 *
 * Durata e costo di un'azione FINITA non sono il contenuto della riga: sono
 * una nota a margine che, ripetuta su ogni riga di ogni turno, disegna una
 * colonna di cifre lungo tutta la chat e toglie peso all'unica cosa che si
 * legge davvero — che cosa ha fatto l'agente. Restano al loro posto (lo spazio
 * è riservato: niente riga che salta al passaggio del mouse) e compaiono
 * sull'hover della riga, o quando ci arrivi da tastiera.
 *
 * Vale solo per il CONSUNTIVO. Ciò che è vivo — il cronometro mentre l'azione
 * gira, la rotella, il cerchietto ambra dell'attesa — non si nasconde mai: è
 * segnale, non archivio.
 *
 * Su touch niente hover: lì i numeri restano come sono sempre stati.
 */
export const SETTLED_METRIC_CLASS = isTouchDevice
  ? ''
  : 'opacity-0 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100 transition-opacity';

/**
 * Lo stesso patto per la riga di riepilogo di un GRUPPO di azioni.
 *
 * Gruppo suo, non `/tool`: il gruppo contiene le righe singole, e con un nome
 * solo il passaggio del mouse su una riga interna accenderebbe anche i numeri
 * del riepilogo sopra. I due nomi vanno scritti per esteso — Tailwind legge le
 * classi nel sorgente, e una composta a runtime non verrebbe mai generata.
 */
export const SETTLED_GROUP_METRIC_CLASS = isTouchDevice
  ? ''
  : 'opacity-0 group-hover/toolgroup:opacity-100 group-focus-within/toolgroup:opacity-100 transition-opacity';
