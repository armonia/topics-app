import { useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PanelTab } from '../../types';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { PaneTabBar } from './PaneTabBar';
import { ChatPanel } from './ChatPanel';
import { LazyPane } from './LazyPane';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import { DND_TYPES, STANDALONE_SCOPE } from '../../lib/dndTypes';
import { useMultiContextPercent } from '../../hooks/useContextInspector';
import { isUtilityPanelId, parseUtilityPanelType } from './UtilityPanel';
import {
  PANE_CONFIG,
  getAddableTypesForScope,
  isProjectPaneId,
  isBrowserPaneId,
  isTerminalPaneId,
  isSessionViewerPaneId,
  getTerminalSessionFromPaneId,
  getProjectPathFromPaneId,
  getSessionKeyFromViewerPaneId,
  getBrowserContextFromPaneId,
  isDraftPaneId,
  useProjectTabStatus,
  type ProjectTabStatus,
} from '../../state/pane/adapters';
import { persistBrowserPaneUrl, getBrowserPaneUrl } from '../../state/pane/browserPaneUrl';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { ProjectWindowPane } from './ProjectWindow';
import { getProjectName, hashToColor } from './projectColors';
import { usePaneOrdering } from './hooks/usePaneOrdering';
import { useActivePaneState } from './hooks/useActivePaneState';
import { usePaneLifecycle } from './hooks/usePaneLifecycle';
import { resolveStandaloneCrossGroupDrop } from './standaloneDrop';
import { primaryFromSoloCellKey } from './soloCells';
import { canSplitPane, standaloneSplitSurface } from './splitRules';

const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));

const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ActivityFeedPanel = lazy(() => import('../Sidebar/ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const JournalPanel = lazy(() => import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const SessionViewerPane = lazy(() => import('../Agents/SessionViewerPane').then(m => ({ default: m.SessionViewerPane })));


interface StandaloneChatGroupProps {
  topicIds: string[];
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string, onCommit?: () => void) => void;
  /** Optional bypass-the-countdown close, plumbed to PaneTabBar's
   *  right-click "Close now" entry. Falls back to onClosePanel. */
  onClosePanelImmediate?: (topicId: string) => void;
  onDragStart: (topicId: string) => (e: React.DragEvent) => void;
  // Chat props pass-through
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onToggleSidebar?: () => void;
  panelInitialTab?: Record<string, PanelTab>;
  onPanelInitialTabConsumed?: (topicId: string) => void;
  // App-level quick-create. May resolve to the new DRAFT pane id (string) —
  // a split cell uses it to re-target the pane into itself (see the wrapper
  // around PaneTabBar's onNewChat below).
  onNewChat?: () => void | Promise<unknown>;
  stopSession: (sessionKey: string) => boolean;
  // Pending pane request for project tabs
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType; terminalSessionId?: string; terminalType?: 'shell' | 'claude-code' | 'codex' } | null;
  onPendingProjectPaneConsumed?: () => void;
  // Create new chat in a project (optional groupId = the tab bar clicked)
  onNewChatInProject?: (projectPath: string, groupId?: string) => void;
  // Pending focus for project tabs (navigate to a topic inside a project)
  pendingProjectFocus?: { projectPath: string; topicId: string; targetGroupId?: string } | null;
  onPendingProjectFocusConsumed?: () => void;
  // Report which topic is active inside the focused project
  onProjectActiveTopicChange?: (projectPath: string, topicId: string | null) => void;
  // Report all open pane IDs inside each project (for sidebar filtering)
  onProjectOpenPanesChange?: (projectPath: string, paneIds: string[]) => void;
  // Create a new terminal (delegates to App). Returns the new pane id so the
  // "+" on a split cell's tab bar can re-target the pane into that cell.
  onCreateTerminal?: (type: 'shell' | 'claude-code' | 'codex', skipPermissions?: boolean) => void | Promise<string | null>;
  // Report whether this group has utility panes (browser/terminal)
  onUtilityPaneChange?: (has: boolean) => void;
  // Pending browser pane request (from sidebar) — contextId or null
  pendingBrowserPane?: string | null;
  onPendingBrowserPaneConsumed?: () => void;
  // Report open browser context IDs to parent
  onOpenBrowserContextIds?: (ids: string[]) => void;
  // Draft chat support
  promoteDraft?: (draftId: string, firstMessage: string, options?: { planMode?: boolean }) => Promise<void>;
  draftMeta?: Record<string, { projectPath?: string }>;
  // Split a pane into its own grid cell (right or down)
  onSplitPane?: (topicId: string, direction: 'right' | 'down') => void;
  // "Reimposta pannelli" — flatten the surrounding grid back to one row of
  // equal cells. Passed through to PaneTabBar's context menu; undefined when
  // the grid is already flat (PanelGrid hides the entry).
  onResetLayout?: () => void;
  // Only the main standalone group should persist panel order (solo groups skip)
  persistOrder?: boolean;
  // Grid item key — used as groupId in PaneTabBar for cross-group DnD detection.
  // "standalone" for the main group, "solo:<topicId>" for split-out groups.
  gridItemKey?: string;
  // Unsolo: merge a solo topic back into the main group
  onUnsolo?: (topicId: string) => void;
  // Accept a solo topic drop (main group only) — unsolos the dropped topic
  onAcceptSoloDrop?: (topicId: string) => void;
  // Merge a dropped tab INTO this split cell (multi-tab column). `targetPrimary`
  // is this cell's primary topic id; `insertIdx` is the tab slot the drop
  // indicators promised (omitted = append). Enables "drop a tab into a
  // populated cell".
  onMergeIntoCell?: (topicId: string, targetPrimary: string, insertIdx?: number) => void;
  // Persist a tab reorder upstream (main pool only — PanelGrid merges the
  // pool's order back into App.openPanels so it survives reload).
  onPersistReorder?: (newPaneIds: string[]) => void;
  // Sidebar "Fissati" pin toggle + state for a tab's subject (chat topicId or
  // `terminal:<sessionId>`). Forwarded to PaneTabBar's context menu so a tab
  // can be pinned/unpinned like its sidebar row. App-level only.
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
}

