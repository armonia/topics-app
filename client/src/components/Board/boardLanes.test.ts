/**
 * The board grouped by project: lanes and their drop ids.
 *
 * @covers KANBAN-106
 */
import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import { columnOfDropId, groupLanes, laneDropId } from './boardLanes';

const task = (id: string, projectId: string, status: BoardTask['status']) => ({ id, projectId, status }) as BoardTask;

describe('groupLanes', () => {
  const byColumn = new Map<string, BoardTask[]>([
    ['todo', [task('a', 'web', 'todo'), task('b', 'api', 'todo'), task('c', 'docs', 'todo')]],
    ['in_progress', [task('d', 'api', 'in_progress')]],
    ['review', []],
  ]);
  const lanes = groupLanes(byColumn, ['todo', 'in_progress', 'review'], (id) => id);

  test('one lane per project with a visible card, running work first, then by name', () => {
    expect(lanes.map((l) => l.projectId)).toEqual(['api', 'docs', 'web']);
  });

  test('each lane keeps every column, in the board order, with only its own cards', () => {
    const api = lanes[0];
    expect([...api.columns.keys()]).toEqual(['todo', 'in_progress', 'review']);
    expect(api.columns.get('todo')!.map((t) => t.id)).toEqual(['b']);
    expect(api.columns.get('in_progress')!.map((t) => t.id)).toEqual(['d']);
    expect(api.columns.get('review')).toEqual([]);
    expect(api.total).toBe(2);
    expect(api.active).toBe(1);
  });

  test('every card lands in exactly one lane', () => {
    const all = lanes.flatMap((l) => [...l.columns.values()].flat().map((t) => t.id)).sort();
    expect(all).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('lane drop ids', () => {
  test('a lane column id gives its column back; a plain id is itself', () => {
    expect(columnOfDropId(laneDropId('ai_review', 'web-x1y2'))).toBe('ai_review');
    expect(columnOfDropId('todo')).toBe('todo');
    expect(columnOfDropId('3f2a-card-id')).toBe('3f2a-card-id');
  });
});
