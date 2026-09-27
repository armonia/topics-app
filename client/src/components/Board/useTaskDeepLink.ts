/**
 * Which task the GLOBAL board was asked to open, and which of its tabs or diff
 * files to put in front: the deep-link half of `KanbanBoardPane`, on its own so
 * a test can drive it without mounting the board.
 *
 * Two doors, both read here. A board already mounted hears `topics:open-task`.
 * A board that mounts AFTER the gesture (a row of the chat's changed-files
 * strip clicked with no board open) reads the task from the URL
 * `openTaskInApp` wrote, and the focus from `pendingTaskFocus`: the URL
 * carries the task and not the file.
 */
import { useEffect, useState } from 'react';
import { currentTaskTarget, pendingTaskFocus } from '../../lib/openTaskLink';

export function useTaskDeepLink(global: boolean) {
  // Seeded from the CURRENT URL, not a one-shot boot value, so it survives a
  // remount and an inactive board tab coming back: the URL is the source of
  // truth. Held until the task shows up in the loaded list, then it becomes
  // the selection.
  const [pendingSelect, setPendingSelect] = useState<string | null>(
    () => (global ? currentTaskTarget()?.taskId ?? null : null),
  );
  // The tab to put in front when a targeted gesture opened the task (the
  // «open in a tab» button on a card's preview, a row of the chat's strip).
  // Reset by every other opening: it belongs to THAT click, it is not a state.
  const [pendingPaneId, setPendingPaneId] = useState<string | null>(() => {
    const target = global ? currentTaskTarget() : null;
    return target ? pendingTaskFocus(target.taskId) : null;
  });
  useEffect(() => {
    if (!global) return;
    const onOpenTask = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId?: string; focusPaneId?: string }>).detail;
      if (!detail?.taskId) return;
      setPendingSelect(detail.taskId);
      setPendingPaneId(detail.focusPaneId ?? null);
    };
    window.addEventListener('topics:open-task', onOpenTask as EventListener);
    return () => window.removeEventListener('topics:open-task', onOpenTask as EventListener);
  }, [global]);
  return { pendingSelect, setPendingSelect, pendingPaneId, setPendingPaneId };
}
