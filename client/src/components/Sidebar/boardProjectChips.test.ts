/**
 * @covers STATUSLINE-02
 */
import { describe, expect, test } from 'bun:test';
import {
  boardProjectChips, fitProjectChips, fitStatusCounts, fitBoardRow, countWidth, countsSpan,
  CHIP_W_ICON, CHIP_GAP, CHIP_SPACING, MORE_W, CHIP_MODES, contaLeggibile,
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
  // TRE PASSI, e i test li tengono distinti perché il layout li tiene distinti:
  // `CHIP_INNER_GAP` (2) lega un'icona al suo numero; `CHIP_SPACING` (12)
  // separa due pastiglie E il «+N» dall'ultima, perché il «+N» parla DI LORO e
  // sta nel loro gruppo; `GROUP_SPACING` (20) separa i gruppi fra loro.
  // `CHIP_GAP` (6) resta solo dentro i conteggi di stato.
  const spanW = (w: number, n: number) => n * w + (n - 1) * CHIP_SPACING;
  const richSpan = (n: number) => spanW(RICCO.w, n);

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
    expect(fitProjectChips(richSpan(5), chips)).toEqual({ shown: chips, hidden: 0, mode: RICCO.mode });
    expect(fitProjectChips(richSpan(5) + 500, chips)).toEqual({ shown: chips, hidden: 0, mode: RICCO.mode });
  });

  test('il «+N» si prende il suo posto PRIMA di contare quante ne restano', () => {
    // Un pixel meno del necessario per cinque: ne entrerebbero quattro, e con
    // quattro mostrate serve anche il «+1» — che qui ci sta.
    expect(fitProjectChips(richSpan(5) - 1, chips)).toEqual({ shown: ['a', 'b', 'c', 'd'], hidden: 1, mode: RICCO.mode });
    // Esattamente lo spazio di quattro: il «+1» NON ci sta più, quindi si
    // scende a tre. È il passaggio che di solito manca, e senza il quale
    // l'ultima pastiglia e il «+N» si contendono gli stessi pixel.
    expect(fitProjectChips(richSpan(4), chips)).toEqual({ shown: ['a', 'b', 'c'], hidden: 2, mode: RICCO.mode });
    // E la soglia esatta: con lo spazio di quattro PIÙ il «+N», quattro tornano.
    expect(fitProjectChips(richSpan(4) + CHIP_SPACING + MORE_W, chips))
      .toEqual({ shown: ['a', 'b', 'c', 'd'], hidden: 1, mode: RICCO.mode });
  });

  test('o la coppia si vede intera, o la pastiglia non si disegna', () => {
    // LA SCALA HA UN GRADINO SOLO, e non è una semplificazione di comodo: il
    // ripiego «solo icona» è stato tolto perché un'icona senza il suo numero
    // non dice ciò per cui questa riga esiste, e accanto a pastiglie complete
    // si legge come un progetto con ZERO task. «Non dovremmo mostrare un'icona
    // se non si riesce a vedere completamente il suo conteggio» (Attilio,
    // 08/08).
    //
    // Sotto la soglia quindi non si degrada: si tace, e il «+N» dice quanti
    // sono i progetti che la riga non sta nominando. Il conto torna sempre —
    // `shown + hidden === chips.length` — perché tacere non è perdere.
    expect(CHIP_MODES).toHaveLength(1);
    const serveUna = RICCO.w + CHIP_SPACING + MORE_W;
    const f = fitProjectChips(serveUna - 1, chips);
    expect(f.shown, 'sotto la soglia non si disegna nessuna pastiglia').toEqual([]);
    expect(f.hidden).toBe(chips.length);
    expect(f.mode).toBe(RICCO.mode);
    // E un pixel sopra, la prima compare intera.
    const g = fitProjectChips(serveUna, chips);
    expect(g.shown).toEqual(['a']);
    expect(g.shown.length + g.hidden).toBe(chips.length);
  });

  test('un conteggio a tre cifre non è leggibile nella scatola prenotata', () => {
    // La pastiglia riserva due cifre: `contaLeggibile` è il predicato che
    // decide, ed è lo STESSO che il componente usa per filtrare. Due copie
    // divergerebbero, e si prenoterebbe spazio per una pastiglia che poi non si
    // disegna — il modo esatto in cui tornava fuori una pastiglia tagliata.
    expect(contaLeggibile(0)).toBe(true);
    expect(contaLeggibile(99)).toBe(true);
    expect(contaLeggibile(100)).toBe(false);
    expect(contaLeggibile(1234)).toBe(false);
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
    const minimumGuaranteed = countWidth(totale) + CHIP_SPACING + MORE_W;
    for (let w = 0; w <= 400; w += 1) {
      const { chips: c, counts: k } = fitBoardRow(w, chips, counts);
      const chipW = CHIP_MODES.find((m) => m.mode === c.mode)!.w;
      let used = c.shown.length * chipW + Math.max(0, c.shown.length - 1) * CHIP_GAP;
      if (c.hidden > 0) used += (c.shown.length > 0 ? CHIP_GAP : 0) + MORE_W;
      const kw = countsSpan(k);
      if (kw > 0 && used > 0) used += CHIP_GAP;
      expect(used + kw, `sborda a ${w}px`).toBeLessThanOrEqual(Math.max(w, minimumGuaranteed));
    }
  });
});
