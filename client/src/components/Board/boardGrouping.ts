/**
 * The board's GROUPING, up to two levels deep («group by», then «and then by»).
 * Pure, so the order of the groups, their counts and the «no value» bucket are
 * tested without a DOM (boardGrouping.test.ts).
 *
 * Grouping never reorders cards inside a group: a leaf keeps the order the
 * tasks arrived in, which is the board's own order.
 */
import type { BoardTask } from '../../lib/board';
import { splitCreatedBy } from '../../../../shared/created-by';
import { taskWaitsOnPerson } from './boardLanes';
import { compareProjectGroups } from '../../../../shared/project-order';
import { PRIORITY_ORDER } from './constants';
import { GROUP_KEYS, type BoardGroupBy } from './boardGeometry';

export type GroupKey = BoardGroupBy;

/** Who closes a card: the person, Jarvis, any other agent, a schedule, or nobody in particular. */
export const CLOSERS = ['me', 'jarvis', 'agents', 'scheduled'] as const;
export type Closer = (typeof CLOSERS)[number];

/** The value of a card for «no value»: its group sits last, whatever the level. */
export const NO_VALUE = '_none';

/** Separates the keys of a path (level 1, level 2) inside one string id. */
export const PATH_SEPARATOR = '\u001f';

/** What the «group by» menus offer: not the status in the kanban (its columns already ARE the status), not the project on a one-project board. */
export function groupKeysFor(view: 'grid' | 'list' | 'plan', hasProjects = true): GroupKey[] {
  return GROUP_KEYS.filter((k) => (view !== 'grid' || k !== 'status') && (hasProjects || k !== 'project'));
}

/** The project a group's path stands for, when one of the two levels is the project. */
export function projectOfPath(path: string, levels: readonly GroupKey[]): string | null {
  const at = levels.indexOf('project');
  return at === -1 ? null : path.split(PATH_SEPARATOR)[at] ?? null;
}

/**
 * The two levels as the view can really draw them: the second level needs a
 * first, differs from it, and the kanban never groups by status.
 */
export function effectiveLevels(first: GroupKey, second: GroupKey, view: 'grid' | 'list' | 'plan', hasProjects = true): GroupKey[] {
  const allowed = (k: GroupKey) => k !== 'none' && (view !== 'grid' || k !== 'status') && (hasProjects || k !== 'project');
  const one = allowed(first) ? first : 'none';
  if (one === 'none') return [];
  return allowed(second) && second !== one ? [one, second] : [one];
}

/** Exclusive on purpose: a card has ONE closer, in the order of who is asked to act first. */
export function closerOf(task: BoardTask): Closer | null {
  if (taskWaitsOnPerson(task)) return 'me';
  const by = splitCreatedBy(task.createdBy);
  if (by?.kind === 'cron' || task.scheduled) return 'scheduled';
  if (by?.kind === 'agent') return by.name?.toLowerCase() === 'jarvis' ? 'jarvis' : 'agents';
  return null;
}

export function groupValue(task: BoardTask, key: GroupKey): string {
  switch (key) {
    case 'none': return NO_VALUE;
    case 'project': return task.projectId || NO_VALUE;
    case 'status': return task.status;
    case 'assignee': return task.assignedTo?.trim() || NO_VALUE;
    case 'closer': return closerOf(task) ?? NO_VALUE;
    case 'priority': return String(task.priority);
  }
}

export interface GroupNode {
  /** The value of this level. */
  key: string;
  /** The ids of the levels above plus this one, unique in the whole tree. */
  path: string;
  /** Every card under this group, children included. */
  count: number;
  tasks: BoardTask[];
  /** Empty at the last level. */
  children: GroupNode[];
  /** Something under it waits for the person (projects with work for them go first). */
  waiting: boolean;
}

export interface GroupContext {
  nameOfProject: (projectId: string) => string;
  /** The status order of the board, for `status`. */
  statusOrder: readonly string[];
  /** A group that must exist even with no card (the composer's ghost lane). */
  keepEmptyProject?: string | null;
}

const BY_NAME = new Intl.Collator('en', { sensitivity: 'base' });

function compareGroups(level: GroupKey, ctx: GroupContext): (a: GroupNode, b: GroupNode) => number {
  const last = (a: GroupNode, b: GroupNode) => (a.key === NO_VALUE ? 1 : 0) - (b.key === NO_VALUE ? 1 : 0);
  switch (level) {
    case 'project': return (a, b) => last(a, b) || compareProjectGroups(
      { projectId: a.key, name: ctx.nameOfProject(a.key), waiting: a.waiting },
      { projectId: b.key, name: ctx.nameOfProject(b.key), waiting: b.waiting });
    case 'status': return (a, b) => ctx.statusOrder.indexOf(a.key) - ctx.statusOrder.indexOf(b.key);
    case 'closer': return (a, b) => last(a, b) || CLOSERS.indexOf(a.key as Closer) - CLOSERS.indexOf(b.key as Closer);
    case 'priority': return (a, b) => PRIORITY_ORDER.indexOf(Number(a.key) as never) - PRIORITY_ORDER.indexOf(Number(b.key) as never);
    default: return (a, b) => last(a, b) || BY_NAME.compare(a.key, b.key) || (a.key < b.key ? -1 : 1);
  }
}

function build(tasks: readonly BoardTask[], levels: readonly GroupKey[], ctx: GroupContext, parent: string): GroupNode[] {
  const [level, ...rest] = levels;
  if (!level || level === 'none') return [];
  const buckets = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    const value = groupValue(task, level);
    const list = buckets.get(value);
    if (list) list.push(task); else buckets.set(value, [task]);
  }
  if (level === 'project' && !parent && ctx.keepEmptyProject && !buckets.has(ctx.keepEmptyProject)) buckets.set(ctx.keepEmptyProject, []);
  const nodes = [...buckets].map(([key, list]): GroupNode => {
    const path = parent ? `${parent}${PATH_SEPARATOR}${key}` : key;
    return {
      key, path, count: list.length, tasks: list, waiting: list.some(taskWaitsOnPerson),
      children: build(list, rest, ctx, path),
    };
  });
  return nodes.sort(compareGroups(level, ctx));
}

/** The groups of `tasks` for up to two levels; no level = no groups (the caller draws the flat board). */
export function groupTasks(tasks: readonly BoardTask[], levels: readonly GroupKey[], ctx: GroupContext): GroupNode[] {
  return build(tasks, levels.slice(0, 2), ctx, '');
}

/** The leaves of a tree, in display order. */
export function leavesOf(nodes: readonly GroupNode[]): GroupNode[] {
  return nodes.flatMap((n) => (n.children.length ? leavesOf(n.children) : [n]));
}
