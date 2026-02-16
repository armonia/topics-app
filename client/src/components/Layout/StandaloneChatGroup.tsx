import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PanelTab } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { ChatPanel } from './ChatPanel';

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
}

export function StandaloneChatGroup({
  topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel, onDragStart,
  getSessionMessages, isSessionLoading, isSessionStreaming,
  sendMessage, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat,
}: StandaloneChatGroupProps) {
  // Track order locally for tab reordering
  const [orderedIds, setOrderedIds] = useState<string[]>(topicIds);

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

  const activeTopic = activeTopicId ? topics[activeTopicId] : null;

  if (!activeTopic || orderedIds.length === 0) return null;

  // Tab bar rendered inline in ChatPanel's header (replaces icon/name/drag)
  const tabBar = (
    <PaneTabBar
      className="flex items-stretch gap-0.5 overflow-x-auto min-w-0 h-full"
      panes={panes}
      activePaneId={activeTopicId}
      onActivate={(paneId) => onFocusPanel(paneId)}
      onClose={(paneId) => onClosePanel(paneId)}
      onAddPane={() => {}}
      availableTypes={[]}
      onNewChat={onNewChat}
      onReorderPanes={handleReorderPanes}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden rounded-lg border border-app-border">
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
  );
}
