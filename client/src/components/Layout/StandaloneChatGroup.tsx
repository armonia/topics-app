import { useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PanelTab } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { ChatPanel } from './ChatPanel';
import { DND_TYPES } from '../../lib/dndTypes';
import { useMultiContextPercent } from '../../hooks/useContextInspector';

const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

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
  stopSession: (sessionKey: string) => void;
  // Cross-panel-type: accept topic drops from project windows
  onAcceptProjectTopicDrop?: (topicId: string) => void;
}

export function StandaloneChatGroup({
  topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel, onDragStart,
  getSessionMessages, isSessionLoading, isSessionStreaming,
  sendMessage, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat, onGroupDragStart: _onGroupDragStart, onAcceptProjectTopicDrop, stopSession,
}: StandaloneChatGroupProps) {
  // Track order locally for tab reordering
  const [orderedIds, setOrderedIds] = useState<string[]>(topicIds);
  const [panelDragOver, setPanelDragOver] = useState(false);
  // Context inspector state (lifted from ChatPanel so ring click can toggle it)
  const [contextOpen, setContextOpen] = useState(false);
  // Settings modal state (opened via right-click menu on tabs)
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  // Sync when topicIds change externally (add/remove)
  useEffect(() => {
    setOrderedIds(prev => {
      const existing = prev.filter(id => topicIds.includes(id));
      const newIds = topicIds.filter(id => !prev.includes(id));
      return [...existing, ...newIds];
    });
  }, [topicIds]);

  // Active topic: prefer focusedPanelId if in our list, else first
  const activeTopicId = orderedIds.includes(focusedPanelId || '')
    ? focusedPanelId!
    : orderedIds[0] || null;

  // Build Pane[] for PaneTabBar
  const panes: Pane[] = useMemo(() =>
    orderedIds.map(id => ({
      id,
      type: 'chat' as PaneType,
      topicId: id,
      title: topics[id]?.name || 'Chat',
    })), [orderedIds, topics]);

  const handleReorderPanes = useCallback((newPaneIds: string[]) => {
    setOrderedIds(newPaneIds);
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

  const activeTopic = activeTopicId ? topics[activeTopicId] : null;

  // Build paneId → topicId map for context percent (paneId = topicId for standalone)
  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id of orderedIds) map[id] = id;
    return map;
  }, [orderedIds]);
  const contextPercent = useMultiContextPercent(paneToTopicMap);

  // Build set of pane IDs that are currently streaming
  const streamingPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of orderedIds) {
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

  if (!activeTopic || orderedIds.length === 0) return null;

  // Tab bar rendered inline in ChatPanel's header (replaces icon/name/drag)
  const tabBar = (
    <PaneTabBar
      className="flex items-center p-1 gap-0.5 min-w-0 overflow-x-auto"
      panes={panes}
      activePaneId={activeTopicId}
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
        <ChatPanel
          topic={activeTopic}
          isFocused={focusedPanelId === activeTopicId}
          onFocus={() => onFocusPanel(activeTopicId!)}
          onClose={() => onClosePanel(activeTopicId!)}
          onDragStart={onDragStart(activeTopicId!)}
          onToggleSidebar={onToggleSidebar}
          isDragOver={false}
          headerLeft={tabBar}
          showCloseButton={false}
          contextOpen={contextOpen}
          onToggleContext={handleToggleContext}
          getSessionMessages={getSessionMessages}
          isSessionLoading={isSessionLoading}
          isSessionStreaming={isSessionStreaming}
          sendMessage={sendMessage}
          loadHistory={loadHistory}
          chatError={chatError}
          sendWS={sendWS}
          onWSMessage={onWSMessage}
          onUpdateTopic={onUpdateTopic}
          initialTab={panelInitialTab?.[activeTopicId!]}
          onInitialTabConsumed={onPanelInitialTabConsumed ? () => onPanelInitialTabConsumed(activeTopicId!) : undefined}
        />
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
