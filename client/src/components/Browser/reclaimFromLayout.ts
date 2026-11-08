/**
 * TAKING A PAGE OUT OF THE LAYOUT, WITHOUT TEARING IT DOWN.
 *
 * Two callers need it and they sit on opposite sides of the topic window's
 * store: the return trip made HERE (`returnSheetToWindow`, which imports the
 * store), and the store itself, when a value read from elsewhere says a page is
 * a sheet of the window again. That is why this module imports neither: the
 * store can call it directly, so the release is wired as soon as the store
 * exists, whichever module happened to load it first.
 */
import { usePaneStore } from '../../state/pane/store';
import { createPaneId } from '../../state/pane/adapters/paneConfig';
import { reclaimProjectBrowserPane, isProjectBrowserPaneOpen } from '../../state/pane/adapters/projectBrowserPanes';
import { beginNativeViewMove } from '../../lib/shell/nativeBrowserViews';

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
 * A page that the window record says is a sheet leaves the layout here too.
 *
 * The device that took it back ran `returnSheetToWindow`, which reclaims the
 * pane in ITS layout. This device hears about it through two records, and they
 * do not say the same thing: the window record names the page as a sheet again,
 * while a project's tab record is received additively (it can add a tab, never
 * remove one) and carries no tombstone for a page that was moved, not closed.
 * Without this the page stayed a pane here and was drawn a second time inside
 * the window. The window record is the one that knows the page by identity, so
 * it is the one that decides.
 *
 * Only a page some layout here actually holds is touched: the move mark of the
 * native view is for a surface that is about to let go, and a mark nobody takes
 * would park the close of a sheet closed in the next seconds.
 */
export function releaseArrivedSheetFromLayout(contextId: string): boolean {
  const paneId = createPaneId('browser', contextId);
  if (!usePaneStore.getState().panes[paneId] && !isProjectBrowserPaneOpen(contextId)) return false;
  beginNativeViewMove(contextId);
  reclaimPaneFromLayout(contextId);
  return true;
}
