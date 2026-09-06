/**
 * How a project's topics split by worktree in the sidebar.
 *
 * Three shapes, one input that matters (`topic.worktreeId`): no binding at all
 * gives no section; a single worktree gives the chip and no section, because a
 * header over one group would only repeat the chip; two worktrees give two
 * sections plus the base list, in the order the rows already had.
 *
 * @covers TOPIC-WT-02
 */
import { describe, test, expect } from 'bun:test';
import { groupProjectChildrenByWorktree, worktreeChipFor, type WorktreeLabel } from './sidebarWorktrees';
import type { SidebarItem } from './buildSidebarItems';
import type { Topic } from '../types';

const topic = (id: string, name: string, extra: Partial<Topic> = {}): Topic => ({
  id,
  name,
  slug: name.toLowerCase(),
  parentId: null,
  links: [],
  sessionKey: `topic:${id}`,
  color: '#0066cc',
  icon: '',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  archived: false,
  ...extra,
});

const chat = (id: string, worktreeId?: string | null): SidebarItem => ({
  id,
  type: 'chat',
  name: id,
  icon: '',
  lastActivity: 0,
  notificationCount: 0,
  archived: false,
  projectPath: '/work/app',
  topic: topic(id, id, { worktreeId }),
});

const terminal = (id: string): SidebarItem => ({
  id: `terminal:${id}`,
  type: 'terminal',
  name: id,
  icon: 'terminal',
  lastActivity: 0,
  notificationCount: 0,
  archived: false,
  projectPath: '/work/app',
});

const worktrees = new Map<string, WorktreeLabel>([
  ['wt-a', { id: 'wt-a', name: 'amber-fox', branchName: 'topics/amber-fox' }],
  ['wt-b', { id: 'wt-b', name: 'blue-owl', branchName: 'topics/blue-owl' }],
]);

describe('groupProjectChildrenByWorktree', () => {
  test('no worktree among the children: everything is base, no section', () => {
    const children = [chat('c1'), chat('c2', null), terminal('t1')];
    const { base, sections } = groupProjectChildrenByWorktree(children, worktrees);
    expect(sections).toEqual([]);
    expect(base.map((c) => c.id)).toEqual(['c1', 'c2', 'terminal:t1']);
  });

  test('one worktree: the chip tells, so no section is cut out', () => {
    const children = [chat('c1', 'wt-a'), chat('c2'), chat('c3', 'wt-a')];
    const { base, sections } = groupProjectChildrenByWorktree(children, worktrees);
    expect(sections).toEqual([]);
    expect(base.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(worktreeChipFor(children[0].topic!, worktrees)?.name).toBe('amber-fox');
    expect(worktreeChipFor(children[1].topic!, worktrees)).toBeNull();
  });

  test('two worktrees: one section each, in order of first appearance, and the rest stays base', () => {
    const children = [chat('c1', 'wt-b'), chat('c2'), chat('c3', 'wt-a'), terminal('t1'), chat('c4', 'wt-b')];
    const { base, sections } = groupProjectChildrenByWorktree(children, worktrees);
    expect(base.map((c) => c.id)).toEqual(['c2', 'terminal:t1']);
    expect(sections.map((s) => s.worktreeId)).toEqual(['wt-b', 'wt-a']);
    expect(sections[0].items.map((c) => c.id)).toEqual(['c1', 'c4']);
    expect(sections[1].items.map((c) => c.id)).toEqual(['c3']);
    expect(sections[0].worktree).toEqual({ id: 'wt-b', name: 'blue-owl', branchName: 'topics/blue-owl' });
  });

  test('a binding the list does not know keeps its section, without a label', () => {
    const children = [chat('c1', 'wt-a'), chat('c2', 'wt-gone')];
    const { sections } = groupProjectChildrenByWorktree(children, worktrees);
    expect(sections.map((s) => s.worktree)).toEqual([
      { id: 'wt-a', name: 'amber-fox', branchName: 'topics/amber-fox' },
      null,
    ]);
  });
});

describe('worktreeChipFor', () => {
  test('a topic without a binding wears no chip', () => {
    expect(worktreeChipFor({ worktreeId: null }, worktrees)).toBeNull();
    expect(worktreeChipFor({}, worktrees)).toBeNull();
  });

  test('a bound topic wears the chip even before the list has a name for it', () => {
    expect(worktreeChipFor({ worktreeId: 'wt-late' }, worktrees)).toEqual({ id: 'wt-late', name: '', branchName: null });
  });
});
