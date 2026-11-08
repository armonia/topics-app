/**
 * The SKELETON of a session's active thread: who comes after whom, without the
 * contents.
 *
 * `GET /api/topics/:id/messages?limit=200` answered with 200 messages out of
 * 3000 but read the text of all 3000 from SQLite (5.8 ms out of 8.7) only to
 * throw 2800 away. Picking WHICH messages go out takes four columns: id,
 * parent, branch index and the `partial` flag. This module is the walk over the
 * thread, extracted from `loadActiveThread` (server/utils.ts) with the same
 * semantics so it can be proven on its own; the real rows are read afterwards,
 * only for the window that goes out.
 */

/** The only columns needed to decide the order of the thread. */
export interface SkeletonRow {
  id: string;
  parent_id: string | null;
  branch_index: number | null;
  partial: number | null;
}

/** A node of the active thread: the row and the two annotations the client expects. */
export interface SkeletonNode<R extends SkeletonRow = SkeletonRow> {
  row: R;
  siblingCount: number;
  activeBranchIndex: number;
}

/**
 * Walks from the roots following the active branch of each level. Rows come in
 * `sort_order` (the sort by `branch_index` is stable, so ties come out in
 * chronological order). Same rules as `loadActiveThread`: at a fork the active
 * branch is asked of `activeBranchOf` (key `__root__` for roots); if no child
 * matches, the first is taken; if two siblings share the index both come out;
 * a cycle is cut instead of spinning.
 */
export function walkActiveThread<R extends SkeletonRow>(
  rows: readonly R[],
  activeBranchOf: (lookupKey: string) => number | undefined,
  warn: (msg: string) => void = () => {},
): SkeletonNode<R>[] {
  const childrenMap = new Map<string | null, R[]>();
  for (const row of rows) {
    const pid = row.parent_id || null;
    let list = childrenMap.get(pid);
    if (!list) childrenMap.set(pid, (list = []));
    list.push(row);
  }
  for (const children of childrenMap.values()) {
    // A single child (the normal thread, almost every level) has nothing to sort.
    if (children.length > 1) children.sort((a, b) => (a.branch_index || 0) - (b.branch_index || 0));
  }

  const thread: SkeletonNode<R>[] = [];
  const visited = new Set<string>();

  const walk = (currentParentId: string | null): void => {
    const children = childrenMap.get(currentParentId);
    if (!children || children.length === 0) return;

    // A single child is always the chosen one: if its index matches the active
    // one (0, with no fork) it is it, and if it does not the fallback to the
    // first applies, which is still it.
    let selected = children;
    if (children.length > 1) {
      let activeBranchIndex = 0;
      const active = activeBranchOf(currentParentId === null ? "__root__" : currentParentId);
      if (active !== undefined) activeBranchIndex = active;
      selected = children.filter((c) => (c.branch_index || 0) === activeBranchIndex);
      if (selected.length === 0) selected = [children[0]!];
      if (selected.length > 1) {
        warn(`${selected.length} siblings share branch_index ${activeBranchIndex} under ${currentParentId ?? "__root__"}`);
      }
    }
    for (const child of selected) {
      if (visited.has(child.id)) {
        warn(`cyclic message chain at ${child.id}`);
        continue;
      }
      visited.add(child.id);
      thread.push({ row: child, siblingCount: children.length, activeBranchIndex: child.branch_index || 0 });
      walk(child.id);
    }
  };

  walk(null);
  return thread;
}
