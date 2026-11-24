/**
 * Accorpa in the sidebar: merged projects fold under their parent entry.
 *
 * @covers WORKTREE-STD-06
 */
import { describe, expect, test } from 'bun:test';
import { projectIdForPath } from '../../../shared/board';
import type { SidebarItem } from './buildSidebarItems';
import { foldMergedProjects } from './sidebarProjectFamilies';

const PARENT = '/w/Shop/shopcms';
const CHILD = '/w/Shop/shopcms-moduli';
const OTHER = '/w/Other/acme-site';
const parentOf = new Map([[projectIdForPath(CHILD), projectIdForPath(PARENT)]]);

function chat(id: string, at: number, extra: Partial<SidebarItem> = {}): SidebarItem {
  return { id, type: 'chat', name: id, icon: '', lastActivity: at, notificationCount: 0, archived: false, ...extra };
}
function project(path: string, children: SidebarItem[], extra: Partial<SidebarItem> = {}): SidebarItem {
  return {
    id: `project:${path}`, type: 'project', name: path.split('/').pop()!, icon: 'folder',
    lastActivity: Math.max(0, ...children.map((c) => c.lastActivity)), notificationCount: 0, archived: false,
    projectPath: path, children, ...extra,
  };
}

describe('foldMergedProjects', () => {
  test('moves the merged project topics under the parent and drops its own row', () => {
    const items = [project(OTHER, [chat('o1', 50)]), project(PARENT, [chat('p1', 10)]), project(CHILD, [chat('c1', 30), chat('c2', 5)])];
    const out = foldMergedProjects(items, parentOf);
    expect(out.map((i) => i.projectPath)).toEqual([OTHER, PARENT]);
    const parent = out.find((i) => i.projectPath === PARENT)!;
    expect(parent.children!.map((c) => c.id)).toEqual(['c1', 'p1', 'c2']);
    expect(parent.children!.map((c) => c.viaProject)).toEqual(['shopcms-moduli', undefined, 'shopcms-moduli']);
  });

  test('separa (no link in the map) leaves everything as it was', () => {
    const items = [project(PARENT, [chat('p1', 10)]), project(CHILD, [chat('c1', 30)])];
    expect(foldMergedProjects(items, new Map())).toBe(items);
  });

  test('the parent carries the lit count, the activity and the lit-first order of the family', () => {
    const items = [
      project(OTHER, [chat('o1', 50)], { notificationCount: 0 }),
      project(PARENT, [chat('p1', 10)]),
      project(CHILD, [chat('c1', 30, { notificationCount: 2, litSince: 99 })], { notificationCount: 2, litSince: 99 }),
    ];
    const out = foldMergedProjects(items, parentOf);
    expect(out[0]!.projectPath).toBe(PARENT);
    expect(out[0]!.notificationCount).toBe(2);
    expect(out[0]!.litSince).toBe(99);
    expect(out[0]!.lastActivity).toBe(30);
  });

  test('a parent with no entry of its own is born from its merged child when its folder is known', () => {
    const items = [project(CHILD, [chat('c1', 30)])];
    const out = foldMergedProjects(items, parentOf, { pathOfBoard: (b) => (b === projectIdForPath(PARENT) ? PARENT : undefined) });
    expect(out.map((i) => [i.projectPath, i.name])).toEqual([[PARENT, 'shopcms']]);
    expect(out[0]!.children!.map((c) => c.id)).toEqual(['c1']);
    expect(out[0]!.archived).toBe(false);
  });

  test('with no entry and no known folder the merged project stays where it is', () => {
    const items = [project(CHILD, [chat('c1', 30)])];
    expect(foldMergedProjects(items, parentOf).map((i) => i.projectPath)).toEqual([CHILD]);
  });

  test('a merged project the person pinned keeps its own row', () => {
    const items = [project(CHILD, [chat('c1', 30)], { pinned: true }), project(PARENT, [chat('p1', 10)])];
    const out = foldMergedProjects(items, parentOf);
    expect(out.map((i) => i.projectPath)).toEqual([CHILD, PARENT]);
    expect(out[1]!.children!.map((c) => c.id)).toEqual(['p1']);
  });

  test('an archived family stays archived only when both entries are', () => {
    const items = [project(PARENT, [chat('p1', 10, { archived: true })], { archived: true }), project(CHILD, [chat('c1', 30)])];
    expect(foldMergedProjects(items, parentOf)[0]!.archived).toBe(false);
  });

  test('does not mutate the rows it was given', () => {
    const parent = project(PARENT, [chat('p1', 10)]);
    const child = project(CHILD, [chat('c1', 30)]);
    foldMergedProjects([parent, child], parentOf);
    expect(parent.children!.map((c) => c.id)).toEqual(['p1']);
    expect(child.children![0]!.viaProject).toBeUndefined();
  });
});
