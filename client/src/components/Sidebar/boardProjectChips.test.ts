import { describe, expect, test } from 'bun:test';
import {
  boardProjectChips, fitProjectChips, fitStatusCounts, fitBoardRow, countWidth, countsSpan,
  CHIP_W_ICON_COUNT, CHIP_W_ICON, CHIP_GAP, CHIP_SPACING, MORE_W, CHIP_MODES,
  type BoardCount, type BoardProjectChip,
} from './boardProjectChips';
import type { BoardProjectRef, BoardTask, TaskStatus } from '../../lib/board';

/** Il gradino piu' RICCO della scala e il suo ingombro. Preso da `CHIP_MODES`
 *  e non scritto qui: e' quello che `fitProjectChips` prova per primo, quindi
 *  e' anche il modo con cui esce quando non ha ancora niente da disegnare, e
 *  se un domani si aggiunge un gradino sopra questi test lo seguono invece di
 *  diventare rossi su una regola intatta. */
const RICCO = CHIP_MODES[0]!;

function task(projectId: string, status: TaskStatus): BoardTask {
  // Solo i tre campi che queste funzioni leggono: un finto completo sarebbe
  // trenta righe di rumore che non partecipano a nessuna asserzione.
  return { projectId, status } as BoardTask;
}

function byStatus(tasks: BoardTask[]): Record<TaskStatus, BoardTask[]> {
  const out = { backlog: [], todo: [], in_progress: [], review: [], done: [] } as Record<TaskStatus, BoardTask[]>;
  for (const t of tasks) out[t.status].push(t);
  return out;
}

const INDEX: BoardProjectRef[] = [
  { projectId: 'topics-a1b2', name: 'topics', path: '/Users/x/topics' },
  { projectId: 'quadra-c3d4', name: 'quadra', path: '/Users/x/quadra' },
];

describe('boardProjectChips', () => {
  test('conta per progetto e ordina dal più carico', () => {
    const chips = boardProjectChips(
      byStatus([
        task('quadra-c3d4', 'todo'),
        task('topics-a1b2', 'review'),
        task('topics-a1b2', 'in_progress'),
        task('topics-a1b2', 'backlog'),
      ]),
      INDEX,
    );
    expect(chips.map(c => [c.name, c.n])).toEqual([['topics', 3], ['quadra', 1]]);
  });

  test("i `done` non contano: la board si annuncia per il lavoro aperto", () => {
    const chips = boardProjectChips(
      byStatus([task('topics-a1b2', 'done'), task('topics-a1b2', 'done'), task('quadra-c3d4', 'todo')]),
      INDEX,
    );
    expect(chips.map(c => [c.name, c.n])).toEqual([['quadra', 1]]);
  });

  test('un progetto che l\'indice non conosce resta contato, col nome ripulito e senza path', () => {
    // È il caso della cartella sparita dal disco, e quello — molto più comune —
    // dell'indice non ancora arrivato: far sparire quei task dal conteggio
    // vorrebbe dire che la riga mente finché una fetch non torna.
    const chips = boardProjectChips(byStatus([task('sparito-9z9z', 'todo')]), INDEX);
    expect(chips).toEqual([{ projectId: 'sparito-9z9z', name: 'sparito', path: '', n: 1 }]);
  });

  test('senza board non c\'è niente da raggruppare', () => {
    expect(boardProjectChips(undefined, INDEX)).toEqual([]);
    expect(boardProjectChips(byStatus([]), INDEX)).toEqual([]);
  });
});

