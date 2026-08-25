/**
 * La regola della trappola del focus, senza DOM.
 *
 * Il bug che chiude: nei modali senza trappola il Tab esce dal dialogo e va a
 * passeggiare sulla pagina sotto — che è coperta dal velo e non si vede. Da
 * tastiera il focus sparisce: si continua a premere Tab senza sapere dove si è.
  * @covers GESTURE-02
 */
import { test, expect } from 'bun:test';
import { nextTrapFocus } from './useModalDialog';

const items = ['first', 'mid', 'last'] as const;

test('Tab dall’ultimo torna al primo — il focus non esce dal dialogo', () => {
  expect(nextTrapFocus(items, 'last', false)).toBe('first');
});

test('Shift+Tab dal primo va all’ultimo', () => {
  expect(nextTrapFocus(items, 'first', true)).toBe('last');
});

test('in mezzo non si interviene: il giro lo fa il browser', () => {
  expect(nextTrapFocus(items, 'mid', false)).toBe(null);
  expect(nextTrapFocus(items, 'mid', true)).toBe(null);
});

test('focus fuori dagli elementi (card appena aperta) → Tab ENTRA dal primo', () => {
  // È il caso del focus iniziale appoggiato sulla card stessa: senza questo,
  // il primo Tab dopo l’apertura usciva dal dialogo.
  expect(nextTrapFocus(items, null, false)).toBe('first');
});

test('…e Shift+Tab entra dall’ultimo', () => {
  expect(nextTrapFocus(items, null, true)).toBe('last');
});

test('un solo elemento focalizzabile: Tab ci resta sopra', () => {
  expect(nextTrapFocus(['only'], 'only', false)).toBe('only');
  expect(nextTrapFocus(['only'], 'only', true)).toBe('only');
});

test('nessun elemento focalizzabile → nessun bersaglio (il chiamante blocca il Tab)', () => {
  expect(nextTrapFocus([], null, false)).toBe(null);
});
