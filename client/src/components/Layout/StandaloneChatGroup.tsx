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
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { ProjectWindowPane } from './ProjectWindow';
import { getProjectName, hashToColor } from './ProjectHeader';
import { usePaneOrdering } from './hooks/usePaneOrdering';
import { useActivePaneState } from './hooks/useActivePaneState';
import { usePaneLifecycle } from './hooks/usePaneLifecycle';
import { resolveStandaloneCrossGroupDrop } from './standaloneDrop';

const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));

const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ActivityFeedPanel = lazy(() => import('../Sidebar/ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const JournalPanel = lazy(() => import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const AllBoardsPane = lazy(() => import('../Board/AllBoardsPane').then(m => ({ default: m.AllBoardsPane })));
const SessionViewerPane = lazy(() => import('../Agents/SessionViewerPane').then(m => ({ default: m.SessionViewerPane })));


interface StandaloneChatGroupProps {
  topicIds: string[];
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  /** Master pane id (if open). Threaded so non-Master ChatPanels can
   *  render a "← Master" back affordance. */
  masterPaneId?: string | null;
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
  onNewChat?: () => void;
  // Grid item drag (for reordering in PanelGrid)
  onGroupDragStart?: (e: React.DragEvent) => void;
  stopSession: (sessionKey: string) => boolean;
  // Cross-panel-type: accept topic drops from project windows
  onAcceptProjectTopicDrop?: (topicId: string) => void;
  // Pending pane request for project tabs
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType; terminalSessionId?: string; terminalType?: 'shell' | 'claude-code' } | null;
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
  // Create a new terminal (delegates to App)
  onCreateTerminal?: (type: 'shell' | 'claude-code', skipPermissions?: boolean) => void;
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
  // Batch-close multiple panels atomically (for "Close Others" etc.)
  onCloseMultiplePanels?: (panelIds: string[]) => void;
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
  // is this cell's primary topic id. Enables "drop a tab into a populated cell".
  onMergeIntoCell?: (topicId: string, targetPrimary: string) => void;
}

export function StandaloneChatGroup({
  topicIds, focusedPanelId,
  onFocusPanel, masterPaneId, onClosePanel, onClosePanelImmediate, onDragStart,
  getSessionMessages, isSessionLoading, isSessionStreaming,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat, onGroupDragStart: _onGroupDragStart, onAcceptProjectTopicDrop, stopSession,
  pendingProjectPane, onPendingProjectPaneConsumed,
  onNewChatInProject, pendingProjectFocus, onPendingProjectFocusConsumed,
  onProjectActiveTopicChange, onProjectOpenPanesChange,
  onCreateTerminal,
  onUtilityPaneChange,
  pendingBrowserPane, onPendingBrowserPaneConsumed,
  onOpenBrowserContextIds,
  promoteDraft, draftMeta: _draftMeta,
  onSplitPane,
  onCloseMultiplePanels,
  persistOrder = true,
  gridItemKey = 'standalone',
  onUnsolo, onAcceptSoloDrop, onMergeIntoCell,
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
  const lifecycle = usePaneLifecycle({
    ordering, active,
    topics, topicIds, gridItemKey,
    onClosePanel, onFocusPanel, onCloseMultiplePanels,
    onSplitPane, onUnsolo,
    onCreateTerminal, claudeSkipPermissions,
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
  const handleCrossGroupDrop = useCallback((sourcePaneId: string, sourceGroupId: string, _insertIdx: number) => {
    // All the routing/anti-collapse logic lives in the pure, unit-tested
    // resolver (standaloneDrop.ts). The handler just dispatches its decision.
    const decision = resolveStandaloneCrossGroupDrop({
      sourcePaneId,
      sourceGroupId,
      targetGroupId: gridItemKey,
      targetTopicIds: topicIds,
      canAcceptSolo: !!onAcceptSoloDrop,
      canMergeIntoCell: !!onMergeIntoCell,
      canAcceptProjectTopic: !!onAcceptProjectTopicDrop,
    });
    switch (decision.kind) {
      case 'noop':
        return;
      case 'merge-into-cell':
        // The dragged tab joins THIS split cell as its next tab — no collapse.
        onMergeIntoCell?.(decision.draggedTopicId, decision.targetPrimary);
        return;
      case 'unsolo-dragged':
        // Dropped on the main pool → un-split the dragged tab back into it.
        onAcceptSoloDrop?.(decision.draggedTopicId);
        return;
      case 'accept-project-topic':
        onAcceptProjectTopicDrop?.(decision.topicId);
        return;
    }
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop, onMergeIntoCell, topicIds, gridItemKey]);

  // Handle drops from project tabs or solo groups (cross-panel-type)
  const handleStandaloneDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptProjectTopicDrop && !onAcceptSoloDrop) return;
    // Accept PANEL_ID drops that also have PANE_TAB (from project tab bars or solo groups)
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Don't accept grid item drags
    if (e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    setPanelDragOver(true);
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop]);

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
      return;
    }
    if (onAcceptProjectTopicDrop) {
      onAcceptProjectTopicDrop(topicId);
    }
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop, onMergeIntoCell, topicIds, gridItemKey]);

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

  // Tab bar rendered inline in header
  const tabBar = (
    <PaneTabBar
      className="flex-1 py-1 pr-0 min-w-0 app-drag-region"
      panes={panes}
      activePaneId={activePaneId}
      groupIsFocused={validatedOrderedIds.includes(focusedPanelId || '')}
      onActivate={(paneId) => {
        clearPane(paneId); // clear non-chat badge on tab activation
        if (isBrowserPaneId(paneId)) {
          onFocusPanel(paneId);
        } else {
          onFocusPanel(paneId);
        }
      }}
      onClose={handleClosePane}
      onCloseImmediate={onClosePanelImmediate}
      onAddPane={handleAddPane}
      availableTypes={availableTypes}
      groupId={gridItemKey}
      // Every top-level group (the main standalone group and any solo split
      // cells) shares the standalone scope, so tabs reorder/merge freely among
      // them but a project's tabs can't be dropped here (and vice-versa).
      dndScope={STANDALONE_SCOPE}
      onNewChat={onNewChat}
      onReorderPanes={handleReorderPanes}
      onCrossGroupDrop={(onAcceptProjectTopicDrop || onAcceptSoloDrop) ? handleCrossGroupDrop : undefined}
      contextPercent={contextPercent}
      onContextRingClick={handleToggleContext}
      // Single-tab splits are allowed: usePaneLifecycle's `isSplittable`
      // gates the actual call. Hiding the menu items only when this group
      // is already a solo cell (where there's nothing left to split out)
      // and when we lack a split callback at all.
      onSplitRight={onSplitPane && !gridItemKey.startsWith('solo:') ? handleSplitRight : undefined}
      onSplitDown={onSplitPane && !gridItemKey.startsWith('solo:') ? handleSplitDown : undefined}
      onCloseOthers={handleCloseOthers}
      onSettings={handleSettings}
      onPopOut={handlePopOut}
      onDetach={handleUnsolo || (onSplitPane ? handleDetach : undefined)}
      onStopStreaming={handleStopStreaming}
      onPinPane={handlePinPane}
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
            navigateUrl={isPaneActive && browserNavigateUrl ? browserNavigateUrl : undefined}
            onNavigateConsumed={isPaneActive ? () => setBrowserNavigateUrl(null) : undefined}
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
          masterPaneId={masterPaneId}
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
          {utilityType === 'all-boards' && <AllBoardsPane onMessage={onWSMessage} onJumpToTopic={(topicId) => onFocusPanel(topicId)} />}
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
        masterPaneId={masterPaneId}
      />
    );
  };

  return (
    <>
      <div
        className={`flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden transition-all ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
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
