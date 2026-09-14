/**
 * THE WAY HOME FOR A PAGE LENT TO THE LAYOUT.
 *
 * The open-as-tab command hands a sheet of the topic's window to the layout, keeping
 * the same contextId: one page, two possible places, never both at once. This
 * module owns the return trip, because two surfaces need it and they must do
 * exactly the same thing: the window's own "+" menu, and the promoted tab's
 * own sheet (return-to-chat, what the requirement asks for, and
 * the only one a person can reach while the window is down to its bar).
 *
 * The pane leaves the layout with RECLAIM_PANE, not CLOSE_PANE: the page is
 * not closed, it moved. A closedStack record would let Cmd+Shift+T re-open the
 * page the window is now showing, and the same contextId would end up in two
 * panels fighting over `set_bounds` of one native view.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { usePaneStore } from '../../state/pane/store';
import { createPaneId } from '../../state/pane/adapters/paneConfig';
import { reclaimProjectBrowserPane } from '../../state/pane/adapters/projectBrowserPanes';
import {
  topicBrowserWindow,
  getTopicWindow,
  findTopicOwningPromoted,
  subscribeTopicWindows,
} from '../../state/topicBrowserWindow';

export interface ReturningSheet {
  contextId: string;
  url?: string;
  title?: string;
}

/**
 * Take the pane out of the layout without destroying its context.
 *
 * Two layouts can hold it, and they do not share a store: the workspace panes
 * live in `usePaneStore`, a project window keeps its own. Ask the projects
 * first, because a page open there is NOT in the pane store and dispatching
 * `RECLAIM_PANE` for it would be a no-op that leaves the page drawn twice.
 */
export function reclaimPaneFromLayout(contextId: string): void {
  if (reclaimProjectBrowserPane(contextId)) return;
  const paneId = createPaneId('browser', contextId);
  usePaneStore.getState().dispatch({ type: 'RECLAIM_PANE', payload: { id: paneId } });
}

/**
 * Bring a page back into a topic's window. `topicId` is optional: a promoted
 * tab does not know which topic lent it, so it is looked up from the windows.
 * Returns the topic that took it back, or null when nobody claims the page.
 */
export function returnSheetToWindow(sheet: ReturningSheet, topicId?: string): string | null {
  const owner = topicId ?? findTopicOwningPromoted(sheet.contextId);
  if (!owner) return null;
  reclaimPaneFromLayout(sheet.contextId);
  if (getTopicWindow(owner).promoted.includes(sheet.contextId)) {
    topicBrowserWindow.returnFromTab(owner, sheet);
  } else {
    topicBrowserWindow.open(owner, sheet);
  }
  return owner;
}

/**
 * The command a PROMOTED tab offers in its own sheet: go back into the chat.
 *
 * Undefined when this page was not lent by any window, which is the normal
 * case for an ordinary browser tab. It is a hook because the answer changes
 * under the pane: the window can take the page back from its own bar, and the
 * item must disappear with it.
 */
export function useReturnToTopicWindow(
  contextId: string,
  page: { url?: string; title?: string },
): (() => void) | undefined {
  const owner = useSyncExternalStore(
    subscribeTopicWindows,
    () => findTopicOwningPromoted(contextId),
    () => null,
  );
  const url = page.url;
  const title = page.title;
  const back = useCallback(() => {
    returnSheetToWindow({ contextId, url, title });
  }, [contextId, url, title]);
  return owner ? back : undefined;
}