export function StandaloneChatGroup({
  topicIds, focusedPanelId,
  onFocusPanel, onClosePanel, onClosePanelImmediate, onDragStart,
  getSessionMessages, isSessionLoading, isSessionStreaming,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat, stopSession,
  pendingProjectPane, onPendingProjectPaneConsumed,
  onNewChatInProject, pendingProjectFocus, onPendingProjectFocusConsumed,
  onProjectActiveTopicChange, onProjectOpenPanesChange,
  onCreateTerminal,
  onUtilityPaneChange,
  pendingBrowserPane, onPendingBrowserPaneConsumed,
  onOpenBrowserContextIds,
  promoteDraft, draftMeta: _draftMeta,
  onSplitPane,
  onResetLayout,
  persistOrder = true,
  gridItemKey = 'standalone',
  onUnsolo, onAcceptSoloDrop, onMergeIntoCell, onPersistReorder,
  onToggleFissato, isFissato,
}: StandaloneChatGroupProps) {
  const [claudeSkipPermissions] = useClaudeSkipPermissions();

  // Topics + terminal sessions from TopicsContext — both used to be
  // drilled here as props.
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();

  // Component-local UI state.
  const [panelDragOver, setPanelDragOver] = useState(false);
  // Context inspector state (lifted from ChatPanel so ring click can toggle it)
  const [contextOpen, setContextOpen] = useState(false);
  // Browser navigate URL (from WS) — owned here, mutated by ordering hook via callback.
  const [browserNavigateUrl, setBrowserNavigateUrl] = useState<string | null>(null);

  // Hook 1: pane ordering, pinning, preview-replacement, browser singleton,
  // WS browser:navigate, initialTab, pendingBrowserPane, utility/browser
  // reporters, and Path 4 activePaneId derivation.
  const ordering = usePaneOrdering({
    topicIds,
    persistOrder,
    onClosePanel,
    onFocusPanel,
    onWSMessage,
    pendingBrowserPane,
    onPendingBrowserPaneConsumed,
    onUtilityPaneChange,
    onOpenBrowserContextIds,
    panelInitialTab,
    onPanelInitialTabConsumed,
    focusedPanelId,
    onBrowserNavigateUrl: setBrowserNavigateUrl,
  });
  const { validatedOrderedIds, effectivePinnedIds, activePaneId } = ordering.derived;

  // Terminal pane labels derived from server sessions
  const terminalLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of terminalSessions) {
      map[`terminal:${s.id}`] = s.name;
    }
    return map;
  }, [terminalSessions]);

  // Hook 3: pure derivations from validatedOrderedIds + activePaneId + topics.
  const active = useActivePaneState({
    validatedOrderedIds,
    activePaneId,
    topics,
  });
  const {
    // Per-pane type flags are now consumed inside `renderPaneBody`
    // directly off pane.id (so hidden panes get the right body too); we
    // only keep the active-* flags that the early-return guard still
    // checks below, plus draftTopics + browserContextId for the chat /
    // browser branches inside renderPaneBody.
    activeIsBrowser, activeIsTerminal, activeIsSessionViewer,
    activeIsProject, activeIsUtility,
    activeTopic, browserContextId,
    draftTopics,
  } = active;

  // Build Pane[] for PaneTabBar (mix of chat topics, utility panes, project panes, browser panes, and terminal panes)
  const panes: Pane[] = useMemo(() =>
    validatedOrderedIds.map(id => {
      const isPreview = !effectivePinnedIds.has(id);
      if (isBrowserPaneId(id)) {
        return {
          id,
          type: 'browser' as PaneType,
          title: 'Browser',
          preview: false,
          // Seed the persisted URL from the store so renderPaneBody passes it
          // as initialUrl → the tab reopens to its page after a restart instead
          // of about:blank. (This map reconstructs panes from ids, so without
          // this the url never reaches the render.)
          url: getBrowserPaneUrl(id),
        };
      }
      if (isTerminalPaneId(id)) {
        return {
          id,
          type: 'terminal' as PaneType,
          title: terminalLabels[id] || 'Terminal',
          preview: false,
        };
      }
      if (isProjectPaneId(id)) {
        const projectPath = getProjectPathFromPaneId(id)!;
        return {
          id,
          type: 'project' as PaneType,
          // Without projectPath on the pane, PaneTabBar gates out the
          // project-level tab indicators (streaming spinner + notification
          // rollup badge) — they'd only render on the sidebar, which uses the
          // raw path. Set it so the project TAB matches the row.
          projectPath,
          title: getProjectName(projectPath),
          preview: false, // project panes are always pinned
          color: hashToColor(projectPath),
        };
      }
      if (isSessionViewerPaneId(id)) {
        const sk = getSessionKeyFromViewerPaneId(id);
        return {
          id,
          type: 'session-viewer' as PaneType,
          title: sk ? `Session: ${sk.split(':').pop()?.slice(0, 8) || 'viewer'}` : 'Session',
          sessionKey: sk || undefined,
          preview: false,
        };
      }
      if (isUtilityPanelId(id)) {
        const utilType = parseUtilityPanelType(id);
        const paneType = (utilType || 'activity') as PaneType;
        const config = PANE_CONFIG[paneType];
        return {
          id,
          type: paneType,
          title: config?.label || 'Panel',
          preview: isPreview,
        };
      }
      if (isDraftPaneId(id)) {
        return {
          id,
          type: 'chat' as PaneType,
          title: 'New Chat',
          preview: false,
        };
      }
      return {
        id,
        type: 'chat' as PaneType,
        topicId: id,
        title: topics[id]?.name || 'Chat',
        preview: isPreview,
      };
    }), [validatedOrderedIds, topics, effectivePinnedIds, terminalLabels]);

  // Build tab notification badge map from context. Project tabs inherit their
  // children's badges via the central rollup (getProjectBadgeCount); other
  // panes use their own badge.
  const { getBadgeCount, getProjectBadgeCount, clearPane } = useTabNotifications();
  const tabNotifications = useMemo(() => {
    const map = new Map<string, number>();
    for (const pane of panes) {
      const count =
        pane.type === 'project' && pane.projectPath
          ? getProjectBadgeCount(pane.projectPath)
          : getBadgeCount(pane.id, pane.topicId, pane.id === activePaneId);
      if (count > 0) map.set(pane.id, count);
    }
    return map;
  }, [panes, getBadgeCount, getProjectBadgeCount, activePaneId]);

  // Keep-alive: track visited pane keys so we can keep their React
  // subtrees mounted across tab switches. Only the active pane is
  // visible at any time (display:flex; the rest are display:none and
  // removed from layout entirely). Preserves chat scroll, history
  // caches, terminal buffers, draft text, expanded tool calls, etc.
  // across tab navigation. Pruned when a pane is closed (no longer in
  // `validatedOrderedIds`).
  //
  // Naming + algorithm match `GroupLayout`'s keep-alive. Top-level
  // panes don't currently set `pane.stableKey`, so the helper falls
  // back to `pane.id`; if the reducer-side stableKey ever propagates
  // here (e.g. for draft → real promotion), the visited set continues
  // to work without remounting the subtree.
  const stableKeyOf = useCallback((p: Pane) => p.stableKey ?? p.id, []);
  const [visitedKeys, setVisitedKeys] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    const lookup = new Map(panes.map((p) => [p.id, p]));
    if (activePaneId) {
      const p = lookup.get(activePaneId);
      if (p) initial.add(p.stableKey ?? p.id);
    }
    return initial;
  });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep-alive set syncs against the live pane list (external-ish derived state); the updater returns `prev` unchanged when nothing changed, so it converges and never cascades
    setVisitedKeys((prev) => {
      const next = new Set(prev);
      let changed = false;
      if (activePaneId) {
        const p = panes.find((q) => q.id === activePaneId);
        if (p) {
          const k = stableKeyOf(p);
          if (!next.has(k)) {
            next.add(k);
            changed = true;
          }
        }
      }
      const liveKeys = new Set(panes.map(stableKeyOf));
      for (const k of next) {
        if (!liveKeys.has(k)) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePaneId, panes, stableKeyOf]);

  // Always include the currently-active pane even if visitedKeys
  // hasn't caught up yet — the visited set updates in the effect above
  // which runs *after* render, so the very first render after a fresh
  // activation would otherwise show no pane bodies for one frame.
  const visitedPanes = useMemo(
    () => panes.filter((p) => visitedKeys.has(stableKeyOf(p)) || p.id === activePaneId),
    [panes, visitedKeys, activePaneId, stableKeyOf],
  );

  // Hook 2: action handlers (browser singleton, close, split, settings, etc.)
  // `onMergeIntoCell` lets handleAddPane route a pane created from THIS split
  // cell's "+" into the cell itself instead of the main standalone pool.
  const lifecycle = usePaneLifecycle({
    ordering, active,
    topics, topicIds, gridItemKey,
    onClosePanel, onFocusPanel,
    onSplitPane, onUnsolo,
    onCreateTerminal, onMergeIntoCell, onPersistReorder, claudeSkipPermissions,
    stopSession,
  });
  const { settingsTopicId, setSettingsTopicId } = lifecycle;
  const {
    handleReorderPanes, handlePinPane, handleAddPane, handleClosePane,
    handleStopStreaming, handleOpenSessionViewer, handleSettings, handlePopOut,
    handleSplitRight, handleSplitDown, handleDetach, handleUnsolo,
    handleCloseOthers,
  } = lifecycle.handlers;

  // Cross-group drop: accept a tab dragged from another group (solo or project).
  // When a tab is dropped onto another group's tab bar:
  // - Unsolo the dragged topic (returns to standalone)
  // - If the TARGET is also solo, unsolo it too (both merge into standalone)
  const handleCrossGroupDrop = useCallback((sourcePaneId: string, sourceGroupId: string, insertIdx: number) => {
    // All the routing/anti-collapse logic lives in the pure, unit-tested
    // resolver (standaloneDrop.ts). The handler just dispatches its decision.
    const decision = resolveStandaloneCrossGroupDrop({
      sourcePaneId,
      sourceGroupId,
      targetGroupId: gridItemKey,
      targetTopicIds: topicIds,
      canAcceptSolo: !!onAcceptSoloDrop,
      canMergeIntoCell: !!onMergeIntoCell,
      insertIdx,
    });
    switch (decision.kind) {
      case 'noop':
        return;
      case 'merge-into-cell':
        // The dragged tab joins THIS split cell at the indicated tab slot —
        // no collapse, and the drop indicator's promise is honored.
        onMergeIntoCell?.(decision.draggedTopicId, decision.targetPrimary, decision.insertIdx);
        return;
      case 'unsolo-dragged':
        // Dropped on the main pool → un-split the dragged tab back into it.
        onAcceptSoloDrop?.(decision.draggedTopicId);
        return;
    }
  }, [onAcceptSoloDrop, onMergeIntoCell, topicIds, gridItemKey]);

  // Handle drops from solo groups (cross-panel-type)
  const handleStandaloneDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptSoloDrop && !onMergeIntoCell) return;
    // Accept PANEL_ID drops that also have PANE_TAB (from project tab bars or solo groups)
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Don't accept grid item drags
    if (e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    // WKWebView (Tauri) needs an explicit dropEffect or the source dragend reads
    // 'none' and the pop-out path closes the dragged pane (this merge drop has
    // its own handler, so PanelGrid's dropConsumedRef guard doesn't cover it).
    e.dataTransfer.dropEffect = 'move';
    setPanelDragOver(true);
  }, [onAcceptSoloDrop, onMergeIntoCell]);

  const handleStandaloneDragLeave = useCallback(() => {
    setPanelDragOver(false);
  }, []);

  const handleStandaloneDrop = useCallback((e: React.DragEvent) => {
    const topicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);
    if (!topicId) return;
    e.preventDefault();
    e.stopPropagation();
    setPanelDragOver(false);

    // If the topic is already in this group, skip
    if (topicIds.includes(topicId)) return;

    // Dropping onto a split cell's body merges into that cell; onto the main
    // pool un-splits the dropped topic. (Mirrors the tab-bar cross-group drop.)
    if (onMergeIntoCell && gridItemKey.startsWith('solo:')) {
      onMergeIntoCell(topicId, gridItemKey.slice('solo:'.length));
      return;
    }
    if (onAcceptSoloDrop) {
      onAcceptSoloDrop(topicId);
    }
  }, [onAcceptSoloDrop, onMergeIntoCell, topicIds, gridItemKey]);

  // Build paneId → topicId map for context percent (only for real chat panes, not drafts)
  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id of validatedOrderedIds) {
      if (!isUtilityPanelId(id) && !isProjectPaneId(id) && !isBrowserPaneId(id) && !isTerminalPaneId(id) && !isSessionViewerPaneId(id) && !isDraftPaneId(id)) map[id] = id;
    }
    return map;
  }, [validatedOrderedIds]);
  const contextPercent = useMultiContextPercent(paneToTopicMap, onWSMessage);

  // Project tab status indicators (git + processes)
  const projectPaths = useMemo(() => {
    const paths: string[] = [];
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id)) {
        const p = getProjectPathFromPaneId(id);
        if (p) paths.push(p);
      }
    }
    return paths;
  }, [validatedOrderedIds]);
  const projectStatusByPath = useProjectTabStatus(projectPaths);
  const projectStatus = useMemo(() => {
    const map: Record<string, ProjectTabStatus> = {};
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id)) {
        const p = getProjectPathFromPaneId(id);
        if (p && projectStatusByPath[p]) map[id] = projectStatusByPath[p];
      }
    }
    return map;
  }, [validatedOrderedIds, projectStatusByPath]);

  const handleToggleContext = useCallback(() => {
    setContextOpen(prev => !prev);
  }, []);

  if (validatedOrderedIds.length === 0) return null;
  // Need at least one valid pane (either a topic, a utility, a project, a browser, or a terminal)
  if (!activeTopic && !activeIsUtility && !activeIsProject && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer) return null;

  // Single source of truth — `addableScopes: ['standalone']` in PANE_CONFIG.
  // Previously this was a hardcoded ['browser', 'terminal'] with a bespoke
  // browser-singleton check; now `getAddableTypesForScope` does both via
  // `singleton` + `addableScopes` flags and the project tab bar derives
  // its list the same way (see useProjectLayout.availableTypesForGroup).
  const availableTypes: PaneType[] = (() => {
    const present = new Set<PaneType>();
    if (validatedOrderedIds.some(id => isBrowserPaneId(id))) present.add('browser');
    return getAddableTypesForScope('standalone', present);
  })();

  // Shared split gating (splitRules.ts) — the ONE predicate this group's
  // menu entries, usePaneLifecycle's handlers and the project surface all
  // agree on, so "Split Right/Down" is offered exactly when it works.
  const groupCanSplit = canSplitPane({
    surface: standaloneSplitSurface(gridItemKey),
    groupSize: validatedOrderedIds.length,
  });

  // Tab bar rendered inline in header
  const tabBar = (
    <PaneTabBar
      className="flex-1 py-1 pr-0 min-w-0 app-drag-region"
      panes={panes}
      activePaneId={activePaneId}
      groupIsFocused={validatedOrderedIds.includes(focusedPanelId || '')}
      onActivate={(paneId) => {
        clearPane(paneId); // clear non-chat badge on tab activation
        onFocusPanel(paneId);
      }}
      onClose={handleClosePane}
      onCloseImmediate={onClosePanelImmediate}
      onAddPane={handleAddPane}
      availableTypes={availableTypes}
      addMenuScope="standalone"
      groupId={gridItemKey}
      // Every top-level group (the main standalone group and any solo split
      // cells) shares the standalone scope, so tabs reorder/merge freely among
      // them but a project's tabs can't be dropped here (and vice-versa).
      dndScope={STANDALONE_SCOPE}
      // Split-cell "+ New Chat": app-level creation appends the draft to the
      // MAIN standalone pool, so when this group is a solo cell re-target the
      // fresh draft into the cell — same routing as terminals/browsers in
      // usePaneLifecycle.handleAddPane.
      onNewChat={onNewChat ? () => {
        const res = onNewChat();
        const targetPrimary = primaryFromSoloCellKey(gridItemKey);
        if (res instanceof Promise && targetPrimary && onMergeIntoCell) {
          void res.then((created) => {
            if (typeof created === 'string') onMergeIntoCell(created, targetPrimary);
          });
        }
      } : undefined}
      onReorderPanes={handleReorderPanes}
      onCrossGroupDrop={onAcceptSoloDrop ? handleCrossGroupDrop : undefined}
      contextPercent={contextPercent}
      onContextRingClick={handleToggleContext}
      // Gated by the SHARED canSplitPane rule (splitRules.ts) — the same
      // predicate usePaneLifecycle's isSplittable guards the handlers with,
      // so an offered entry always works: the pool always splits (single-tab
      // auto-spawns a draft companion), a solo cell splits only when it
      // holds MORE than one tab (a member splits out into its own cell,
      // exactly like the drag path's extractToOwnCell).
      onSplitRight={onSplitPane && groupCanSplit ? handleSplitRight : undefined}
      onSplitDown={onSplitPane && groupCanSplit ? handleSplitDown : undefined}
      onResetLayout={onResetLayout}
      // Spazi: every top-level (app-level) group offers "Sposta nello
      // Spazio →" — project-inner tab bars never pass this.
      canMoveToSpace
      onCloseOthers={handleCloseOthers}
      onSettings={handleSettings}
      onPopOut={handlePopOut}
      // 'Detach' = split OUT into an own cell (pool tabs). A solo cell's tab
      // instead offers 'Riporta nel gruppo' (onReattach → unsolo) — the two
      // used to share one 'Detach' label with opposite semantics.
      onDetach={handleUnsolo ? undefined : (onSplitPane && groupCanSplit ? handleDetach : undefined)}
      onReattach={handleUnsolo}
      onStopStreaming={handleStopStreaming}
      onPinPane={handlePinPane}
      onToggleFissato={onToggleFissato}
      isFissato={isFissato}
      projectStatus={projectStatus}
      tabNotifications={tabNotifications}
      hasLeftOverlay={!!onToggleSidebar}
    />
  );

  const settingsTopic = settingsTopicId ? topics[settingsTopicId] : null;

  // Renders the BODY of a single pane (no header — the header lives once
  // at the top of the standalone group). All visited panes render their
  // body simultaneously so their React state survives tab switches; only
  // the active body is visible (display:flex), the others are
  // display:none and out of layout. `isPaneActive` lets us thread per-
  // pane focus / browser-navigate-url props without leaking transient
  // signals into hidden siblings.
  const renderPaneBody = (pane: Pane, isPaneActive: boolean): React.ReactNode => {
    const paneId = pane.id;
    if (isTerminalPaneId(paneId)) {
      const sessionId = getTerminalSessionFromPaneId(paneId);
      if (!sessionId) return null;
      return (
        <LazyPane>
          <SingleTerminalPane sessionId={sessionId} isActive={isPaneActive} />
        </LazyPane>
      );
    }
    if (isSessionViewerPaneId(paneId)) {
      const sk = getSessionKeyFromViewerPaneId(paneId);
      if (!sk) return null;
      return (
        <LazyPane>
          <SessionViewerPane sessionKey={sk} onNavigateToTopic={(topicId) => onFocusPanel(topicId)} />
        </LazyPane>
      );
    }
    if (isBrowserPaneId(paneId)) {
      const ctx = getBrowserContextFromPaneId(paneId) || browserContextId;
      return (
        <LazyPane>
          <RemoteBrowserPanel
            contextId={ctx}
            // Restore the tab to its last page after a window restart (the
            // browser analogue of a chat tab restoring its conversation).
            // pane.url round-trips via the pane snapshot; mount-only in the hook.
            initialUrl={pane.url}
            navigateUrl={isPaneActive && browserNavigateUrl ? browserNavigateUrl : undefined}
            onNavigateConsumed={isPaneActive ? () => setBrowserNavigateUrl(null) : undefined}
            // Persist each navigation onto the pane so the next restart restores it.
            onUrlChange={(u) => persistBrowserPaneUrl(paneId, u)}
            // Drives WebContentsView visibility — `display:none` on the
            // keep-alive wrapper doesn't reach the OS-level overlay, so
            // we tell it explicitly. Without this, the inactive browser's
            // native view would stay at its last-known bounds and bleed
            // through underneath the active pane.
            isVisible={isPaneActive}
            // Wires the back-to-spawner toolbar button — the panel reads
            // browserSpawner registry internally and only surfaces the
            // button when this browser was opened from a known chat.
            onFocusPanel={onFocusPanel}
            topics={topics}
            // A click inside the native pane never reaches React; activate this
            // pane's tab the same way the tab bar's onActivate does (line ~512).
            onSelfFocus={() => onFocusPanel(paneId)}
          />
        </LazyPane>
      );
    }
    if (isProjectPaneId(paneId)) {
      const projectPath = getProjectPathFromPaneId(paneId);
      if (!projectPath) return null;
      return (
        <ProjectWindowPane
          key={projectPath}
          projectPath={projectPath}
          focusedPanelId={focusedPanelId}
          onFocusPanel={onFocusPanel}
          onClosePanel={onClosePanel}
          getSessionMessages={getSessionMessages}
          isSessionLoading={isSessionLoading}
          isSessionStreaming={isSessionStreaming}
          stopSession={stopSession}
          sendMessage={sendMessage}
          editMessage={editMessage}
          switchBranch={switchBranch}
          loadHistory={loadHistory}
          chatError={chatError}
          sendWS={sendWS}
          onWSMessage={onWSMessage}
          onUpdateTopic={onUpdateTopic}
          pendingPane={pendingProjectPane && pendingProjectPane.projectPath === projectPath ? pendingProjectPane.type : undefined}
          pendingTerminalSessionId={pendingProjectPane && pendingProjectPane.projectPath === projectPath ? pendingProjectPane.terminalSessionId : undefined}
          pendingTerminalType={pendingProjectPane && pendingProjectPane.projectPath === projectPath ? pendingProjectPane.terminalType : undefined}
          onPendingPaneConsumed={onPendingProjectPaneConsumed}
          onNewChat={onNewChatInProject ? (groupId?: string) => onNewChatInProject(projectPath, groupId) : undefined}
          pendingFocusTopicId={pendingProjectFocus && pendingProjectFocus.projectPath === projectPath ? pendingProjectFocus.topicId : null}
          pendingFocusTargetGroupId={pendingProjectFocus && pendingProjectFocus.projectPath === projectPath ? pendingProjectFocus.targetGroupId : undefined}
          onPendingFocusConsumed={onPendingProjectFocusConsumed}
          onActiveTopicChange={onProjectActiveTopicChange ? (topicId) => onProjectActiveTopicChange(projectPath, topicId) : undefined}
          onOpenPanesChange={onProjectOpenPanesChange ? (paneIds) => onProjectOpenPanesChange(projectPath, paneIds) : undefined}
        />
      );
    }
    if (isUtilityPanelId(paneId)) {
      const utilityType = parseUtilityPanelType(paneId);
      return (
        <LazyPane>
          {utilityType === 'activity' && <ActivityFeedPanel enabled />}
          {utilityType === 'journal' && <JournalPanel enabled />}
          {utilityType === 'agents' && (
            <AgentsPane
              onNavigateToTopic={(topicId) => onFocusPanel(topicId)}
              onOpenSessionViewer={handleOpenSessionViewer}
              onMessage={onWSMessage}
            />
          )}
          {utilityType === 'dashboard' && <DashboardPane onMessage={onWSMessage} />}
        </LazyPane>
      );
    }
    // Chat (real or draft).
    const topic = topics[paneId] || draftTopics[paneId];
    if (!topic) return null;
    const isDraft = isDraftPaneId(paneId);
    const isPinned = effectivePinnedIds.has(paneId);
    const wrappedSendMessage = isDraft
      ? async (_sk: string, content: string, options?: { planMode?: boolean }) => {
          if (promoteDraft) {
            await promoteDraft(paneId, content, options);
          }
          return true;
        }
      : !isPinned
        ? async (sk: string, content: string, options?: { planMode?: boolean }) => {
            ordering.ops.pin(paneId);
            return sendMessage(sk, content, options);
          }
        : sendMessage;
    return (
      <ChatPanel
        bodyOnly
        topic={topic}
        isFocused={isPaneActive && focusedPanelId === paneId}
        onFocus={() => onFocusPanel(paneId)}
        onClose={() => onClosePanel(paneId)}
        onDragStart={onDragStart(paneId)}
        onToggleSidebar={onToggleSidebar}
        isDragOver={false}
        showCloseButton={false}
        contextOpen={contextOpen}
        onToggleContext={handleToggleContext}
        getSessionMessages={getSessionMessages}
        isSessionLoading={isSessionLoading}
        isSessionStreaming={isSessionStreaming}
        stopSession={stopSession}
        sendMessage={wrappedSendMessage}
        editMessage={editMessage}
        switchBranch={switchBranch}
        loadHistory={loadHistory}
        chatError={chatError}
        sendWS={sendWS}
        onWSMessage={onWSMessage}
        onUpdateTopic={isDraft ? async () => null : onUpdateTopic}
        initialTab={panelInitialTab?.[paneId]}
        onInitialTabConsumed={onPanelInitialTabConsumed ? () => onPanelInitialTabConsumed(paneId) : undefined}
        onOpenSessionViewer={handleOpenSessionViewer}
        onFocusPanel={onFocusPanel}
      />
    );
  };

  return (
    <>
      <div
        data-split-card
        className={`flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden transition-shadow ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
        onMouseDownCapture={() => {
          if (activePaneId && focusedPanelId !== activePaneId) {
            onFocusPanel(activePaneId);
          }
        }}
        onDragOver={handleStandaloneDragOver}
        onDragLeave={handleStandaloneDragLeave}
        onDrop={handleStandaloneDrop}
      >
        {/* Single shared header — tab bar + (optional) sidebar toggle.
            Previously every pane-type branch rendered its own copy of
            this header; consolidating it lets the body switch underneath
            without re-mounting the tab bar / re-running its hooks. */}
        <div className="chrome-glass flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
          <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
          {onToggleSidebar && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1">
              <SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" />
            </div>
          )}
        </div>

        {/* Keep-alive body area — every visited pane stays mounted; only
            the active one is `display: flex`, the rest are `display: none`
            and removed from layout entirely. Preserves chat scroll,
            history caches, terminal buffers, virtuoso state, and form
            drafts across tab switches.
            `chrome-glass`: under Electron-mac this backdrop goes transparent so
            the native vibrancy reads through; each content pane wrapper below
            re-paints its own opaque `bg-surface`, while `project` and `terminal`
            panes stay transparent to frost (matching GroupLayout so a standalone
            shell rides the vibrancy like one inside a project). Outside Electron,
            `bg-surface` is the backdrop. */}
        <div className="chrome-glass flex-1 flex flex-col min-h-0 min-w-0 bg-surface overflow-hidden relative">
          {visitedPanes.length === 0 ? (
            <div className="flex-1" aria-hidden="true" />
          ) : (
            visitedPanes.map((pane) => {
              const isPaneActive = pane.id === activePaneId;
              return (
                <div
                  // `stableKey` (when set by the pane reducer) survives
                  // PANE_ID_REMAP — same pattern as PaneTabBar's tab DOM
                  // and GroupLayout's keep-alive wrapper.
                  key={stableKeyOf(pane)}
                  className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${pane.type === 'project' || pane.type === 'terminal' ? '' : 'bg-surface'}`}
                  style={{ display: isPaneActive ? 'flex' : 'none' }}
                  aria-hidden={!isPaneActive}
                >
                  {renderPaneBody(pane, isPaneActive)}
                </div>
              );
            })
          )}
        </div>
      </div>
      {settingsTopic && (
        <Suspense fallback={null}>
          <TopicSettingsModal
            topic={settingsTopic}
            isOpen={!!settingsTopicId}
            onClose={() => setSettingsTopicId(null)}
            onUpdate={onUpdateTopic}
          />
        </Suspense>
      )}
    </>
  );
}
