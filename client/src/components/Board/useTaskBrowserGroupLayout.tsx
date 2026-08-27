/**
 * useTaskBrowserGroupLayout — drive the app's real layout engine (`GroupLayout`)
 * for the WHOLE task drawer body, task-scoped and OUTSIDE `pane-store-v2`.
 *
 * The drawer's surfaces are ONE tab group of the app's real `PaneTabBar`: a
 * always-present Thread pane, the agent session (only when the task HAS one),
 * the task's live browser tabs, an optional Piano pane, and one pane per media
 * attachment. Thread/session/plan/media are DERIVED from task data (not
 * persisted identities), so they're composed into the pane list at render-time
 * here; only the browser tabs have a persisted identity store
 * (`taskBrowserTabs`). The tiling descriptor (`taskBrowserLayout`) is pane-id
 * agnostic, so it hosts the synthetic panes for free.
 *
 * Reuse boundary: `GroupLayout` + `SplitTree` + `PaneTabBar` are the real app
 * components (split / resize / drag / drop are native). Pop-out / move-to-Space
 * / settings / rename-chat are deliberately NOT wired (the only gestures that
 * would cross into the global pane store). The synthetic panes are marked
 * non-closable so the shared `PaneTabBar` hides their X.
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { Pane, PaneType, PaneGroupType, GroupLayoutRow, PaneGroup } from '../../types';
import { RemoteBrowserPanel } from '../Browser/RemoteBrowserPanel';
import { useTaskBrowserTabs, taskBrowserTabs, liveTabs, getTaskTabs, isPinnedTitle, type TaskBrowserTab } from '../../state/taskBrowserTabs';
import { useTaskTabNavigate, clearTaskTabNavigate } from '../../state/taskTabNavigate';
import { mediaPaneIdFor } from './constants';
import {
  usePersistedTaskLayout,
  taskBrowserLayout,
  reconcileTaskLayout,
  syncRowsWithGroups,
  tabToPane,
  paneIdToContextId,
  canAutoActivateTaskPane,
} from '../../state/taskBrowserLayout';

const BROWSER_ONLY: PaneType[] = ['browser'];

/** A stranded auth wall — the seeded output_url 307'd here and never came back.
 *  Never a reviewable surface, so it's safe to retire even without a screenshot. */
