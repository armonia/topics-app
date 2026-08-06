/**
 * Chi si sta trascinando, ADESSO, dentro questa finestra.
 *
 * ── Perché non basta il `dataTransfer` ──────────────────────────────────────
 * Durante `dragover` il browser espone i TIPI ma non i DATI: `getData()` torna
 * stringa vuota fino al `drop`. È una regola di privacy (una pagina non deve
 * poter leggere un file trascinato solo perché ci passi sopra), e non si
 * aggira. La conseguenza pratica è che chi riceve non può sapere COSA sta per
 * atterrare finché non è atterrato — quindi può disegnare solo un rettangolo
 * generico, e l'anteprima diventa un cartello colorato invece che la cosa.
 *
 * Qui il mittente e il destinatario sono lo stesso documento, quindi il dato
 * non ha bisogno di passare dal `dataTransfer` per arrivare: basta lasciarlo
 * su un ripiano condiviso, e il `dataTransfer` resta l'unica autorità al
 * momento del drop (è l'unico che funziona anche fra due finestre).
 *
 * Vale finché il drag è vivo: si pulisce da solo al `dragend`, che il browser
 * emette SEMPRE sull'elemento sorgente — anche se il drop è caduto fuori dalla
 * finestra, o è stato annullato con Escape.
 */

let draggedPane: string | null = null;

/**
 * Ricorda la pane che parte. Da chiamare nel `dragstart`, accanto al
 * `setData` — non al posto suo: fra due finestre questo ripiano è vuoto e
 * comanda il `dataTransfer`.
 */
export function rememberDraggedPane(paneId: string): void {
  draggedPane = paneId;
  // `once` + window: il `dragend` bolla sempre fin qui, e non serve che la
  // sorgente si ricordi di pulire (metà delle sorgenti non ha un `onDragEnd`).
  window.addEventListener('dragend', forgetDraggedPane, { once: true });
}

/** La pane in volo, o `null` se il drag viene da un'altra finestra. */
export function draggedPaneId(): string | null {
  return draggedPane;
}

export function forgetDraggedPane(): void {
  draggedPane = null;
}
