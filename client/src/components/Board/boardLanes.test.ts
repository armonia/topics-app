/**
 * The board grouped by project, its drop ids and the view preferences.
 *
 * @covers KANBAN-107
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type BoardTask } from '../../lib/board';
import { columnIdOfDropTarget, dropsOnOtherProject, laneDropId, projectIdOfDropTarget, taskWaitsOnPerson, toggleCollapsed } from './boardLanes';
import {
  BOARD_COLLAPSED_PROJECTS_STORAGE_KEY, BOARD_GROUP_BY_STORAGE_KEY,
  BOARD_THEN_BY_STORAGE_KEY, readBoardGroupBy, readBoardThenBy, readCollapsedProjects, writeBoardPreference, writeCollapsedProjects,
} from './boardGeometry';

/** A card with the fields the lane's «waits for the person» rule reads. */
const cardOf = (id: string, projectId: string, fields: Partial<BoardTask> = {}): BoardTask => ({ id, projectId, status: 'todo', ...fields } as BoardTask);

describe('taskWaitsOnPerson', () => {
  test('review, a question, a human ask, a «waits» line and a parked card wait; a done card or one in the CI column do not', () => {
    expect(taskWaitsOnPerson(cardOf('a', 'p', { status: 'review' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('b', 'p', { status: 'in_progress', awaitingAnswer: true }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('c', 'p', { status: 'review', humanAsk: 'Ti piace?' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('d', 'p', { status: 'backlog', descriptionPreview: 'Piano.\naspetta: attilio' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('e', 'p', { status: 'backlog', dispatchState: 'failed' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('f', 'p', { status: 'review', stage: 'ci' }))).toBe(false);
    expect(taskWaitsOnPerson(cardOf('g', 'p', { status: 'done', awaitingAnswer: true }))).toBe(false);
    expect(taskWaitsOnPerson(cardOf('h', 'p', { status: 'todo' }))).toBe(false);
  });
});

describe('lane drop ids', () => {
  test('round trip to the workflow column, plain ids untouched', () => {
    expect(columnIdOfDropTarget(laneDropId('ci', 'proj-x'))).toBe('ci');
    expect(columnIdOfDropTarget('todo')).toBe('todo');
    expect(columnIdOfDropTarget('3f2a-task-id')).toBe('3f2a-task-id');
  });
  test('two lanes never share a droppable id', () => {
    expect(laneDropId('todo', 'p1')).not.toBe(laneDropId('todo', 'p2'));
  });
});

describe('a drop in the lane of another project', () => {
  const card = { projectId: 'p1' };
  const noCards = () => undefined;
  test('the lane of the same project is a normal drop', () => {
    expect(projectIdOfDropTarget(laneDropId('todo', 'p1'))).toBe('p1');
    expect(dropsOnOtherProject(card, laneDropId('todo', 'p1'), noCards)).toBe(false);
  });
  test('the lane of another project is refused', () => {
    expect(dropsOnOtherProject(card, laneDropId('todo', 'p2'), noCards)).toBe(true);
  });
  test('a card of another project counts, a card of the same project does not', () => {
    const owner = (id: string) => (id === 'c-other' ? 'p2' : id === 'c-same' ? 'p1' : undefined);
    expect(dropsOnOtherProject(card, 'c-other', owner)).toBe(true);
    expect(dropsOnOtherProject(card, 'c-same', owner)).toBe(false);
  });
  test('the flat board has no lanes: plain column ids and no target are never refused', () => {
    expect(projectIdOfDropTarget('todo')).toBeNull();
    expect(dropsOnOtherProject(card, 'todo', noCards)).toBe(false);
    expect(dropsOnOtherProject(card, null, noCards)).toBe(false);
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

  test('defaults: flat board, nothing folded', () => {
    install(fake);
    expect(readBoardGroupBy()).toBe('none');
    expect(readCollapsedProjects().size).toBe(0);
  });

  test('stored values come back, unknown ones fall to the default', () => {
    install(fake);
    writeBoardPreference(BOARD_GROUP_BY_STORAGE_KEY, 'project');
    expect(readBoardGroupBy()).toBe('project');
    store.set(BOARD_GROUP_BY_STORAGE_KEY, 'bogus');
    expect(readBoardGroupBy()).toBe('none');
    // `closer` was renamed `owner`: a board grouped by it before stays grouped.
    store.set(BOARD_GROUP_BY_STORAGE_KEY, 'closer');
    expect(readBoardGroupBy()).toBe('owner');
  });

  test('the choice is kept per board; a board that never chose reads the old global key', () => {
    install(fake);
    writeBoardPreference(BOARD_GROUP_BY_STORAGE_KEY, 'project');
    writeBoardPreference(`${BOARD_GROUP_BY_STORAGE_KEY}:b1`, 'owner');
    writeBoardPreference(`${BOARD_THEN_BY_STORAGE_KEY}:b1`, 'priority');
    expect(readBoardGroupBy('b1')).toBe('owner');
    expect(readBoardThenBy('b1')).toBe('priority');
    expect(readBoardGroupBy('b2')).toBe('project');
    expect(readBoardThenBy('b2')).toBe('none');
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
    expect(readCollapsedProjects().size).toBe(0);
    expect(() => writeBoardPreference(BOARD_GROUP_BY_STORAGE_KEY, 'project')).not.toThrow();
  });
});