describe('fitProjectChips', () => {
  const chips = ['a', 'b', 'c', 'd', 'e'];
  /** Lo spazio che occupano `n` pastiglie affiancate, per modo. Derivato dalle
   *  costanti, non ricopiato: la larghezza è già cambiata due volte e con i
   *  numeri scritti a mano questi test sarebbero diventati rossi mentre la
   *  regola restava intatta. */
  // Fra le pastiglie corre `CHIP_SPACING` (12), non `CHIP_GAP` (6): sono due
  // passi diversi da quando la pastiglia ha perso la superficie e a raggruppare
  // è rimasta la distanza. Il «+N» resta un blocco a sé, quindi lì sotto si
  // continua a sommare `CHIP_GAP`.
  const spanW = (w: number, n: number) => n * w + (n - 1) * CHIP_SPACING;
  const spanRicco = (n: number) => spanW(RICCO.w, n);
  const spanIcon = (n: number) => spanW(CHIP_W_ICON, n);

  test('non ancora misurato (null) tace del tutto, e non è la stessa cosa di zero', () => {
    // Un «+5» che compare e sparisce al primo layout è peggio del vuoto di un
    // frame: finché non si sa quanto spazio c'è, `hidden` resta 0.
    expect(fitProjectChips(null, chips)).toEqual({ shown: [], hidden: 0, mode: RICCO.mode });
  });

  test('misurato ZERO si ANNUNCIA: nessuna pastiglia, ma il «+N» dice che mancano', () => {
    // È il caso che rende il difetto visibile invece che muto. Appiccicare
    // l'ultima larghezza buona (`if (w > 0) setWidth(w)`) rimetterebbe il
    // silenzio, ed è esattamente ciò che BOARD-14 blocca.
    expect(fitProjectChips(0, chips)).toEqual({ shown: [], hidden: 5, mode: RICCO.mode });
  });

  test('se ci stanno tutte sul gradino ricco non c\'è nessun «+N»', () => {
    expect(fitProjectChips(spanRicco(5), chips)).toEqual({ shown: chips, hidden: 0, mode: RICCO.mode });
    expect(fitProjectChips(spanRicco(5) + 500, chips)).toEqual({ shown: chips, hidden: 0, mode: RICCO.mode });
  });

  test('il «+N» si prende il suo posto PRIMA di contare quante ne restano', () => {
    // Un pixel meno del necessario per cinque: ne entrerebbero quattro, e con
    // quattro mostrate serve anche il «+1» — che qui ci sta.
    expect(fitProjectChips(spanRicco(5) - 1, chips)).toEqual({ shown: ['a', 'b', 'c', 'd'], hidden: 1, mode: RICCO.mode });
    // Esattamente lo spazio di quattro: il «+1» NON ci sta più, quindi si
    // scende a tre. È il passaggio che di solito manca, e senza il quale
    // l'ultima pastiglia e il «+N» si contendono gli stessi pixel.
    expect(fitProjectChips(spanRicco(4), chips)).toEqual({ shown: ['a', 'b', 'c'], hidden: 2, mode: RICCO.mode });
    // E la soglia esatta: con lo spazio di quattro PIÙ il «+N», quattro tornano.
    expect(fitProjectChips(spanRicco(4) + CHIP_GAP + MORE_W, chips))
      .toEqual({ shown: ['a', 'b', 'c', 'd'], hidden: 1, mode: RICCO.mode });
  });

  test('la scala scende UN gradino alla volta, e solo quando non ne entra nemmeno una', () => {
    // Fra i due gradini c'è una fascia in cui il ricco non entra e il successivo
    // sì: lì il modo deve essere il SECONDO, non l'ultimo. Un `??` che salta
    // direttamente in fondo (era la forma di prima, con due soli gradini) qui
    // darebbe 'icon' e nessuno se ne accorgerebbe dal risultato — le pastiglie
    // ci sarebbero comunque, solo mute.
    const secondo = CHIP_MODES[1]!;
    const serveSecondo = secondo.w + CHIP_GAP + MORE_W;
    const serveRicco = RICCO.w + CHIP_GAP + MORE_W;
    expect(serveSecondo).toBeLessThan(serveRicco);
    for (const w of [serveSecondo, serveRicco - 1]) {
      const f = fitProjectChips(w, chips);
      expect(f.mode, `a ${w}px`).toBe(secondo.mode);
      expect(f.shown.length, `a ${w}px`).toBeGreaterThanOrEqual(1);
      expect(f.shown.length + f.hidden).toBe(chips.length);
    }
    // E un pixel sopra la soglia del ricco, il ricco torna.
    expect(fitProjectChips(serveRicco, chips).mode).toBe(RICCO.mode);
  });

  test('quando col numero non ne entra NEMMENO UNA si scende a solo-icona', () => {
    // Il degrado è progressivo, non uno stato scelto: il numero ha la
    // precedenza finché ce n'è uno che ci sta, perché è metà dell'informazione
    // che questa riga esiste per dare («n progetti con n task»).
    // Un pixel meno di quanto serve a una pastiglia col numero PIÙ il suo «+N»
    // (che serve, visto che cinque non ci stanno): col numero non ne entra
    // nessuna, a sole icone sì.
    const stretta = CHIP_W_ICON_COUNT + CHIP_GAP + MORE_W - 1;
    expect(stretta).toBeGreaterThanOrEqual(spanIcon(1) + CHIP_GAP + MORE_W);
    const fitted = fitProjectChips(stretta, chips);
    expect(fitted.mode).toBe('icon');
    // QUANTE ne entrano si CALCOLA, non si ricopia: il numero dipende dal
    // rapporto fra le due larghezze, e ricopiarlo lega il test a quel rapporto
    // invece che alla regola. (Successo l'08/08: tolto il numero dalla
    // pastiglia, `CHIP_W_ICON` è sceso da 36 a 20 e qui era rosso un «1» che
    // non diceva niente di sbagliato.)
    let entrano = chips.length;
    while (entrano > 0 && spanIcon(entrano) + CHIP_GAP + MORE_W > stretta) entrano--;
    expect(entrano).toBeGreaterThan(0);
    expect(fitted.shown).toEqual(chips.slice(0, entrano));
    expect(fitted.hidden).toBe(chips.length - entrano);
  });

  test('col numero ne entra una: si resta col numero anche se a sole icone ne entrerebbero di più', () => {
    const w = spanRicco(1) + CHIP_GAP + MORE_W;
    expect(fitProjectChips(w, chips)).toEqual({ shown: ['a'], hidden: 4, mode: RICCO.mode });
  });

  test('una colonna troppo stretta perfino per un\'icona non disegna niente, ma lo dice', () => {
    expect(fitProjectChips(CHIP_W_ICON - 1, chips)).toEqual({ shown: [], hidden: 5, mode: RICCO.mode });
  });

  test('nessun progetto, nessuna riga', () => {
    expect(fitProjectChips(500, [])).toEqual({ shown: [], hidden: 0, mode: RICCO.mode });
  });
});

