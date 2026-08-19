import { describe, expect, test } from 'bun:test';
import { alzataCurva, curvaturaEsterna, formaFila, pavimentoFila, raggioSchermo } from './safeAreaArc';

/** La fila vera: 44 di altezza, angoli standard da 12. */
const ALTEZZA = 44;
const STANDARD = 12;

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

describe('alzataCurva, angolo appuntito (curvatura 0)', () => {
  test('sul bordo l’arco mangia tutto il raggio, alla sua fine niente', () => {
    expect(alzataCurva(0, 54, 0)).toBeCloseTo(54, 6);
    expect(alzataCurva(54, 54, 0)).toBe(0);
    expect(alzataCurva(200, 54, 0)).toBe(0);
  });

  test('raggio zero ⇒ alzata zero, sempre', () => {
    expect(alzataCurva(0, 0, 0)).toBe(0);
    expect(alzataCurva(8, 0, 0)).toBe(0);
  });

  test('a metà raggio vale R − √(R²−(R/2)²), non la metà di R', () => {
    // La curva NON è una rampa: a 27 di 54 l'arco mangia 7,24 e non 27.
    expect(alzataCurva(27, 54, 0)).toBeCloseTo(54 - Math.sqrt(54 * 54 - 27 * 27), 6);
    expect(alzataCurva(27, 54, 0)).toBeCloseTo(7.23, 2);
  });

  test('è monotona: più ci si allontana dal bordo, meno l’arco mangia', () => {
    let prec = Infinity;
    for (let d = 0; d <= 60; d += 4) {
      const a = alzataCurva(d, 54, 0);
      expect(a).toBeLessThanOrEqual(prec + 1e-9);
      prec = a;
    }
  });
});

