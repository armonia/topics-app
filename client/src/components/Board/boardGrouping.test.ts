/**
 * The two-level grouper: group order, counts and the «no value» bucket.
 *
 * @covers KANBAN-107
 */
import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import { effectiveLevels, groupKeysFor, groupTasks, groupValue, laneProjectOf, leavesOf, projectOfPath, NO_VALUE, PATH_SEPARATOR, type GroupContext } from './boardGrouping';

const card = (id: string, fields: Partial<BoardTask> = {}): BoardTask =>
  ({ id, projectId: 'p1', status: 'todo', priority: 2, assignedTo: null, createdBy: 'human', ...fields } as BoardTask);

const names: Record<string, string> = { p1: 'Zeta', p2: 'Alfa' };
const ctx: GroupContext = { nameOfProject: (id) => names[id] ?? id, statusOrder: ['todo', 'in_progress', 'review', 'done'] };

const tasks = [
  card('a', { projectId: 'p1', assignedTo: 'bob', createdBy: 'agent:jarvis' }),
  card('b', { projectId: 'p2', assignedTo: 'amy', createdBy: 'cron:nightly' }),
  card('c', { projectId: 'p1', assignedTo: null, createdBy: 'agent:other' }),
  card('d', { projectId: 'p2', assignedTo: 'amy', priority: 4 }),
  card('e', { projectId: 'p1', assignedTo: 'amy', status: 'review', humanAsk: 'look' } as Partial<BoardTask>),
];

describe('groupTasks, one level', () => {
  test('projects: the one waiting for the person first, then by name', () => {
    const groups = groupTasks(tasks, ['project'], ctx);
    expect(groups.map((g) => g.key)).toEqual(['p1', 'p2']);
    expect(groups.map((g) => g.count)).toEqual([3, 2]);
  });
  test('assignee: by name, cards with nobody in «none», last', () => {
    const groups = groupTasks(tasks, ['assignee'], ctx);
    expect(groups.map((g) => g.key)).toEqual(['amy', 'bob', NO_VALUE]);
    expect(groups.map((g) => g.count)).toEqual([3, 1, 1]);
  });
  test('owner: the person, then the main agent, other agents, schedules', () => {
    const keys = groupTasks(tasks, ['owner'], ctx).map((g) => g.key);
    expect(keys).toEqual(['me', 'agent:jarvis', 'agent:other', 'scheduled']);
  });
  test('priority: urgent first', () => {
    expect(groupTasks(tasks, ['priority'], ctx).map((g) => g.key)).toEqual(['4', '2']);
  });
  test('status follows the board order', () => {
    expect(groupTasks(tasks, ['status'], ctx).map((g) => g.key)).toEqual(['todo', 'review']);
  });
  test('no level means no groups; every card is counted exactly once', () => {
    expect(groupTasks(tasks, [], ctx)).toEqual([]);
    const groups = groupTasks(tasks, ['assignee'], ctx);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(tasks.length);
  });
});

describe('groupTasks, two levels', () => {
  const groups = groupTasks(tasks, ['project', 'assignee'], ctx);
  test('the second level splits every first-level group and keeps the counts', () => {
    expect(groups.map((g) => g.children.map((c) => [c.key, c.count]))).toEqual([
      [['amy', 1], ['bob', 1], [NO_VALUE, 1]],
      [['amy', 2]],
    ]);
  });
  test('paths are unique and leaves carry the cards', () => {
    const leaves = leavesOf(groups);
    expect(new Set(leaves.map((l) => l.path)).size).toBe(leaves.length);
    expect(leaves[0].path).toBe(`p1${PATH_SEPARATOR}amy`);
    expect(leaves.reduce((n, l) => n + l.tasks.length, 0)).toBe(tasks.length);
  });
  test('a third level is ignored', () => {
    const deep = groupTasks(tasks, ['project', 'assignee', 'priority'], ctx);
    expect(leavesOf(deep)[0].children).toEqual([]);
  });
  test('an empty project can be kept as a group', () => {
    const kept = groupTasks(tasks, ['project'], { ...ctx, keepEmptyProject: 'p9' });
    expect(kept.find((g) => g.key === 'p9')?.count).toBe(0);
  });
});

