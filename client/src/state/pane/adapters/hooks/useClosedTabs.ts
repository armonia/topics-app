/**
 * Adapter hook for the recently-closed-tab stack.
 *
 * Returns the exact destructured surface that legacy consumers expect:
 *   { closedTabs, pushClosedTab, popClosedTab, removeClosedTab, clearClosedTabs }
 *
 * Backed by the reducer's `closedStack` (bounded at 50, FIFO). Projection
 * into the legacy ClosedTabRecord shape is done inline — see
 * adapters/closedTabRecord.ts for the shared projector helper.
 */
import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePaneStore } from '../../store';
import type { PaneStore } from '../../store';
import type { Pane } from '../../../../types';
import type { ClosedPaneRecord } from '../../types';
import { cancelTerminalCleanup } from '../closedTabRecord';

export interface ClosedTabRecord {
  id: string;
  closedAt: number;
  pane: Pane;
  groupId: string;
  groupIndex: number;
  level: 'project' | 'app';
  projectPath?: string;
  topicId?: string;
  filePath?: string;
}

function projectRecord(rec: ClosedPaneRecord): ClosedTabRecord {
  return {
    id: rec.id,
    closedAt: rec.closedAt,
    pane: rec.pane as unknown as Pane,
    groupId: rec.groupId,
    groupIndex: rec.groupIndex,
    level: rec.level,
    projectPath: rec.projectPath,
    topicId: rec.topicId,
    filePath: rec.filePath,
  };
}

export function useClosedTabs() {
  // Reducer stores newest-at-end; legacy callers expect newest-first.
  const rawStack = usePaneStore(useShallow((s: PaneStore) => s.closedStack));
  const closedTabs = useMemo(
    () => rawStack.slice().reverse().map(projectRecord),
    [rawStack],
  );

  const pushClosedTab = useCallback((record: ClosedTabRecord) => {
    usePaneStore.getState().dispatch({
      type: 'CLOSE_PANE',
      payload: {
        id: record.pane.id,
        groupId: record.groupId,
        groupIndex: record.groupIndex,
      },
    });
  }, []);

  const popClosedTab = useCallback((): ClosedTabRecord | undefined => {
    const state = usePaneStore.getState();
    const stack = state.closedStack;
    const top = stack[stack.length - 1];
    if (!top) return undefined;
    state.dispatch({ type: 'UNDO_CLOSE' });
    return projectRecord(top);
  }, []);

  const removeClosedTab = useCallback((recordId: string) => {
    // Cancel any pending terminal cleanup BEFORE dispatching — cleanupTimers
    // are module-level (pitfall #4) so the reducer can't reach them. If the
    // record doesn't have a terminal or no timer is pending, this is a
    // harmless no-op on the timer map.
    const rec = usePaneStore
      .getState()
      .closedStack.find((r) => r.id === recordId);
    if (rec?.pane.type === 'terminal') cancelTerminalCleanup(recordId);
    usePaneStore
      .getState()
      .dispatch({ type: 'CLEAR_CLOSED_RECORD', payload: { id: recordId } });
  }, []);

  const clearClosedTabs = useCallback(() => {
    // Cancel every pending terminal cleanup before wiping the stack. After
    // dispatch the reducer has no record to correlate timers back to.
    const stack = usePaneStore.getState().closedStack;
    for (const rec of stack) {
      if (rec.pane.type === 'terminal') cancelTerminalCleanup(rec.id);
    }
    usePaneStore.getState().dispatch({ type: 'CLEAR_CLOSED_STACK' });
  }, []);

  const undoLastClose = popClosedTab;

  return {
    closedTabs,
    pushClosedTab,
    popClosedTab,
    removeClosedTab,
    clearClosedTabs,
    undoLastClose,
  };
}