function isLoginWall(url: string): boolean {
  return /\/(login|signin|sign-in|auth)(\/|\?|#|$)/i.test(url || '');
}

// Stable ids for the derived (non-browser) surfaces. They never enter
// pane-store-v2; they live only in this task's tiling descriptor.
const threadPaneId = (taskId: string) => `thread:${taskId}`;
const planPaneId = (taskId: string) => `plan:${taskId}`;
const mediaPaneId = mediaPaneIdFor;
const isBrowserPane = (paneId: string) => paneId.startsWith('browser:');

/**
 * The agent session's pane id. Keyed on the TASK, never on the topic it was
 * dispatched to: a redispatch moves `assignedTopicId` but must not mint a new
 * pane identity, or the layout persisted for this task (and synced to every
 * other device) would lose the tab's place and re-append it at the end.
 */
export const sessionPaneId = (taskId: string) => `session:${taskId}`;

/** How TaskDetail renders the body of a non-browser (thread/plan/media) pane. */
export type RenderSurface = (pane: Pane, isVisible: boolean) => React.ReactNode;

export interface TaskDrawerLayoutInput {
  /** True when the task has a plan-first plan to surface (planComment != null). */
  planActive: boolean;
  /** True when the task has a topic assigned: without one there is no agent
   *  session to show, and the tab must not exist at all — an empty session tab
   *  would be one more surface saying nothing the drawer doesn't already say. */
  sessionActive: boolean;
  /** Translated label for the session tab. The hook has no `useT`, so the
   *  drawer hands it the word it puts on the tab. */
  sessionTitle?: string;
  /** Attachment paths, already deduped/ordered by TaskDetail. */
  mediaPaths: string[];
  /** Renders thread/plan/media pane bodies (closure from TaskDetail). */
  renderSurface: RenderSurface;
  /**
   * The drawer mounts the THREAD (the conversation, with the composer under it)
   * in a column of its own, so the `thread:` pane leaves the tab bar: without
   * this the same conversation would be in two places at once.
   *
   * It leaves the VIEW, not the state. The pane's identity and its place in the
   * groups stay in the persisted layout (which is cross-device), so narrowing
   * and widening is not a write, and it never reorders the tabs of someone
   * reading the same task on another device.
   */
  threadInline?: boolean;
  /**
   * «Apri nel progetto» sul tasto destro di UNA tab del task.
   *
   * Il hook non sa niente di progetti: sa solo che una pane `browser:<ctx>` ha
   * un url. Chi promuove è il drawer, che ha il progetto della card e la porta
   * per aprirlo — qui passa solo il paneId su cui si è premuto.
   */
  openPaneInProject?: (paneId: string) => void;
}

export interface TaskBrowserGroupLayout {
  liveCount: number;
  /** L'url della tab viva in primo piano (o la prima viva se nessuna è attiva),
   *  `null` senza tab vive. È IL risultato del task nel modello «tab + file»:
   *  serve a «Apri nel workspace», che promuove QUESTA tab nella finestra del
   *  progetto invece del solo `output_url` (che è solo il seme della prima). */
  activeUrl: string | null;
  /** Le tab VIVE, nell'ordine in cui sono nate: È il manifesto della consegna.
   *  Chi promuove il risultato nel workspace le apre TUTTE, non solo la prima. */
  live: TaskBrowserTab[];
  /** The soft-closed browser tabs for the closed-tab tray under the description. */
  parkedTabs: TaskBrowserTab[];
  /** Open a fresh browser tab (tray "+" / empty-state affordance). */
  addBrowserTab: () => void;
  /** Reopen a parked browser tab into the layout. */
  reopenTab: (contextId: string) => void;
  /** Hard-remove a parked browser tab (tray trash). */
  removeTab: (contextId: string) => void;
  /** Activate a pane in whichever group hosts it (thread-attachment click). */
  /** Porta davanti una pane. `false` se quella pane non c'è (ancora): chi
   *  apre il drawer su una tab precisa deve poter riprovare al fetch dopo. */
  focusPane: (paneId: string) => boolean;
  /** Seed the first browser tab from a url only when the task has no tabs yet. */
  seedFromUrl: (url: string, title?: string) => Promise<void>;
  /** Park the lone auto-seeded output tab (a screenshot supersedes the live,
   *  often login-gated server as the review surface). Reopenable from the tray.
   *  `loginWallOnly` restricts it to tabs stranded on a login page — used when
   *  there's no screenshot, so a legit live server is left seeded. */
  retireLoneSeed: (opts?: { loginWallOnly?: boolean }) => Promise<void>;
  /** Spread straight into `<GroupLayout {...props} />`. */
  groupLayoutProps: {
    panes: Pane[];
    groups: PaneGroup[];
    rows: GroupLayoutRow[];
    rowHeights: number[];
    focusedGroupId: string | null;
    dndScope: string;
    /** L'ospite di queste tab per «Copia link»: le pane browser del drawer non
     *  stanno né nel pane-store né in un layout di progetto, quindi il permalink
     *  porta `?task=<id>` e chi lo apre torna QUI (apre il task) invece di
     *  cercare una pane che nessuna superficie possiede. */
    linkContext: { taskId: string };
    onOpenPaneInProject?: (paneId: string) => void;
    nonClosablePaneIds: Set<string>;
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

export function useTaskBrowserGroupLayout(taskId: string, input: TaskDrawerLayoutInput): TaskBrowserGroupLayout {
  const { planActive, sessionActive, sessionTitle, mediaPaths, renderSurface, threadInline = false, openPaneInProject } = input;
  const tabsState = useTaskBrowserTabs(taskId);
  // Pending "the agent re-opened this tab elsewhere" navigations (transient).
  const navigates = useTaskTabNavigate();
  const persisted = usePersistedTaskLayout(taskId);

  const live = useMemo(() => liveTabs(tabsState), [tabsState]);

  // The derived (non-browser) surface panes. Stable ids so GroupLayout's
  // keep-alive never remounts the Thread subtree across tab switches.
  // The Thread pane's title is vestigial: `threadInline` takes it out of the
  // view, so no bar ever paints it. It still must not read "Sessione" — that
  // word now names the tab NEXT to it, and a title that lies is worse than one
  // nobody sees.
  const threadPane = useMemo<Pane>(() => ({
    id: threadPaneId(taskId), type: 'chat', title: 'Thread', stableKey: threadPaneId(taskId),
  }), [taskId]);
  // No `topicId` on the session pane on purpose: it would switch PaneTabBar
  // onto the topic's own icon/colour and into the attention/seen machinery,
  // which is a different behaviour (and a different decision) from showing the
  // task's session as one more tab.
  const sessionPane = useMemo<Pane | null>(() => (sessionActive
    ? { id: sessionPaneId(taskId), type: 'chat', title: sessionTitle ?? 'Session', stableKey: sessionPaneId(taskId) }
    : null), [taskId, sessionActive, sessionTitle]);
  const planPane = useMemo<Pane | null>(() => (planActive
    ? { id: planPaneId(taskId), type: 'plan', title: 'Piano', stableKey: planPaneId(taskId) }
    : null), [taskId, planActive]);
  const mediaPanes = useMemo<Pane[]>(() => mediaPaths.map((p) => ({
    id: mediaPaneId(p), type: 'file', title: p.split('/').pop() || 'Allegato', stableKey: mediaPaneId(p),
  })), [mediaPaths]);

  // Composed pane list: Thread, then the agent session, then live browsers,
  // then Piano, then media. The session's place is load-bearing twice over: the
  // thread pane is filtered out of the view, so it is the LEFTMOST tab in the
  // bar; and reconcile activates the LAST orphan that qualifies, so a browser
  // tab born in the same pass still wins the active slot over it.
  const panes = useMemo<Pane[]>(() => [
    threadPane,
    ...(sessionPane ? [sessionPane] : []),
    ...live.map(tabToPane),
    ...(planPane ? [planPane] : []),
    ...mediaPanes,
  ], [threadPane, sessionPane, live, planPane, mediaPanes]);
  const livePaneIds = useMemo(() => panes.map((p) => p.id), [panes]);
  const nonClosablePaneIds = useMemo(
    () => new Set(panes.filter((p) => !isBrowserPane(p.id)).map((p) => p.id)),
    [panes],
  );

  // Reconcile the persisted layout against the live pane set (append new panes,
  // prune gone ones, preserve manual sizes). Same-reference stable.
  const reconciled = useMemo(
    () => reconcileTaskLayout(persisted, livePaneIds, undefined, canAutoActivateTaskPane),
    [persisted, livePaneIds],
  );

  // Persist the reconciled layout so the reducers (which read getTaskLayout)
  // see the same groups that are rendered. Idempotent: once committed, the next
  // reconcile returns the same reference and this no-ops.
  useEffect(() => {
    if (reconciled !== persisted) taskBrowserLayout.set(taskId, reconciled);
  }, [taskId, reconciled, persisted]);

  // The VIEW GroupLayout receives. Same as `reconciled`, except that the
  // `thread:` pane steps out of it (TaskDetail mounts the thread in a column of
  // its own). Derived on every render, NEVER persisted: see `threadInline`.
  //
  // ONLY `thread:` leaves the view. The session pane is a tab like any other:
  // filtering "everything that isn't a browser" here would delete it from the
  // bar the moment it was born.
  //
  // Un gruppo rimasto senza pane sparisce dalla vista, e con lui la sua cella:
  // se spariscono tutti la colonna di destra resta senza gruppi — caso reale su
  // un task senza tab, senza piano e senza allegati — e TaskDetail lo riconosce
  // da `panes.length === 0` per mostrare uno stato vuoto invece di un rettangolo.
  const view = useMemo(() => {
    const tid = threadPaneId(taskId);
    if (!threadInline) return reconciled;
    const groups = reconciled.groups
      .map((g) => {
        if (!g.paneIds.includes(tid)) return g;
        const paneIds = g.paneIds.filter((id) => id !== tid);
        return { ...g, paneIds, activePaneId: paneIds.includes(g.activePaneId) ? g.activePaneId : (paneIds[0] ?? g.activePaneId) };
      })
      .filter((g) => g.paneIds.length > 0);
    if (groups.length === reconciled.groups.length && groups.every((g, i) => g === reconciled.groups[i])) return reconciled;
    const r = syncRowsWithGroups(groups, reconciled.rows, reconciled.rowHeights);
    const focusedGroupId = groups.some((g) => g.id === reconciled.focusedGroupId)
      ? reconciled.focusedGroupId
      : (groups[0]?.id ?? null);
    return { groups, rows: r.rows, rowHeights: r.rowHeights, focusedGroupId };
  }, [reconciled, threadInline, taskId]);
  const viewPanes = useMemo(
    () => (threadInline ? panes.filter((p) => p.id !== threadPaneId(taskId)) : panes),
    [panes, threadInline, taskId],
  );

  const onActivatePane = useCallback((groupId: string, paneId: string) => taskBrowserLayout.activatePane(taskId, groupId, paneId), [taskId]);
  // Close routing: a browser tab parks (soft-close → reopenable tray); the
  // derived thread/plan/media panes have no X (nonClosablePaneIds), so this is
  // only ever reached for browsers. Guard anyway.
  const onClosePane = useCallback((_groupId: string, paneId: string) => {
    if (!isBrowserPane(paneId)) return;
    const ctx = paneIdToContextId(paneId);
    // Drop any navigation the pane never consumed: it would fire at the next
    // un-park, on a page the agent asked for a long time ago.
    clearTaskTabNavigate(ctx);
    taskBrowserTabs.closeTab(taskId, ctx);
  }, [taskId]);
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
    if (!isBrowserPane(pane.id)) return renderSurface(pane, isVisible);
    const ctx = paneIdToContextId(pane.id);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <RemoteBrowserPanel
          contextId={ctx}
          initialUrl={pane.url}
          // The agent re-opened this ALREADY MOUNTED tab on another URL:
          // `initialUrl` is read at mount only, so the request rides the same
          // `navigateUrl` channel the project window and the standalone chat
          // have always used. Cleared on consume, so it fires once.
          navigateUrl={navigates[ctx]}
          onNavigateConsumed={() => clearTaskTabNavigate(ctx)}
          isVisible={isVisible}
          // Ignore `about:blank`: a failed navigation (dead/unreachable target)
          // reports about:blank, which would CLOBBER the seeded URL and strand
          // the tab on a blank page (the seeded output_url would be lost). Keep
          // the intended URL so a retry / server-up still loads it.
          onUrlChange={(u) => { if (u && u !== 'about:blank') taskBrowserTabs.updateTab(taskId, ctx, { url: u }); }}
          onTitleChange={(t) => { if (t) taskBrowserTabs.updateTab(taskId, ctx, { title: t, titleSource: 'auto' }); }}
        />
      </div>
    );
  }, [taskId, renderSurface, navigates]);

  const addBrowserTab = useCallback(() => { taskBrowserTabs.addTab(taskId, '', ''); }, [taskId]);
  const reopenTab = useCallback((ctx: string) => taskBrowserTabs.unparkTab(taskId, ctx), [taskId]);
  const removeTab = useCallback((ctx: string) => taskBrowserTabs.removeTab(taskId, ctx), [taskId]);
  // Activate a pane in whichever group hosts it (thread-attachment preview click).
  const focusPane = useCallback((paneId: string) => {
    const g = reconciled.groups.find((gr) => gr.paneIds.includes(paneId));
    if (!g) return false;
    taskBrowserLayout.activatePane(taskId, g.id, paneId);
    return true;
  }, [taskId, reconciled.groups]);
  /** Open a first browser tab from a url (e.g. the review output_url) ONLY when
   *  the task has no browser tabs yet. Hydrates first so it never double-seeds. */
  const seedFromUrl = useCallback(async (url: string, title?: string) => {
    if (!url) return;
    await taskBrowserTabs.ensureLoaded(taskId);
    if (getTaskTabs(taskId).tabs.length === 0) taskBrowserTabs.addTab(taskId, url, title);
  }, [taskId]);
  /** Retire (park) the lone auto-seeded output tab when the screenshot takes
   *  over as the review surface. The seeded tab's URL is unreliable — it drifts
   *  to `/login` after a 307, or points at a stale port — so we DON'T match on
   *  url: a single live tab that the reviewer never pinned (renamed) IS the
   *  auto-seed / a stale live server, and the screenshot supersedes it. A
   *  reviewer who split/added tabs (>1) or pinned one is left untouched. Parked
   *  = reopenable from the closed-tab tray, never destroyed; the live server
   *  also stays a click away via the drawer's "Apri l'output" button. */
  const retireLoneSeed = useCallback(async (opts?: { loginWallOnly?: boolean }) => {
    await taskBrowserTabs.ensureLoaded(taskId);
    const live = liveTabs(getTaskTabs(taskId));
    if (live.length !== 1) return;
    const t = live[0];
    // Etichetta decisa da qualcuno: il reviewer l'ha rinominata, oppure è il
    // NOME che l'agente le ha dato nel manifesto. In entrambi i casi non è il
    // seme automatico dell'output_url, quindi non si ritira.
    if (isPinnedTitle(t.titleSource)) return;
    if (opts?.loginWallOnly && !isLoginWall(t.url)) return;     // keep a legit live server
    taskBrowserTabs.closeTab(taskId, t.contextId);
  }, [taskId]);

  return {
    liveCount: live.length,
    live,
    activeUrl: (live.find((t) => t.contextId === tabsState.activeContextId) ?? live[0])?.url || null,
    parkedTabs: useMemo(() => tabsState.tabs.filter((t) => t.parked), [tabsState.tabs]),
    addBrowserTab,
    reopenTab,
    removeTab,
    focusPane,
    seedFromUrl,
    retireLoneSeed,
    groupLayoutProps: {
      panes: viewPanes,
      groups: view.groups,
      rows: view.rows,
      rowHeights: view.rowHeights,
      focusedGroupId: view.focusedGroupId,
      dndScope: `task:${taskId}`,
      linkContext: { taskId },
      onOpenPaneInProject: openPaneInProject,
      nonClosablePaneIds,
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
