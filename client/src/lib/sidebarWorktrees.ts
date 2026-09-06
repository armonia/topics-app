/**
 * Where a project's topics stand with respect to its worktrees, for the sidebar.
 *
 * A topic bound to a worktree works on its own branch, in its own checkout,
 * and until now the sidebar drew it exactly like a topic that works in the
 * project's main checkout: same row, same indent, same section. The two are
 * not the same thing, and the difference is the one a person needs when three
 * chats of one project are editing three branches at once.
 *
 * Two answers come out of this module, both keyed on `topic.worktreeId` — the
 * same fact the changed-files strip already reads (`changesStripBranch.ts`),
 * so the sidebar and the strip cannot disagree about which topics have a
 * branch of their own:
 *
 *  · `worktreeChipFor` — the chip a topic row wears. The worktree entity gives
 *    it a name and a branch; when the list has not answered yet the chip still
 *    shows (the binding is a fact of the topic), just without a name.
 *  · `groupProjectChildrenByWorktree` — the sub-sections of a project. They
 *    appear only when live topics sit on MORE THAN ONE worktree: with a single
 *    worktree the chip already says everything a header would repeat, and a
 *    section of one is a header for nothing.
 *
 * Pure on purpose, like `buildSidebarItems`: rows in, rows out, no store.
 */
import type { SidebarItem } from './buildSidebarItems';
import type { Topic, Worktree } from '../types';

/** What a row or a section header needs to know about a worktree. */
export type WorktreeLabel = Pick<Worktree, 'id' | 'name' | 'branchName'>;

export interface WorktreeSection {
  worktreeId: string;
  /** `null` while the worktree list has not answered (or the id is stale). */
  worktree: WorktreeLabel | null;
  items: SidebarItem[];
}

export interface WorktreeGrouping {
  /** Rows that work in the project's own checkout: chats without a binding,
   *  and every terminal and browser (they have no binding at all). */
  base: SidebarItem[];
  /** One per worktree, in order of first appearance among `children` — which
   *  the builder already sorted by activity, so the busiest worktree comes
   *  first. Empty unless at least two worktrees carry live topics. */
  sections: WorktreeSection[];
}

/**
 * The chip a topic row wears, or `null` for a topic that works in the
 * project's own checkout. A bound topic whose worktree is not (yet) in the
 * map still gets a chip: the binding is the topic's fact, the name is the
 * list's, and the first must not wait for the second.
 */
export function worktreeChipFor(
  topic: Pick<Topic, 'worktreeId'>,
  worktreesById: ReadonlyMap<string, WorktreeLabel>,
): WorktreeLabel | null {
  if (!topic.worktreeId) return null;
  return worktreesById.get(topic.worktreeId) ?? { id: topic.worktreeId, name: '', branchName: null };
}

/** The worktree a project child is bound to; only chats can be. */
function boundWorktreeId(item: SidebarItem): string | null {
  return item.type === 'chat' ? (item.topic?.worktreeId ?? null) : null;
}

/**
 * Split a project's visible children into the base list and one section per
 * worktree. Relative order is preserved everywhere: the builder already
 * sorted these rows, and a section must read like the slice of that list it
 * is.
 */
export function groupProjectChildrenByWorktree(
  children: readonly SidebarItem[],
  worktreesById: ReadonlyMap<string, WorktreeLabel>,
): WorktreeGrouping {
  const base: SidebarItem[] = [];
  const byWorktree = new Map<string, SidebarItem[]>();
  for (const child of children) {
    const worktreeId = boundWorktreeId(child);
    if (!worktreeId) { base.push(child); continue; }
    const bucket = byWorktree.get(worktreeId);
    if (bucket) bucket.push(child);
    else byWorktree.set(worktreeId, [child]);
  }
  // One worktree (or none) is not a partition worth a header: everything
  // stays in the base list, and the chip on the row does the telling.
  if (byWorktree.size < 2) return { base: [...children], sections: [] };
  const sections: WorktreeSection[] = [];
  for (const [worktreeId, items] of byWorktree) {
    sections.push({ worktreeId, worktree: worktreesById.get(worktreeId) ?? null, items });
  }
  return { base, sections };
}
