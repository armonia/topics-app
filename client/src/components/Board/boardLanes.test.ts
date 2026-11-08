/**
 * The board grouped by project, its drop ids and the view preferences.
 *
 * @covers KANBAN-106
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import { columnIdOfDropTarget, laneDropId, sortProjectGroups, splitIntoLanes, toggleCollapsed } from './boardLanes';
import { draftLaneOf, type DraftPreview } from './draftPreview';
import {
  BOARD_COLLAPSED_PROJECTS_STORAGE_KEY, BOARD_DENSITY_STORAGE_KEY, BOARD_GROUP_BY_STORAGE_KEY,
  readBoardDensity, readBoardGroupBy, readCollapsedProjects, writeBoardPreference, writeCollapsedProjects,
} from './boardGeometry';

const task = (id: string, projectId: string): BoardTask => ({ id, projectId } as BoardTask);
const names: Record<string, string> = { p1: 'Zeta', p2: 'alfa', p3: 'Alfa' };
const nameOf = (id: string) => names[id] ?? id;

describe('splitIntoLanes', () => {
  const byColumn = new Map<string, BoardTask[]>([
    ['todo', [task('a', 'p1'), task('b', 'p2'), task('c', 'p1')]],
    ['in_progress', [task('d', 'p2')]],
    ['review', []],
  ]);
  const lanes = splitIntoLanes(byColumn, ['todo', 'in_progress', 'review'], nameOf);

  test('one lane per project, ordered by name ignoring case, ties by id', () => {
    expect(lanes.map((l) => l.projectId)).toEqual(['p2', 'p1']);
    const tie = splitIntoLanes(new Map([['todo', [task('x', 'p3'), task('y', 'p2')]]]), ['todo'], nameOf);
    expect(tie.map((l) => l.projectId)).toEqual(['p2', 'p3']);
  });

  test('keeps the board order inside each column and counts per column', () => {
    const p1 = lanes.find((l) => l.projectId === 'p1')!;
    expect(p1.columns.get('todo')!.map((t) => t.id)).toEqual(['a', 'c']);
    expect(p1.counts).toEqual({ todo: 2, in_progress: 0, review: 0 });
    expect(p1.total).toBe(2);
  });

  test('every column exists in every lane, empty or not', () => {
    for (const lane of lanes) expect([...lane.columns.keys()]).toEqual(['todo', 'in_progress', 'review']);
  });

  test('no cards, no lanes', () => {
    expect(splitIntoLanes(new Map(), ['todo'], nameOf)).toEqual([]);
  });
});

describe('lane drop ids', () => {
  test('round trip to the workflow column, plain ids untouched', () => {
    expect(columnIdOfDropTarget(laneDropId('ai_review', 'proj-x'))).toBe('ai_review');
    expect(columnIdOfDropTarget('todo')).toBe('todo');
    expect(columnIdOfDropTarget('3f2a-task-id')).toBe('3f2a-task-id');
  });
  test('two lanes never share a droppable id', () => {
    expect(laneDropId('todo', 'p1')).not.toBe(laneDropId('todo', 'p2'));
  });
});

describe('toggleCollapsed', () => {
  test('adds and removes without touching the input set', () => {
    const start = new Set(['p1']);
    const added = toggleCollapsed(start, 'p2');
    expect([...added].sort()).toEqual(['p1', 'p2']);
    expect([...toggleCollapsed(added, 'p1')]).toEqual(['p2']);
    expect([...start]).toEqual(['p1']);
  });
});

describe('view preferences', () => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  const install = (value: unknown) => Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
  afterEach(() => { store.clear(); install(original); });

  test('defaults: flat board, full cards, nothing folded', () => {
    install(fake);
    expect(readBoardGroupBy()).toBe('none');
    expect(readBoardDensity()).toBe('full');
    expect(readCollapsedProjects().size).toBe(0);
  });

  test('stored values come back, unknown ones fall to the default', () => {
    install(fake);
    writeBoardPreference(BOARD_GROUP_BY_STORAGE_KEY, 'project');
    writeBoardPreference(BOARD_DENSITY_STORAGE_KEY, 'compact');
    expect(readBoardGroupBy()).toBe('project');
    expect(readBoardDensity()).toBe('compact');
    store.set(BOARD_GROUP_BY_STORAGE_KEY, 'status');
    store.set(BOARD_DENSITY_STORAGE_KEY, 'tiny');
    expect(readBoardGroupBy()).toBe('none');
    expect(readBoardDensity()).toBe('full');
  });

  test('folded projects survive a write and a broken value reads as none', () => {
    install(fake);
    writeCollapsedProjects(new Set(['b', 'a']));
    expect(store.get(BOARD_COLLAPSED_PROJECTS_STORAGE_KEY)).toBe('["a","b"]');
    expect([...readCollapsedProjects()].sort()).toEqual(['a', 'b']);
    store.set(BOARD_COLLAPSED_PROJECTS_STORAGE_KEY, '{not json');
    expect(readCollapsedProjects().size).toBe(0);
    store.set(BOARD_COLLAPSED_PROJECTS_STORAGE_KEY, '[1,"ok"]');
    expect([...readCollapsedProjects()]).toEqual(['ok']);
  });

  test('a storage that throws never breaks the view', () => {
    install({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readBoardGroupBy()).toBe('none');
    expect(readBoardDensity()).toBe('full');
    expect(readCollapsedProjects().size).toBe(0);
    expect(() => writeBoardPreference(BOARD_DENSITY_STORAGE_KEY, 'compact')).not.toThrow();
  });
});

describe('one order and one ghost for the grouped board', () => {
  test('lanes and Plan tiles share the order: by name, ties on the id', () => {
    const groups = [{ projectId: 'z', name: 'zeta' }, { projectId: 'b', name: 'Alfa' }, { projectId: 'a', name: 'alfa' }];
    expect(sortProjectGroups(groups, (g) => g.name).map((g) => g.projectId)).toEqual(['a', 'b', 'z']);
    // The input is not reordered in place: the Plan sorts the server's array.
    expect(groups.map((g) => g.projectId)).toEqual(['z', 'b', 'a']);
  });

  test("the composer's ghost sits in its project's lane, else in the first, never in none", () => {
    const draft: DraftPreview = { title: 't', description: null, status: 'todo', images: [], files: [], projectId: 'b' };
    expect(draftLaneOf(draft, ['a', 'b'])).toBe('b');
    expect(draftLaneOf({ ...draft, projectId: 'auto' }, ['a', 'b'])).toBe('a');
    expect(draftLaneOf({ ...draft, projectId: undefined }, ['a', 'b'])).toBe('a');
    expect(draftLaneOf(null, ['a'])).toBeNull();
    expect(draftLaneOf(draft, [])).toBeNull();
  });
});
