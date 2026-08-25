/**
 * @covers LAYOUT-20
 */
import { describe, expect, test } from 'bun:test';
import {
  PINNED_ROW_MAX,
  flattenPinnedLayout,
  insertPinnedRow,
  mergePinnedLayout,
  movePinnedTile,
  pinnedDropAllowed,
  pinnedRowWidths,
  placePinnedTile,
  reconcilePinnedLayout,
  reorderWithinRow,
  samePinnedLayout,
  type PinnedRow,
} from './pinnedLayout';

/** Ogni riga deve sempre uscire con larghezze coerenti: una per chiave, somma 1. */
function expectWellFormed(layout: readonly PinnedRow[]) {
  for (const row of layout) {
    expect(row.widths.length).toBe(row.keys.length);
    expect(row.keys.length).toBeGreaterThan(0);
    const sum = row.widths.reduce((s, w) => s + w, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  }
}

const row = (...keys: string[]): PinnedRow => ({
  keys,
  widths: keys.map(() => 1 / keys.length),
});

describe('reconcilePinnedLayout', () => {
  test('layout assente → derivato dall\'ordine di pin', () => {
    const l = reconcilePinnedLayout(['a', 'b'], undefined);
    expect(flattenPinnedLayout(l)).toEqual(['a', 'b']);
    expectWellFormed(l);
  });

  test('pota le chiavi non più fissate, e le superstiti restano larghe uguali', () => {
    // Le proporzioni salvate NON si conservano di proposito: nessuno può averle
    // volute (non c'è un gesto per ridimensionare una tessera), quindi sono
    // rumore accumulato dall\'append e vanno raddrizzate. Vedi `widthsFor`.
    const before: PinnedRow[] = [{ keys: ['a', 'b', 'c'], widths: [0.2, 0.3, 0.5] }];
    const l = reconcilePinnedLayout(['a', 'c'], before);
    expect(l.map(r => r.keys)).toEqual([['a', 'c']]);
    expect(l[0].widths[0]).toBeCloseTo(0.5, 9);
    expect(l[0].widths[1]).toBeCloseTo(0.5, 9);
    expectWellFormed(l);
  });

  test('una riga che si svuota sparisce', () => {
    const l = reconcilePinnedLayout(['a'], [row('a'), row('b')]);
    expect(l.map(r => r.keys)).toEqual([['a']]);
  });

  test('i doppioni collassano sulla prima occorrenza', () => {
    const l = reconcilePinnedLayout(['a', 'b'], [row('a', 'b'), row('a')]);
    expect(flattenPinnedLayout(l)).toEqual(['a', 'b']);
    expectWellFormed(l);
  });

  test('un fissato nuovo si accoda all\'ultima riga finché c\'è posto', () => {
    const l = reconcilePinnedLayout(['a', 'b', 'c'], [row('a', 'b')]);
    expect(l.map(r => r.keys)).toEqual([['a', 'b', 'c']]);
    expectWellFormed(l);
  });

  test('oltre il tetto per riga il fissato nuovo apre una riga', () => {
    const full = Array.from({ length: PINNED_ROW_MAX }, (_, i) => `k${i}`);
    const l = reconcilePinnedLayout([...full, 'nuovo'], [row(...full)]);
    expect(l.length).toBe(2);
    expect(l[1].keys).toEqual(['nuovo']);
    expectWellFormed(l);
  });

  test('è idempotente', () => {
    const once = reconcilePinnedLayout(['a', 'b', 'c'], [row('a'), row('b', 'c')]);
    const twice = reconcilePinnedLayout(['a', 'b', 'c'], once);
    expect(samePinnedLayout(once, twice)).toBe(true);
  });

  test('è idempotente ANCHE se i fissati arrivano con un doppione', () => {
    // Il merge fra due device (o un payload vecchio) può portare 'b' due volte:
    // il ramo dei mancanti lo accodava DUE volte, e solo il giro dopo lo
    // raddrizzava — cioè la funzione dichiarata idempotente non lo era.
    const once = reconcilePinnedLayout(['a', 'b', 'b'], [row('a')]);
    expect(flattenPinnedLayout(once)).toEqual(['a', 'b']);
    const twice = reconcilePinnedLayout(['a', 'b', 'b'], once);
    expect(samePinnedLayout(once, twice)).toBe(true);
    expectWellFormed(once);
  });

  test('regge righe malformate senza perdere i fissati', () => {
    const junk = [
      null,
      { keys: ['a'], widths: [] },
      { keys: 'nope', widths: [] },
      { keys: ['b', 42], widths: [0.5, 0.5] },
    ] as unknown as PinnedRow[];
    const l = reconcilePinnedLayout(['a', 'b', 'c'], junk);
    expect(flattenPinnedLayout(l).sort()).toEqual(['a', 'b', 'c']);
    expectWellFormed(l);
  });
});

describe('movePinnedTile', () => {
  test('sposta dentro la stessa riga, all\'indice chiesto', () => {
    const l = movePinnedTile([row('a', 'b', 'c')], 'c', { rowIdx: 0, insertAt: 0 });
    expect(l[0].keys).toEqual(['c', 'a', 'b']);
    expectWellFormed(l);
  });

  test('dentro la stessa riga verso DESTRA non scavalca di uno', () => {
    // `insertAt` è contato sulla riga con la tessera ancora dentro. Passando
    // per `pluck`+`splice` atterrava un posto più a destra di dove puntavi —
    // e diverso da quello che l'anteprima mostrava mentre tenevi premuto.
    const l = movePinnedTile([row('a', 'b', 'c')], 'a', { rowIdx: 0, insertAt: 2 });
    expect(l[0].keys).toEqual(['b', 'a', 'c']);
    expectWellFormed(l);
  });

  test('l\'UNICA tessera di una riga, rilasciata sulla PROPRIA riga, resta dov\'è', () => {
    // `pluck` cancellava la riga svuotata, e `rowIdx` finiva a puntare quella
    // dopo: rimettere la tessera dov'era FONDEVA due righe in una, in modo
    // persistente e senza undo.
    const before = [row('x'), row('a', 'b')];
    for (const at of [0, 1]) {
      const l = movePinnedTile(before, 'x', { rowIdx: 0, insertAt: at });
      expect(l.map(r => r.keys)).toEqual([['x'], ['a', 'b']]);
      expectWellFormed(l);
    }
  });

  test('una riga di mezzo non si tocca quando il movimento è altrove', () => {
    const l = movePinnedTile([row('a', 'b'), row('m'), row('c')], 'a', { rowIdx: 0, insertAt: 2 });
    expect(l.map(r => r.keys)).toEqual([['b', 'a'], ['m'], ['c']]);
  });

  test('sposta su un\'altra riga', () => {
    const l = movePinnedTile([row('a', 'b'), row('c', 'd')], 'a', { rowIdx: 1, insertAt: 1 });
    expect(l.map(r => r.keys)).toEqual([['b'], ['c', 'a', 'd']]);
    expectWellFormed(l);
  });

  test('la riga di partenza che si svuota sparisce, e la destinazione scala', () => {
    // 'x' è solo sulla riga 0; destinazione riga 1 (che dopo la rimozione è la 0).
    const l = movePinnedTile([row('x'), row('a', 'b')], 'x', { rowIdx: 1, insertAt: 2 });
    expect(l.map(r => r.keys)).toEqual([['a', 'b', 'x']]);
    expectWellFormed(l);
  });

  test('indici fuori scala vengono clampati invece di rompere', () => {
    const l = movePinnedTile([row('a', 'b'), row('c')], 'a', { rowIdx: 99, insertAt: 99 });
    expect(flattenPinnedLayout(l).sort()).toEqual(['a', 'b', 'c']);
    expectWellFormed(l);
  });

  test('una chiave che non c\'è lascia il layout com\'è', () => {
    const before = [row('a', 'b')];
    const l = movePinnedTile(before, 'zzz', { rowIdx: 0, insertAt: 0 });
    expect(samePinnedLayout(before, l)).toBe(true);
  });

  test('non perde né duplica mai chiavi', () => {
    let l: PinnedRow[] = [row('a', 'b', 'c'), row('d', 'e')];
    const moves: Array<[string, number, number]> = [
      ['a', 1, 0], ['e', 0, 2], ['c', 1, 1], ['b', 0, 0], ['d', 1, 0],
    ];
    for (const [key, rowIdx, insertAt] of moves) {
      l = movePinnedTile(l, key, { rowIdx, insertAt });
      expect(flattenPinnedLayout(l).slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expectWellFormed(l);
    }
  });
});

describe('insertPinnedRow', () => {
  test('apre una riga nuova in fondo', () => {
    const l = insertPinnedRow([row('a', 'b')], 'b', 1);
    expect(l.map(r => r.keys)).toEqual([['a'], ['b']]);
    expectWellFormed(l);
  });

  test('apre una riga nuova in mezzo', () => {
    const l = insertPinnedRow([row('a', 'b'), row('c')], 'a', 1);
    expect(l.map(r => r.keys)).toEqual([['b'], ['a'], ['c']]);
    expectWellFormed(l);
  });

  test('spostare l\'unica tessera di una riga su una riga nuova adiacente è un no-op', () => {
    const before = [row('x'), row('a')];
    expect(samePinnedLayout(insertPinnedRow(before, 'x', 0), before)).toBe(true);
    expect(samePinnedLayout(insertPinnedRow(before, 'x', 1), before)).toBe(true);
  });

  test('su una chiave che il layout non conosce non si inventa una riga', () => {
    // Gemella di `movePinnedTile`: la stessa domanda deve avere la stessa
    // risposta. È il pin a decidere CHI c'è; chi vuole piazzare una chiave
    // nuova passa da `placePinnedTile`, che prima la fa esistere.
    const before = [row('a', 'b')];
    expect(samePinnedLayout(insertPinnedRow(before, 'fantasma', 1), before)).toBe(true);
    expect(samePinnedLayout(movePinnedTile(before, 'fantasma', { rowIdx: 0, insertAt: 0 }), before)).toBe(true);
  });
});

/**
 * `reorderWithinRow` — l'UNICA conversione fra «quante tessere ho a sinistra del
 * cursore» e «in che posizione finisce la tessera».
 *
 * Esiste perché la stessa formula viveva in due copie — una nell'anteprima del
 * componente, una implicita nel `pluck`+`splice` del modello — e le due
 * divergevano su ogni spostamento verso destra. I test qui sotto sono scritti
 * come il gesto: `insertAt` contato sulla riga COSÌ COM'È, con la tessera in
 * volo ancora al suo posto, perché è l'unica cosa che il cursore possa misurare.
 */
describe('reorderWithinRow', () => {
  test('verso destra: l\'indice è contato con la tessera ancora dentro', () => {
    // [a,b,c], cursore oltre il centro di 'b' ⇒ due tessere a sinistra ⇒ 2.
    // Il risultato giusto è [b,a,c]: 'a' passa 'b'. Il `pluck`+`splice` nudo
    // dava [b,c,a] — un posto più in là di dove puntavi, e diverso da quello
    // che l'anteprima stava mostrando.
    expect(reorderWithinRow(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c']);
    expect(reorderWithinRow(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
  });

  test('verso sinistra: l\'indice non va compensato', () => {
    expect(reorderWithinRow(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(reorderWithinRow(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'c', 'b']);
  });

  test('lasciarla dov\'era non la muove', () => {
    for (const at of [0, 1]) expect(reorderWithinRow(['a', 'b', 'c'], 'a', at)).toEqual(['a', 'b', 'c']);
    expect(reorderWithinRow(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    expect(reorderWithinRow(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c']);
  });

  test('indici fuori scala si clampano, la chiave sconosciuta non tocca niente', () => {
    expect(reorderWithinRow(['a', 'b'], 'a', 99)).toEqual(['b', 'a']);
    expect(reorderWithinRow(['a', 'b'], 'b', -5)).toEqual(['b', 'a']);
    expect(reorderWithinRow(['a', 'b'], 'zzz', 1)).toEqual(['a', 'b']);
  });

  test('non perde né duplica mai una chiave, a nessun indice', () => {
    const keys = ['a', 'b', 'c', 'd'];
    for (const k of keys) {
      for (let at = 0; at <= keys.length; at++) {
        expect(reorderWithinRow(keys, k, at).slice().sort()).toEqual([...keys].sort());
      }
    }
  });

  test('è la STESSA cosa che fa il drop: anteprima e risultato coincidono', () => {
    const keys = ['a', 'b', 'c', 'd'];
    for (const k of keys) {
      for (let at = 0; at <= keys.length; at++) {
        const anteprima = reorderWithinRow(keys, k, at);
        const drop = movePinnedTile([row(...keys)], k, { rowIdx: 0, insertAt: at });
        expect(drop[0].keys).toEqual(anteprima);
      }
    }
  });
});

/**
 * `pinnedDropAllowed` — «questo bersaglio ha senso offrirlo?».
 *
 * Il difetto che chiude, con le parole di chi l'ha visto: «se sto occupando una
 * riga intera, mi dà la possibilità di spostarla in una riga sotto, ma non ha
 * senso perché già sta occupando una riga». Il modello lo sapeva già e rifiutava
 * il gesto — ma la griglia continuava ad aprire lo spazio, accenderlo e
 * disegnarci dentro l'anteprima. Un'affordance che mente è peggio di una che
 * manca, quindi la domanda è UNA e sta qui.
 */
describe('pinnedDropAllowed', () => {
  test('una tessera che ha già una riga tutta sua: sopra e sotto non sono bersagli', () => {
    const l = [row('a', 'b'), row('x'), row('c')];
    expect(pinnedDropAllowed(l, 'x', { kind: 'newRow', atRowIdx: 1 })).toBe(false);
    expect(pinnedDropAllowed(l, 'x', { kind: 'newRow', atRowIdx: 2 })).toBe(false);
    // Le altre sì: lì la riga di partenza sparisce davvero e ne nasce una altrove.
    expect(pinnedDropAllowed(l, 'x', { kind: 'newRow', atRowIdx: 0 })).toBe(true);
    expect(pinnedDropAllowed(l, 'x', { kind: 'newRow', atRowIdx: 3 })).toBe(true);
  });

  test('una tessera che divide la riga può SEMPRE aprirsene una', () => {
    const l = [row('a', 'b')];
    for (const at of [0, 1]) expect(pinnedDropAllowed(l, 'a', { kind: 'newRow', atRowIdx: at })).toBe(true);
  });

  test('con UNA sola tessera fissata nessun bersaglio si accende', () => {
    // Prima si illuminavano tutti, e nessuno poteva muovere niente.
    const l = [row('solo')];
    expect(pinnedDropAllowed(l, 'solo', { kind: 'newRow', atRowIdx: 0 })).toBe(false);
    expect(pinnedDropAllowed(l, 'solo', { kind: 'newRow', atRowIdx: 1 })).toBe(false);
    expect(pinnedDropAllowed(l, 'solo', { kind: 'row', rowIdx: 0, insertAt: 0 })).toBe(false);
  });

  test('riordinare dentro la PROPRIA riga si può, anche se è piena', () => {
    const piena = row(...Array.from({ length: PINNED_ROW_MAX }, (_, i) => `k${i}`));
    expect(pinnedDropAllowed([piena], 'k0', { kind: 'row', rowIdx: 0, insertAt: 3 })).toBe(true);
  });

  test('entrare in una riga piena no: il conteggio crescerebbe', () => {
    const piena = row(...Array.from({ length: PINNED_ROW_MAX }, (_, i) => `k${i}`));
    const l = [piena, row('x')];
    expect(pinnedDropAllowed(l, 'x', { kind: 'row', rowIdx: 0, insertAt: 0 })).toBe(false);
    expect(pinnedDropAllowed(l, null, { kind: 'row', rowIdx: 0, insertAt: 0 })).toBe(false);
    // …e la riga nuova resta aperta: il rifiuto non è un vicolo cieco.
    expect(pinnedDropAllowed(l, 'x', { kind: 'newRow', atRowIdx: 0 })).toBe(true);
  });

  test('una cosa che arriva da FUORI: riga nuova sempre sì, riga esistente se c\'è posto', () => {
    const l = [row('a', 'b')];
    expect(pinnedDropAllowed(l, null, { kind: 'newRow', atRowIdx: 0 })).toBe(true);
    expect(pinnedDropAllowed(l, null, { kind: 'newRow', atRowIdx: 1 })).toBe(true);
    expect(pinnedDropAllowed(l, null, { kind: 'row', rowIdx: 0, insertAt: 1 })).toBe(true);
  });

  test('una riga che non esiste non è un bersaglio', () => {
    expect(pinnedDropAllowed([row('a')], null, { kind: 'row', rowIdx: 7, insertAt: 0 })).toBe(false);
  });

  test('ogni bersaglio PERMESSO cambia davvero qualcosa', () => {
    // L'invariante che tiene insieme affordance e modello: se si accende, il
    // drop non può essere un no-op silenzioso.
    const layouts: PinnedRow[][] = [
      [row('a', 'b', 'c')],
      [row('a'), row('b')],
      [row('a', 'b'), row('c')],
      [row('x'), row('a', 'b'), row('y')],
    ];
    for (const l of layouts) {
      for (const k of flattenPinnedLayout(l)) {
        for (let at = 0; at <= l.length; at++) {
          if (!pinnedDropAllowed(l, k, { kind: 'newRow', atRowIdx: at })) continue;
          expect(samePinnedLayout(l, insertPinnedRow(l, k, at))).toBe(false);
        }
        for (let ri = 0; ri < l.length; ri++) {
          if (!pinnedDropAllowed(l, k, { kind: 'row', rowIdx: ri, insertAt: 0 })) continue;
          const cambia = Array.from({ length: l[ri].keys.length + 1 }, (_, at) =>
            !samePinnedLayout(l, movePinnedTile(l, k, { rowIdx: ri, insertAt: at })));
          expect(cambia.some(Boolean)).toBe(true);
        }
      }
    }
  });
});

/**
 * `mergePinnedLayout` — la griglia in resa parla solo delle tessere VISIBILI.
 *
 * La ricerca della sidebar filtra, e una chat fissata poi archiviata sparisce da
 * sola: il componente riconciliava e committava una disposizione che nominava un
 * SOTTOINSIEME dei fissati, e chi la riceveva la prendeva per la verità su
 * tutti — le assenti risultavano «mancanti» e finivano riaccodate all'ultima
 * riga. Bastava riordinare due tessere con una ricerca attiva per appiattire su
 * una riga sola una disposizione fatta a mano, senza undo.
 */
describe('mergePinnedLayout', () => {
  test('senza niente di nascosto restituisce quello che ha ricevuto', () => {
    const prev = [row('a', 'b'), row('c')];
    const next = [row('b', 'a'), row('c')];
    expect(samePinnedLayout(mergePinnedLayout(prev, next), next)).toBe(true);
  });

  test('la nascosta torna accanto al vicino di sinistra con cui stava', () => {
    // 'b' filtrata via: la griglia mostra [a, c] su una riga, ma 'b' stava
    // fra loro e ci deve tornare.
    const prev = [row('a', 'b', 'c')];
    const next = [row('c', 'a')]; // riordinata mentre 'b' era nascosta
    const out = mergePinnedLayout(prev, next);
    expect(flattenPinnedLayout(out).slice().sort()).toEqual(['a', 'b', 'c']);
    expect(out.length).toBe(1);
    // dopo 'a', che è il vicino di sinistra che 'b' aveva
    expect(out[0].keys).toEqual(['c', 'a', 'b']);
    expectWellFormed(out);
  });

  test('senza vicini a sinistra ripiega su quello a destra', () => {
    const prev = [row('nascosta', 'a')];
    const next = [row('a')];
    const out = mergePinnedLayout(prev, next);
    expect(out[0].keys).toEqual(['nascosta', 'a']);
    expectWellFormed(out);
  });

  test('una riga interamente nascosta rinasce al suo posto, non in coda', () => {
    const prev = [row('a'), row('x', 'y'), row('b')];
    const next = [row('a'), row('b')]; // la riga di mezzo era tutta filtrata
    const out = mergePinnedLayout(prev, next);
    expect(out.map(r => r.keys)).toEqual([['a'], ['x', 'y'], ['b']]);
    expectWellFormed(out);
  });

  test('il riordino fatto con la ricerca attiva RESTA, e non appiattisce niente', () => {
    // Il caso vero: due righe, la ricerca mostra solo 'a' e 'c', li si scambia.
    const prev = [row('a', 'nascosta'), row('c')];
    const next = [row('c'), row('a')];
    const out = mergePinnedLayout(prev, next);
    expect(out.length).toBe(2);
    expect(flattenPinnedLayout(out).slice().sort()).toEqual(['a', 'c', 'nascosta']);
    expect(out.map(r => r.keys)).toEqual([['c'], ['a', 'nascosta']]);
    expectWellFormed(out);
  });

  test('griglia vuota (tutto filtrato): il layout salvato sopravvive intero', () => {
    const prev = [row('a', 'b'), row('c')];
    const out = mergePinnedLayout(prev, []);
    expect(flattenPinnedLayout(out).slice().sort()).toEqual(['a', 'b', 'c']);
  });

  test('riconciliando dopo il merge non si perde né si duplica un fissato', () => {
    const prev = [row('a', 'nascosta'), row('c')];
    const out = reconcilePinnedLayout(['a', 'nascosta', 'c'], mergePinnedLayout(prev, [row('c'), row('a')]));
    expect(flattenPinnedLayout(out).slice().sort()).toEqual(['a', 'c', 'nascosta']);
    expectWellFormed(out);
  });
});

describe('pinnedRowWidths', () => {
  test('è esattamente ciò che il drop produrrà', () => {
    const r = row('a', 'b');
    const preview = pinnedRowWidths(r.keys.length + 1);
    const dropped = movePinnedTile([r, row('z')], 'z', { rowIdx: 0, insertAt: 1 });
    expect(preview.length).toBe(3);
    preview.forEach((w, i) => expect(w).toBeCloseTo(dropped[0].widths[i], 9));
  });

  test('somma 1 a qualunque conteggio', () => {
    for (let n = 1; n <= 8; n++) {
      const w = pinnedRowWidths(n);
      expect(w.length).toBe(n);
      expect(Math.abs(w.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-9);
    }
  });
});

/** Tutte uguali entro un epsilon. */
function expectEven(row: PinnedRow) {
  const target = 1 / row.widths.length;
  for (const w of row.widths) expect(Math.abs(w - target)).toBeLessThan(1e-6);
}

describe('le tessere restano larghe uguali', () => {
  test('fissarne una terza su una riga da due NON stringe solo la nuova', () => {
    // Il bug visto sullo schermo: `appendColumnWidths` preserva le proporzioni
    // (giusto per colonne ridimensionate a mano) e su una riga equa produceva
    // [0.375, 0.375, 0.25]. Finché non esiste un gesto di resize, ogni riga è
    // "senza volontà" e va riequilibrata.
    const l = reconcilePinnedLayout(['a', 'b', 'c'], [row('a', 'b')]);
    expect(l[0].keys).toEqual(['a', 'b', 'c']);
    expectEven(l[0]);
  });

  test('accodando una alla volta si resta equi a ogni passo', () => {
    let l: PinnedRow[] = [];
    const pins: string[] = [];
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      pins.push(k);
      l = reconcilePinnedLayout(pins, l);
      for (const r of l) expectEven(r);
    }
  });

  test('togliere una tessera lascia le altre uguali fra loro', () => {
    const l3 = reconcilePinnedLayout(['a', 'b', 'c'], [row('a', 'b')]);
    const l2 = reconcilePinnedLayout(['a', 'c'], l3);
    expect(l2[0].keys).toEqual(['a', 'c']);
    expectEven(l2[0]);
  });

  test('spostare una tessera dentro una riga equa la lascia equa', () => {
    const l = movePinnedTile([row('a', 'b'), row('c')], 'c', { rowIdx: 0, insertAt: 1 });
    expect(l[0].keys).toEqual(['a', 'c', 'b']);
    expectEven(l[0]);
  });

  test("l'anteprima del drag mostra le stesse larghezze eque del drop", () => {
    const r = row('a', 'b');
    const preview = pinnedRowWidths(r.keys.length + 1);
    const dropped = movePinnedTile([r, row('z')], 'z', { rowIdx: 0, insertAt: 1 });
    expect(preview.length).toBe(3);
    preview.forEach((w, i) => expect(w).toBeCloseTo(dropped[0].widths[i], 9));
    expectEven({ keys: ['a', 'z', 'b'], widths: preview });
  });

  test('una riga arrivata STORTA da un client vecchio si raddrizza', () => {
    const storta: PinnedRow[] = [{ keys: ['a', 'b', 'c'], widths: [0.375, 0.375, 0.25] }];
    const l = reconcilePinnedLayout(['a', 'b', 'c'], storta);
    expectEven(l[0]);
  });
});

/**
 * `placePinnedTile` — fissare una cosa arrivata da fuori E metterla DOVE è
 * stata lasciata cadere.
 *
 * Il bug che chiude: la tessera si posava sempre in coda, mai sotto il cursore.
 * La causa non era il calcolo della posizione — era l'ORDINE. `movePinnedTile`
 * su una chiave che il layout non conosce ancora è un no-op silenzioso, quindi
 * spostare-e-poi-riconciliare buttava via lo spostamento senza dire niente.
 */
describe('placePinnedTile', () => {
  test('la nuova tessera finisce nella cella indicata, non in fondo', () => {
    const l = placePinnedTile(['a', 'b', 'c', 'nuovo'], [row('a', 'b', 'c')], 'nuovo', {
      kind: 'row', rowIdx: 0, insertAt: 1,
    });
    expect(l[0].keys).toEqual(['a', 'nuovo', 'b', 'c']);
    expectWellFormed(l);
  });

  test('in testa e in coda alla riga, agli estremi', () => {
    const testa = placePinnedTile(['a', 'b', 'x'], [row('a', 'b')], 'x', { kind: 'row', rowIdx: 0, insertAt: 0 });
    expect(testa[0].keys).toEqual(['x', 'a', 'b']);
    const coda = placePinnedTile(['a', 'b', 'x'], [row('a', 'b')], 'x', { kind: 'row', rowIdx: 0, insertAt: 2 });
    expect(coda[0].keys).toEqual(['a', 'b', 'x']);
  });

  test('la riga di destinazione è quella indicata, non la prima', () => {
    const l = placePinnedTile(['a', 'b', 'x'], [row('a'), row('b')], 'x', { kind: 'row', rowIdx: 1, insertAt: 0 });
    expect(l.map(r => r.keys)).toEqual([['a'], ['x', 'b']]);
  });

  test('una riga NUOVA si apre esattamente dove è stato lasciato il drop', () => {
    const l = placePinnedTile(['a', 'b', 'x'], [row('a'), row('b')], 'x', { kind: 'newRow', atRowIdx: 1 });
    expect(l.map(r => r.keys)).toEqual([['a'], ['x'], ['b']]);
    expectWellFormed(l);
  });

  test('senza niente di salvato la prima tessera atterra comunque', () => {
    const l = placePinnedTile(['x'], [], 'x', { kind: 'row', rowIdx: 0, insertAt: 0 });
    expect(flattenPinnedLayout(l)).toEqual(['x']);
    const nuova = placePinnedTile(['x'], undefined, 'x', { kind: 'newRow', atRowIdx: 0 });
    expect(flattenPinnedLayout(nuova)).toEqual(['x']);
  });

  test('la riga resta equa: la nuova tessera non nasce più stretta delle altre', () => {
    const l = placePinnedTile(['a', 'b', 'x'], [row('a', 'b')], 'x', { kind: 'row', rowIdx: 0, insertAt: 1 });
    const w = l[0].widths;
    for (const x of w) expect(x).toBeCloseTo(1 / 3, 9);
  });

  test('un indice di riga oltre il layout non perde la tessera', () => {
    const l = placePinnedTile(['a', 'x'], [row('a')], 'x', { kind: 'row', rowIdx: 9, insertAt: 5 });
    expect(flattenPinnedLayout(l).sort()).toEqual(['a', 'x']);
    expectWellFormed(l);
  });

  test('è il PIN a decidere chi c\'è: una chiave non fissata non entra', () => {
    // `pinnedItems` è l'autorità. Se il chiamante dimentica di aggiungerla, la
    // funzione non se la inventa — meglio nessuna cella che una che non si
    // risolve in nessuna riga della sidebar.
    const l = placePinnedTile(['a'], [row('a')], 'fantasma', { kind: 'row', rowIdx: 0, insertAt: 0 });
    expect(flattenPinnedLayout(l)).toEqual(['a']);
  });
});
