/**
 * Accorpa in the sidebar: the topics of a project merged into a parent sit under
 * the parent's entry, and the merged project no longer has a row of its own.
 *
 * Pure on purpose, like `buildSidebarItems`: rows in, rows out, no store. It runs
 * AFTER the builder, so every rule that decides which rows exist (open tabs,
 * unread, pins, archive) is already applied; this only moves rows between two
 * project entries and recomputes what the parent says about them.
 *
 * What stays as it was: `separa` links (the caller only passes merging ones), a
 * merged project the person pinned (they asked for its own row), and every row
 * whose parent has no entry and no known path (nothing to fold into).
 */
import { projectIdForPath } from '../../../shared/board';
import { byAttentionThenActivity, type SidebarItem } from './buildSidebarItems';
import { getProjectLabel } from './projectLabel';

export interface FoldDeps {
  /** The folder of a board id, for a parent that has no entry yet (a parent with no topics of its own). */
  pathOfBoard?: (boardId: string) => string | undefined;
}

const boardOf = (item: SidebarItem): string | null => (item.type === 'project' && item.projectPath ? projectIdForPath(item.projectPath) : null);

/**
 * `parentOf`: child board id to parent board id, for merging links only
 * (`mergedParentMap` in `shared/project-family.ts`).
 */
export function foldMergedProjects(
  items: readonly SidebarItem[],
  parentOf: ReadonlyMap<string, string>,
  deps: FoldDeps = {},
): SidebarItem[] {
  if (parentOf.size === 0) return items as SidebarItem[];

  const folded = new Map<string, SidebarItem[]>(); // parent board id -> merged child entries
  const kept: SidebarItem[] = [];
  const entryOfBoard = new Map<string, SidebarItem>();
  for (const item of items) {
    const board = boardOf(item);
    if (board) entryOfBoard.set(board, item);
  }

  for (const item of items) {
    const board = boardOf(item);
    const parentBoard = board ? parentOf.get(board) : undefined;
    const canFold = parentBoard !== undefined && !item.pinned && (entryOfBoard.has(parentBoard) || deps.pathOfBoard?.(parentBoard) !== undefined);
    if (canFold) {
      const list = folded.get(parentBoard!) ?? [];
      list.push(item);
      folded.set(parentBoard!, list);
    } else {
      kept.push(item);
    }
  }
  if (folded.size === 0) return items as SidebarItem[];

  const merge = (parent: SidebarItem, kids: readonly SidebarItem[]): SidebarItem => {
    const moved = kids.flatMap((kid) => {
      const label = getProjectLabel(kid.projectPath ?? kid.name);
      return (kid.children ?? []).map((row) => ({ ...row, viaProject: row.viaProject ?? label }));
    });
    const children = [...(parent.children ?? []), ...moved].sort(byAttentionThenActivity);
    const lit = [parent, ...kids].filter((p) => p.notificationCount > 0);
    return {
      ...parent,
      children,
      lastActivity: Math.max(parent.lastActivity, ...kids.map((k) => k.lastActivity)),
      notificationCount: [parent, ...kids].reduce((n, p) => n + p.notificationCount, 0),
      ...(lit.length > 0 ? { litSince: Math.max(...lit.map((p) => p.litSince ?? 0)) } : {}),
      // A project is archived when ALL its topics are, whichever entry they sit in.
      archived: parent.archived && kids.every((k) => k.archived),
    };
  };

  const out: SidebarItem[] = [];
  const placed = new Set<string>();
  for (const item of kept) {
    const board = boardOf(item);
    const kids = board ? folded.get(board) : undefined;
    if (board && kids) {
      out.push(merge(item, kids));
      placed.add(board);
    } else {
      out.push(item);
    }
  }
  // A parent without an entry of its own: born from its first merged child, at the child's place.
  for (const [parentBoard, kids] of folded) {
    if (placed.has(parentBoard)) continue;
    const path = deps.pathOfBoard?.(parentBoard);
    if (path === undefined) continue;
    const seed: SidebarItem = {
      id: `project:${path}`,
      type: 'project',
      name: getProjectLabel(path),
      icon: 'folder',
      lastActivity: 0,
      notificationCount: 0,
      archived: true,
      projectPath: path,
      children: [],
    };
    out.push(merge(seed, kids));
  }
  // The builder sorts the list lit-first then by activity; a merged parent now says more, so it goes back in order.
  return out.sort(byAttentionThenActivity);
}