describe('effectiveLevels', () => {
  test('the kanban drops «status»; the second level needs a first and differs from it', () => {
    expect(effectiveLevels('status', 'project', 'grid')).toEqual([]);
    expect(effectiveLevels('project', 'project', 'list')).toEqual(['project']);
    expect(effectiveLevels('none', 'project', 'list')).toEqual([]);
    expect(effectiveLevels('project', 'owner', 'plan')).toEqual(['project', 'owner']);
  });
  test('the cards view is grouped by owner until another level is chosen; the workflow view has no groups', () => {
    expect(effectiveLevels('none', 'none', 'plan')).toEqual(['owner']);
    expect(effectiveLevels('none', 'priority', 'plan')).toEqual(['owner', 'priority']);
    expect(groupKeysFor('plan')).not.toContain('none');
    expect(effectiveLevels('project', 'owner', 'workflow')).toEqual([]);
  });
});

describe('menus and paths', () => {
  test('the kanban hides «status», a one-project board hides «project»', () => {
    expect(groupKeysFor('grid')).not.toContain('status');
    expect(groupKeysFor('list')).toContain('status');
    expect(groupKeysFor('list', false)).not.toContain('project');
    expect(effectiveLevels('project', 'owner', 'list', false)).toEqual([]);
  });
  test('the project of a path, at either level', () => {
    expect(projectOfPath(`p1${PATH_SEPARATOR}amy`, ['project', 'assignee'])).toBe('p1');
    expect(projectOfPath(`amy${PATH_SEPARATOR}p2`, ['assignee', 'project'])).toBe('p2');
    expect(projectOfPath('amy', ['assignee'])).toBeNull();
  });
});

describe('accorpa: a merged project shares its parent lane', () => {
  // p3 is merged into p1; p2 has no family.
  const parentOf = new Map([['p3', 'p1']]);
  const family = [...tasks, card('f', { projectId: 'p3' }), card('g', { projectId: 'p3', assignedTo: 'amy' })];

  test('groupValue maps a child board id to its parent, and leaves everyone else alone', () => {
    expect(groupValue(card('x', { projectId: 'p3' }), 'project', null, parentOf)).toBe('p1');
    expect(groupValue(card('x', { projectId: 'p1' }), 'project', null, parentOf)).toBe('p1');
    expect(groupValue(card('x', { projectId: 'p2' }), 'project', null, parentOf)).toBe('p2');
    expect(groupValue(card('x', { projectId: 'p3' }), 'project')).toBe('p3');
    expect(groupValue(card('x', { projectId: '' }), 'project', null, parentOf)).toBe(NO_VALUE);
    expect(laneProjectOf('p3', parentOf)).toBe('p1');
  });
  test('only the project key is affected by the map', () => {
    expect(groupValue(card('x', { projectId: 'p3', assignedTo: 'amy' }), 'assignee', null, parentOf)).toBe('amy');
  });
  test('the project lanes: the child cards sit in the parent lane, no lane of their own', () => {
    const groups = groupTasks(family, ['project'], { ...ctx, projectParent: parentOf });
    expect(groups.map((g) => [g.key, g.count])).toEqual([['p1', 5], ['p2', 2]]);
    expect(groups.find((g) => g.key === 'p1')!.tasks.map((t) => t.id)).toContain('f');
  });
  test('without the map the child keeps a lane of its own (separa)', () => {
    expect(groupTasks(family, ['project'], ctx).map((g) => g.key).sort()).toEqual(['p1', 'p2', 'p3']);
  });
  test('the composer ghost lane of a merged project opens in the parent lane', () => {
    const groups = groupTasks([card('only', { projectId: 'p2' })], ['project'], { ...ctx, projectParent: parentOf, keepEmptyProject: 'p3' });
    expect(groups.map((g) => g.key).sort()).toEqual(['p1', 'p2']);
  });
  test('two levels keep the merge at the project level', () => {
    const groups = groupTasks(family, ['project', 'assignee'], { ...ctx, projectParent: parentOf });
    const p1 = groups.find((g) => g.key === 'p1')!;
    expect(leavesOf([p1]).map((l) => l.path.split(PATH_SEPARATOR)[0])).toEqual(Array(p1.children.length).fill('p1'));
  });
});
