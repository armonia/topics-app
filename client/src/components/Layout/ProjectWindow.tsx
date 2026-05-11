import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType } from '../../types';
import { ProjectHeader, getProjectName } from './ProjectHeader';
import { ProjectSidebar } from '../Project/ProjectSidebar';
import { GroupLayout } from './GroupLayout';
import { ChatPane } from '../Chat/ChatPane';
import { topicsApi } from '../../lib/api';
import {
  createPaneId,
  getTerminalSessionFromPaneId,
  useClosedTabs,
} from '../../state/pane/adapters';
import { DND_TYPES } from '../../lib/dndTypes';
import { sendFocusTopic, sendBlur } from '../../lib/focusMessaging';
import { useMultiContextPercent } from '../../hooks/useContextInspector';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { useTerminalActivity } from '../../hooks/useTerminalActivity';
import { ToastOutlet } from '../Shared/Toast';
import { useProjectPersistenceLoad } from './hooks/useProjectPersistenceLoad';
import { useProjectLayout } from './hooks/useProjectLayout';
import { useProjectChatSync } from './hooks/useProjectChatSync';
import { useProjectPersistenceSave } from './hooks/useProjectPersistenceSave';

const ContextInspector = lazy(() => import('../Context/ContextInspector').then(m => ({ default: m.ContextInspector })));
const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));
const FileExplorer = lazy(() => import('../Project/FileExplorer').then(m => ({ default: m.FileExplorer })));
const FilePane = lazy(() => import('../Editor/FilePane').then(m => ({ default: m.FilePane })));
const GitChanges = lazy(() => import('../Project/GitChanges').then(m => ({ default: m.GitChanges })));
const ActivityPane = lazy(() => import('../Sidebar/ActivityPane').then(m => ({ default: m.ActivityPane })));
const JournalPane = lazy(() => import('../Journal/JournalPane').then(m => ({ default: m.JournalPane })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const KanbanBoard = lazy(() => import('../Board/KanbanBoard').then(m => ({ default: m.KanbanBoard })));
const BoardMemoryPanel = lazy(() => import('../Board/BoardMemoryPanel').then(m => ({ default: m.BoardMemoryPanel })));
const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ProcessLogPane = lazy(() => import('../Project/ProcessLogPane').then(m => ({ default: m.ProcessLogPane })));

const LazySpinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

// --- ProjectWindowPane: self-contained project content (no header/chrome) ---

export interface ProjectWindowPaneProps {
  projectPath: string;
  topics: Record<string, Topic>;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  stopSession: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  pendingPane?: PaneType;
  pendingTerminalSessionId?: string;
  pendingTerminalType?: 'shell' | 'claude-code';
  onPendingPaneConsumed?: () => void;
  onNewChat?: () => void;
  // Navigate to a specific topic inside the project (from external focus)
  pendingFocusTopicId?: string | null;
  onPendingFocusConsumed?: () => void;
  // Report which topic is currently active in this project window
  onActiveTopicChange?: (topicId: string | null) => void;
  // Report all open pane IDs inside this project (for sidebar filtering)
  onOpenPanesChange?: (paneIds: string[]) => void;
}

export function ProjectWindowPane({
  projectPath, topics, focusedPanelId,
  onFocusPanel, onClosePanel: _onClosePanel,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  pendingPane, pendingTerminalSessionId, pendingTerminalType, onPendingPaneConsumed, onNewChat,
  pendingFocusTopicId, onPendingFocusConsumed,
  onActiveTopicChange, onOpenPanesChange,
}: ProjectWindowPaneProps) {
  // Load persisted state (fast-paint from localStorage; server fetch triggers onUpdate)
  const loaded = useProjectPersistenceLoad({ projectPath });

  // The pane id this ProjectWindow renders under at the parent layout level.
  // Computed once per projectPath; used wherever we need to compare against
  // the wrapper (focus checks, "open me at top level", strip-from-children).
  const wrapperPaneId = useMemo(() => createPaneId('project', projectPath), [projectPath]);

  // Responsive: overlay context inspector when window is narrow
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 1024);
  useEffect(() => { const h = () => setIsNarrow(window.innerWidth < 1024); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  // --- Recently closed tabs ---
  const { pushClosedTab, popClosedTab, removeClosedTab } = useClosedTabs();

  const [showContext, setShowContext] = useState(() => {
    try { return localStorage.getItem('topics-context-inspector-open') === 'true'; } catch { return false; }
  });
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);
  const [claudeSkipPermissions] = useClaudeSkipPermissions();

  // --- Layout (state + handlers + file events) ---
  const layout = useProjectLayout({
    projectPath,
    topics,
    initial: loaded.initial,
    focusedPanelId,
    pendingPane,
    pendingTerminalSessionId,
    pendingTerminalType,
    onPendingPaneConsumed,
    pendingFocusTopicId,
    onPendingFocusConsumed,
    onWSMessage,
    claudeSkipPermissions,
    onFocusPanel: () => onFocusPanel(wrapperPaneId),
    onNewChat,
    pushClosedTab,
    popClosedTab,
    removeClosedTab,
    onOpenPanesChange,
    isSessionStreaming,
    stopSession,
    onOpenPaneSettings: setSettingsTopicId,
    gateRefs: loaded.gateRefs,
  });
  const { panes, groups, rows, rowHeights, focusedGroupId, sidebarCollapsed } = layout.state;
  const { setRows, setRowHeights, setSidebarCollapsed } = layout.setters;
  const pinPaneById = layout.handlers.pinPaneById;
  const handleOpenFile = layout.handlers.openFile;
  const handleOpenProcessLog = layout.handlers.openProcessLog;
  const handleAddPaneToGroup = layout.handlers.addToGroup;
  const handleAddPaneWhenEmpty = layout.handlers.addWhenEmpty;
  const handleActivatePane = layout.handlers.activate;
  const handleClosePane = layout.handlers.close;
  const handleClosePaneImmediate = layout.handlers.closeNow;
  const handleReorderGroupPanes = layout.handlers.reorderGroupPanes;
  const handleMovePaneBetweenGroups = layout.handlers.moveBetweenGroups;
  const handleSplitGroup = layout.handlers.splitGroup;
  const handleReorderRows = layout.handlers.reorderRows;
  const handlePinPane = layout.handlers.pinPane;
  const handlePaneSettings = layout.handlers.paneSettings;
  const handlePanePopOut = layout.handlers.panePopOut;
  const availableTypesForGroup = layout.helpers.availableTypesForGroup;

  // --- Chat sync (chat-pane reconciliation against topic list) ---
  const chatSync = useProjectChatSync({
    projectPath,
    topics,
    initial: loaded.initial,
    panes,
    groups,
    focusedGroupId,
    applyChatReconciliation: layout.applyChatReconciliation,
    reopenChatPane: layout.reopenChatPane,
    gateRefs: loaded.gateRefs,
    markChatSyncDone: loaded.markChatSyncDone,
  });
  const { activeTopicId, activeTopic } = chatSync;

  // Wire server-hydrate (single callback, no bus). chat-sync owns the
  // reconciliation policy; loaded owns the subscribe/userEditedRef gate.
  useEffect(() => {
    loaded.setOnServerHydrate(chatSync.onServerHydrate);
    return () => loaded.setOnServerHydrate(null);
  }, [loaded, chatSync.onServerHydrate]);

  // Report active topic changes to parent (for sidebar highlighting)
  useEffect(() => {
    onActiveTopicChange?.(activeTopicId);
  }, [activeTopicId, onActiveTopicChange]);

  // Mark active topic as read when it changes within the project
  const isProjectFocused = focusedPanelId === wrapperPaneId;
  useEffect(() => {
    if (!isProjectFocused) return;
    if (activeTopicId) {
      topicsApi.markRead(activeTopicId).catch(() => {});
      sendFocusTopic(sendWS, activeTopicId);
    } else {
      // Active pane is non-chat (terminal, browser, etc.) — clear server focus
      sendBlur(sendWS);
    }
  }, [activeTopicId, isProjectFocused, sendWS]);

  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of panes) {
      if (p.type === 'chat' && p.topicId) map[p.id] = p.topicId;
    }
    return map;
  }, [panes]);
  const contextPercent = useMultiContextPercent(paneToTopicMap, onWSMessage);

  // Two sources for the tab "in progress" spinner — chat panes
  // streaming an LLM, terminal panes producing pty output. See
  // StandaloneChatGroup for the full rationale; the project window
  // mirrors the same wiring so terminal tabs inside a project pulse
  // the same way as terminal tabs at top-level.
  const activeTerminalIds = useTerminalActivity();
  const streamingPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of panes) {
      if (p.type === 'chat' && p.topicId) {
        const topic = topics[p.topicId];
        if (topic && isSessionStreaming(topic.sessionKey)) {
          ids.add(p.id);
        }
      } else if (p.type === 'terminal') {
        const sessionId = getTerminalSessionFromPaneId(p.id);
        if (sessionId && activeTerminalIds.has(sessionId)) {
          ids.add(p.id);
        }
      }
    }
    return ids;
  }, [panes, topics, isSessionStreaming, activeTerminalIds]);

  const handleStopStreaming = layout.handlers.stopStreaming;

  useEffect(() => {
    try { localStorage.setItem('topics-context-inspector-open', String(showContext)); } catch {}
  }, [showContext]);

  // Listen for context-ring clicks from any ChatInput inside this project.
  // Only react when the event's topicId matches the currently active topic
  // so chat-pane events meant for a sibling project window are ignored.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { topicId?: string } | undefined;
      if (!detail || !activeTopicId || detail.topicId !== activeTopicId) return;
      setShowContext(prev => !prev);
    };
    window.addEventListener('chat-input:toggle-context', handler);
    return () => window.removeEventListener('chat-input:toggle-context', handler);
  }, [activeTopicId]);

  // Listen for global Cmd+1-9 events that resolve to a pane inside this
  // project. We find which group owns the paneId and activate it. The event
  // is keyed by projectPath so projects in split view ignore each other's
  // hits.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectPath?: string; paneId?: string } | undefined;
      if (!detail || detail.projectPath !== projectPath || !detail.paneId) return;
      // Find which group contains this pane (panes can live in any group).
      const owningGroup = groups.find(g => g.paneIds.includes(detail.paneId!));
      if (!owningGroup) return;
      handleActivatePane(owningGroup.id, detail.paneId);
    };
    window.addEventListener('global-tab:focus-inner', handler);
    return () => window.removeEventListener('global-tab:focus-inner', handler);
  }, [projectPath, groups, handleActivatePane]);

  // Persist tab identity to server (cross-device sync) and layout to
  // localStorage only. Owns the userEditedRef flag-flip via mountedRef.
  useProjectPersistenceSave({
    projectPath,
    panes,
    groups,
    rows,
    rowHeights,
    sidebarCollapsed,
    activeChatTopicId: activeTopicId ?? undefined,
    gateRefs: loaded.gateRefs,
    onOpenPanesChange,
  });

  const handleNewChatInGroup = useCallback((_groupId: string) => {
    onNewChat?.();
  }, [onNewChat]);


  const primaryTopicId = chatSync.topicIds[0];

  const renderPane = useCallback((pane: Pane, isFocused: boolean, isVisible: boolean) => {
    switch (pane.type) {
      case 'chat': {
        const topic = pane.topicId ? topics[pane.topicId] : null;
        if (!topic) return <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">Topic not found</div>;
        const wrappedSendMessage = pane.preview
          ? async (sk: string, content: string, options?: { planMode?: boolean }) => {
              pinPaneById(pane.id);
              return sendMessage(sk, content, options);
            }
          : sendMessage;
        return (
          <ChatPane
            topic={topic}
            isFocused={isFocused && focusedPanelId === wrapperPaneId}
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
            onUpdateTopic={onUpdateTopic}
            onOpenFile={handleOpenFile}
          />
        );
      }
      case 'browser':
        return (
          <Suspense fallback={LazySpinner}>
            {/* `isVisible` drives WebContentsView visibility — see the
                same prop in StandaloneChatGroup.renderPaneBody for the
                full rationale. The keep-alive wrapper in GroupLayout is
                what hides this pane via display:none, but the OS-level
                native browser overlay can't observe that. */}
            <RemoteBrowserPanel contextId={projectPath} isVisible={isVisible} />
          </Suspense>
        );
      case 'terminal': {
        const sessionId = getTerminalSessionFromPaneId(pane.id);
        if (!sessionId) return null;
        return (
          <Suspense fallback={LazySpinner}>
            <SingleTerminalPane sessionId={sessionId} />
          </Suspense>
        );
      }
      case 'file':
        return pane.filePath ? (
          <Suspense fallback={LazySpinner}>
            <FilePane
              filePath={pane.filePath}
              projectPath={projectPath}
              diff={pane.diff}
              diffProjectPath={pane.diffProjectPath}
              onPin={pane.preview ? () => pinPaneById(pane.id) : undefined}
            />
          </Suspense>
        ) : null;
      case 'files':
        return (
          <Suspense fallback={LazySpinner}>
            <FileExplorer projectPath={projectPath} />
          </Suspense>
        );
      case 'git':
        return (
          <Suspense fallback={LazySpinner}>
            <GitChanges projectPath={projectPath} />
          </Suspense>
        );
      case 'activity':
        return (
          <Suspense fallback={LazySpinner}>
            <ActivityPane />
          </Suspense>
        );
      case 'journal':
        return (
          <Suspense fallback={LazySpinner}>
            <JournalPane />
          </Suspense>
        );
      case 'agents':
        return (
          <Suspense fallback={LazySpinner}>
            <AgentsPane onNavigateToTopic={(topicId) => onFocusPanel(topicId)} onMessage={onWSMessage} />
          </Suspense>
        );
      case 'board':
        return (
          <Suspense fallback={LazySpinner}>
            <KanbanBoard projectId={encodeURIComponent(projectPath)} topicId={primaryTopicId} onWSMessage={onWSMessage} />
          </Suspense>
        );
      case 'board-memory':
        return (
          <Suspense fallback={LazySpinner}>
            <BoardMemoryPanel projectId={encodeURIComponent(projectPath)} onWSMessage={onWSMessage} />
          </Suspense>
        );
      case 'dashboard':
        return (
          <Suspense fallback={LazySpinner}>
            <DashboardPane onMessage={onWSMessage} />
          </Suspense>
        );
      case 'process-log':
        return pane.processId ? (
          <Suspense fallback={LazySpinner}>
            <ProcessLogPane processId={pane.processId} scriptName={pane.title} />
          </Suspense>
        ) : null;
      default:
        return null;
    }
  }, [
    topics, focusedPanelId, projectPath,
    getSessionMessages, isSessionLoading, isSessionStreaming,
    sendMessage, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
    handleOpenFile, pinPaneById,
  ]);

  return (
    <>
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
        <ProjectSidebar
          projectPath={projectPath}
          topicId={primaryTopicId}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
          onOpenFile={handleOpenFile}
          onWSMessage={onWSMessage}
          onOpenProcessLog={handleOpenProcessLog}
          onOpenBoard={() => {
            const targetGroupId = focusedGroupId || groups[0]?.id;
            if (targetGroupId) {
              handleAddPaneToGroup(targetGroupId, 'board');
            } else {
              // No groups exist yet -- use handleAddPaneWhenEmpty to create one
              handleAddPaneWhenEmpty('board');
            }
          }}
        />
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <GroupLayout
            panes={panes}
            groups={groups}
            rows={rows}
            rowHeights={rowHeights}
            focusedGroupId={focusedGroupId}
            // App-level focus signal: PaneTabBar uses this to render a
            // dimmed-active state for the focused group's active tab when
            // the project itself sits next to a sibling in App split view
            // and the user is interacting with that sibling.
            isAppFocused={isProjectFocused}
            onActivatePane={handleActivatePane}
            onClosePane={handleClosePane}
            onClosePaneImmediate={handleClosePaneImmediate}
            onAddPaneToGroup={handleAddPaneToGroup}
            onNewChatInGroup={onNewChat ? handleNewChatInGroup : undefined}
            onAddPaneWhenEmpty={handleAddPaneWhenEmpty}
            onReorderGroupPanes={handleReorderGroupPanes}
            onMovePaneBetweenGroups={handleMovePaneBetweenGroups}
            onSplitGroup={handleSplitGroup}
            onReorderRows={handleReorderRows}
            onUpdateRows={setRows}
            onUpdateRowHeights={setRowHeights}
            renderPane={renderPane}
            availableTypesForGroup={availableTypesForGroup}
            contextPercent={contextPercent}
            onContextRingClick={() => setShowContext(prev => !prev)}
            streamingPaneIds={streamingPaneIds}
            onStopStreaming={handleStopStreaming}
            onSettings={handlePaneSettings}
            onPopOut={handlePanePopOut}
            onPinPane={handlePinPane}
          />
        </div>
        {showContext && activeTopic && (
          <div className={`overflow-hidden transition-all duration-200 ${isNarrow ? 'absolute inset-0 z-40' : 'w-[320px] flex-shrink-0 border-l border-app-border'}`}>
            <Suspense fallback={LazySpinner}>
              <ContextInspector
                topic={activeTopic}
                isOpen={showContext}
                onClose={() => setShowContext(false)}
                onUpdateTopic={onUpdateTopic}
                onMessage={onWSMessage}
                onOpenFile={handleOpenFile}
              />
            </Suspense>
          </div>
        )}
      </div>
      {settingsTopicId && topics[settingsTopicId] && (
        <Suspense fallback={null}>
          <TopicSettingsModal
            topic={topics[settingsTopicId]}
            isOpen={!!settingsTopicId}
            onClose={() => setSettingsTopicId(null)}
            onUpdate={onUpdateTopic}
          />
        </Suspense>
      )}
    </>
  );
}

