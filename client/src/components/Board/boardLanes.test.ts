/**
 * The board grouped by project, its drop ids and the view preferences.
 *
 * @covers KANBAN-107
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AUTO_PROJECT_ID, type BoardTask } from '../../lib/board';
import { columnIdOfDropTarget, dropsOnOtherProject, laneDropId, projectIdOfDropTarget, splitIntoLanes, taskWaitsOnPerson, toggleCollapsed, withDraftLane } from './boardLanes';
import { draftLaneOf, type DraftPreview } from './draftPreview';
import {
  BOARD_COLLAPSED_PROJECTS_STORAGE_KEY, BOARD_GROUP_BY_STORAGE_KEY,
  readBoardGroupBy, readCollapsedProjects, writeBoardPreference, writeCollapsedProjects,
} from './boardGeometry';

const task = (id: string, projectId: string): BoardTask => ({ id, projectId } as BoardTask);
const names: Record<string, string> = { p1: 'Zeta', p2: 'alfa', p3: 'Alfa' };
const nameOf = (id: string) => names[id] ?? id;
/** A card with the fields the lane's «waits for the person» rule reads. */
const cardOf = (id: string, projectId: string, fields: Partial<BoardTask> = {}): BoardTask => ({ id, projectId, status: 'todo', ...fields } as BoardTask);

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

describe('the lanes wait for the person first', () => {
  const columns = ['todo', 'review'];
  const lanesOf = (cards: BoardTask[]) => splitIntoLanes(
    new Map(columns.map((c) => [c, cards.filter((t) => (t.status === 'review') === (c === 'review'))])),
    columns,
    nameOf,
  );

  test('a project with a card in review goes before the others, which keep the name order', () => {
    // By name alone: alfa (p2), Alfa (p3), Zeta (p1). Zeta has the review card.
    const lanes = lanesOf([cardOf('a', 'p1', { status: 'review' }), cardOf('b', 'p2'), cardOf('c', 'p3')]);
    expect(lanes.map((l) => [l.projectId, l.waiting])).toEqual([['p1', true], ['p2', false], ['p3', false]]);
  });

  test('two waiting projects are told apart by name, then by id', () => {
    const lanes = lanesOf([cardOf('a', 'p1', { status: 'review' }), cardOf('b', 'p2', { status: 'review' }), cardOf('c', 'p3', { status: 'review' })]);
    expect(lanes.map((l) => l.projectId)).toEqual(['p2', 'p3', 'p1']);
  });

  test('a waiting card in the second column lifts its lane too, once', () => {
    const lanes = lanesOf([cardOf('a', 'p1'), cardOf('b', 'p1', { status: 'review' }), cardOf('c', 'p2')]);
    expect(lanes.map((l) => l.projectId)).toEqual(['p1', 'p2']);
    expect(lanes[0]!.total).toBe(2);
  });

  test('the caller can say that nothing waits (the archive): back to the name order', () => {
    const cards = [cardOf('a', 'p1', { status: 'review' }), cardOf('b', 'p2')];
    const byColumn = new Map([['todo', [cards[1]!]], ['review', [cards[0]!]]]);
    expect(splitIntoLanes(byColumn, columns, nameOf, () => false).map((l) => l.projectId)).toEqual(['p2', 'p1']);
  });

  test('the temporary lane of the composer sits among the others by the same rule', () => {
    const base = lanesOf([cardOf('a', 'p1', { status: 'review' }), cardOf('b', 'p2')]);
    const withEmpty = withDraftLane(base, { kind: 'new-lane', projectId: 'mid' }, columns, (id) => id);
    // The empty lane waits for nothing: after the waiting lane, then by name among the rest.
    expect(withEmpty.map((l) => l.projectId)).toEqual(['p1', 'mid', 'p2']);
  });
});

describe('taskWaitsOnPerson', () => {
  test('review, a question, a human ask, a «waits» line and a parked card wait; a done card or an AI review do not', () => {
    expect(taskWaitsOnPerson(cardOf('a', 'p', { status: 'review' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('b', 'p', { status: 'in_progress', awaitingAnswer: true }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('c', 'p', { status: 'review', stage: 'human_review', humanAsk: 'Ti piace?' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('d', 'p', { status: 'backlog', descriptionPreview: 'Piano.\naspetta: attilio' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('e', 'p', { status: 'backlog', dispatchState: 'failed' }))).toBe(true);
    expect(taskWaitsOnPerson(cardOf('f', 'p', { status: 'review', stage: 'ai_review' }))).toBe(false);
    expect(taskWaitsOnPerson(cardOf('g', 'p', { status: 'done', awaitingAnswer: true }))).toBe(false);
    expect(taskWaitsOnPerson(cardOf('h', 'p', { status: 'todo' }))).toBe(false);
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
    store.set(BOARD_GROUP_BY_STORAGE_KEY, 'status');
    expect(readBoardGroupBy()).toBe('none');
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

describe('one order and one ghost for the grouped board', () => {
  test("the composer's ghost: its project's lane, a temporary lane for an empty project, above the lanes for «Automatico»", () => {
    const draft: DraftPreview = { title: 't', description: null, status: 'todo', images: [], files: [], projectId: 'b' };
    // 1. the project has a lane
    expect(draftLaneOf(draft, ['a', 'b'])).toEqual({ kind: 'lane', projectId: 'b' });
    // 2. the project was chosen but has no card: its OWN temporary lane, never the first one
    expect(draftLaneOf({ ...draft, projectId: 'vuoto' }, ['a', 'b'])).toEqual({ kind: 'new-lane', projectId: 'vuoto' });
    expect(draftLaneOf({ ...draft, projectId: 'vuoto' }, [])).toEqual({ kind: 'new-lane', projectId: 'vuoto' });
    // 3. «Automatico» (or no project at all): above the lanes, no project
    expect(draftLaneOf({ ...draft, projectId: AUTO_PROJECT_ID }, ['a', 'b'])).toEqual({ kind: 'above' });
    expect(draftLaneOf({ ...draft, projectId: undefined }, ['a', 'b'])).toEqual({ kind: 'above' });
    // 4. nothing being written
    expect(draftLaneOf(null, ['a'])).toBeNull();
  });

  test('the temporary lane takes its sorted place and exists only for the new-lane case', () => {
    const ids = ['todo', 'done'];
    const base = splitIntoLanes(new Map([['todo', [task('1', 'alfa')]], ['done', [task('2', 'zeta')]]]), ids, (id) => id);
    const nameOf = (id: string) => id;
    const withEmpty = withDraftLane(base, { kind: 'new-lane', projectId: 'mid' }, ids, nameOf);
    expect(withEmpty.map((l) => l.projectId)).toEqual(['alfa', 'mid', 'zeta']);
    expect(withEmpty[1]!.total).toBe(0);
    expect(withEmpty[1]!.columns.get('todo')).toEqual([]);
    expect(withDraftLane(base, { kind: 'lane', projectId: 'alfa' }, ids, nameOf).map((l) => l.projectId)).toEqual(['alfa', 'zeta']);
    expect(withDraftLane(base, { kind: 'above' }, ids, nameOf).map((l) => l.projectId)).toEqual(['alfa', 'zeta']);
    expect(withDraftLane(base, null, ids, nameOf).map((l) => l.projectId)).toEqual(['alfa', 'zeta']);
    // The base lanes are not touched: the lane lives only while the ghost does.
    expect(base.map((l) => l.projectId)).toEqual(['alfa', 'zeta']);
  });
});
