import { useState, useCallback, useMemo, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PanelTab, TerminalSessionInfo } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { ChatPanel } from './ChatPanel';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import { DND_TYPES } from '../../lib/dndTypes';
import { useMultiContextPercent } from '../../hooks/useContextInspector';
import { isUtilityPanelId, parseUtilityPanelType } from './UtilityPanel';
import {
  PANE_CONFIG,
  isProjectPaneId,
  isBrowserPaneId,
  isTerminalPaneId,
  isSessionViewerPaneId,
  getTerminalSessionFromPaneId,
  getProjectPathFromPaneId,
  getSessionKeyFromViewerPaneId,
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

const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));

const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ActivityFeedPanel = lazy(() => import('../Sidebar/ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const JournalPanel = lazy(() => import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const AllBoardsPane = lazy(() => import('../Board/AllBoardsPane').then(m => ({ default: m.AllBoardsPane })));
const SessionViewerPane = lazy(() => import('../Agents/SessionViewerPane').then(m => ({ default: m.SessionViewerPane })));

const LazySpinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

interface StandaloneChatGroupProps {
  topicIds: string[];
  topics: Record<string, Topic>;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
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
  // Create new chat in a project
  onNewChatInProject?: (projectPath: string) => void;
  // Pending focus for project tabs (navigate to a topic inside a project)
  pendingProjectFocus?: { projectPath: string; topicId: string } | null;
  onPendingProjectFocusConsumed?: () => void;
  // Report which topic is active inside the focused project
  onProjectActiveTopicChange?: (projectPath: string, topicId: string | null) => void;
  // Report all open pane IDs inside each project (for sidebar filtering)
  onProjectOpenPanesChange?: (projectPath: string, paneIds: string[]) => void;
  // Terminal sessions for label resolution (from server)
  terminalSessions?: TerminalSessionInfo[];
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
}

export function StandaloneChatGroup({
  topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel, onDragStart,
  getSessionMessages, isSessionLoading, isSessionStreaming,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat, onGroupDragStart: _onGroupDragStart, onAcceptProjectTopicDrop, stopSession,
  pendingProjectPane, onPendingProjectPaneConsumed,
  onNewChatInProject, pendingProjectFocus, onPendingProjectFocusConsumed,
  onProjectActiveTopicChange, onProjectOpenPanesChange,
  terminalSessions = [], onCreateTerminal,
  onUtilityPaneChange,
  pendingBrowserPane, onPendingBrowserPaneConsumed,
  onOpenBrowserContextIds,
  promoteDraft, draftMeta: _draftMeta,
  onSplitPane,
  onCloseMultiplePanels,
  persistOrder = true,
  gridItemKey = 'standalone',
  onUnsolo, onAcceptSoloDrop,
}: StandaloneChatGroupProps) {
  const [claudeSkipPermissions] = useClaudeSkipPermissions();

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
    activeIsBrowser, activeIsTerminal, activeIsSessionViewer,
    activeIsProject, activeIsUtility,
    activeSessionKey, activeProjectPath, activeUtilityType,
    activeTopic, browserContextId,
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

  // Build tab notification badge map from context
  const { getBadgeCount, clearPane } = useTabNotifications();
  const tabNotifications = useMemo(() => {
    const map = new Map<string, number>();
    for (const pane of panes) {
      const count = getBadgeCount(pane.id, pane.topicId, pane.id === activePaneId);
      if (count > 0) map.set(pane.id, count);
    }
    return map;
  }, [panes, getBadgeCount, activePaneId]);

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
    const topicId = sourcePaneId.startsWith('chat:') ? sourcePaneId.slice(5) : sourcePaneId;

    if (onAcceptSoloDrop && sourceGroupId !== 'standalone' && !sourcePaneId.startsWith('chat:')) {
      // Unsolo the dragged topic
      onAcceptSoloDrop(topicId);
      // Also unsolo this group's topic if it's a solo group (merge both into standalone)
      if (onUnsolo && topicIds.length === 1) {
        onUnsolo(topicIds[0]);
      }
      return;
    }

    if (!onAcceptProjectTopicDrop) return;
    if (topicIds.includes(topicId)) return;
    onAcceptProjectTopicDrop(topicId);
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop, onUnsolo, topicIds]);

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

    // Unsolo the dropped topic
    if (onAcceptSoloDrop) {
      onAcceptSoloDrop(topicId);
      // Also unsolo this group if it's solo (merge both into standalone)
      if (onUnsolo && topicIds.length === 1) {
        onUnsolo(topicIds[0]);
      }
      return;
    }
    if (onAcceptProjectTopicDrop) {
      onAcceptProjectTopicDrop(topicId);
    }
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop, onUnsolo, topicIds]);

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

  // Build set of pane IDs that are currently streaming (only real chat panes stream, not drafts)
  const streamingPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of validatedOrderedIds) {
      if (isUtilityPanelId(id) || isBrowserPaneId(id) || isTerminalPaneId(id) || isSessionViewerPaneId(id) || isDraftPaneId(id)) continue;
      const topic = topics[id];
      if (topic && isSessionStreaming(topic.sessionKey)) {
        ids.add(id);
      }
    }
    return ids;
  }, [validatedOrderedIds, topics, isSessionStreaming]);

  const handleToggleContext = useCallback(() => {
    setContextOpen(prev => !prev);
  }, []);

  if (validatedOrderedIds.length === 0) return null;
  // Need at least one valid pane (either a topic, a utility, a project, a browser, or a terminal)
  if (!activeTopic && !activeIsUtility && !activeIsProject && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer) return null;

  // Available pane types for the "+" menu
  const availableTypes: PaneType[] = (() => {
    const types: PaneType[] = ['browser', 'terminal'];
    // Only offer types that aren't already open (singleton check)
    return types.filter(t => {
      if (t === 'browser') return !validatedOrderedIds.some(id => isBrowserPaneId(id));
      return true; // terminal is not singleton — can have multiple
    });
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
      onAddPane={handleAddPane}
      availableTypes={availableTypes}
      groupId={gridItemKey}
      onNewChat={onNewChat}
      onReorderPanes={handleReorderPanes}
      onCrossGroupDrop={(onAcceptProjectTopicDrop || onAcceptSoloDrop) ? handleCrossGroupDrop : undefined}
      contextPercent={contextPercent}
      onContextRingClick={handleToggleContext}
      onSplitRight={onSplitPane && !gridItemKey.startsWith('solo:') && validatedOrderedIds.length >= 2 ? handleSplitRight : undefined}
      onSplitDown={onSplitPane && !gridItemKey.startsWith('solo:') && validatedOrderedIds.length >= 2 ? handleSplitDown : undefined}
      onCloseOthers={handleCloseOthers}
      onSettings={handleSettings}
      onPopOut={handlePopOut}
      onDetach={handleUnsolo || (onSplitPane ? handleDetach : undefined)}
      streamingPaneIds={streamingPaneIds}
      onStopStreaming={handleStopStreaming}
      onPinPane={handlePinPane}
      projectStatus={projectStatus}
      tabNotifications={tabNotifications}
      hasLeftOverlay={!!onToggleSidebar}
    />
  );

  const settingsTopic = settingsTopicId ? topics[settingsTopicId] : null;

  return (
    <>
      <div
        className={`flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden transition-all ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
        onDragOver={handleStandaloneDragOver}
        onDragLeave={handleStandaloneDragLeave}
        onDrop={handleStandaloneDrop}
      >
        {activeIsTerminal ? (
          /* ---- Terminal pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
            <Suspense fallback={LazySpinner}>
              <SingleTerminalPane sessionId={getTerminalSessionFromPaneId(activePaneId!)!} />
            </Suspense>
          </div>
        ) : activeIsSessionViewer && activeSessionKey ? (
          /* ---- Session viewer pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
            <Suspense fallback={LazySpinner}>
              <SessionViewerPane sessionKey={activeSessionKey} onNavigateToTopic={(topicId) => onFocusPanel(topicId)} />
            </Suspense>
          </div>
        ) : activeIsBrowser ? (
          /* ---- Browser pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
            <Suspense fallback={LazySpinner}>
              <RemoteBrowserPanel
                contextId={browserContextId}
                navigateUrl={browserNavigateUrl || undefined}
                onNavigateConsumed={() => setBrowserNavigateUrl(null)}
              />
            </Suspense>
          </div>
        ) : activeIsProject && activeProjectPath ? (
          /* ---- Project pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
            <ProjectWindowPane
              key={activeProjectPath}
              projectPath={activeProjectPath}
              topics={topics}
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
              pendingPane={pendingProjectPane && pendingProjectPane.projectPath === activeProjectPath ? pendingProjectPane.type : undefined}
              pendingTerminalSessionId={pendingProjectPane && pendingProjectPane.projectPath === activeProjectPath ? pendingProjectPane.terminalSessionId : undefined}
              pendingTerminalType={pendingProjectPane && pendingProjectPane.projectPath === activeProjectPath ? pendingProjectPane.terminalType : undefined}
              onPendingPaneConsumed={onPendingProjectPaneConsumed}
              onNewChat={onNewChatInProject ? () => onNewChatInProject(activeProjectPath) : undefined}
              pendingFocusTopicId={pendingProjectFocus && pendingProjectFocus.projectPath === activeProjectPath ? pendingProjectFocus.topicId : null}
              onPendingFocusConsumed={onPendingProjectFocusConsumed}
              onActiveTopicChange={onProjectActiveTopicChange ? (topicId) => onProjectActiveTopicChange(activeProjectPath, topicId) : undefined}
              onOpenPanesChange={onProjectOpenPanesChange ? (paneIds) => onProjectOpenPanesChange(activeProjectPath, paneIds) : undefined}
            />
          </div>
        ) : activeIsUtility ? (
          /* ---- Utility pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            {/* Header with tab bar */}
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
            {/* Utility panel body */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Suspense fallback={LazySpinner}>
                {activeUtilityType === 'activity' && <ActivityFeedPanel enabled />}
                {activeUtilityType === 'journal' && <JournalPanel enabled />}
                {activeUtilityType === 'agents' && <AgentsPane
                  onNavigateToTopic={(topicId) => onFocusPanel(topicId)}
                  onOpenSessionViewer={handleOpenSessionViewer}
                  onMessage={onWSMessage}
                />}
                {activeUtilityType === 'dashboard' && <DashboardPane onMessage={onWSMessage} />}
                {activeUtilityType === 'all-boards' && <AllBoardsPane onMessage={onWSMessage} />}
              </Suspense>
            </div>
          </div>
        ) : activeTopic ? (
          /* ---- Chat topic content ---- */
          <ChatPanel
            topic={activeTopic}
            isFocused={focusedPanelId === activePaneId}
            onFocus={() => onFocusPanel(activePaneId!)}
            onClose={() => onClosePanel(activePaneId!)}
            onDragStart={onDragStart(activePaneId!)}
            onToggleSidebar={onToggleSidebar}
            isDragOver={false}
            headerLeft={tabBar}
            showCloseButton={false}
            contextOpen={contextOpen}
            onToggleContext={handleToggleContext}
            getSessionMessages={getSessionMessages}
            isSessionLoading={isSessionLoading}
            isSessionStreaming={isSessionStreaming}
            sendMessage={
              isDraftPaneId(activePaneId!)
                ? async (_sk: string, content: string, options?: { planMode?: boolean }) => {
                    if (promoteDraft) {
                      await promoteDraft(activePaneId!, content, options);
                    }
                    return true;
                  }
                : !effectivePinnedIds.has(activePaneId!)
                  ? async (sk: string, content: string, options?: { planMode?: boolean }) => {
                      ordering.ops.pin(activePaneId!);
                      return sendMessage(sk, content, options);
                    }
                  : sendMessage
            }
            editMessage={editMessage}
            switchBranch={switchBranch}
            loadHistory={loadHistory}
            chatError={chatError}
            sendWS={sendWS}
            onWSMessage={onWSMessage}
            onUpdateTopic={isDraftPaneId(activePaneId!)
              ? async () => null
              : onUpdateTopic
            }
            initialTab={panelInitialTab?.[activePaneId!]}
            onInitialTabConsumed={onPanelInitialTabConsumed ? () => onPanelInitialTabConsumed(activePaneId!) : undefined}
            onOpenSessionViewer={handleOpenSessionViewer}
          />
        ) : (
          /* ---- Empty state with header ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
            <div className="flex-1" />
          </div>
        )}
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
