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
import { useMemo, useSyncExternalStore } from 'react';
import {
  topicBrowserWindow,
  findTopicOwningPromoted,
  subscribeTopicWindows,
} from '../../state/topicBrowserWindow';
import { beginNativeViewMove } from '../../lib/shell/nativeBrowserViews';
import { reclaimPaneFromLayout } from './reclaimFromLayout';

export interface ReturningSheet {
  contextId: string;
  url?: string;
  title?: string;
}

/**
 * Bring a page back into a topic's window. `topicId` is optional: a promoted
 * tab does not know which topic lent it, so it is looked up from the windows.
 * Returns the topic that took it back, or null when nobody claims the page.
 */
export function returnSheetToWindow(sheet: ReturningSheet, topicId?: string): string | null {
  const owner = topicId ?? findTopicOwningPromoted(sheet.contextId);
  if (!owner) return null;
  // The same handoff as the way out: the tab that leaves parks its close until
  // the window's sheet adopts the view.
  beginNativeViewMove(sheet.contextId);
  reclaimPaneFromLayout(sheet.contextId);
  topicBrowserWindow.takeFromLayout(owner, sheet);
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
/**
 * The decision behind the command, as a pure function: is there a way home
 * for this page, and what does taking it do.
 *
 * Split out of the hook so it can be tested without a renderer: this project
 * has no hook-testing harness, and "the item appears only for a lent page" is
 * exactly the part worth pinning down.
 */
export function returnCommandFor(
  owner: string | null,
  sheet: ReturningSheet,
): (() => void) | undefined {
  if (!owner) return undefined;
  return () => { returnSheetToWindow(sheet); };
}

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
  return useMemo(
    () => returnCommandFor(owner, { contextId, url, title }),
    [owner, contextId, url, title],
  );
}