describe('alzataCurva, angolo tondo: è ciò che permette di stare a filo', () => {
  test('a filo del bordo un angolo tondo costa R meno il proprio raggio', () => {
    // L'iPhone in verticale: 54 di arco, un tasto da 44 che porta 22 di raggio.
    // Appuntito, stare a x=0 costerebbe 54 di alzata; tondo ne costa 32.
    expect(alzataCurva(0, 54, 22)).toBeCloseTo(32, 6);
    expect(alzataCurva(0, 54, 0)).toBeCloseTo(54, 6);
  });

  test('un angolo tondo quanto l’arco non paga niente: è lo stesso cerchio', () => {
    expect(alzataCurva(0, 54, 54)).toBe(0);
    // E nemmeno se lo si chiede più tondo dell'arco: il raggio viene tagliato.
    expect(alzataCurva(0, 54, 90)).toBe(0);
  });

  test('costa sempre meno o quanto l’angolo appuntito, a ogni distanza', () => {
    for (let d = 0; d <= 60; d += 3) {
      expect(alzataCurva(d, 54, 22)).toBeLessThanOrEqual(alzataCurva(d, 54, 0) + 1e-9);
    }
  });

  test('fuori dall’arco non alza nessuno, tondo o appuntito che sia', () => {
    expect(alzataCurva(54, 54, 22)).toBe(0);
    expect(alzataCurva(200, 54, 22)).toBe(0);
    expect(alzataCurva(10, 0, 22)).toBe(0);
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

describe('curvaturaEsterna', () => {
  test('schermo squadrato ⇒ raggio standard, nessuna curva da seguire', () => {
    expect(curvaturaEsterna(8, 0, ALTEZZA, STANDARD)).toBe(STANDARD);
  });

  test('fuori dall’arco ⇒ standard: è ciò che tiene squadrato quello in mezzo', () => {
    expect(curvaturaEsterna(54, 54, ALTEZZA, STANDARD)).toBe(STANDARD);
    expect(curvaturaEsterna(160, 54, ALTEZZA, STANDARD)).toBe(STANDARD);
  });

  test('dentro l’arco il raggio è CONCENTRICO: quello dello schermo meno il gioco', () => {
    // Con una scatola alta abbastanza da portarlo, R−d e non un numero scelto.
    expect(curvaturaEsterna(8, 54, 200, STANDARD)).toBe(46);
    expect(curvaturaEsterna(20, 54, 200, STANDARD)).toBe(34);
  });

  test('mezza altezza è il tetto: un tasto da 44 non porta 46 di raggio', () => {
    expect(curvaturaEsterna(8, 54, ALTEZZA, STANDARD)).toBe(22);
  });

  test('non scende MAI sotto lo standard, nemmeno con un raggio minuscolo', () => {
    // Uno schermo appena stondato non deve squadrare l'angolo esterno più
    // degli altri tre: sarebbe un difetto, non una curva.
    expect(curvaturaEsterna(8, 14, ALTEZZA, STANDARD)).toBe(STANDARD);
  });
});

describe('formaFila', () => {
  /** La fila vera: tre scatole A FILO dei bordi, nessun rientro. È lo scopo del
   *  modulo — se si sta larghi 32 come la barra di stato, l'arco non tocca
   *  nessuno e non c'era niente da calcolare. */
  const treScatole = (larghezza: number, l = 84, rientro = 0) => {
    const passo = (larghezza - 2 * rientro - l) / 2;
    return [0, 1, 2].map((i) => ({ x: rientro + i * passo, larghezza: l }));
  };

  const fila = (larghezza: number, fascia: number, extra?: { raggio?: number; pavimento?: number }) =>
    formaFila({
      larghezza,
      scatole: treScatole(larghezza),
      raggio: extra?.raggio ?? raggioSchermo(fascia),
      pavimento: extra?.pavimento ?? pavimentoFila(fascia),
      altezza: ALTEZZA,
      standard: STANDARD,
    });

  test('schermo squadrato: la fila è DRITTA e tutta standard, senza rami dedicati', () => {
    const forme = fila(390, 0);
    expect(forme.map((f) => f.alzata)).toEqual([10, 10, 10]);
    expect(forme.map((f) => f.curvatura)).toEqual([STANDARD, STANDARD, STANDARD]);
    expect(forme.map((f) => f.lato)).toEqual([null, null, null]);
  });

  test('iPhone: gli estremi salgono, quello in mezzo resta sul pavimento', () => {
    const forme = fila(390, 34);
    expect(forme[1].alzata).toBe(22);            // il centro non lo tocca l'arco
    expect(forme[0].alzata).toBeGreaterThan(22); // i lati sì
    expect(forme[0].alzata).toBe(forme[2].alzata); // ed è simmetrica
  });

  test('iPhone: sinistra curva a SINISTRA, destra a DESTRA, il centro resta standard', () => {
    const forme = fila(390, 34);
    expect(forme.map((f) => f.lato)).toEqual(['sinistra', null, 'destra']);
    // Il raggio degli estremi è quello che l'arco impone (qui il tetto di
    // mezza altezza), MAI un numero scelto a mano.
    expect(forme[0].curvatura).toBe(curvaturaEsterna(0, raggioSchermo(34), ALTEZZA, STANDARD));
    expect(forme[0].curvatura).toBe(forme[2].curvatura);
    expect(forme[1].curvatura).toBe(STANDARD);
  });

  test('l’alzata si misura sull’angolo ESTERNO, non sul centro della scatola', () => {
    // Una scatola larga il doppio, ancorata allo stesso x: il suo angolo basso
    // sinistro non si è mosso, quindi nemmeno l'alzata.
    const comune = { larghezza: 390, raggio: 54, pavimento: 22, altezza: ALTEZZA, standard: STANDARD };
    const stretta = formaFila({ ...comune, scatole: [{ x: 0, larghezza: 44 }] });
    const larga = formaFila({ ...comune, scatole: [{ x: 0, larghezza: 120 }] });
    expect(larga[0].alzata).toBe(stretta[0].alzata);
    // A filo del bordo vale l'arco (32, col suo angolo da 22), non il pavimento.
    expect(stretta[0].alzata).toBeCloseTo(32, 2);
  });

  test('a filo la fila sale di 32 e non di 54: la differenza è l’angolo tondo', () => {
    // La prova che il primo e l'ultimo tasto POSSONO stare sul bordo. Con
    // l'angolo appuntito servivano 54 di alzata, cioè più dell'altezza del
    // tasto: la fila sarebbe uscita dalla barra invece di seguirne la curva.
    const forme = fila(390, 34);
    expect(forme[0].alzata).toBeCloseTo(32, 2);
    expect(forme[0].curvatura).toBe(22);
    expect(forme[1].alzata).toBe(22);
  });

  test('il pavimento è un minimo, non un addendo', () => {
    const forme = fila(390, 34, { raggio: 54, pavimento: 54 });
    expect(forme.map((f) => f.alzata)).toEqual([54, 54, 54]);
  });

  test('nessuna scatola finisce sotto il pavimento, su nessuna larghezza', () => {
    for (const larghezza of [320, 375, 390, 414, 430, 768]) {
      for (const f of fila(larghezza, 34)) expect(f.alzata).toBeGreaterThanOrEqual(22);
    }
  });

  test('su ogni larghezza la curva sta agli estremi e mai in mezzo', () => {
    for (const larghezza of [320, 375, 390, 414, 430]) {
      const forme = fila(larghezza, 34);
      expect(forme.map((f) => f.lato)).toEqual(['sinistra', null, 'destra']);
    }
  });
});
