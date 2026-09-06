/**
 * I sensori del drag della board sono SORDI a ciò con cui si interagisce.
 *
 * Il difetto che questi test presidiano è stato segnalato due volte, e la
 * seconda dopo che credevo di averlo chiuso:
 *
 *  · 12/08, mattina — «mentre scrivo nell'input di risposta di un task, anche
 *    solo cliccando, me lo porta in dnd». Colpevole: il `MouseSensor` con
 *    `activationConstraint: { distance: 4 }`, che guarda quanto ti sei mosso e
 *    mai su cosa hai premuto.
 *  · 12/08, sera — «ancora, appena scrivo parte il dnd o l'invio». Colpevole
 *    diverso: la BARRA SPAZIATRICE. Il `KeyboardSensor` parte su `Space` o
 *    `Enter` e la sua unica protezione è confrontare il bersaglio col nodo
 *    attivatore, che qui è `null` perché `Card.tsx` sparge i listener sulla
 *    radice della card. Guardia saltata, `preventDefault` chiamato: lo spazio
 *    non si scriveva nemmeno.
 *
 * Ogni sensore ha la sua porta d'ingresso, quindi una cura sola non basta: ogni
 * porta va provata. È il motivo per cui questi test esistono per tutte e tre.
 *
 * @covers KANBAN-01
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { PoliteKeyboardSensor, PoliteMouseSensor, PoliteTouchSensor, releaseTouchDrag } from './dndSensors';

/**
 * Sotto `bun test` non c'è un DOM, e i sensori chiedono due cose sole al
 * bersaglio: che sia un `Element` e che sappia rispondere a `closest`. Questo è
 * il minimo che le soddisfa entrambe, senza montare un browser per una riga di
 * logica.
 */
class FakeElement {
  constructor(private readonly combacia: string | null) {}
  closest(selettore: string): FakeElement | null {
    if (!this.combacia) return null;
    return selettore.includes(this.combacia) ? this : null;
  }
}
const elementInstalledByUs = typeof (globalThis as { Element?: unknown }).Element === 'undefined';
if (elementInstalledByUs) {
  (globalThis as { Element?: unknown }).Element = FakeElement;
}

// If the global Element is ours (bun has none), remove it when the file ends: an
// `instanceof Element` in a later file of the same sharded process must not trip
// over our FakeElement.
afterAll(() => {
  if (elementInstalledByUs) delete (globalThis as { Element?: unknown }).Element;
});

/** Un bersaglio finto con la catena `closest` che serve al sensore. */
function bersaglio(selettoreCheCombacia: string | null): EventTarget {
  return new FakeElement(selettoreCheCombacia) as unknown as EventTarget;
}

function activatorOf(sensor: { activators: Array<{ handler: (...a: never[]) => boolean }> }) {
  return sensor.activators[0]!.handler;
}

describe('i sensori non partono da un campo di testo', () => {
  test('mouse: premere dentro una textarea non è una presa', () => {
    const h = activatorOf(PoliteMouseSensor as never);
    expect(h({ nativeEvent: { target: bersaglio('textarea') } } as never)).toBe(false);
  });

  test('mouse: premere sul corpo della card lo è', () => {
    const h = activatorOf(PoliteMouseSensor as never);
    expect(h({ nativeEvent: { target: bersaglio(null) } } as never)).toBe(true);
  });

  test('dito: il long-press dentro un input resta dell input', () => {
    const h = activatorOf(PoliteTouchSensor as never);
    expect(h({ nativeEvent: { target: bersaglio('input') } } as never)).toBe(false);
  });

  test('tastiera: lo SPAZIO dentro la textarea di risposta non trascina', () => {
    // Il caso vero: si sta scrivendo una risposta e si separa una parola.
    const h = activatorOf(PoliteKeyboardSensor as never);
    const evento = { nativeEvent: { code: 'Space', target: bersaglio('textarea') } };
    expect(h(evento as never, {} as never, { active: { activatorNode: { current: null } } } as never)).toBe(false);
  });

  test('tastiera: l INVIO su un comando resta del comando', () => {
    const h = activatorOf(PoliteKeyboardSensor as never);
    const evento = { nativeEvent: { code: 'Enter', target: bersaglio('button') } };
    expect(h(evento as never, {} as never, { active: { activatorNode: { current: null } } } as never)).toBe(false);
  });

  test('tastiera: sulla card, invece, lo spazio prende ancora la card', () => {
    // Il controllo dei due test qui sopra: togliere un caso non deve spegnere
    // il sensore. Chi naviga da tastiera deve poter ancora afferrare una card.
    const h = activatorOf(PoliteKeyboardSensor as never);
    const evento = {
      nativeEvent: { code: 'Space', target: bersaglio(null) },
      preventDefault() {},
    };
    expect(h(evento as never, {} as never, { active: { activatorNode: { current: null } } } as never)).toBe(true);
  });
});

describe('the long press that wins the finger releases the drag', () => {
  test('releaseTouchDrag sends the touchcancel the sensor listens for to the touched node, and it does not bubble', () => {
    // The sensor keeps its end-of-gesture listeners on the `touchstart`
    // target (`getEventListenerTarget`), not on the document: measured on
    // 2026-09-06, a `touchcancel` on the document left the card lifted under
    // the open menu. And it must not bubble: React delivers `onTouchCancel`
    // from the root, and the long press's own handler would forget the
    // gesture and let the synthetic click through. The test pins both.
    const seen: Array<{ type: string; bubbles: boolean }> = [];
    const touched = { dispatchEvent: (e: Event) => { seen.push({ type: e.type, bubbles: e.bubbles }); return true; } };
    releaseTouchDrag(touched as unknown as EventTarget);
    expect(seen).toEqual([{ type: 'touchcancel', bubbles: false }]);
  });
});
