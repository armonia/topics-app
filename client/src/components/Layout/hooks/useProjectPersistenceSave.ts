/**
 * useProjectPersistenceSave — owns the project-window persistence write
 * effect. Extracted from `ProjectWindow.tsx` during the four-hook refactor
 * (Commit 5).
 *
 * Owns:
 *  - The big save effect that runs on every layout/chat change.
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
import { getBrowserContextFromPaneId, recordBrowserOrigin } from '../../../state/pane/adapters';

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
  /** Which split cell is focused — persisted so a reload restores it. */
  focusedGroupId: string | null;
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
    focusedGroupId,
    onOpenPanesChange,
  } = args;

  // Persist tab identity to the server (cross-device sync) and layout to
  // localStorage only, on every layout/chat change. Deps mirror the original
  // inline effect (panes, groups, rows, rowHeights, sidebarCollapsed,
  // projectPath, onOpenPanesChange) plus activeChatTopicId since the value is
  // now computed by chat-sync and passed in.
  useEffect(() => {
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

    // Durable browser origin: record every OPEN project browser's
    // {projectPath, url, title} on each persist (including the mount pass), so a
    // later close leaves a closedStack-independent origin even if the pane was
    // never re-navigated (updatePane's url-change writer wouldn't have fired).
    // This is what lets the "Fissati" row nest back under its project WITH its
    // title after the pane is stripped from the snapshot. See browserOriginStore.
    for (const p of nonChatPanes) {
      if (p.type !== 'browser' || typeof p.url !== 'string' || !p.url || p.url === 'about:blank') continue;
      const ctx = getBrowserContextFromPaneId(p.id);
      if (ctx) recordBrowserOrigin(ctx, projectPath, p.url, typeof p.title === 'string' ? p.title : undefined);
    }

    // Local-only: layout structure (splits, groups, tab order, sidebar, focus)
    savePersistedLayoutState(projectPath, {
      groups,
      rows,
      rowHeights,
      sidebarCollapsed,
      focusedGroupId,
    });

    // Report open panes to parent for sidebar filtering
    onOpenPanesChange?.(panes.map(p => p.id));
  }, [panes, groups, rows, rowHeights, sidebarCollapsed, activeChatTopicId, focusedGroupId, projectPath, onOpenPanesChange]);
}
