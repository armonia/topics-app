/**
 * The closed rows of the column (open / closed / archived, lib/closedRows.ts):
 * the records that keep a top-level tab as a closed row, the chats closed
 * inside a project window, and the click that brings a closed tab back from
 * its record. None in the two-state model, where closing archives.
 */
import { useCallback, useMemo } from 'react';
import { closedProjectChatIds, closedRowRecords, CLOSE_PROJECT_INNER_PANE_EVENT, type CloseProjectInnerPaneDetail } from '@/lib/closedRows';
import { sidebarItemPaneId, type SidebarItem } from '@/lib/buildSidebarItems';
import { createPaneId } from '@/state/pane/adapters';
import type { ClosedTabRecord } from '../../state/pane/adapters/closedTabRecord';
import type { Topic } from '../../types';

const NO_RECORDS: ClosedTabRecord[] = [];
const NO_CHATS: ReadonlySet<string> = new Set();

export function useClosedRows({ closeArchives, closedTabs, openPanels, topics, onReopenClosedTab }: {
  closeArchives: boolean;
  closedTabs: readonly ClosedTabRecord[];
  openPanels: readonly string[];
  topics: Readonly<Record<string, Topic>>;
  onReopenClosedTab?: (record: ClosedTabRecord) => void;
}) {
  const closedRecords = useMemo(
    () => (closeArchives ? NO_RECORDS : closedRowRecords(closedTabs, { openIds: new Set(openPanels), topics })),
    [closeArchives, closedTabs, openPanels, topics],
  );
  // Whether the chat is open inside its window is asked by buildSidebarItems,
  // which reads the windows' panes: here only the top-level tabs.
  const closedProjectChats = useMemo(
    () => (closeArchives ? NO_CHATS : closedProjectChatIds(closedTabs, { openIds: new Set(openPanels), topics })),
    [closeArchives, closedTabs, openPanels, topics],
  );
  const recordById = useMemo(() => new Map(closedRecords.map((r) => [r.pane.id, r])), [closedRecords]);
  /** A closed row's click: its tab comes back from the record, in its slot.
   *  False when the row has no record (it opens the usual way). */
  const reopenClosed = useCallback((item: SidebarItem): boolean => {
    if (!item.closed || !onReopenClosedTab) return false;
    const record = recordById.get(sidebarItemPaneId(item));
    if (!record) return false;
    onReopenClosedTab(record);
    return true;
  }, [recordById, onReopenClosedTab]);
  return { closedRecords, closedProjectChats, reopenClosed };
}

/**
 * The circle of a chat open INSIDE a project window: it closes there, through
 * the window's own close (a closed row under the project, or archived in the
 * two-state model). With no window to take it (the project is not mounted)
 * the circle archives, as it always did.
 */
export function useCloseInnerChat(archive: (topicId: string, archive: boolean) => unknown) {
  return useCallback((projectPath: string, topicId: string) => {
    const ev = new CustomEvent<CloseProjectInnerPaneDetail>(CLOSE_PROJECT_INNER_PANE_EVENT, {
      detail: { projectPath, paneIds: [createPaneId('chat', topicId), topicId] },
      cancelable: true,
    });
    window.dispatchEvent(ev);
    if (!ev.defaultPrevented) void archive(topicId, true);
  }, [archive]);
}
