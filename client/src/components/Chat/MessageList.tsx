import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Paperclip } from 'lucide-react';
import type { Topic, ChatMessage } from '../../types';
import { TopicIcon } from '@/lib/topicIcons';
import { ScrollToBottom, NewMessageBanner } from '../Shared/ScrollToBottom';
import { loadSettings } from '../../lib/settings';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  isMobile: boolean;
  topic: Topic;
  currentMessages: ChatMessage[];
  currentLoading: boolean;
  currentStreaming: boolean;
  copiedMsgId: string | null;
  fileDragOver: boolean;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onReply: (msg: ChatMessage) => void;
  onCopy: (msg: ChatMessage) => void;
  onTogglePin: (msg: ChatMessage) => void;
  onFileDragOver: (e: React.DragEvent) => void;
  onFileDragLeave: (e: React.DragEvent) => void;
  onFileDrop: (e: React.DragEvent) => void;
  setMessage: (v: string) => void;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
  onRemember?: (msg: ChatMessage) => void;
  onEdit?: (msg: ChatMessage) => void;
  onSwitchBranch?: (messageId: string, branchIndex: number) => void;
  onOpenSessionViewer?: (sessionKey: string) => void;
}

export function MessageList({
  isMobile,
  topic,
  currentMessages,
  currentLoading,
  currentStreaming: _currentStreaming,
  copiedMsgId,
  fileDragOver,
  chatContainerRef,
  messagesEndRef,
  textareaRef,
  onReply,
  onCopy,
  onTogglePin,
  onFileDragOver,
  onFileDragLeave,
  onFileDrop,
  setMessage,
  onPlanApprove,
  onPlanReject,
  onRemember,
  onEdit,
  onSwitchBranch,
  onOpenSessionViewer,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const isScrolledUpRef = useRef(false);
  const prevStreamingRef = useRef(false);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const [showNewBanner, setShowNewBanner] = useState(false);
  const prevMsgCountRef = useRef(currentMessages.length);
  const prevTopicIdRef = useRef(topic.id);
  const needsScrollRef = useRef(false);
  const settings = loadSettings();
  const isCompact = settings.messageDensity === 'compact';

  // Memoize filtered messages
  const filteredMessages = useMemo(() =>
    currentMessages.filter(msg => {
      // Keep partial assistant messages (streaming placeholder)
      if (msg.role === 'assistant' && msg.partial) return true;
      const c = msg.content?.trim();
      if (!c) return false;
      if (c === 'NO_REPLY' || c === 'ANNOUNCE_SKIP') return false;
      if (c.startsWith('Agent-to-agent announce step')) return false;
      return true;
    }),
    [currentMessages]
  );

  // Reset scroll state on topic switch
  useEffect(() => {
    if (prevTopicIdRef.current !== topic.id) {
      prevTopicIdRef.current = topic.id;
      needsScrollRef.current = true;
      isScrolledUpRef.current = false;
      setIsScrolledUp(false);
      setNewMsgCount(0);
      setShowNewBanner(false);
      prevMsgCountRef.current = 0;
    }
  }, [topic.id]);

  // Scroll to bottom after messages load for a new topic
  useEffect(() => {
    if (needsScrollRef.current && filteredMessages.length > 0 && !currentLoading) {
      needsScrollRef.current = false;
      const timer = setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [filteredMessages.length, currentLoading]);

  // Force scroll anchor when streaming starts (user just sent a message).
  // When new items are added (user msg + assistant placeholder), Virtuoso may
  // briefly report atBottom=false before followOutput catches up, which would
  // set isScrolledUpRef=true and block our streaming scroll. Reset it here.
  // This effect is declared BEFORE the streaming scroll effect so React runs
  // it first in the same render cycle.
  useEffect(() => {
    if (_currentStreaming && !prevStreamingRef.current) {
      isScrolledUpRef.current = false;
      setIsScrolledUp(false);
    }
    prevStreamingRef.current = _currentStreaming;
  }, [_currentStreaming]);

  // Auto-scroll during streaming: the last message content grows in-place
  // (no new items added), so Virtuoso's followOutput doesn't trigger.
  // We set scrollTop = scrollHeight directly on the scroller DOM element,
  // bypassing Virtuoso's item-height measurement which may lag the actual layout.
  // Uses isScrolledUpRef (not state) to avoid re-triggering on scroll changes.
  useEffect(() => {
    if (_currentStreaming && !isScrolledUpRef.current) {
      requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  }, [filteredMessages, _currentStreaming]);

  // Detect new messages while scrolled up
  useEffect(() => {
    if (currentMessages.length > prevMsgCountRef.current && isScrolledUp) {
      const newCount = currentMessages.length - prevMsgCountRef.current;
      setNewMsgCount(prev => prev + newCount);
      setShowNewBanner(true);
    }
    prevMsgCountRef.current = currentMessages.length;
  }, [currentMessages.length, isScrolledUp]);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    setNewMsgCount(0);
    setShowNewBanner(false);
  }, []);

  return (
    <div
      ref={chatContainerRef}
      role="log"
      aria-live="polite"
      aria-label={`Messages for ${topic.name}`}
      className={`flex-1 overflow-y-auto relative min-h-0 ${fileDragOver ? 'bg-primary/3' : ''}`}
      onDragOver={onFileDragOver}
      onDragLeave={onFileDragLeave}
      onDrop={onFileDrop}
    >
      {fileDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/30 rounded-lg pointer-events-none">
          <div className="text-center">
            <Paperclip size={20} className="mx-auto mb-1 text-primary/50" />
            <p className="text-primary/70 font-medium text-[12px]">Drop files here</p>
          </div>
        </div>
      )}

      <NewMessageBanner show={showNewBanner} onClick={scrollToBottom} />

      {currentLoading && currentMessages.length === 0 ? (
        <div className={`${isMobile ? 'px-2' : 'px-4'} ${isCompact ? 'space-y-1' : 'space-y-2'} overflow-hidden`}>
          {[1,2,3].map(i => (
            <div key={i} className={`flex gap-1.5 ${i % 2 === 0 ? 'justify-end' : 'justify-start'} animate-pulse`}>
              <div className={`rounded-lg px-3 py-2 max-w-[85%] ${
                i % 2 === 0 
                  ? 'bg-primary/20' 
                  : 'bg-app-hover'
              }`}>
                <div className="h-3 rounded w-32 mb-1.5 bg-black/10 dark:bg-white/10" />
                <div className="h-3 rounded w-20 bg-black/5 dark:bg-white/5" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredMessages.length === 0 ? (
        <div className={`text-center ${'py-3 px-3 md:py-8 md:px-4'}`}>
          <div className="float-icon inline-block mb-3">
            <TopicIcon name={topic.icon} size={36} color={topic.color || undefined} />
          </div>
          <p className="text-[14px] font-medium text-app-text-secondary">{topic.name}</p>
          {topic.systemPrompt && (
            <p className="text-[11px] text-purple-400 mt-1 flex items-center justify-center gap-1">
              <span>✨</span> Custom system prompt active
            </p>
          )}
          {!topic.projectPath && (
            <p className="text-[12px] text-app-text-muted mt-2 mb-2">Start a conversation</p>
          )}
          <div className="flex flex-wrap gap-2 justify-center mt-4">
            {(topic.projectPath ? [
                { label: '📋 Describe this project', msg: 'Give me a brief overview of this project — what it does, the tech stack, and the main files.' },
                { label: '🔄 Recent changes', msg: 'Show me the recent git changes in this project and summarize what was modified.' },
                { label: '🐛 Find issues', msg: 'Review this project for potential bugs, code smells, or improvements.' },
              ] : [
                { label: '💡 Brainstorm ideas', msg: 'Help me brainstorm some ideas.' },
                { label: '📝 Write something', msg: 'Help me write ' },
                { label: '🔍 Research a topic', msg: 'Research ' },
              ]).map(q => (
                <button
                  key={q.label}
                  onClick={() => { setMessage(q.msg); textareaRef.current?.focus(); }}
                  className="px-3 py-1.5 text-[12px] rounded-full border border-app-border-light text-app-text-secondary hover:bg-app-hover hover:border-primary hover:text-primary transition-all hover-lift"
                >
                  {q.label}
                </button>
              ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 justify-center text-[11px] text-app-text-faint">
            <span className="flex items-center gap-1.5"><kbd className="kbd">⌘K</kbd> commands</span>
            <span className="flex items-center gap-1.5"><kbd className="kbd">/</kbd> slash commands</span>
            {topic.projectPath && <span className="flex items-center gap-1.5"><kbd className="kbd">@</kbd> mention file</span>}
            <span className="flex items-center gap-1.5"><kbd className="kbd">⌘?</kbd> all shortcuts</span>
          </div>
        </div>
      ) : (
        <Virtuoso
          key={topic.id}
          ref={virtuosoRef}
          scrollerRef={(ref) => { scrollerElRef.current = ref as HTMLElement | null; }}
          data={filteredMessages}
          initialTopMostItemIndex={filteredMessages.length - 1}
          followOutput={_currentStreaming ? false : 'smooth'}
          atBottomThreshold={50}
          atBottomStateChange={(atBottom) => {
            const scrolledUp = !atBottom;
            isScrolledUpRef.current = scrolledUp;
            setIsScrolledUp(scrolledUp);
            if (atBottom) {
              setNewMsgCount(0);
              setShowNewBanner(false);
            }
          }}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          itemContent={(idx, msg) => {
            const prev = idx > 0 ? filteredMessages[idx - 1] : undefined;
            // Only show plan approve/reject on the last assistant message
            const isLastAssistant = msg.role === 'assistant' && idx === filteredMessages.length - 1;
            return (
              <div className={isMobile ? 'px-2' : 'px-4'}>
                <MessageBubble
                  msg={msg}
                  prev={prev}
                  idx={idx}
                  topic={topic}
                  copiedMsgId={copiedMsgId}
                  isCompact={isCompact}
                  fontSize={settings.fontSize}
                  isMobile={isMobile}
                  onReply={onReply}
                  onCopy={onCopy}
                  onTogglePin={onTogglePin}
                  onPlanApprove={isLastAssistant ? onPlanApprove : undefined}
                  onPlanReject={isLastAssistant ? onPlanReject : undefined}
                  onRemember={onRemember}
                  onEdit={onEdit}
                  onSwitchBranch={onSwitchBranch}
                  onOpenSessionViewer={onOpenSessionViewer}
                />
              </div>
            );
          }}
          style={{ height: '100%' }}
        />
      )}

      <div ref={messagesEndRef} />
      <ScrollToBottom show={isScrolledUp} newCount={newMsgCount} onClick={scrollToBottom} />
    </div>
  );
}
