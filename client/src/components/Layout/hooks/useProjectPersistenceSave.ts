/**
 * useProjectPersistenceSave — owns the project-window persistence write
 * effect. Extracted from `ProjectWindow.tsx` during the four-hook refactor
 * (Commit 5).
 *
 * Owns:
 *  - The big save effect that runs on every layout/chat change.
 *  - The `userEditedRef` flag-flip on first render-after-mount via
 *    `mountedRef` (PLAN A2). This MUST stay inside the save effect — no
 *    other hook touches the flag.
 *  - Calls `savePersistedTabState` (server-synced) and
 *    `savePersistedLayoutState` (local-only) on each commit.
 *  - Fires `onOpenPanesChange` so the parent sidebar can filter.
 *
 * Does NOT own:
 *  - Reading persisted state (that's `useProjectPersistenceLoad`).
 *  - Layout/chat state itself — receives values as args.
 *
 * Pure side-effect — no return value. Args carry everything the effect
 * needs; deps mirror the original inline effect exactly so behavior is
 * unchanged.
 */
import { useEffect } from 'react';
import type { Pane, PaneGroup, GroupLayoutRow } from '../../../types';
import {
  savePersistedTabState,
  savePersistedLayoutState,
  stripWrapperPaneId,
} from './projectPersistence';
import type { PersistenceGateRefs } from './types';

export interface UseProjectPersistenceSaveArgs {
  projectPath: string;
  panes: Pane[];
  groups: PaneGroup[];
  rows: GroupLayoutRow[];
  rowHeights: number[];
  sidebarCollapsed: boolean;
  /** Currently-active chat topic id from `useProjectChatSync.activeTopicId`.
   *  Persisted alongside tab identity so the next session restores focus. */
  activeChatTopicId?: string;
  gateRefs: PersistenceGateRefs;
  onOpenPanesChange?: (paneIds: string[]) => void;
}

export function useProjectPersistenceSave(
  args: UseProjectPersistenceSaveArgs,
): void {
  const {
    projectPath,
    panes,
    groups,
    rows,
    rowHeights,
    sidebarCollapsed,
    activeChatTopicId,
    gateRefs,
    onOpenPanesChange,
  } = args;
  const { userEditedRef, mountedRef } = gateRefs;

  // Persist tab identity to server (cross-device sync) and layout to
  // localStorage only. Mark userEditedRef after mount so the server-fetch
  // callback skips stale overwrites. Deps mirror the original inline effect
  // (panes, groups, rows, rowHeights, sidebarCollapsed, projectPath,
  // onOpenPanesChange) plus activeChatTopicId since the value is now
  // computed by chat-sync and passed in.
  useEffect(() => {
    if (mountedRef.current) userEditedRef.current = true;
    else mountedRef.current = true;

    // Defensive: never persist the project's own wrapper pane as one of its
    // child panes. If it ever sneaks in (e.g. from a corrupted snapshot), it
    // would resurface on reload as an unkillable phantom tab inside the
    // project window.
    const nonChatPanes = stripWrapperPaneId(
      panes.filter(p => p.type !== 'chat' && !p.preview),
      projectPath,
    );
    const openChatTopicIds = panes
      .filter(p => p.type === 'chat' && p.topicId)
      .map(p => p.topicId!);

    // Server-synced: tab identity only (which tabs are open)
    savePersistedTabState(projectPath, {
      nonChatPanes,
      openChatTopicIds,
      activeChatTopicId,
    });

    // Local-only: layout structure (splits, groups, tab order, sidebar)
    savePersistedLayoutState(projectPath, {
      groups,
      rows,
      rowHeights,
      sidebarCollapsed,
    });

    // Report open panes to parent for sidebar filtering
    onOpenPanesChange?.(panes.map(p => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, groups, rows, rowHeights, sidebarCollapsed, projectPath, onOpenPanesChange]);
}
