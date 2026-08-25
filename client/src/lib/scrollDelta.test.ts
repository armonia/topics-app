/**
 * @covers SCROLLDELTA-01
 */
import { describe, expect, test } from 'bun:test';
import { scrollDelta, type Span } from './scrollDelta';

const span = (start: number, end: number): Span => ({ start, end });

describe('scrollDelta', () => {
  test('già dentro: non si muove niente', () => {
    expect(scrollDelta(span(0, 500), span(100, 200))).toBe(0);
  });

  test('a filo dei due bordi conta come dentro (senza margine)', () => {
    expect(scrollDelta(span(0, 500), span(0, 500))).toBe(0);
  });

  test('oltre il bordo finale: avanti quel tanto che basta', () => {
    // Il bordo destro della card cade a 620 in una finestra che finisce a 500.
    expect(scrollDelta(span(0, 500), span(560, 620))).toBe(120);
  });

  test('prima del bordo iniziale: indietro, quindi negativo', () => {
    expect(scrollDelta(span(100, 600), span(20, 80))).toBe(-80);
  });

  test('il margine stacca dal bordo invece di appoggiarcelo', () => {
    // Senza margine sarebbe già dentro (finisce esattamente a 500).
    expect(scrollDelta(span(0, 500), span(440, 500))).toBe(0);
    expect(scrollDelta(span(0, 500), span(440, 500), 8)).toBe(8);
    expect(scrollDelta(span(0, 500), span(0, 60), 8)).toBe(-8);
  });

  test('bersaglio più grande della finestra: si allinea l\'INIZIO, non la fine', () => {
    // Card alta 700 in un corpo colonna alto 400. Il ramo "oltre il bordo
    // finale" porterebbe in vista il FONDO della card — cioè l'unica parte che
    // non dice quale card è.
    expect(scrollDelta(span(0, 400), span(300, 1000))).toBe(300);
    // E vale anche quando sfora dal lato opposto: si sale fino alla sua cima.
    expect(scrollDelta(span(0, 400), span(-250, 450))).toBe(-250);
  });

  test('la finestra non parte da zero: i numeri sono quelli del viewport', () => {
    // getBoundingClientRect è relativo al viewport, non al contenitore.
    expect(scrollDelta(span(240, 900), span(950, 1010))).toBe(110);
    expect(scrollDelta(span(240, 900), span(180, 230))).toBe(-60);
  });
});
