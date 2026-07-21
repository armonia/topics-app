import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Paperclip } from 'lucide-react';
import type { Topic, ChatMessage, WSMessage, CompactionMarker } from '../../types';
import { ScrollToBottom, NewMessageBanner } from '../Shared/ScrollToBottom';
import { CompactionDivider } from './CompactionDivider';
import { partitionMarkers } from './partitionMarkers';
import { loadSettings, SETTINGS_CHANGED_EVENT } from '../../lib/settings';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageBubble } from './MessageBubble';
import { clampScrollOffset } from '../../state/pane/adapters';
import {
  SCROLL_TO_MESSAGE_EVENT,
  peekScrollToMessage,
  consumeScrollToMessage,
  markScrollToMessageFired,
} from '../../state/scrollToMessage';

interface MessageListProps {
  isMobile: boolean;
  topic: Topic;
  currentMessages: ChatMessage[];
  /** Compaction dividers for this session (CHAT-COMPACT-01); folded into the
   *  transcript by afterMessageId. */
  compactionMarkers?: CompactionMarker[];
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
  onRegenerate?: (msg: ChatMessage) => void;
  onDeleteMessage?: (msg: ChatMessage) => void;
  onSwitchBranch?: (messageId: string, branchIndex: number) => void;
  onOpenSessionViewer?: (sessionKey: string) => void;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onRetry?: () => void;
  inputAreaHeight?: number;
  /**
   * PANE-03 scroll restore (review I1). When set to a finite positive value
   * at mount, the scroller's scrollTop is restored to it (clamped to content
   * height) AFTER Virtuoso's default bottom-anchor. Used by ChatPane's undo
   * path — leave undefined for normal opens.
   */
  initialScrollOffset?: number;
  /**
   * Fired (throttled) when the user scrolls. Lets the parent persist the
   * current position on the pane so a later close+undo can restore it.
   */
  onScrollOffsetChange?: (scrollTop: number) => void;
}