describe('fitStatusCounts', () => {
  const counts: BoardCount[] = [
    { status: 'review', n: 2 },
    { status: 'in_progress', n: 1 },
    { status: 'todo', n: 3 },
    { status: 'backlog', n: 4 },
  ];
  const span = (ws: number[]) => ws.reduce((a, b) => a + b, 0) + (ws.length - 1) * CHIP_GAP;

  test('se ci stanno tutti non si arrotola niente', () => {
    const w = span(counts.map(c => countWidth(c.n)));
    expect(fitStatusCounts(w, 0, counts)).toEqual({ shown: counts, rolled: null });
  });

  test('la CODA si arrotola, la testa resta: si perde il backlog, mai il review', () => {
    // Spazio per tre elementi esatti ⇒ due conteggi più il rollup.
    const w = span([countWidth(2), countWidth(1), countWidth(7)]);
    expect(fitStatusCounts(w, 0, counts)).toEqual({
      shown: [counts[0], counts[1]],
      rolled: { statuses: ['todo', 'backlog'], n: 7 },
    });
  });

  test('il pavimento delle pastiglie viene tolto PRIMA: sono i conteggi a cedere', () => {
    // Questo è il difetto di prima, in un'asserzione: con lo spazio giusto per
    // tutti e quattro i conteggi, il pavimento di una pastiglia solo-icona li
    // costringe comunque ad arrotolarsi — invece di prendersi la riga intera e
    // lasciare a zero l'unica cosa che dice DOVE sta quel lavoro.
    const w = span(counts.map(c => countWidth(c.n)));
    const fitted = fitStatusCounts(w, CHIP_W_ICON + CHIP_GAP, counts);
    expect(fitted.rolled).not.toBeNull();
    expect(countsSpan(fitted)).toBeLessThanOrEqual(w - (CHIP_W_ICON + CHIP_GAP));
  });

  test('un conteggio solo non si arrotola MAI, nemmeno se non ci sta', () => {
    // Un rollup di uno è lo stesso numero con un glifo che dice meno, e il
    // segnale primario può stringersi ma non sparire.
    const uno: BoardCount[] = [{ status: 'review', n: 9 }];
    expect(fitStatusCounts(0, 0, uno)).toEqual({ shown: uno, rolled: null });
  });

  test('spazio per nessuno: resta il solo rollup', () => {
    expect(fitStatusCounts(1, 0, counts)).toEqual({
      shown: [],
      rolled: { statuses: ['review', 'in_progress', 'todo', 'backlog'], n: 10 },
    });
  });

  test('nessuna colonna aperta, nessun conteggio', () => {
    expect(fitStatusCounts(500, 0, [])).toEqual({ shown: [], rolled: null });
  });
});

