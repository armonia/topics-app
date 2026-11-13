import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import { useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { PoliteKeyboardSensor, PoliteMouseSensor, PoliteTouchSensor } from './dndSensors';
import { useT } from '../../hooks/useT';
import {
  boardApi, isProjectlessId, STATUS_LABEL, columnOfTask, type BoardTask,
} from '../../lib/board';
import { groupByStatus, planDrop, type DropPlan, type OrderScope } from '../../lib/boardOrder';
import { resolveProjectRefs, type useBoardProjectLabels } from '../../lib/boardProjectsStore';
import type { useBoardFeed } from '../../hooks/useBoardFeed';
import { columnIdOfDropTarget, dropsOnOtherProject } from './boardLanes';
import { projectOfPath, type GroupKey } from './boardGrouping';
import { PRIORITY_LABEL } from './constants';
import { taskActionErrorMessage } from './taskActionError';
import type { useBoardMotion } from './useBoardMotion';
import type { useRowSnapHold } from './useRowSnapHold';

/** Identity stable for "no write in flight": a fresh Map on every render
 *  would redo the memo that overlays the patches, and with it every column. */
export const EMPTY_WRITES: ReadonlyMap<string, Partial<BoardTask>> = new Map();


// SENSOR OPTIONS LIVE AT MODULE LEVEL, NOT INLINE. dnd-kit memoizes each sensor
// on `[sensor, options]`, so an inline options object made `sensors` a new array
// on every render of the pane, which rebuilt dnd-kit's InternalContext, which
// re-rendered every `useSortable` card at identical props: the `memo(Card)`
// below never held from the day it was written (measured 2026-09-07: 32/32
// cards re-rendered 25-29 times in 30 idle seconds, ~550 ms of JS per 30 s with
// four agents at work). Hoisting the three objects is the whole fix.
const MOUSE_SENSOR_OPTS = { activationConstraint: { distance: 4 } } as const;
const TOUCH_SENSOR_OPTS = { activationConstraint: { delay: 200, tolerance: 8 } } as const;
const KEYBOARD_SENSOR_OPTS = { coordinateGetter: sortableKeyboardCoordinates } as const;

type BoardFeed = ReturnType<typeof useBoardFeed>;

interface BoardDragArgs {
  tasks: readonly BoardTask[];
  byStatus: Parameters<typeof planDrop>[0]['byStatus'];
  boardColumns: Parameters<typeof columnOfTask>[0];
  /** The grouping levels in force: a drop across projects is refused when one of them is the project. */
  groupLevels: readonly GroupKey[];
  orderScope: OrderScope;
  setActiveId: (id: string | null) => void;
  setDropNotice: (notice: string | null) => void;
  setPendingWrites: Dispatch<SetStateAction<ReadonlyMap<string, Partial<BoardTask>>>>;
  onCardError: (taskId: string, message: string | null) => void;
  patchTask: BoardFeed['patchTask'];
  refetch: BoardFeed['refetch'];
  beginDrag: BoardFeed['beginDrag'];
  endDrag: BoardFeed['endDrag'];
  flushDeferredRead: BoardFeed['flushDeferredRead'];
  holdColumnsSnap: ReturnType<typeof useRowSnapHold>['hold'];
  skipFlight: ReturnType<typeof useBoardMotion>;
}

/** The drag-and-drop wiring of the board: sensors, the two dnd-kit handlers and
 *  the optimistic write a drop turns into. */
export function useBoardDrag({
  tasks, byStatus, boardColumns, groupLevels, orderScope, setActiveId, setDropNotice, setPendingWrites,
  onCardError, patchTask, refetch, beginDrag, endDrag, flushDeferredRead, holdColumnsSnap, skipFlight,
}: BoardDragArgs) {
  const tr = useT();
  /**
   * Persist a drop: status and/or position, optimistically. Routed by the
   * task's OWN projectId so it works identically in the global board.
   *
   * `plan.renumber` is there only in the rare case where the fractional gap
   * ran out (see `lib/boardOrder`): then the column must be rewritten as
   * integers, N patches instead of one. The column is sent FIRST and the
   * dragged card after, so if a write drops halfway the card is not the only
   * one moved into an order that no longer matches it; any error refetches and
   * the truth comes back from the server.
   */
  const dropTo = useCallback(async (task: BoardTask, plan: DropPlan) => {
    // A redirected drop onto a card that is already where the redirect sends it
    // has nothing to write: the plan exists only to carry the notice. Nothing
    // to write = nothing to wait for, so the parked read starts here.
    if (Object.keys(plan.patch).length === 0 && !plan.renumber?.length) { flushDeferredRead(); return; }
    for (const r of plan.renumber ?? []) patchTask(r.id, { kanbanOrder: r.kanbanOrder });
    patchTask(task.id, plan.patch); // optimistic
    // The same patches, but marked IN FLIGHT: `patchTask` writes into the
    // current list, this layer lays them over the ones that will arrive before
    // the server confirms (see `pendingWrites`).
    const inFlight = new Map<string, Partial<BoardTask>>();
    for (const r of plan.renumber ?? []) inFlight.set(r.id, { kanbanOrder: r.kanbanOrder });
    inFlight.set(task.id, plan.patch);
    setPendingWrites((prev) => new Map([...prev, ...inFlight]));
    try {
      // `renumber` exists only in the `board` scope (on the global board the
      // position is not written at all), so the rewritten cards are by
      // construction of the SAME project as the dragged one.
      for (const r of plan.renumber ?? []) {
        await boardApi.update(task.projectId, r.id, { kanbanOrder: r.kanbanOrder });
      }
      await boardApi.update(task.projectId, task.id, plan.patch);
      onCardError(task.id, null);
    } catch (e) {
      // The notice was written before the PATCH (it explains the GESTURE, and
      // waiting for the round trip would make it arrive late). If the write
      // failed the card is where it was, so the notice is now false: it goes,
      // and the error speaks alone.
      setDropNotice(null);
      // And it speaks ON THE CARD. Dragging a parent with open children into
      // Done is the same refusal as the Approve button: the refetch puts the
      // card back, and the reason waits for it there instead of at the top of
      // the panel, where with a scrolled column nobody read it.
      onCardError(task.id, taskActionErrorMessage(e, tr, tr('board.actionError.moveFailed')));
      refetch();
    } finally {
      // The write answered (well or badly): from here on the server rules, so
      // the optimistic layer comes off and ONLY NOW does the read that the
      // drag parked start. Sending it earlier meant asking for the state from
      // someone who had not received it yet, and getting the starting column
      // back in answer.
      setPendingWrites((prev) => {
        const next = new Map(prev);
        for (const id of inFlight.keys()) next.delete(id);
        return next.size === 0 ? EMPTY_WRITES : next;
      });
      flushDeferredRead();
    }
  }, [patchTask, refetch, onCardError, flushDeferredRead, setDropNotice, setPendingWrites, tr]);

  // Mouse: pick a card up after a 4px drag. Touch: require a 200ms press-and-hold
  // (with an 8px slop) before a drag starts, so a horizontal swipe scrolls the
  // snap carousel instead of yanking the card under the finger.
  // Keyboard: space/enter grabs the card, arrows move it, space drops, Esc
  // cancels. Without this sensor reordering a column was possible ONLY with
  // the mouse - changing status was not (the selector in the drawer exists),
  // but the position inside the column was not reachable any other way.
  // Sensors DEAF to fields and controls: a click in the reply input must not
  // become a drag (see `dndSensors.ts` for why).
  const sensors = useSensors(
    useSensor(PoliteMouseSensor, MOUSE_SENSOR_OPTS),
    useSensor(PoliteTouchSensor, TOUCH_SENSOR_OPTS),
    useSensor(PoliteKeyboardSensor, KEYBOARD_SENSOR_OPTS),
  );
  const onDragStart = useCallback((e: DragStartEvent) => {
    // Rows freeze here and thaw in `endDrag`: as long as the card is in hand no
    // re-read (of this pane or of the shared store) can redo the columns under
    // the pointer.
    beginDrag();
    // No snap while the card is in hand: dnd-kit's auto-scroll near the row's
    // edge would otherwise jump whole columns under a pointer that has not
    // moved, and the drop would land on a column nobody aimed at.
    holdColumnsSnap();
    setActiveId(String(e.active.id));
    // A new gesture retires the previous one's explanation, whatever this drag
    // turns out to do (including being cancelled, or ending on a card that is
    // no longer in the list).
    setDropNotice(null);
  }, [beginDrag, holdColumnsSnap, setActiveId, setDropNotice]);
  // What a drop produces lives in `lib/boardOrder` - pure and tested (bun:test):
  // only the glue between dnd-kit and the PATCH stays here.
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    // This card does not travel on the next round: the finger just brought it
    // where it is, and making it restart from where it was to redo the trip on
    // its own would be the one animation that contradicts the viewer's gesture.
    skipFlight(String(e.active.id));
    // Thaw the rows, and ONLY that: the read the drag parked would start before
    // the drop's PATCH and answer with the starting state - the card went back
    // to the previous column for a whole network round trip. `dropTo` releases
    // it, when the write has answered.
    endDrag();
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task) { flushDeferredRead(); return; }
    // WHICH WORKFLOW COLUMN the hand let go on: a column's own id (Triage, AI
    // review...) or a card inside one. `planDrop` speaks statuses, so it gets
    // the column's base; the column itself travels as `stage`.
    // A card keeps its project: a drop in another project's lane is refused with
    // a word, not carried out as a status change in a project nobody aimed at.
    if (groupLevels.includes('project') && dropsOnOtherProject(task, e.over ? String(e.over.id) : null, (id) => tasks.find((t) => t.id === id)?.projectId, (path) => projectOfPath(path, groupLevels))) {
      setDropNotice(tr('board.drop.otherProject'));
      flushDeferredRead();
      return;
    }
    const overRaw = e.over ? columnIdOfDropTarget(String(e.over.id)) : null;
    const overColumn = overRaw ? boardColumns.find((c) => c.id === overRaw) : undefined;
    const overCard = !overColumn && overRaw ? tasks.find((t) => t.id === overRaw) : undefined;
    const targetColumn = overColumn ?? (overCard ? columnOfTask(boardColumns, overCard) : null);
    const plan = planDrop({
      task,
      overId: overColumn ? overColumn.base : overRaw,
      byStatus,
      // The numbers are decided by the WHOLE column, not the filtered one: see
      // `planDrop`. With a filter on they were the same list, and the
      // renumbering rewrote 1..N over the hidden cards.
      //
      // It is grouped HERE and not in a render memo: it is needed once per
      // drop, and a memo would recompute it at every arrival of rows - the hot
      // path this round is trying to lighten.
      byStatusAll: groupByStatus(tasks, orderScope),
      scope: orderScope,
    });
    // The card did not land where the hand let it go: say it, or the gesture
    // reads as a bug. `onDragStart` already cleared the previous one, so this
    // only ever adds.
    if (plan?.redirectedFrom === 'in_progress') setDropNotice(tr('board.drop.inProgressRedirected'));
    // The column changes, the status may not (AI review → Human review): the
    // stage says it. Only when the card really lands in that column: a
    // redirected drop goes where the redirect sends it, with no stage.
    if (plan && targetColumn && !plan.redirectedFrom) {
      const landsIn = plan.patch.status ?? task.status;
      const fromColumn = columnOfTask(boardColumns, task);
      if (landsIn === targetColumn.base && fromColumn?.id !== targetColumn.id) {
        plan.patch = { ...plan.patch, status: targetColumn.base, stage: targetColumn.id === targetColumn.base ? null : targetColumn.id };
      }
    }
    // No plan = no write to wait for: the parked read has nothing left to
    // queue behind.
    if (plan) dropTo(task, plan); else flushDeferredRead();
  }, [tasks, byStatus, boardColumns, dropTo, endDrag, flushDeferredRead, groupLevels, orderScope, setActiveId, setDropNotice, skipFlight, tr]);
  return { sensors, onDragStart, onDragEnd };
}

