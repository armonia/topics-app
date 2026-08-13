import { describe, it, expect } from 'bun:test';
import { sheetSettle } from './useSheetDrag';

/**
 * La posa del foglio: dove va quando il dito si stacca.
 *
 * È la regola che decide se il gesto è servito a qualcosa, ed è l'unico pezzo
 * del trascinamento che si può provare senza un dito vero. Il resto (chi prende
 * il tocco, quando lo lascia allo scorrimento) sta nella spec touch.
 */

const ALTEZZA = 400;

describe('sheetSettle', () => {
  it('un LANCIO verso il basso chiude anche da fermo a due dita di corsa', () => {
    // 40px su 400 è un decimo: la posizione da sola direbbe «resta».
    expect(sheetSettle(40, ALTEZZA, 1.2).chiudi).toBe(true);
  });

  it('un lancio verso l’ALTO tiene aperto anche da sotto lo schermo', () => {
    // Il ripensamento: giù fin quasi in fondo, poi il dito risale e stacca.
    expect(sheetSettle(320, ALTEZZA, -1.2).chiudi).toBe(false);
  });

  it('senza velocità decide la posizione, con la metà come confine', () => {
    expect(sheetSettle(201, ALTEZZA, 0).chiudi).toBe(true);
    expect(sheetSettle(199, ALTEZZA, 0).chiudi).toBe(false);
    // Esattamente a metà non è ancora andato: chiudere pretende di SUPERARE.
    expect(sheetSettle(200, ALTEZZA, 0).chiudi).toBe(false);
  });

  it('una corsa lenta e lunga non conta come lancio', () => {
    // 90px in mezzo secondo (0,18 px/ms) è un ripensamento, non un lancio:
    // è il caso che una media mobile leggeva al contrario.
    expect(sheetSettle(90, ALTEZZA, 0.18).chiudi).toBe(false);
  });

  it('la durata sta nella fascia in cui un movimento si legge ancora', () => {
    const fermo = sheetSettle(210, ALTEZZA, 0);
    const lancio = sheetSettle(40, ALTEZZA, 3);
    const lento = sheetSettle(210, ALTEZZA, 0.06);
    for (const p of [fermo, lancio, lento]) {
      expect(p.durataMs).toBeGreaterThanOrEqual(120);
      expect(p.durataMs).toBeLessThanOrEqual(300);
    }
    // Un lancio non si posa con lo stesso tempo di un dito fermo: la distanza
    // che resta la copre alla velocità che aveva.
    expect(lancio.durataMs).toBeLessThan(fermo.durataMs);
  });

  it('non divide per zero su un foglio ancora senza altezza misurata', () => {
    const p = sheetSettle(0, 1, 0);
    expect(Number.isFinite(p.durataMs)).toBe(true);
    expect(p.chiudi).toBe(false);
  });
});
