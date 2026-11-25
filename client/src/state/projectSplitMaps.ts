/**
 * The map of the splits INSIDE each project window, for the project's row in
 * the column (SPLIT-07).
 *
 * The top-level grid already publishes where each pane sits
 * (SplitPositionContext), so a project row could say where its window is, but
 * not how the window is divided: a project split in three showed the same row
 * as a project with one pane. Each ProjectWindow publishes its own layout
 * here, keyed by project path; the row reads it with `useProjectSplitMap`.
 *
 * A module store, like projectGridWeights: the publisher is a deep child of
 * the grid and the reader a sibling subtree, and only the rows of the projects
 * whose map changed re-render.
 */
import { useSyncExternalStore } from 'react';
import type { GroupLayoutRow } from '../types';
import type { SplitMapDescriptor } from '../components/Shared/SplitMiniMap';

/**
 * The descriptor of a project window's layout, or undefined when it holds a
 * single cell (nothing to orient against). A row that is one stacked column
 * is drawn as stacked rows, which is what the eye sees; stacks beside other
 * columns are drawn as their column, the size the map can still tell apart.
 */
export function projectSplitMap(
  rows: readonly GroupLayoutRow[],
  rowHeights: readonly number[] | undefined,
  activeGroupId: string | null,
): SplitMapDescriptor | undefined {
  const outRows: number[][] = [];
  const outHeights: number[] = [];
  let active: [number, number] = [0, 0];
  const evenHeights = !rowHeights || rowHeights.length !== rows.length;
  rows.forEach((row, ri) => {
    const rowShare = evenHeights ? 1 / Math.max(rows.length, 1) : rowHeights[ri];
    const lone = row.groupIds.length === 1 ? row.cellStacks?.[row.groupIds[0]] : undefined;
    if (lone && lone.groupIds.length > 0) {
      const members = [row.groupIds[0], ...lone.groupIds];
      const shares = lone.heights.length === members.length ? lone.heights : members.map(() => 1 / members.length);
      members.forEach((g, k) => {
        if (g === activeGroupId) active = [outRows.length, 0];
        outRows.push([1]);
        outHeights.push(rowShare * shares[k]);
      });
      return;
    }
    row.groupIds.forEach((g, ci) => {
      if (g === activeGroupId || (activeGroupId && row.cellStacks?.[g]?.groupIds.includes(activeGroupId))) active = [outRows.length, ci];
    });
    outRows.push([...row.widths]);
    outHeights.push(rowShare);
  });
  const cells = outRows.reduce((n, r) => n + r.length, 0);
  return cells > 1 ? { rows: outRows, rowHeights: outHeights, active } : undefined;
}

const maps = new Map<string, SplitMapDescriptor>();
const listeners = new Set<() => void>();

function sameMap(a: SplitMapDescriptor | undefined, b: SplitMapDescriptor | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Publish (or clear, with undefined) the map of a project window. */
export function publishProjectSplitMap(projectPath: string, map: SplitMapDescriptor | undefined): void {
  if (sameMap(maps.get(projectPath), map)) return;
  if (map) maps.set(projectPath, map);
  else maps.delete(projectPath);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The map of the splits inside a project window, or undefined. */
export function useProjectSplitMap(projectPath: string | null | undefined): SplitMapDescriptor | undefined {
  return useSyncExternalStore(subscribe, () => (projectPath ? maps.get(projectPath) : undefined), () => undefined);
}
