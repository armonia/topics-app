import { describe, expect, test } from 'bun:test';
import { alzataArco, alzateFila, pavimentoFila, raggioSchermo } from './safeAreaArc';

describe('raggioSchermo', () => {
  test('fascia assente ⇒ raggio zero (schermo squadrato)', () => {
    expect(raggioSchermo(0)).toBe(0);
    expect(raggioSchermo(-1)).toBe(0);
    expect(raggioSchermo(Number.NaN)).toBe(0);
  });

  test('la fascia di un iPhone in verticale dà un raggio della famiglia giusta', () => {
    // 34px di home indicator ⇒ 54: fra i 44 dell'iPhone X e i 55 dei Pro
    // recenti, e dal lato che sbaglia in eccesso.
    expect(raggioSchermo(34)).toBe(54);
  });

  test('un raggio dichiarato batte la stima; uno non valido no', () => {
    expect(raggioSchermo(34, 44)).toBe(44);
    expect(raggioSchermo(34, 0)).toBe(54);
    expect(raggioSchermo(34, Number.NaN)).toBe(54);
  });
});

describe('alzataArco', () => {
  test('sul bordo l’arco mangia tutto il raggio, alla sua fine niente', () => {
    expect(alzataArco(0, 54)).toBeCloseTo(54, 6);
    expect(alzataArco(54, 54)).toBe(0);
    expect(alzataArco(200, 54)).toBe(0);
  });

  test('raggio zero ⇒ alzata zero, sempre', () => {
    expect(alzataArco(0, 0)).toBe(0);
    expect(alzataArco(8, 0)).toBe(0);
  });

  test('a metà raggio vale R − √(R²−(R/2)²), non la metà di R', () => {
    // La curva NON è una rampa: a 27 di 54 l'arco mangia 7,24 e non 27.
    expect(alzataArco(27, 54)).toBeCloseTo(54 - Math.sqrt(54 * 54 - 27 * 27), 6);
    expect(alzataArco(27, 54)).toBeCloseTo(7.23, 2);
  });

  test('è monotona: più ci si allontana dal bordo, meno l’arco mangia', () => {
    let prec = Infinity;
    for (let d = 0; d <= 60; d += 4) {
      const a = alzataArco(d, 54);
      expect(a).toBeLessThanOrEqual(prec + 1e-9);
      prec = a;
    }
  });
});

describe('pavimentoFila', () => {
  test('senza fascia resta un respiro di 10px', () => {
    expect(pavimentoFila(0)).toBe(10);
  });

  test('con la fascia dell’iPhone si abita la banda: 22 dal fondo', () => {
    // Stessa quota a cui la barra di stato mette già il suo contenuto: dentro
    // la fascia, sopra l'home indicator.
    expect(pavimentoFila(34)).toBe(22);
  });

  test('non scende mai sotto i 10, nemmeno con una fascia sottile', () => {
    expect(pavimentoFila(14)).toBe(10);
  });
});

describe('alzateFila', () => {
  /** La fila vera: tre scatole spinte ai bordi, 8px di rientro per lato. È lo
   *  scopo del modulo — se si sta larghi 32 come la barra di stato, l'arco non
   *  tocca nessuno e non c'era niente da calcolare. */
  const treScatole = (larghezza: number, l = 84, rientro = 8) => {
    const passo = (larghezza - 2 * rientro - l) / 2;
    return [0, 1, 2].map((i) => ({ x: rientro + i * passo, larghezza: l }));
  };

  test('schermo squadrato: la fila è DRITTA, senza rami dedicati', () => {
    const alzate = alzateFila({
      larghezza: 390,
      scatole: treScatole(390),
      raggio: raggioSchermo(0),
      pavimento: pavimentoFila(0),
    });
    expect(alzate).toEqual([10, 10, 10]);
  });

  test('iPhone: gli estremi salgono, quello in mezzo resta sul pavimento', () => {
    const alzate = alzateFila({
      larghezza: 390,
      scatole: treScatole(390),
      raggio: raggioSchermo(34),
      pavimento: pavimentoFila(34),
    });
    expect(alzate[1]).toBe(22);           // il centro non lo tocca l'arco
    expect(alzate[0]).toBeGreaterThan(22); // i lati sì
    expect(alzate[0]).toBe(alzate[2]);     // ed è simmetrica
  });

  test('l’alzata si misura sull’angolo ESTERNO, non sul centro della scatola', () => {
    // Una scatola larga il doppio, ancorata allo stesso x: il suo angolo basso
    // sinistro non si è mosso, quindi nemmeno l'alzata.
    const stretta = alzateFila({ larghezza: 390, scatole: [{ x: 8, larghezza: 44 }], raggio: 54, pavimento: 22 });
    const larga = alzateFila({ larghezza: 390, scatole: [{ x: 8, larghezza: 120 }], raggio: 54, pavimento: 22 });
    expect(larga[0]).toBe(stretta[0]);
    // e vale l'arco a 8px dal bordo, non il pavimento
    expect(stretta[0]).toBeCloseTo(54 - Math.sqrt(54 * 54 - 46 * 46), 2);
  });

  test('il pavimento è un minimo, non un addendo', () => {
    // Con un pavimento alto quanto il raggio, l'arco non aggiunge niente.
    const alzate = alzateFila({ larghezza: 390, scatole: treScatole(390), raggio: 54, pavimento: 54 });
    expect(alzate).toEqual([54, 54, 54]);
  });

  test('nessuna scatola finisce sotto il pavimento, su nessuna larghezza', () => {
    for (const larghezza of [320, 375, 390, 414, 430, 768]) {
      const alzate = alzateFila({
        larghezza,
        scatole: treScatole(larghezza),
        raggio: raggioSchermo(34),
        pavimento: pavimentoFila(34),
      });
      for (const a of alzate) expect(a).toBeGreaterThanOrEqual(22);
    }
  });
});
