import { describe, expect, test } from 'bun:test';
import { boardProjectChips, fitProjectChips } from './boardProjectChips';
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

  test('prima della prima misura non si disegna e non si annuncia niente', () => {
    // Un «+5» che compare e sparisce al primo layout è peggio del vuoto di un
    // frame: `hidden` resta 0 finché non si sa quanto spazio c'è.
    expect(fitProjectChips(0, chips)).toEqual({ shown: [], hidden: 0 });
  });

  test('se ci stanno tutte non c\'è nessun «+N»', () => {
    // 5 × 68 + 4 × 6 = 364
    expect(fitProjectChips(364, chips)).toEqual({ shown: chips, hidden: 0 });
    expect(fitProjectChips(1000, chips)).toEqual({ shown: chips, hidden: 0 });
  });

  test('il «+N» si prende il suo posto PRIMA di contare quante ne restano', () => {
    // A 363px ne entrerebbero 4 (4×68 + 3×6 = 290) — ma con 4 mostrate serve
    // anche il «+1»: 290 + 6 + 22 = 318 ≤ 363, quindi 4 e una nascosta.
    expect(fitProjectChips(363, chips)).toEqual({ shown: ['a', 'b', 'c', 'd'], hidden: 1 });
    // A 310px il conto con quattro non regge (318 > 310): si scende a tre.
    expect(fitProjectChips(310, chips)).toEqual({ shown: ['a', 'b', 'c'], hidden: 2 });
  });

  test('una colonna troppo stretta per una sola pastiglia non ne disegna nessuna', () => {
    expect(fitProjectChips(40, chips)).toEqual({ shown: [], hidden: 5 });
  });

  test('nessun progetto, nessuna riga', () => {
    expect(fitProjectChips(500, [])).toEqual({ shown: [], hidden: 0 });
  });
});
