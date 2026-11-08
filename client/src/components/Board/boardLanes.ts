/**
 * The board grouped BY PROJECT: one lane per project, each lane the same row of
 * workflow columns the flat board draws. Pure, so the split is tested without
 * a DOM (boardLanes.test.ts).
 *
 * The split happens AFTER the column split, never before: the order inside a
 * column (`groupByStatus`, `columnOfTask`) is already decided, and a lane only
 * keeps the cards of its project in that same order. Grouping never reorders.
 */
import type { BoardTask } from '../../lib/board';

export interface BoardLane {
  projectId: string;
  /** The column id → that project's cards in it, in the board's order. Every column is present, empty or not. */
  columns: Map<string, BoardTask[]>;
  /** How many cards the project has in each column: the lane header's counts. */
  counts: Record<string, number>;
  total: number;
}

/**
 * Splits the board's columns into one lane per project.
 *
 * Lanes are ordered by NAME (via `nameOf`), not by size: a lane that jumps up
 * the board every time one of its cards is created is a lane nobody finds
 * twice in the same place. Ties on the name fall back to the id, so two boards
 * with the same name still keep a stable order.
 */
export function splitIntoLanes(
  byColumn: ReadonlyMap<string, readonly BoardTask[]>,
  columnIds: readonly string[],
  nameOf: (projectId: string) => string,
): BoardLane[] {
  const lanes = new Map<string, BoardLane>();
  const laneOf = (projectId: string): BoardLane => {
    let lane = lanes.get(projectId);
    if (!lane) {
      lane = {
        projectId,
        columns: new Map(columnIds.map((id) => [id, []])),
        counts: Object.fromEntries(columnIds.map((id) => [id, 0])),
        total: 0,
      };
      lanes.set(projectId, lane);
    }
    return lane;
  };
  for (const columnId of columnIds) {
    for (const task of byColumn.get(columnId) ?? []) {
      const lane = laneOf(task.projectId);
      lane.columns.get(columnId)!.push(task);
      lane.counts[columnId] += 1;
      lane.total += 1;
    }
  }
  return [...lanes.values()].sort((a, b) => {
    const byName = nameOf(a.projectId).localeCompare(nameOf(b.projectId), undefined, { sensitivity: 'base' });
    return byName !== 0 ? byName : a.projectId.localeCompare(b.projectId);
  });
}

/**
 * A lane's column needs its OWN droppable id: dnd-kit keys targets by id, and
 * five lanes each registering «todo» would leave four of them unreachable.
 * The suffix is stripped before the drop is planned, so a drop in any lane is
 * the same status change it is on the flat board (the card keeps its project).
 */
const LANE_SEPARATOR = '@lane:';

export function laneDropId(columnId: string, projectId: string): string {
  return `${columnId}${LANE_SEPARATOR}${projectId}`;
}

/** The workflow column a droppable id names: the id itself on the flat board, the prefix in a lane. */
export function columnIdOfDropTarget(id: string): string {
  const at = id.indexOf(LANE_SEPARATOR);
  return at === -1 ? id : id.slice(0, at);
}

/** Toggles one project in the folded set, returning a NEW set (React state). */
export function toggleCollapsed(collapsed: ReadonlySet<string>, projectId: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
  return next;
}
