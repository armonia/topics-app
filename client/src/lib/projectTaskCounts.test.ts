/**
 * Il conto per progetto: quello che il filtro «Progetto» della kanban mostra
 * accanto a ogni nome. Si prova qui perché è la parte che si può sbagliare in
 * silenzio — un task «senza progetto» finito in una riga sua, o un `done`
 * contato fra gli aperti — e sullo schermo si vedrebbe solo come un numero
 * plausibile ma sbagliato.
 *
 * @covers KANBAN-06
 */
import { describe, test, expect } from 'bun:test';
import { projectTaskCounts, countsSummary } from './projectTaskCounts';
import { STATUS_LABEL } from './board';
import type { BoardTask, TaskStatus } from './board';

const task = (projectId: string, status: TaskStatus): BoardTask =>
  ({ id: `${projectId}-${status}-${Math.random()}`, projectId, status, priority: 2, text: 'x', labels: [] }) as unknown as BoardTask;

describe('projectTaskCounts', () => {
  test('separa gli stati e non conta i chiusi fra gli aperti', () => {
    const counts = projectTaskCounts(
      [
        task('a', 'backlog'), task('a', 'todo'), task('a', 'in_progress'),
        task('a', 'review'), task('a', 'done'), task('a', 'done'),
        task('b', 'review'),
      ],
      (t) => t.projectId,
    );
    expect(counts.a).toEqual({ review: 1, inProgress: 1, queued: 2, open: 4, done: 2, total: 6 });
    expect(counts.b).toEqual({ review: 1, inProgress: 0, queued: 0, open: 1, done: 0, total: 1 });
  });

  test('la chiave la decide il chiamante: due id senza progetto fanno una riga sola', () => {
    const counts = projectTaskCounts(
      [task('_none', 'todo'), task('generale-9f2c', 'review'), task('a', 'todo')],
      (t) => (t.projectId === '_none' || t.projectId.startsWith('generale-') ? '__unassigned' : t.projectId),
    );
    expect(counts.__unassigned?.total).toBe(2);
    expect(counts.__unassigned?.review).toBe(1);
    expect(counts.a?.total).toBe(1);
  });

  test('una lista vuota (o assente) non inventa progetti', () => {
    expect(projectTaskCounts([], (t) => t.projectId)).toEqual({});
    expect(projectTaskCounts(null, (t) => t.projectId)).toEqual({});
  });

  test('il riassunto per il tooltip nomina tutti gli stati, zeri compresi', () => {
    const counts = projectTaskCounts([task('a', 'review')], (t) => t.projectId);
    const s = countsSummary(counts.a!, STATUS_LABEL);
    expect(s).toContain(`${STATUS_LABEL.review}: 1`);
    expect(s).toContain(`${STATUS_LABEL.in_progress}: 0`);
    expect(s).toContain('in coda: 0');
  });
});