describe('fitBoardRow', () => {
  const chips: BoardProjectChip[] = [
    { projectId: 'p1', name: 'topics', path: '/x/topics', n: 4 },
    { projectId: 'p2', name: 'quadra', path: '/x/quadra', n: 2 },
    { projectId: 'p3', name: 'landing', path: '', n: 1 },
  ];
  const counts: BoardCount[] = [
    { status: 'review', n: 2 },
    { status: 'in_progress', n: 1 },
    { status: 'todo', n: 3 },
    { status: 'backlog', n: 1 },
  ];

  test('prima della misura i conteggi si vedono INTERI e le pastiglie tacciono', () => {
    // I conteggi non dipendono da una misura per esistere; le pastiglie sì.
    const fitted = fitBoardRow(null, chips, counts);
    expect(fitted.counts).toEqual({ shown: counts, rolled: null });
    expect(fitted.chips).toEqual({ shown: [], hidden: 0, mode: RICCO.mode });
  });

  /**
   * IL DIFETTO, IN UN NUMERO SOLO.
   *
   * 158px è lo spazio elastico vero della riga a colonna 256 (244 di card, 228
   * di contenuto, meno glifo, nome e spazi). Prima, con quattro colonne aperte,
   * i conteggi si prendevano tutto e alle pastiglie restava meno di una: ZERO
   * progetti sulla riga, senza nemmeno un «+N» a dirlo.
   */
  test('a 158px con quattro colonne aperte resta comunque almeno un progetto, e il resto è dichiarato', () => {
    const fitted = fitBoardRow(158, chips, counts);
    expect(fitted.chips.shown.length).toBeGreaterThanOrEqual(1);
    expect(fitted.chips.shown.length + fitted.chips.hidden).toBe(chips.length);
    // E i conteggi hanno ceduto qualcosa invece di prendersi tutto.
    expect(fitted.counts.rolled).not.toBeNull();
  });

  test('niente pastiglie da mostrare ⇒ nessun pavimento riservato, i conteggi si prendono la riga', () => {
    const fitted = fitBoardRow(158, [], counts);
    expect(fitted.counts).toEqual({ shown: counts, rolled: null });
    expect(fitted.chips.shown).toEqual([]);
  });

  test('a colonna larga ci stanno tutti e due i lati per intero', () => {
    const fitted = fitBoardRow(600, chips, counts);
    expect(fitted.counts).toEqual({ shown: counts, rolled: null });
    expect(fitted.chips).toEqual({ shown: chips, hidden: 0, mode: RICCO.mode });
  });

  test('quello che si disegna non sborda MAI dallo spazio misurato', () => {
    // La proprietà che tiene insieme tutto il resto: qualunque larghezza, la
    // somma di ciò che si rende sta dentro. È l'asserzione che il ritaglio a
    // due priorità (conteggi + pastiglie) può rompere in silenzio.
    //
    // Sotto il MINIMO GARANTITO la riga non può onorare tutto, e sfora di
    // proposito: il rollup dei conteggi e il «+N» delle pastiglie sono le due
    // cose che non spariscono mai — sparire in silenzio è il difetto, non la
    // soluzione. Il minimo è quel rollup più quel «+N», e sotto quella soglia
    // la riga vera non ci arriva comunque (a colonna 180px lo spazio elastico
    // è ~78px).
    const totale = counts.reduce((a, c) => a + c.n, 0);
    const minimoGarantito = countWidth(totale) + CHIP_GAP + MORE_W;
    for (let w = 0; w <= 400; w += 1) {
      const { chips: c, counts: k } = fitBoardRow(w, chips, counts);
      const chipW = CHIP_MODES.find((m) => m.mode === c.mode)!.w;
      let used = c.shown.length * chipW + Math.max(0, c.shown.length - 1) * CHIP_GAP;
      if (c.hidden > 0) used += (c.shown.length > 0 ? CHIP_GAP : 0) + MORE_W;
      const kw = countsSpan(k);
      if (kw > 0 && used > 0) used += CHIP_GAP;
      expect(used + kw, `sborda a ${w}px`).toBeLessThanOrEqual(Math.max(w, minimoGarantito));
    }
  });
});
