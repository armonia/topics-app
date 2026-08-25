/**
 * @covers BROWSER-FIND-01
 */
import { describe, expect, test } from 'bun:test';
import { stepMatchIndex, formatMatchCounter } from './findInPageModel';

describe('stepMatchIndex', () => {
  test('da fermo il primo passo avanti è la PRIMA corrispondenza', () => {
    expect(stepMatchIndex(0, 12, true)).toBe(1);
  });

  test('da fermo il primo passo indietro è l\'ULTIMA (dove atterra window.find)', () => {
    expect(stepMatchIndex(0, 12, false)).toBe(12);
  });

  test('avanti avanza di uno', () => {
    expect(stepMatchIndex(3, 12, true)).toBe(4);
  });

  test('indietro torna di uno', () => {
    expect(stepMatchIndex(3, 12, false)).toBe(2);
  });

  test('dopo l\'ultima si RICOMINCIA da 1 (come window.find con wrap)', () => {
    expect(stepMatchIndex(12, 12, true)).toBe(1);
  });

  test('indietro dalla prima si va all\'ULTIMA', () => {
    expect(stepMatchIndex(1, 12, false)).toBe(12);
  });

  test('con una sola corrispondenza si resta su quella, nei due versi', () => {
    expect(stepMatchIndex(1, 1, true)).toBe(1);
    expect(stepMatchIndex(1, 1, false)).toBe(1);
  });

  test('zero risultati: nessun passo alza l\'indice sopra lo zero', () => {
    expect(stepMatchIndex(0, 0, true)).toBe(0);
    expect(stepMatchIndex(5, 0, false)).toBe(0);
    expect(stepMatchIndex(0, -3, true)).toBe(0);
  });

  test('un indice FUORI SCALA riparte dal bordo verso cui si sta andando', () => {
    // La pagina è cambiata sotto la barra: m era 12, ora è 3. Da 12 il passo
    // avanti deve tornare a 1, non finire a 13.
    expect(stepMatchIndex(12, 3, true)).toBe(1);
    expect(stepMatchIndex(12, 3, false)).toBe(3);
    expect(stepMatchIndex(-4, 3, true)).toBe(1);
  });

  test('numeri non finiti non producono NaN a video', () => {
    expect(stepMatchIndex(Number.NaN, 5, true)).toBe(1);
    expect(stepMatchIndex(2, Number.NaN, true)).toBe(0);
  });
});

describe('formatMatchCounter', () => {
  test('«n/m» come lo legge l\'utente', () => {
    expect(formatMatchCounter(3, 12)).toBe('3/12');
  });

  test('niente da trovare = «0/0», qualunque indice resti appeso', () => {
    expect(formatMatchCounter(0, 0)).toBe('0/0');
    expect(formatMatchCounter(7, 0)).toBe('0/0');
    expect(formatMatchCounter(1, -2)).toBe('0/0');
  });

  test('un totale c\'è ma nessun ⏎ è stato premuto: «0/12»', () => {
    expect(formatMatchCounter(0, 12)).toBe('0/12');
  });

  test('l\'indice non può sfondare il totale nemmeno per un giro', () => {
    expect(formatMatchCounter(14, 12)).toBe('12/12');
    expect(formatMatchCounter(-1, 12)).toBe('0/12');
  });
});