// --- Original ProjectWindow: thin wrapper with header ---

interface ProjectWindowProps {
  projectPath: string;
  topicIds: string[];
  topics: Record<string, Topic>;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  stopSession: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onOpenInFinder?: () => void;
  onGroupDragStart?: (e: React.DragEvent) => void;
  onCloseProject?: () => void;
  pendingPane?: PaneType;
  onPendingPaneConsumed?: () => void;
  onNewChat?: () => void;
  onAcceptTopicDrop?: (topicId: string) => void;
}

export function ProjectWindow({
  projectPath, topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onOpenInFinder, onGroupDragStart, onCloseProject, pendingPane, onPendingPaneConsumed, onNewChat,
  onAcceptTopicDrop,
}: ProjectWindowProps) {
  // Cross-panel-type drop: accept standalone chat drops
  const [panelDragOver, setPanelDragOver] = useState(false);

  const handleProjectDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptTopicDrop) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    if (e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    setPanelDragOver(true);
  }, [onAcceptTopicDrop]);

  const handleProjectDragLeave = useCallback(() => {
    setPanelDragOver(false);
  }, []);

  const handleProjectDrop = useCallback((e: React.DragEvent) => {
    if (!onAcceptTopicDrop) return;
    const topicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);
    if (!topicId) return;
    if (topicIds.includes(topicId)) return;
    e.preventDefault();
    e.stopPropagation();
    setPanelDragOver(false);
    onAcceptTopicDrop(topicId);
  }, [onAcceptTopicDrop, topicIds]);

  return (
    <div
      className={`relative flex flex-col min-h-0 min-w-[200px] overflow-hidden transition-all ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
      style={{ flex: 1 }}
      onDragOver={handleProjectDragOver}
      onDragLeave={handleProjectDragLeave}
      onDrop={handleProjectDrop}
    >
      {/* Project header — draggable for group reordering */}
      <div
        draggable={!!onGroupDragStart}
        onDragStart={onGroupDragStart}
        className={onGroupDragStart ? 'cursor-grab active:cursor-grabbing' : ''}
      >
        <ProjectHeader
          projectPath={projectPath}
          projectName={getProjectName(projectPath)}
          onOpenInFinder={onOpenInFinder}
          onClose={onCloseProject}
        />
      </div>

      {/* Main content: delegates to ProjectWindowPane */}
      <ProjectWindowPane
        projectPath={projectPath}
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
        pendingPane={pendingPane}
        onPendingPaneConsumed={onPendingPaneConsumed}
        onNewChat={onNewChat}
      />
      <ToastOutlet />
    </div>
  );
}
