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
import type { DraftPlacement } from './draftPreview';

export interface BoardLane {
  projectId: string;
  /** The column id → that project's cards in it, in the board's order. Every column is present, empty or not. */
  columns: Map<string, BoardTask[]>;
  /** How many cards the project has in each column: the lane header's counts. */
  counts: Record<string, number>;
  total: number;
}

/** A lane with every column present and no card in it. */
export function emptyLane(projectId: string, columnIds: readonly string[]): BoardLane {
  return {
    projectId,
    columns: new Map(columnIds.map((id) => [id, []])),
    counts: Object.fromEntries(columnIds.map((id) => [id, 0])),
    total: 0,
  };
}

/**
 * The lanes plus, when the composer's ghost belongs to a project that has no
 * card yet, a temporary empty lane of that project in its sorted place. The
 * lane exists only while the ghost does.
 */
export function withDraftLane(
  lanes: readonly BoardLane[],
  placement: DraftPlacement | null,
  columnIds: readonly string[],
  nameOf: (projectId: string) => string,
): BoardLane[] {
  if (placement?.kind !== 'new-lane' || lanes.some((l) => l.projectId === placement.projectId)) return [...lanes];
  return sortProjectGroups([...lanes, emptyLane(placement.projectId, columnIds)], (lane) => nameOf(lane.projectId));
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
      lane = emptyLane(projectId, columnIds);
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
  return sortProjectGroups([...lanes.values()], (lane) => nameOf(lane.projectId));
}

/**
 * THE ORDER OF PROJECT GROUPS, one for the Kanban lanes and the Plan tiles: by
 * name, ties on the id. The two views of one board list projects in the same
 * order, so a project is found in the same place in both.
 */
export function sortProjectGroups<T extends { projectId: string }>(groups: readonly T[], nameOf: (group: T) => string): T[] {
  return [...groups].sort((a, b) => {
    const byName = nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
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

/** The project a lane's droppable id belongs to, or null for the flat board's ids and card ids. */
export function projectIdOfDropTarget(id: string): string | null {
  const at = id.indexOf(LANE_SEPARATOR);
  return at === -1 ? null : id.slice(at + LANE_SEPARATOR.length);
}

/**
 * Whether a drop lands in ANOTHER project's lane. A card cannot change project
 * by being dragged: letting the drop through would change its status in a
 * project the person was not looking at, and the card would jump back to its
 * own lane. The drop is refused (and says so) instead. A card dropped on a card
 * of another project counts too. Only the GROUPED board asks: on the flat
 * board cards of every project share the columns and reordering among them is
 * the normal gesture.
 */
export function dropsOnOtherProject(
  task: { projectId: string },
  overId: string | null,
  cardProjectOf: (cardId: string) => string | undefined,
): boolean {
  if (!overId) return false;
  const laneProject = projectIdOfDropTarget(overId);
  if (laneProject !== null) return laneProject !== task.projectId;
  const cardProject = cardProjectOf(overId);
  return cardProject !== undefined && cardProject !== task.projectId;
}

/** Toggles one project in the folded set, returning a NEW set (React state). */
export function toggleCollapsed(collapsed: ReadonlySet<string>, projectId: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
  return next;
}
