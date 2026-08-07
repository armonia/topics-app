import { describe, expect, test } from 'bun:test';
import { boardProjectChips, fitProjectChips, CHIP_W, CHIP_GAP, MORE_W } from './boardProjectChips';
import type { BoardProjectRef, BoardTask, TaskStatus } from '../../lib/board';

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
  /** Lo spazio che occupano `n` pastiglie affiancate. Derivato dalle costanti,
   *  non ricopiato: la larghezza è già cambiata una volta (68 → 52, passando da
   *  due piani a uno) e con i numeri scritti a mano questi test sarebbero
   *  diventati rossi mentre la regola restava intatta. */
  const span = (n: number) => n * CHIP_W + (n - 1) * CHIP_GAP;

  test('prima della prima misura non si disegna e non si annuncia niente', () => {
    // Un «+5» che compare e sparisce al primo layout è peggio del vuoto di un
    // frame: `hidden` resta 0 finché non si sa quanto spazio c'è.
    expect(fitProjectChips(0, chips)).toEqual({ shown: [], hidden: 0 });
  });

  test('se ci stanno tutte non c\'è nessun «+N»', () => {
    expect(fitProjectChips(span(5), chips)).toEqual({ shown: chips, hidden: 0 });
    expect(fitProjectChips(span(5) + 500, chips)).toEqual({ shown: chips, hidden: 0 });
  });

  test('il «+N» si prende il suo posto PRIMA di contare quante ne restano', () => {
    // Un pixel meno del necessario per cinque: ne entrerebbero quattro, e con
    // quattro mostrate serve anche il «+1» — che qui ci sta.
    expect(fitProjectChips(span(5) - 1, chips)).toEqual({ shown: ['a', 'b', 'c', 'd'], hidden: 1 });
    // Esattamente lo spazio di quattro: il «+1» NON ci sta più, quindi si
    // scende a tre. È il passaggio che di solito manca, e senza il quale
    // l'ultima pastiglia e il «+N» si contendono gli stessi pixel.
    expect(fitProjectChips(span(4), chips)).toEqual({ shown: ['a', 'b', 'c'], hidden: 2 });
    // E la soglia esatta: con lo spazio di quattro PIÙ il «+N», quattro tornano.
    expect(fitProjectChips(span(4) + CHIP_GAP + MORE_W, chips)).toEqual({ shown: ['a', 'b', 'c', 'd'], hidden: 1 });
  });

  test('una colonna troppo stretta per una sola pastiglia non ne disegna nessuna', () => {
    expect(fitProjectChips(CHIP_W - 1, chips)).toEqual({ shown: [], hidden: 5 });
  });

  test('nessun progetto, nessuna riga', () => {
    expect(fitProjectChips(500, [])).toEqual({ shown: [], hidden: 0 });
  });
});
