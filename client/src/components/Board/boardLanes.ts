/**
 * THE BOARD GROUPED BY PROJECT: one row of the same columns per project (a
 * swimlane), on the cross-project board. Pure, so the order and the drop ids
 * are tested without a board.
 *
 * DROP IDS. A column is one droppable; with lanes the same column appears once
 * per project, and dnd-kit needs every droppable id unique. A lane's column is
 * `<column id><LANE_SEP><project id>`, and `columnOfDropId` gives the column
 * back: a drop changes the card's column, never its project.
 */
import type { BoardTask } from '../../lib/board';

export const LANE_SEP = '::lane::';

export function laneDropId(columnId: string, projectId: string): string {
  return `${columnId}${LANE_SEP}${projectId}`;
}

/** The column a droppable id names: the id itself, or a lane's column without its project. */
export function columnOfDropId(id: string): string {
  const at = id.indexOf(LANE_SEP);
  return at < 0 ? id : id.slice(0, at);
}

export interface BoardLane {
  projectId: string;
  /** The cards of each column of this project, in the board's own order. */
  columns: Map<string, BoardTask[]>;
  total: number;
  /** Cards that want attention now: running or waiting for a person. */
  active: number;
}

/**
 * The lanes, from the board's columns: a project with no visible card has no
 * lane. The projects where something runs or waits come first, then the
 * fuller ones, then by name, so the order holds still between two reads.
 */
export function groupLanes(
  byColumn: ReadonlyMap<string, readonly BoardTask[]>,
  columnIds: readonly string[],
  nameOf: (projectId: string) => string,
): BoardLane[] {
  const lanes = new Map<string, BoardLane>();
  for (const col of columnIds) {
    for (const t of byColumn.get(col) ?? []) {
      let lane = lanes.get(t.projectId);
      if (!lane) {
        lane = { projectId: t.projectId, columns: new Map(columnIds.map((c) => [c, []])), total: 0, active: 0 };
        lanes.set(t.projectId, lane);
      }
      lane.columns.get(col)!.push(t);
      lane.total += 1;
      if (t.status === 'in_progress' || t.status === 'review') lane.active += 1;
    }
  }
  return [...lanes.values()].sort((a, b) =>
    b.active - a.active || b.total - a.total || nameOf(a.projectId).localeCompare(nameOf(b.projectId)));
}
