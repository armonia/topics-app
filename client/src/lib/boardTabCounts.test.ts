import { describe, expect, test } from 'bun:test';
import { boardTabCounts, SUMMARY_STATUSES } from './boardTabCounts';
import type { BoardTask, TaskStatus } from './board';

/** Solo i due campi che la funzione legge: un finto completo sarebbe trenta
 *
 * @covers KANBAN-06
 *  righe di rumore che non partecipano a nessuna asserzione. */
function task(projectId: string, status: TaskStatus): BoardTask {
  return { projectId, status } as BoardTask;
}

const TASKS: BoardTask[] = [
  task('topics-a1b2', 'review'),
  task('topics-a1b2', 'review'),
  task('topics-a1b2', 'in_progress'),
  task('topics-a1b2', 'backlog'),
  task('topics-a1b2', 'done'),
  task('quadra-c3d4', 'review'),
  task('quadra-c3d4', 'todo'),
];

describe('boardTabCounts', () => {
  test('conta gli stati riassunti su tutti i progetti', () => {
    expect(boardTabCounts(TASKS)).toEqual([
      { status: 'review', n: 3 },
      { status: 'in_progress', n: 1 },
    ]);
  });

  test('review viene prima di in corso: è l\'ordine in cui si rinuncia', () => {
    expect(boardTabCounts(TASKS).map((c) => c.status)).toEqual([...SUMMARY_STATUSES]);
  });

  test('la coda e il lavoro chiuso non si contano', () => {
    // backlog, todo e done ci sono in `TASKS` e non compaiono da nessuna parte:
    // la somma dei conteggi è solo review + in_progress.
    const somma = boardTabCounts(TASKS).reduce((s, c) => s + c.n, 0);
    expect(somma).toBe(4);
  });

  test('con un progetto conta SOLO i suoi', () => {
    expect(boardTabCounts(TASKS, 'quadra-c3d4')).toEqual([{ status: 'review', n: 1 }]);
  });

  test('gli zeri non si disegnano: niente riga per uno stato vuoto', () => {
    expect(boardTabCounts([task('x-1', 'in_progress')])).toEqual([{ status: 'in_progress', n: 1 }]);
  });

  test('niente da dire = lista vuota (la tab resta com\'era)', () => {
    expect(boardTabCounts([task('x-1', 'backlog')])).toEqual([]);
    expect(boardTabCounts([])).toEqual([]);
    expect(boardTabCounts(null)).toEqual([]);
    expect(boardTabCounts(undefined)).toEqual([]);
  });

  test('un progetto senza task non eredita i numeri degli altri', () => {
    // Il caso che conta davvero: la tab di progetto NON deve mai mostrare il
    // totale globale quando la sua board è vuota.
    expect(boardTabCounts(TASKS, 'nessuno-z9')).toEqual([]);
  });
});