/**
 * WHAT IS IN HAND, in words: the context line and the badges the drag card
 * carries under the title (the `DragOverlay` at the end of the render).
 *
 * It is computed here and not inside the JSX because while the card is in hand
 * the pane redraws at every pointer move, and `resolveProjectRefs` would
 * rebuild the project index on every frame to read a single name.
 */
export function useDragPreview(
  activeTask: BoardTask | null,
  mode: 'project' | 'all',
  projectIndex: ReturnType<typeof useBoardProjectLabels>,
) {
  return useMemo(() => {
    if (!activeTask) return null;
    // The project ONLY where it tells something apart. On a project board it
    // would be the same word on every card, that is noise. The name comes from
    // `resolveProjectRefs`, the same shared index the filter and the card take
    // it from: an id without a project (`isProjectlessId`) has no name to
    // show, exactly like the card that does not draw the chip.
    const projectName = mode === 'all' && !isProjectlessId(activeTask.projectId)
      ? resolveProjectRefs([activeTask.projectId], projectIndex)[0]?.name ?? null
      : null;
    // The starting column is the fact the title never says. Dragging across
    // five columns, "where it comes from" is half of what you need to know.
    const subtitle = [STATUS_LABEL[activeTask.status], projectName].filter(Boolean).join(' · ');
    // Three at most, priority first because it is the only one always there.
    // The labels are already the word that is read (`shared/task-labels`: the
    // vocabulary IS the text), and they stay in the order the card draws
    // them, so the preview does not tell a different card from the one you
    // picked. Beyond the third badge the card grows more than it says.
    //
    // `filter(Boolean)` covers an out-of-range priority, which has no entry in
    // the names map and would leave a badge without text.
    const badges = [
      PRIORITY_LABEL[activeTask.priority],
      ...activeTask.labels.map((l) => l.label),
    ].filter(Boolean).slice(0, 3);
    return { subtitle, badges };
  }, [activeTask, mode, projectIndex]);
}