export function MessageList({
  isMobile,
  topic,
  currentMessages,
  compactionMarkers,
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
  onRegenerate,
  onDeleteMessage,
  onSwitchBranch,
  onOpenSessionViewer,
  onMessage,
  onRetry,
  inputAreaHeight = 0,
  initialScrollOffset,
  onScrollOffsetChange,
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
  const prevLoadingRef = useRef(false);
  // Guard: ignore atBottomStateChange for a brief period after forced scrolls
  // to prevent Virtuoso's layout measurement from falsely setting isScrolledUp=true
  const scrollGuardRef = useRef(false);
  // Read settings into state instead of calling loadSettings() in the render
  // body — MessageList re-renders on every streaming token, so the old inline
  // read ran a synchronous localStorage.getItem + JSON.parse per token on the
  // hottest component. Refresh only when settings actually change.
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    const reload = () => setSettings(loadSettings());
    window.addEventListener(SETTINGS_CHANGED_EVENT, reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reload);
      window.removeEventListener('storage', reload);
    };
  }, []);
  const isCompact = settings.messageDensity === 'compact';

  // Stable Virtuoso `components` map: a fresh object + Footer fn identity every
  // render defeats Virtuoso's bailout, so the footer churned per streaming
  // token. The footer only depends on inputAreaHeight.
  const virtuosoComponents = useMemo(() => ({
    Footer: () => inputAreaHeight > 0 ? <div style={{ height: inputAreaHeight }} /> : null,
  }), [inputAreaHeight]);

  // Memoize filtered messages
  const filteredMessages = useMemo(() =>
    currentMessages.filter(msg => {
      // Keep partial assistant messages (streaming placeholder)
      if (msg.role === 'assistant' && msg.partial) return true;
      const c = msg.content?.trim();
      if (!c) {
        // An assistant turn can legitimately end with no prose — it only ran
        // tools, or it was interrupted (timeout/stale/abort) before the final
        // text. Keep it when it carries tool work so the timeline renders,
        // instead of the message silently vanishing after it streamed.
        const hasWork = msg.role === 'assistant' && (
          (Array.isArray(msg.blocks) && msg.blocks.length > 0) ||
          (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)
        );
        return hasWork;
      }
      if (c === 'NO_REPLY' || c === 'ANNOUNCE_SKIP') return false;
      if (c.startsWith('Agent-to-agent announce step')) return false;
      return true;
    }),
    [currentMessages]
  );

  // Position compaction dividers within the visible transcript (CHAT-COMPACT-01).
  const markerPartition = useMemo(
    () => partitionMarkers(filteredMessages, compactionMarkers),
    [filteredMessages, compactionMarkers],
  );

  // Helper: activate scroll guard for a brief period after forced scrolls
  const activateScrollGuard = useCallback(() => {
    scrollGuardRef.current = true;
    setTimeout(() => { scrollGuardRef.current = false; }, 600);
  }, []);

  // True once THIS instance has watched a loadHistory cycle complete FOR THE
  // CURRENT TOPIC — the only moment the thread is known authoritative. The
  // palette-jump effect gates its "loaded thread lacks the id → drop the
  // target" branch on it: on a slow machine the pane mounts with a transient
  // non-empty STALE message set and loading=false, and consuming there threw
  // the target away before the real history ever arrived (CI-only CMD-16
  // failure). Reset on topic switch below.
  const sawLoadCompleteRef = useRef(false);

  // Reset scroll state on topic switch
  useEffect(() => {
    if (prevTopicIdRef.current !== topic.id) {
      prevTopicIdRef.current = topic.id;
      needsScrollRef.current = true;
      isScrolledUpRef.current = false;
      sawLoadCompleteRef.current = false;
      setIsScrolledUp(false);
      setNewMsgCount(0);
      setShowNewBanner(false);
      prevMsgCountRef.current = 0;
      activateScrollGuard();
    }
  }, [topic.id, activateScrollGuard]);

  // Scroll to bottom after messages load for a new topic.
  // Skipped while a palette jump target is pending (peekScrollToMessage): the
  // jump effect below positions the list instead — this effect's rAF would
  // otherwise run AFTER the jump's scrollToIndex and drag it back to bottom,
  // unmounting the virtualized target row (and its highlight) entirely.
  useEffect(() => {
    if (needsScrollRef.current && filteredMessages.length > 0 && !currentLoading) {
      if (peekScrollToMessage(topic.id)) return;
      needsScrollRef.current = false;
      activateScrollGuard();
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
      requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [filteredMessages.length, currentLoading, activateScrollGuard, topic.id]);

  // Scroll to bottom after loadHistory completes (loading: true → false).
  // On page refresh or tab switch, Virtuoso mounts at the bottom via
  // initialTopMostItemIndex, but loadHistory then replaces the messages array
  // which can shift the scroll position.
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = currentLoading;
    if (wasLoading && !currentLoading) sawLoadCompleteRef.current = true;
    if (wasLoading && !currentLoading && filteredMessages.length > 0) {
      // Pending palette jump wins over the bottom anchor — see the effect above.
      if (peekScrollToMessage(topic.id)) return;
      activateScrollGuard();
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
      requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [currentLoading, filteredMessages.length, activateScrollGuard, topic.id]);

  // ── Palette jump: scroll to a searched message ────────────────────────────
  // A ⌘K message hit registers a pending target (scrollToMessage.ts) before
  // opening the topic. Consume it here once the thread actually contains the
  // id: scroll the row to center and flash a highlight. Declared AFTER the
  // bottom-anchor effects above so, in the same commit, this scrollToIndex
  // runs last and wins over the default "open at bottom".
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const jumpHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tryScrollToTarget = useCallback(() => {
    // NEVER jump (or consume) while this pane is hidden: keep-alive keeps
    // background tabs mounted with display:none, where Virtuoso's viewport is
    // 0-high and renders NO rows — a jump there scrolls into the void and the
    // target is lost before the pane ever becomes visible (the palette event
    // fires exactly in that state when the hit's topic isn't the active tab).
    // The scroller ResizeObserver below re-fires this when the pane shows.
    const scroller = scrollerElRef.current;
    if (!scroller || scroller.clientHeight === 0) return;
    const targetId = peekScrollToMessage(topic.id);
    if (!targetId) return;
    const index = filteredMessages.findIndex((m) => m.id === targetId);
    if (index < 0) {
      // Drop the target ONLY when an AUTHORITATIVE thread lacks the id
      // (inactive branch, deleted message) — i.e. this instance has watched a
      // loadHistory cycle complete AND the result is non-empty. Both weaker
      // states bit us live: a mounted-but-never-loaded keep-alive pane
      // (0 messages, loading=false — the palette event fires against exactly
      // that), and a slow-machine mount window holding a non-empty STALE set
      // before loadHistory even started (CI-only). The TTL covers leaks.
      if (sawLoadCompleteRef.current && !currentLoading && filteredMessages.length > 0) {
        consumeScrollToMessage(topic.id);
      }
      return;
    }
    // markFired, NOT consume: opening from the palette also fires a message
    // reload whose completion runs the bottom-anchor effects AFTER this jump —
    // with the target consumed their peek-guard is gone and the list snaps
    // back to the bottom (observed: scrollTop 0 → bottom within 100ms). The
    // fired entry keeps those guards active for a short grace and lets the
    // post-reload pass re-run this jump; the store purges it afterwards.
    markScrollToMessageFired(topic.id);
    activateScrollGuard();
    // rAF so we land AFTER any bottom-anchor rAF a prior effect queued in this
    // same frame (belt to the peek-guards' suspenders — event-path timing).
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index, align: 'center' });
    });
    setJumpHighlightId(targetId);
    if (jumpHighlightTimer.current) clearTimeout(jumpHighlightTimer.current);
    jumpHighlightTimer.current = setTimeout(() => setJumpHighlightId(null), 2400);
  }, [topic.id, filteredMessages, currentLoading, activateScrollGuard]);
  useEffect(() => {
    if (!currentLoading && filteredMessages.length > 0) tryScrollToTarget();
  }, [currentLoading, filteredMessages.length, tryScrollToTarget]);
  // Topic already open when the palette hit is clicked → no load transition
  // fires, so the request event is the trigger.
  useEffect(() => {
    const onJump = (e: Event) => {
      if ((e as CustomEvent<{ topicId?: string }>).detail?.topicId === topic.id) tryScrollToTarget();
    };
    window.addEventListener(SCROLL_TO_MESSAGE_EVENT, onJump);
    return () => window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, onJump);
  }, [topic.id, tryScrollToTarget]);
  useEffect(() => () => {
    if (jumpHighlightTimer.current) clearTimeout(jumpHighlightTimer.current);
  }, []);
  // Safety-net poll. The discrete triggers above (load transition, request
  // event) each have real race windows around a palette-driven open: the
  // event can fire against a hidden/unloaded pane, the load transition can
  // land while the scroller has no layout yet, and slow machines widen every
  // gap (CI-only failures). The poll closes them all: while a target is
  // PENDING for this topic it re-tries every 150ms until the jump fires or
  // the store purges the target (TTL / post-fire grace). Idle cost is one
  // Map lookup per tick — the peek short-circuits before any DOM read.
  const tryScrollToTargetRef = useRef(tryScrollToTarget);
  tryScrollToTargetRef.current = tryScrollToTarget;
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (!peekScrollToMessage(topic.id)) return;
      tryScrollToTargetRef.current();
    }, 150);
    return () => window.clearInterval(iv);
  }, [topic.id]);

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
      activateScrollGuard();
    }
    prevStreamingRef.current = _currentStreaming;
  }, [_currentStreaming, activateScrollGuard]);

  // Auto-scroll during streaming: the last message content grows in-place
  // (no new items added), so Virtuoso's followOutput doesn't trigger.
  // We set scrollTop = scrollHeight directly on the scroller DOM element,
  // bypassing Virtuoso's item-height measurement which may lag the actual layout.
  // Uses isScrolledUpRef (not state) to avoid re-triggering on scroll changes.
  useEffect(() => {
    if (_currentStreaming && !isScrolledUpRef.current) {
      // Pending palette jump wins over the streaming pin as well — the user
      // explicitly asked to look at an older message; the pin resumes once
      // the jump's short grace expires (scrollToMessage.ts).
      if (peekScrollToMessage(topic.id)) return;
      requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  }, [filteredMessages, _currentStreaming, topic.id]);

  // Auto-scroll to bottom when a NEW message is APPENDED while streaming is
  // NOT active — an inbound system message, or a peer's message in a shared
  // topic — and the user is parked at the bottom. Virtuoso's followOutput
  // ('smooth') is unreliable for this case: the appended item's height is
  // measured a frame late, so 'smooth' lands short and leaves the view scrolled
  // up with an unread banner (chat-scroll.spec:29). Mirror the streaming effect
  // and pin the scroller DOM element directly once the list has grown.
  const prevAppendLenRef = useRef(filteredMessages.length);
  useEffect(() => {
    const grew = filteredMessages.length > prevAppendLenRef.current;
    prevAppendLenRef.current = filteredMessages.length;
    if (grew && !_currentStreaming && !isScrolledUpRef.current) {
      // A pending palette jump vetoes this pin too: the jump's own load
      // replaces 0 → N messages, which counts as "grew" here — and this
      // effect is declared AFTER the jump effect, so its rAF ran last and
      // dragged the fresh jump back to the bottom (the 4th and final
      // bottom-anchor mechanism in the palette-jump bug chain).
      if (peekScrollToMessage(topic.id)) return;
      activateScrollGuard();
      requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [filteredMessages, _currentStreaming, activateScrollGuard, topic.id]);

  // A message the USER just sent must ALWAYS snap the view to the bottom —
  // even if they were reading scrolled-up history — because sending is an
  // explicit intent to follow the reply. Unlike the inbound-append effect
  // above (which respects scroll-up for peer/system messages), this fires
  // ONLY when the newly appended last message is the user's own, and bypasses
  // the isScrolledUpRef gate. Double-rAF so the freshly measured item height
  // lands before we pin (mirrors the streaming pin). The palette-jump veto
  // still wins.
  const prevSendLenRef = useRef(filteredMessages.length);
  useEffect(() => {
    const grew = filteredMessages.length > prevSendLenRef.current;
    prevSendLenRef.current = filteredMessages.length;
    if (!grew) return;
    const last = filteredMessages[filteredMessages.length - 1];
    if (last?.role !== 'user') return;
    if (peekScrollToMessage(topic.id)) return;
    isScrolledUpRef.current = false;
    setIsScrolledUp(false);
    activateScrollGuard();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }, [filteredMessages, activateScrollGuard, topic.id]);

  // Detect new messages while scrolled up
  useEffect(() => {
    if (currentMessages.length > prevMsgCountRef.current && isScrolledUp) {
      const newCount = currentMessages.length - prevMsgCountRef.current;
      setNewMsgCount(prev => prev + newCount);
      setShowNewBanner(true);
    }
    prevMsgCountRef.current = currentMessages.length;
  }, [currentMessages.length, isScrolledUp]);

  // PANE-03 scroll-restore (review I1). Apply the undo-captured offset once
  // per topic mount, AFTER Virtuoso's default bottom-anchor settles. We run
  // the effect keyed on topic.id (the Virtuoso remounts via `key={topic.id}`),
  // wait two frames so the initial layout+bottom-scroll lands, then set the
  // scroll position clamped to scrollHeight. If initialScrollOffset is
  // undefined/0/negative we do nothing — normal opens keep their bottom-
  // anchored behavior.
  const restoredForTopicRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredForTopicRef.current === topic.id) return;
    if (typeof initialScrollOffset !== 'number' || initialScrollOffset <= 0) return;
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (!el) return;
        const target = clampScrollOffset(initialScrollOffset, el.scrollHeight, el.clientHeight);
        // Skip micro-noise — only apply if meaningfully different from the
        // default anchor; also guards against accidentally scrolling away
        // from the bottom if the restored offset rounds to max.
        if (target > 0 && Math.abs(el.scrollTop - target) > 2) {
          el.scrollTop = target;
          // Match the "scrolled up" state so autoscroll heuristics know we
          // are intentionally not at the bottom. A restored undo offset uses a
          // tight 50 px band (independent of the looser 150 px atBottomThreshold
          // used for the live bottom-follow) so a deliberate restore isn't
          // rounded back to the bottom.
          if (el.scrollHeight - target - el.clientHeight > 50) {
            isScrolledUpRef.current = true;
            setIsScrolledUp(true);
          }
        }
        restoredForTopicRef.current = topic.id;
      });
      return () => cancelAnimationFrame(raf2);
    });
    return () => cancelAnimationFrame(raf1);
    // Intentionally not depending on initialScrollOffset — we only want the
    // value as captured at mount (undo time). Subsequent prop churn is ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.id]);

  // Throttled scroll tracker — keeps pane.scrollOffset fresh on the store so
  // a future CLOSE_PANE captures the real position (review I1 PANE-03 wiring).
  const trackThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!onScrollOffsetChange) return;
    const el = scrollerElRef.current;
    if (!el) return;
    const onScroll = () => {
      if (trackThrottleRef.current) return;
      trackThrottleRef.current = setTimeout(() => {
        trackThrottleRef.current = null;
        const cur = scrollerElRef.current;
        if (cur) onScrollOffsetChange(cur.scrollTop);
      }, 250);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (trackThrottleRef.current) {
        clearTimeout(trackThrottleRef.current);
        trackThrottleRef.current = null;
        // Review #3: flush the pending scroll position on cleanup so a
        // quick scroll-then-close (or topic switch) still captures the
        // final offset — otherwise CLOSE_PANE reads a value up to 250 ms
        // stale. Reading `el.scrollTop` from the closure is safe because
        // the element is still live until React completes the unmount.
        onScrollOffsetChange(el.scrollTop);
      }
    };
    // Re-bind when the scroller element changes (topic swap remounts Virtuoso).
  }, [topic.id, onScrollOffsetChange]);

  const scrollToBottom = useCallback(() => {
    activateScrollGuard();
    isScrolledUpRef.current = false;
    setIsScrolledUp(false);
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
    // Pin via DOM on next frame to prevent any drift after Virtuoso settles
    requestAnimationFrame(() => {
      const el = scrollerElRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    setNewMsgCount(0);
    setShowNewBanner(false);
  }, [activateScrollGuard]);

  // data-testid on the outer wrapper ensures the selector is always queryable
  // regardless of loading/empty/Virtuoso state (pane-undo.spec.ts relies on
  // [data-testid='chat-scroll-container']). The Virtuoso internal scroller is
  // targeted via scrollerElRef without a separate testid.
  return (
    <div
      data-testid="chat-scroll-container"
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
          {inputAreaHeight > 0 && <div style={{ height: inputAreaHeight }} />}
        </div>
      ) : (
        <Virtuoso
          data-testid="chat-message-list"
          key={topic.id}
          ref={virtuosoRef}
          scrollerRef={(ref) => {
            scrollerElRef.current = ref as HTMLElement | null;
          }}
          data={filteredMessages}
          initialTopMostItemIndex={filteredMessages.length - 1}
          // Callback form so a pending palette jump can veto the auto-follow:
          // the load that the jump rides in replaces 0 → N messages, and with
          // zero items Virtuoso considers itself trivially "at bottom" — the
          // plain 'smooth' prop then animated to the bottom ~150ms AFTER the
          // jump's scrollToIndex, silently undoing it (the final live bug in
          // the palette-jump chain). Otherwise mirrors the old behavior:
          // follow when at bottom and not streaming.
          followOutput={(isAtBottom: boolean) => {
            if (peekScrollToMessage(topic.id)) return false;
            if (_currentStreaming) return false;
            return isAtBottom ? 'smooth' : false;
          }}
          // 150 (not 50) so the redesign's initial bottom-anchor — which
          // settles ~1 short message (≈60–150px) above the true bottom as
          // Virtuoso lazily remeasures item heights — still counts as
          // "at bottom". At 50px that lag latched isScrolledUpRef=true, which
          // permanently suppressed the append-auto-scroll effect (a new inbound
          // message no longer stuck to the bottom — chat-scroll.spec:29). This
          // matches the 150px "genuinely scrolled up" cutoff in
          // atBottomStateChange below and the app's own at-bottom tolerance.
          atBottomThreshold={150}
          atBottomStateChange={(atBottom) => {
            // During scroll guard, only suppress brief false "not at bottom" reports
            // (the bounce), but allow genuine user scroll-up to be detected
            if (!atBottom && scrollGuardRef.current) {
              const el = scrollerElRef.current;
              if (el) {
                const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                // If user genuinely scrolled far from bottom (>150px), respect it
                if (distFromBottom < 150) return;
              } else {
                return;
              }
            }
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
            const trailingMarkers = msg.id ? markerPartition.byAfter.get(msg.id) : undefined;
            return (
              <>
              {idx === 0 && markerPartition.leading.map((mk) => (
                <CompactionDivider key={mk.id} marker={mk} />
              ))}
              <div
                className={
                  (isMobile ? 'px-2' : 'px-4') +
                  (msg.id === jumpHighlightId ? ' chat-msg-jump-highlight' : '')
                }
                data-jump-highlight={msg.id === jumpHighlightId ? 'true' : undefined}
              >
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
                  onRegenerate={onRegenerate}
                  onDeleteMessage={onDeleteMessage}
                  onSwitchBranch={onSwitchBranch}
                  onOpenSessionViewer={onOpenSessionViewer}
                  onMessage={onMessage}
                  onRetry={isLastAssistant ? onRetry : undefined}
                />
              </div>
              {trailingMarkers && trailingMarkers.map((mk) => (
                <CompactionDivider key={mk.id} marker={mk} />
              ))}
              </>
            );
          }}
          components={virtuosoComponents}
          style={{ height: '100%' }}
        />
      )}

      <div ref={messagesEndRef} />
      <ScrollToBottom show={isScrolledUp} newCount={newMsgCount} onClick={scrollToBottom} bottomOffset={inputAreaHeight} />
    </div>
  );
}
