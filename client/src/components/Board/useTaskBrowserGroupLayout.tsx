/**
 * useTaskBrowserGroupLayout — drive the app's real layout engine (`GroupLayout`)
 * for a task's browser tabs, task-scoped and OUTSIDE `pane-store-v2`.
 *
 * It marries the two task-scoped stores — identity (`taskBrowserTabs`) and the
 * tiling descriptor (`taskBrowserLayout`) — into the exact prop set `GroupLayout`
 * expects: `panes` derived from the live (non-parked) tabs, the reconciled
 * groups/rows, and every mutation callback routed back into the task-scoped
 * reducers. Pop-out / move-to-Space / settings are deliberately NOT wired (the
 * only gestures that would cross into the global pane store), so the reused
 * engine can never leak a task pane into the app layout.
 *
 * The reconciled layout is committed back to the store in an effect, so the
 * handlers (which read the persisted state) always operate on the same groups
 * the user sees rendered — the first render mints groups from the tabs, the
 * effect persists them, and every later interaction is structural.
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { Pane, PaneType, PaneGroupType, GroupLayoutRow, PaneGroup } from '../../types';
import { RemoteBrowserPanel } from '../Browser/RemoteBrowserPanel';
import { useTaskBrowserTabs, taskBrowserTabs, liveTabs, getTaskTabs, type TaskBrowserTab } from '../../state/taskBrowserTabs';
import {
  usePersistedTaskLayout,
  taskBrowserLayout,
  reconcileTaskLayout,
  tabToPane,
  paneIdToContextId,
} from '../../state/taskBrowserLayout';

const BROWSER_ONLY: PaneType[] = ['browser'];

export interface TaskBrowserGroupLayout {
  /** True when the task has at least one LIVE (non-parked) browser tab. */
  hasBrowser: boolean;
  liveCount: number;
  /** Every tab (live + parked) for the preview strip under the description. */
  allTabs: TaskBrowserTab[];
  parkedTabs: TaskBrowserTab[];
  /** Open a fresh browser tab (preview strip "+" / empty-state affordance). */
  addBrowserTab: () => void;
  /** Reopen a parked tab into the layout. */
  reopenTab: (contextId: string) => void;
  /** Hard-remove a tab (preview trash). */
  removeTab: (contextId: string) => void;
  /** Activate a live tab in its host group (preview-strip click). */
  focusTab: (contextId: string) => void;
  /** Seed the first tab from a url only when the task has no tabs yet. */
  seedFromUrl: (url: string, title?: string) => Promise<void>;
  /** Spread straight into `<GroupLayout {...props} />`. */
  groupLayoutProps: {
    panes: Pane[];
    groups: PaneGroup[];
    rows: GroupLayoutRow[];
    rowHeights: number[];
    focusedGroupId: string | null;
    dndScope: string;
    onActivatePane: (groupId: string, paneId: string) => void;
    onClosePane: (groupId: string, paneId: string) => void;
    onClosePaneImmediate: (groupId: string, paneId: string) => void;
    onAddPaneToGroup: (groupId: string, type: PaneType) => void;
    onReorderGroupPanes: (groupId: string, newPaneIds: string[]) => void;
    onMovePaneBetweenGroups: (sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => void;
    onSplitGroup: (sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom', opts?: { fullRow?: boolean }) => void;
    onReorderRows: (newRowOrder: number[]) => void;
    onUpdateRows: (rows: GroupLayoutRow[]) => void;
    onUpdateRowHeights: (heights: number[]) => void;
    onRenameBrowser: (paneId: string, name: string) => void;
    availableTypesForGroup: (groupType: PaneGroupType, groupId: string) => PaneType[];
    renderPane: (pane: Pane, isFocused: boolean, isVisible: boolean) => React.ReactNode;
  };
}

export function useTaskBrowserGroupLayout(taskId: string): TaskBrowserGroupLayout {
  const tabsState = useTaskBrowserTabs(taskId);
  const persisted = usePersistedTaskLayout(taskId);

  const live = useMemo(() => liveTabs(tabsState), [tabsState]);
  const livePaneIds = useMemo(() => live.map((t) => `browser:${t.contextId}`), [live]);
  const panes = useMemo(() => live.map(tabToPane), [live]);

  // Reconcile the persisted layout against the live pane set (append new tabs,
  // prune closed/parked ones, preserve manual sizes). Same-reference stable.
  const reconciled = useMemo(() => reconcileTaskLayout(persisted, livePaneIds), [persisted, livePaneIds]);

  // Persist the reconciled layout so the reducers (which read getTaskLayout)
  // see the same groups that are rendered. Idempotent: once committed, the next
  // reconcile returns the same reference and this no-ops.
  useEffect(() => {
    if (reconciled !== persisted) taskBrowserLayout.set(taskId, reconciled);
  }, [taskId, reconciled, persisted]);

  const onActivatePane = useCallback((groupId: string, paneId: string) => taskBrowserLayout.activatePane(taskId, groupId, paneId), [taskId]);
  const onClosePane = useCallback((_groupId: string, paneId: string) => taskBrowserTabs.closeTab(taskId, paneIdToContextId(paneId)), [taskId]);
  const onAddPaneToGroup = useCallback((groupId: string) => {
    // Land the new tab in the bar the user clicked, then let reconcile place it.
    taskBrowserLayout.focusGroup(taskId, groupId);
    taskBrowserTabs.addTab(taskId, '', '');
  }, [taskId]);
  const onReorderGroupPanes = useCallback((groupId: string, ids: string[]) => taskBrowserLayout.reorderGroupPanes(taskId, groupId, ids), [taskId]);
  const onMovePaneBetweenGroups = useCallback((src: string, tgt: string, paneId: string, idx: number) => taskBrowserLayout.movePaneBetweenGroups(taskId, src, tgt, paneId, idx), [taskId]);
  const onSplitGroup = useCallback((src: string, paneId: string, tgt: string, edge: 'left' | 'right' | 'top' | 'bottom', opts?: { fullRow?: boolean }) => taskBrowserLayout.splitGroup(taskId, src, paneId, tgt, edge, opts), [taskId]);
  const onReorderRows = useCallback((order: number[]) => taskBrowserLayout.reorderRows(taskId, order), [taskId]);
  const onUpdateRows = useCallback((rows: GroupLayoutRow[]) => taskBrowserLayout.updateRows(taskId, rows), [taskId]);
  const onUpdateRowHeights = useCallback((heights: number[]) => taskBrowserLayout.updateRowHeights(taskId, heights), [taskId]);
  const onRenameBrowser = useCallback((paneId: string, name: string) => taskBrowserTabs.updateTab(taskId, paneIdToContextId(paneId), { title: name, titleSource: 'user' }), [taskId]);
  const availableTypesForGroup = useCallback(() => BROWSER_ONLY, []);

  const renderPane = useCallback((pane: Pane, _isFocused: boolean, isVisible: boolean) => {
    const ctx = paneIdToContextId(pane.id);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <RemoteBrowserPanel
          contextId={ctx}
          initialUrl={pane.url}
          isVisible={isVisible}
          onUrlChange={(u) => { if (u) taskBrowserTabs.updateTab(taskId, ctx, { url: u }); }}
          onTitleChange={(t) => { if (t) taskBrowserTabs.updateTab(taskId, ctx, { title: t, titleSource: 'auto' }); }}
        />
      </div>
    );
  }, [taskId]);

  const addBrowserTab = useCallback(() => { taskBrowserTabs.addTab(taskId, '', ''); }, [taskId]);
  const reopenTab = useCallback((ctx: string) => taskBrowserTabs.unparkTab(taskId, ctx), [taskId]);
  const removeTab = useCallback((ctx: string) => taskBrowserTabs.removeTab(taskId, ctx), [taskId]);
  /** Activate a live tab in whichever group hosts it (preview-strip click). */
  const focusTab = useCallback((ctx: string) => {
    const paneId = `browser:${ctx}`;
    const g = reconciled.groups.find((gr) => gr.paneIds.includes(paneId));
    if (g) taskBrowserLayout.activatePane(taskId, g.id, paneId);
  }, [taskId, reconciled.groups]);
  /** Open a first tab from a url (e.g. the review output_url) ONLY when the task
   *  has no tabs yet. Hydrates first so it never double-seeds over persisted tabs. */
  const seedFromUrl = useCallback(async (url: string, title?: string) => {
    if (!url) return;
    await taskBrowserTabs.ensureLoaded(taskId);
    if (getTaskTabs(taskId).tabs.length === 0) taskBrowserTabs.addTab(taskId, url, title);
  }, [taskId]);

  return {
    hasBrowser: live.length > 0,
    liveCount: live.length,
    allTabs: tabsState.tabs,
    parkedTabs: useMemo(() => tabsState.tabs.filter((t) => t.parked), [tabsState.tabs]),
    addBrowserTab,
    reopenTab,
    removeTab,
    focusTab,
    seedFromUrl,
    groupLayoutProps: {
      panes,
      groups: reconciled.groups,
      rows: reconciled.rows,
      rowHeights: reconciled.rowHeights,
      focusedGroupId: reconciled.focusedGroupId,
      dndScope: `task:${taskId}`,
      onActivatePane,
      onClosePane,
      onClosePaneImmediate: onClosePane,
      onAddPaneToGroup,
      onReorderGroupPanes,
      onMovePaneBetweenGroups,
      onSplitGroup,
      onReorderRows,
      onUpdateRows,
      onUpdateRowHeights,
      onRenameBrowser,
      availableTypesForGroup,
      renderPane,
    },
  };
}
