/**
 * "C'è un modale aperto?" — chiesto al DOM, non a una lista di booleani.
 *
 * Il perché sta in una riga di `useKeyboardShortcuts`: Escape, quando NON c'è
 * nulla da chiudere, interrompe il turno in streaming (SIGINT alla claude-code).
 * La condizione "non c'è nulla da chiudere" era una lista scritta a mano di
 * quattro flag (`showSearch, showNewTopic, showShortcuts, showFileSearch`).
 * Ogni modale nato dopo — Impostazioni, il roster degli agenti, l'editor di
 * profilo, il lightbox delle anteprime — non era in lista: con quello aperto,
 * Escape passava oltre e AMMAZZAVA il turno dell'AI dietro al modale. Un bug
 * che si ripresenta a ogni modale nuovo, perché la lista non si aggiorna da sé.
 *
 * Qui la domanda si fa al DOM: un modale aperto è un nodo aperto, e ogni modale
 * dell'app ne porta già il marcatore — `.native-occlude` (dentro `MODAL_PANEL`,
 * lib/modalStyles) o `role="dialog"`. Nessun registro da tenere allineato:
 * un modale futuro è coperto dal giorno zero, purché usi lo stile condiviso o
 * il ruolo ARIA che gli spetta comunque.
 *
 * DELIBERATAMENTE più stretto di `OVERLAY_SELECTOR` (lib/shell/browserOcclusion),
 * che include anche `.glass-surface`, `[role="menu"]`, `[role="listbox"]`: quelli
 * sono menu e popover, e hanno già il LORO Escape (`useDismissable`, che ferma la
 * propagazione in capture). Trattarli da modale qui vorrebbe dire che un tooltip
 * a schermo disarma l'interruzione del turno — l'errore opposto.
 */

/** Il minimo che serve per decidere: un nodo è "aperto" se disegna qualcosa.
 *  Duck-typed apposta, così la regola si testa senza montare un DOM. */
export interface ModalSurfaceNode {
  getClientRects(): { length: number };
}

export interface ModalSurfaceRoot {
  querySelectorAll(selector: string): ArrayLike<ModalSurfaceNode>;
}

/** I due marcatori che ogni modale dell'app porta già addosso.
 *  Esportato perché il test possa verificare che `MODAL_PANEL` lo soddisfi
 *  ancora: è quel legame — non un commento — a tenere in piedi la regola. */
export const MODAL_SURFACE_SELECTOR = '.native-occlude, [role="dialog"]';

/**
 * C'è almeno un modale VISIBILE nel documento?
 *
 * "Visibile" = ha almeno un rettangolo di layout. Un modale smontato non è nel
 * DOM; uno in `display:none` (pattern usato da chi tiene il nodo montato per
 * conservare lo stato) non ha rettangoli, e non deve contare — altrimenti
 * basterebbe averlo aperto una volta per disarmare Escape per sempre.
 */
export function hasOpenModalSurface(root: ModalSurfaceRoot = document): boolean {
  const nodes = root.querySelectorAll(MODAL_SURFACE_SELECTOR);
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getClientRects().length > 0) return true;
  }
  return false;
}
