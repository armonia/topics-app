import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PanelTab } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { ChatPanel } from './ChatPanel';
import { DND_TYPES } from '../../lib/dndTypes';
import { useMultiContextPercent } from '../../hooks/useContextInspector';
import { isUtilityPanelId, parseUtilityPanelType } from './UtilityPanel';
import { PANE_CONFIG, isProjectPaneId, getProjectPathFromPaneId } from '../../lib/paneConfig';
import { findPreviewInList, replaceInList } from '../../lib/previewTabs';
import { ProjectWindowPane } from './ProjectWindow';
import { getProjectName, hashToColor } from './ProjectHeader';

const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ActivityFeedPanel = lazy(() => import('../Sidebar/ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const JournalPanel = lazy(() => import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const AllBoardsPane = lazy(() => import('../Board/AllBoardsPane').then(m => ({ default: m.AllBoardsPane })));

const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;
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
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType } | null;
  onPendingProjectPaneConsumed?: () => void;
  // Create new chat in a project
  onNewChatInProject?: (projectPath: string) => void;
  // Pending focus for project tabs (navigate to a topic inside a project)
  pendingProjectFocus?: { projectPath: string; topicId: string } | null;
  onPendingProjectFocusConsumed?: () => void;
}

export function StandaloneChatGroup({
  topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel, onDragStart,
  getSessionMessages, isSessionLoading, isSessionStreaming,
  sendMessage, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat, onGroupDragStart: _onGroupDragStart, onAcceptProjectTopicDrop, stopSession,
  pendingProjectPane, onPendingProjectPaneConsumed,
  onNewChatInProject, pendingProjectFocus, onPendingProjectFocusConsumed,
}: StandaloneChatGroupProps) {
  // Track order locally for tab reordering
  const [orderedIds, setOrderedIds] = useState<string[]>(topicIds);
  const [panelDragOver, setPanelDragOver] = useState(false);
  // Track which panes have been pinned (not preview)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const pinnedIdsRef = useRef(pinnedIds);
  pinnedIdsRef.current = pinnedIds;
  // Pending preview close (deferred to avoid loop with parent)
  const pendingCloseRef = useRef<string | null>(null);
  // Context inspector state (lifted from ChatPanel so ring click can toggle it)
  const [contextOpen, setContextOpen] = useState(false);
  // Settings modal state (opened via right-click menu on tabs)
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  // Sync when topicIds change externally (add/remove)
  // Handles preview replacement: new tab replaces the existing preview tab
  const prevTopicCountRef = useRef(topicIds.length);
  useEffect(() => {
    const wasAdded = topicIds.length > prevTopicCountRef.current;
    prevTopicCountRef.current = topicIds.length;

    setOrderedIds(prev => {
      const existing = prev.filter(id => topicIds.includes(id));
      const added = topicIds.filter(id => !prev.includes(id));

      // Preview replacement: if a single new tab was added, replace existing preview
      if (wasAdded && added.length === 1) {
        const previewId = findPreviewInList(existing, pinnedIdsRef.current, added[0]);
        if (previewId) {
          pendingCloseRef.current = previewId;
          return replaceInList(existing, previewId, added[0]);
        }
      }

      return [...existing, ...added];
    });
    // Cleanup pinnedIds for removed topics
    setPinnedIds(prev => {
      const next = new Set([...prev].filter(id => topicIds.includes(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [topicIds]);

  // Close the replaced preview tab (deferred to next frame to avoid update loop)
  useEffect(() => {
    if (pendingCloseRef.current) {
      const id = pendingCloseRef.current;
      pendingCloseRef.current = null;
      onClosePanel(id);
    }
  });

  // Active pane: prefer focusedPanelId if in our list, else first
  const activePaneId = orderedIds.includes(focusedPanelId || '')
    ? focusedPanelId!
    : orderedIds[0] || null;

  // Determine if the active pane is a utility panel, project pane, or a chat topic
  const activeIsProject = activePaneId ? isProjectPaneId(activePaneId) : false;
  const activeProjectPath = activePaneId && activeIsProject ? getProjectPathFromPaneId(activePaneId) : null;
  const activeIsUtility = activePaneId && !activeIsProject ? isUtilityPanelId(activePaneId) : false;
  const activeUtilityType = activePaneId && activeIsUtility ? parseUtilityPanelType(activePaneId) : null;
  const activeTopic = activePaneId && !activeIsUtility && !activeIsProject ? topics[activePaneId] : null;

  // Build Pane[] for PaneTabBar (mix of chat topics, utility panes, and project panes)
  const panes: Pane[] = useMemo(() =>
    orderedIds.map(id => {
      const isPreview = !pinnedIds.has(id);
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
      return {
        id,
        type: 'chat' as PaneType,
        topicId: id,
        title: topics[id]?.name || 'Chat',
        preview: isPreview,
      };
    }), [orderedIds, topics, pinnedIds]);

  const handleReorderPanes = useCallback((newPaneIds: string[]) => {
    setOrderedIds(newPaneIds);
  }, []);

  // Pin a preview pane (make it permanent)
  const handlePinPane = useCallback((paneId: string) => {
    setPinnedIds(prev => new Set([...prev, paneId]));
  }, []);

  // Cross-group drop: accept a tab dragged from a project tab bar
  const handleCrossGroupDrop = useCallback((sourcePaneId: string, _sourceGroupId: string, _insertIdx: number) => {
    if (!onAcceptProjectTopicDrop) return;
    // sourcePaneId from project is "chat:<topicId>" — extract topicId
    const topicId = sourcePaneId.startsWith('chat:') ? sourcePaneId.slice(5) : sourcePaneId;
    if (topicIds.includes(topicId)) return; // already here
    onAcceptProjectTopicDrop(topicId);
  }, [onAcceptProjectTopicDrop, topicIds]);

  // Handle drops from project tabs (cross-panel-type)
  const handleStandaloneDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptProjectTopicDrop) return;
    // Accept PANEL_ID drops that also have PANE_TAB (from project tab bars)
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Don't accept grid item drags
    if (e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    setPanelDragOver(true);
  }, [onAcceptProjectTopicDrop]);

  const handleStandaloneDragLeave = useCallback(() => {
    setPanelDragOver(false);
  }, []);

  const handleStandaloneDrop = useCallback((e: React.DragEvent) => {
    if (!onAcceptProjectTopicDrop) return;
    const topicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);
    if (!topicId) return;
    // Don't accept topics already standalone
    if (topicIds.includes(topicId)) return;
    e.preventDefault();
    e.stopPropagation();
    setPanelDragOver(false);
    onAcceptProjectTopicDrop(topicId);
  }, [onAcceptProjectTopicDrop, topicIds]);

  // Build paneId → topicId map for context percent (only for chat panes)
  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id of orderedIds) {
      if (!isUtilityPanelId(id) && !isProjectPaneId(id)) map[id] = id;
    }
    return map;
  }, [orderedIds]);
  const contextPercent = useMultiContextPercent(paneToTopicMap);

  // Build set of pane IDs that are currently streaming (only chat panes stream)
  const streamingPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of orderedIds) {
      if (isUtilityPanelId(id)) continue;
      const topic = topics[id];
      if (topic && isSessionStreaming(topic.sessionKey)) {
        ids.add(id);
      }
    }
    return ids;
  }, [orderedIds, topics, isSessionStreaming]);

  // Stop streaming for a pane (paneId = topicId in standalone)
  const handleStopStreaming = useCallback((paneId: string) => {
    const topic = topics[paneId];
    if (topic) {
      const isFirst = stopSession(topic.sessionKey);
      if (isFirst) onClosePanel(paneId);
    }
  }, [topics, stopSession, onClosePanel]);

  const handleToggleContext = useCallback(() => {
    setContextOpen(prev => !prev);
  }, []);

  // Right-click menu: Settings opens TopicSettingsModal
  const handleSettings = useCallback((paneId: string) => {
    setSettingsTopicId(paneId);
  }, []);

  // Right-click menu: Pop Out opens in new window
  const handlePopOut = useCallback((paneId: string) => {
    const url = `${window.location.origin}?topic=${paneId}`;
    isNativeApp
      ? window.open(url, `topic-${paneId}`, 'width=900,height=700')
      : window.open(url, `topic-${paneId}`);
    onClosePanel(paneId);
  }, [onClosePanel]);

  if (orderedIds.length === 0) return null;
  // Need at least one valid pane (either a topic, a utility, or a project)
  if (!activeTopic && !activeIsUtility && !activeIsProject) return null;

  // Tab bar rendered inline in header
  const tabBar = (
    <PaneTabBar
      className="flex-1 flex items-center bg-elevated/60 p-1 gap-0.5 min-w-0"
      panes={panes}
      activePaneId={activePaneId}
      onActivate={(paneId) => onFocusPanel(paneId)}
      onClose={(paneId) => onClosePanel(paneId)}
      onAddPane={() => {}}
      availableTypes={[]}
      groupId="standalone"
      onNewChat={onNewChat}
      onReorderPanes={handleReorderPanes}
      onCrossGroupDrop={onAcceptProjectTopicDrop ? handleCrossGroupDrop : undefined}
      contextPercent={contextPercent}
      onContextRingClick={handleToggleContext}
      onSettings={handleSettings}
      onPopOut={handlePopOut}
      streamingPaneIds={streamingPaneIds}
      onStopStreaming={handleStopStreaming}
      onPinPane={handlePinPane}
    />
  );

  const settingsTopic = settingsTopicId ? topics[settingsTopicId] : null;

  return (
    <>
      <div
        className={`flex flex-col flex-1 min-h-0 transition-all ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
        onDragOver={handleStandaloneDragOver}
        onDragLeave={handleStandaloneDragLeave}
        onDrop={handleStandaloneDrop}
      >
        {activeIsProject && activeProjectPath ? (
          /* ---- Project pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 bg-surface overflow-hidden">
            <div className="flex items-center gap-1.5 pr-2 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region">
              {onToggleSidebar && <button onClick={(e) => { e.stopPropagation(); onToggleSidebar(); }} className="w-8 h-8 flex items-center justify-center rounded hover:bg-app-hover text-app-text-secondary transition-colors app-no-drag flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg></button>}
              <div className="flex-1 flex items-center min-w-0 overflow-visible app-no-drag">{tabBar}</div>
            </div>
            <ProjectWindowPane
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
              loadHistory={loadHistory}
              chatError={chatError}
              sendWS={sendWS}
              onWSMessage={onWSMessage}
              onUpdateTopic={onUpdateTopic}
              pendingPane={pendingProjectPane && pendingProjectPane.projectPath === activeProjectPath ? pendingProjectPane.type : undefined}
              onPendingPaneConsumed={onPendingProjectPaneConsumed}
              onNewChat={onNewChatInProject ? () => onNewChatInProject(activeProjectPath) : undefined}
              pendingFocusTopicId={pendingProjectFocus && pendingProjectFocus.projectPath === activeProjectPath ? pendingProjectFocus.topicId : null}
              onPendingFocusConsumed={onPendingProjectFocusConsumed}
            />
          </div>
        ) : activeIsUtility ? (
          /* ---- Utility pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 bg-surface overflow-hidden">
            {/* Header with tab bar */}
            <div className="flex items-center gap-1.5 pr-2 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region">
              {onToggleSidebar && <button onClick={(e) => { e.stopPropagation(); onToggleSidebar(); }} className="w-8 h-8 flex items-center justify-center rounded hover:bg-app-hover text-app-text-secondary transition-colors app-no-drag flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg></button>}
              <div className="flex-1 flex items-center min-w-0 overflow-visible app-no-drag">{tabBar}</div>
            </div>
            {/* Utility panel body */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Suspense fallback={LazySpinner}>
                {activeUtilityType === 'activity' && <ActivityFeedPanel enabled />}
                {activeUtilityType === 'journal' && <JournalPanel enabled />}
                {activeUtilityType === 'agents' && <AgentsPane onNavigateToTopic={(topicId) => onFocusPanel(topicId)} onMessage={onWSMessage} />}
                {activeUtilityType === 'dashboard' && <DashboardPane />}
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
            sendMessage={!pinnedIds.has(activePaneId!)
              ? async (sk: string, content: string, options?: { planMode?: boolean }) => {
                  setPinnedIds(prev => new Set([...prev, activePaneId!]));
                  return sendMessage(sk, content, options);
                }
              : sendMessage
            }
            loadHistory={loadHistory}
            chatError={chatError}
            sendWS={sendWS}
            onWSMessage={onWSMessage}
            onUpdateTopic={onUpdateTopic}
            initialTab={panelInitialTab?.[activePaneId!]}
            onInitialTabConsumed={onPanelInitialTabConsumed ? () => onPanelInitialTabConsumed(activePaneId!) : undefined}
          />
        ) : null}
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
