import { MouseSensor, TouchSensor } from '@dnd-kit/core';

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
const NON_E_UNA_MANIGLIA = 'input, textarea, select, button, a, [contenteditable="true"], [data-no-dnd]';

function suUnElementoInterattivo(event: Event): boolean {
  const t = event.target;
  return t instanceof Element && t.closest(NON_E_UNA_MANIGLIA) !== null;
}

/** Mouse: come quello di dnd-kit, ma non parte da un campo o da un comando. */
export class MouseSensorGentile extends MouseSensor {
  static activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: MouseEvent }) => !suUnElementoInterattivo(nativeEvent),
    },
  ];
}

/** Dito: stessa sordità, così il long-press dentro un campo resta del campo. */
export class TouchSensorGentile extends TouchSensor {
  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: ({ nativeEvent }: { nativeEvent: TouchEvent }) => !suUnElementoInterattivo(nativeEvent),
    },
  ];
}
