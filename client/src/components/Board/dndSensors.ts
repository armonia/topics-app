import { KeyboardSensor, MouseSensor, TouchSensor } from '@dnd-kit/core';

/**
 * I sensori del drag della board, sordi a ciò con cui si INTERAGISCE.
 *
 * Il difetto che chiudono, segnalato da Attilio il 12/08: scrivendo nell'input
 * di risposta di un task, «anche solo cliccando», la card partiva in
 * trascinamento. Il sensore del mouse ha `activationConstraint: { distance: 4 }`,
 * quindi bastano quattro pixel a bottone premuto: un click che seleziona del
 * testo, o una mano che trema, li fa. E dnd-kit di suo non guarda SU COSA hai
 * premuto, guarda solo quanto ti sei mosso.
 *
 * Non si cura alzando la soglia. Alzarla rende il drag legittimo più faticoso
 * per tutti e lascia comunque il difetto a chi trascina il cursore per
 * selezionare una parola, che è un gesto lungo per definizione. La cura è dire
 * al sensore che certi bersagli non sono maniglie:
 *
 *  · i campi di testo (`input`, `textarea`, `[contenteditable]`), dove un
 *    trascinamento è selezione, non spostamento;
 *  · i comandi (`button`, `a`, `select`), dove il gesto atteso è il click;
 *  · qualunque cosa marcata `[data-no-dnd]`, la via d'uscita per i casi che
 *    non rientrano nei due elenchi sopra.
 *
 * La stessa regola vale per il dito: la soglia a 200ms del `TouchSensor` non
 * protegge un long-press dentro un campo, che è come si porta su la lente di
 * ingrandimento di iOS.
 */
const NOT_A_HANDLE = 'input, textarea, select, button, a, [contenteditable="true"], [data-no-dnd]';

/**
 * THE FINGER CHANGED OWNER: the board's touch drag lets go.
 *
 * `PoliteTouchSensor` arms on the SAME `touchstart` as the card's long press
 * (`Card.tsx`, `onCardTouchStart`) and activates after 200 ms of a still
 * finger — the card lifts — before the menu's 500 ms. From activation on,
 * dnd-kit keeps a capture-phase `click` listener on the document that stops
 * EVERY click, and removes it only 50 ms after the gesture ends
 * (`AbstractPointerSensor.handleStart` / `detach`). The menu opening does not
 * end the gesture: the card stayed lifted under the open menu with the rows
 * frozen (`beginDrag`) until the finger came off, and a click landing inside
 * those 50 ms was eaten. Measured 2026-09-06 on `board-card-stop.spec.ts`,
 * touch project: the click on the menu item arrived 46 ms after the lift, the
 * menu stayed open, and no `POST …/stop` ever left the browser.
 *
 * `touchcancel` is the signal the sensor already listens to for "the system
 * took the touch", and it listens ON THE NODE THE FINGER LANDED ON — dnd-kit
 * attaches its move/end/cancel listeners to the `touchstart` target, not to
 * the document, so that a re-render cannot orphan them
 * (`getEventListenerTarget`). Hence `touched`, the innermost target, and not
 * the card. The event does not bubble on purpose: React delivers bubble-phase
 * handlers from the root, so the long press's own `onTouchCancel` — which
 * would forget the gesture and let the synthetic click through — never sees
 * it, and nothing else listening on the document does either.
 */
export function releaseTouchDrag(touched: EventTarget): void {
  touched.dispatchEvent(new Event('touchcancel'));
}

function onInteractiveTarget(event: Event): boolean {
  const t = event.target;
  return t instanceof Element && t.closest(NOT_A_HANDLE) !== null;
}

/** Mouse: come quello di dnd-kit, ma non parte da un campo o da un comando. */
export class PoliteMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: MouseEvent }) => !onInteractiveTarget(nativeEvent),
    },
  ];
}

/** Dito: stessa sordità, così il long-press dentro un campo resta del campo. */
export class PoliteTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: ({ nativeEvent }: { nativeEvent: TouchEvent }) => !onInteractiveTarget(nativeEvent),
    },
  ];
}

/**
 * Tastiera: ed è QUESTO il sensore che faceva partire il trascinamento mentre si
 * scriveva, non il mouse.
 *
 * Segnalato da Attilio il 12/08 dopo la cura al mouse: «appena scrivo parte il
 * dnd o l'invio, non capisco». Il colpevole è la BARRA SPAZIATRICE. Il
 * `KeyboardSensor` di dnd-kit parte su `Space` o `Enter`, e la sua unica
 * protezione è questa (core.cjs.development.js:1362):
 *
 *     const activator = active.activatorNode.current;
 *     if (activator && event.target !== activator) return false;
 *     event.preventDefault();
 *
 * La guardia vale solo se esiste un NODO ATTIVATORE dedicato. `Card.tsx` sparge
 * `{...listeners}` sulla radice della card e non usa `setActivatorNodeRef`,
 * quindi `activatorNode.current` è `null`, la guardia si salta, e ogni spazio
 * battuto dentro la textarea di risposta apre un trascinamento da tastiera —
 * con `preventDefault`, che è il motivo per cui lo spazio non compariva e
 * l'invio si comportava in modo strano.
 *
 * Stessa regola degli altri due: se si sta scrivendo in un campo o si sta per
 * premere un comando, il tasto è del campo, non della board.
 */
export class PoliteKeyboardSensor extends KeyboardSensor {
  static activators = [
    {
      eventName: 'onKeyDown' as const,
      handler: (event: { nativeEvent: KeyboardEvent }, options: unknown, context: unknown): boolean => {
        if (onInteractiveTarget(event.nativeEvent)) return false;
        // Per tutto il resto vale il comportamento della libreria: qui si toglie
        // un caso, non si riscrive il sensore.
        const original = (KeyboardSensor.activators[0] as { handler: (...a: unknown[]) => boolean }).handler;
        return original(event, options, context);
      },
    },
  ];
}
