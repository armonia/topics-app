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
import { waitOnPerson } from '../../../../shared/waits-on-person';

export interface BoardLane {
  projectId: string;
  /** The column id → that project's cards in it, in the board's order. Every column is present, empty or not. */
  columns: Map<string, BoardTask[]>;
  /** How many cards the project has in each column: the lane header's counts. */
  counts: Record<string, number>;
  total: number;
  /** One of the project's cards waits for the person: the lane goes first (`sortProjectGroups`). */
  waiting: boolean;
}

/**
 * Does this board card wait for the person? The Plan's rule (`waitOnPerson`,
 * shared/waits-on-person.ts) read over what the card carries: its status and
 * stage, the human ask, a stop chip, the durable «unanswered question» flag.
 * Only the first 240 characters of the description travel with the card, so a
 * «waits for the person» line past them is seen by the Plan and not by the lane.
 */
export function taskWaitsOnPerson(task: BoardTask): boolean {
  return waitOnPerson({
    status: task.status,
    stage: task.stage,
    description: task.descriptionPreview ?? task.description,
    human_ask: task.humanAsk,
    dispatch_state: task.dispatchState,
    dispatch_error: task.dispatchError,
    awaitingAnswer: task.awaitingAnswer,
  }, []) !== null;
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
  projectOfLane: (laneKey: string) => string | null = (key) => key,
): boolean {
  if (!overId) return false;
  const laneKey = projectIdOfDropTarget(overId);
  if (laneKey !== null) {
    const laneProject = projectOfLane(laneKey);
    return laneProject !== null && laneProject !== task.projectId;
  }
  const cardProject = cardProjectOf(overId);
  return cardProject !== undefined && cardProject !== task.projectId;
}

/** Toggles one project in the folded set, returning a NEW set (React state). */
export function toggleCollapsed(collapsed: ReadonlySet<string>, projectId: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
  return next;
}
