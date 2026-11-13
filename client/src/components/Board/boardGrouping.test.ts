/**
 * The two-level grouper: group order, counts and the «no value» bucket.
 *
 * @covers KANBAN-107
 */
import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import { effectiveLevels, groupKeysFor, groupTasks, leavesOf, projectOfPath, NO_VALUE, PATH_SEPARATOR, type GroupContext } from './boardGrouping';

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
  test('closer: fixed order, no value last', () => {
    const keys = groupTasks(tasks, ['closer'], ctx).map((g) => g.key);
    expect(keys).toEqual(['me', 'jarvis', 'agents', 'scheduled', NO_VALUE]);
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
    expect(effectiveLevels('project', 'closer', 'plan')).toEqual(['project', 'closer']);
  });
});

describe('menus and paths', () => {
  test('the kanban hides «status», a one-project board hides «project»', () => {
    expect(groupKeysFor('grid')).not.toContain('status');
    expect(groupKeysFor('list')).toContain('status');
    expect(groupKeysFor('list', false)).not.toContain('project');
    expect(effectiveLevels('project', 'closer', 'list', false)).toEqual([]);
  });
  test('the project of a path, at either level', () => {
    expect(projectOfPath(`p1${PATH_SEPARATOR}amy`, ['project', 'assignee'])).toBe('p1');
    expect(projectOfPath(`amy${PATH_SEPARATOR}p2`, ['assignee', 'project'])).toBe('p2');
    expect(projectOfPath('amy', ['assignee'])).toBeNull();
  });
});
