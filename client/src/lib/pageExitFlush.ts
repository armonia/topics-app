/**
 * What the page owes the server and its own storage as it goes away (a
 * reload, a navigation, iOS putting it away), in the one order that works.
 *
 * A close still counting down is COMMITTED first, not dropped: otherwise the
 * just-closed browser / terminal / utility tab resurrects on the next boot
 * (the pending CLOSE_PANE that records the tombstone and removes the pane from
 * the persisted snapshot never ran). What that commit produced is flushed
 * after it: the store snapshot, and the cleanup of a closed terminal.
 *
 * Both of those also have a `pagehide` listener of their own, registered when
 * their module loads, before the app mounts its handler: on that same event
 * they run FIRST, before the commit, and find nothing to do. So they are
 * called again here, after it.
 */
import { flushPendingActions } from '../contexts/PendingActionContext';
import { flushLocalPaneStoreNow } from '../state/pane/middleware';
import { flushTerminalCleanups } from '../state/pane/adapters';

export function flushAtPageExit(): void {
  flushPendingActions();
  flushLocalPaneStoreNow();
  flushTerminalCleanups();
}
