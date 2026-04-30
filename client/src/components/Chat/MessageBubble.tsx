import { memo, useState, useCallback, useRef } from 'react';
import { Copy, Check, Pin, Brain, Pencil, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Topic, ChatMessage } from '../../types';
import { MessageContent } from '../MessageContent';

// Detect touch-only devices (no fine pointer / no hover capability)
const isTouchDevice = typeof window !== 'undefined' && (
  'ontouchstart' in window || window.matchMedia('(hover: none)').matches
);

// Detect emoji-only messages (1-5 emojis/symbols with no other text)
const EMOJI_REGEX = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u2713\u2714\u2715\u2716\u2718\u2022\s]{1,10}$/u;
export const isEmojiOnly = (content: string): boolean => {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 20) return false;
  return EMOJI_REGEX.test(trimmed) && !/[a-zA-Z0-9]/.test(trimmed);
};

export const formatTimestamp = (ts: string): string => {
  try {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

export const getDateSeparator = (ts: string, prevTs?: string): string | null => {
  try {
    const date = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (prevTs) {
      const prevDate = new Date(prevTs);
      const prevMsgDate = new Date(prevDate.getFullYear(), prevDate.getMonth(), prevDate.getDate());
      if (msgDate.getTime() === prevMsgDate.getTime()) return null;
    }

    if (msgDate.getTime() === today.getTime()) return 'Today';
    if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  } catch {
    return null;
  }
};

interface MessageBubbleProps {
  msg: ChatMessage;
  prev?: ChatMessage;
  idx: number;
  topic: Topic;
  copiedMsgId: string | null;
  isCompact: boolean;
  fontSize: number;
  isMobile: boolean;
  onReply: (msg: ChatMessage) => void;
  onCopy: (msg: ChatMessage) => void;
  onTogglePin: (msg: ChatMessage) => void;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
  onRemember?: (msg: ChatMessage) => void;
  onEdit?: (msg: ChatMessage) => void;
  onSwitchBranch?: (messageId: string, branchIndex: number) => void;
  onOpenSessionViewer?: (sessionKey: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
  onRetry?: () => void;
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  prev,
  idx,
  topic,
  copiedMsgId,
  isCompact,
  fontSize,
  isMobile,
  onReply,
  onCopy,
  onTogglePin,
  onPlanApprove,
  onPlanReject,
  onRemember,
  onEdit,
  onSwitchBranch,
  onOpenSessionViewer,
  onMessage,
  onRetry,
}: MessageBubbleProps) {
  const grouped = idx > 0 && prev && prev.role === msg.role && msg.timestamp && prev.timestamp && (new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() < 120000);
  const dateSep = getDateSeparator(msg.timestamp, prev?.timestamp);
  const emojiMsg = isEmojiOnly(msg.content);

  // Long-press state for touch devices
  const [showActions, setShowActions] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = useCallback(() => {
    if (!isTouchDevice) return;
    longPressTimer.current = setTimeout(() => {
      setShowActions(true);
    }, 500);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Visibility class: on touch devices show at reduced opacity always (or full on long-press),
  // on pointer devices show on group hover
  const actionsVisibility = isTouchDevice
    ? (showActions ? 'opacity-100' : 'opacity-40')
    : 'opacity-0 group-hover:opacity-100';

  const actionBtnClass = "w-7 h-7 flex items-center justify-center text-app-text-muted hover:text-primary rounded";

  return (
    <div
      className={emojiMsg ? 'mb-1' : isCompact ? 'mb-1' : 'mb-1.5'}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      {/* Date separator */}
      {dateSep && (
        <div className="flex items-center gap-3 my-3">
          <div className="flex-1 h-px bg-app-border" />
          <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wider">{dateSep}</span>
          <div className="flex-1 h-px bg-app-border" />
        </div>
      )}

      <div
        className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} ${!grouped ? 'message-appear' : ''} ${grouped && isCompact ? 'mt-0.5' : ''}`}
      >
        <div
          className={`relative flex flex-col min-w-0 overflow-hidden`}
          style={{ maxWidth: isMobile ? 'calc(100vw - 5rem)' : '85%' }}
        >
          {/* Floating action toolbar */}
          {!grouped && (
            <div className={`absolute bottom-full mb-1 ${msg.role === 'user' ? 'right-1' : 'left-1'} flex items-center gap-0.5 z-10 transition-opacity ${actionsVisibility} bg-elevated dark:bg-app-surface rounded-lg shadow-sm border border-app-border-light px-1 py-0.5`}>
              {msg.role === 'user' && onEdit && (
                <button onClick={() => onEdit(msg)} className={actionBtnClass} title="Edit" aria-label="Edit message">
                  <Pencil size={14} />
                </button>
              )}
              <button onClick={() => onReply(msg)} className={actionBtnClass} title="Reply" aria-label="Reply">↩</button>
              <button onClick={() => onCopy(msg)} className={actionBtnClass} title="Copy" aria-label="Copy message">
                {copiedMsgId === msg.id ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
              <button onClick={() => onTogglePin(msg)} className={`w-7 h-7 flex items-center justify-center rounded ${(topic.pinnedMessages || []).includes(msg.id) ? 'text-yellow-500' : 'text-app-text-muted hover:text-yellow-500'}`} title="Pin" aria-label="Pin message">
                <Pin size={14} />
              </button>
              {msg.role === 'assistant' && onRemember && (
                <button onClick={() => onRemember(msg)} className="w-7 h-7 flex items-center justify-center text-app-text-muted hover:text-purple-500 rounded" title="Remember this" aria-label="Save to memory">
                  <Brain size={14} />
                </button>
              )}
            </div>
          )}
          {isEmojiOnly(msg.content) ? (
            <div className="text-[32px] leading-none py-0.5">
              {msg.content.trim()}
            </div>
          ) : (
          <div
            className={`px-3 py-2 text-[13px] leading-relaxed overflow-hidden ${
              msg.role === 'user'
                ? 'user-bubble bg-primary text-white shadow-sm'
                : msg.role === 'assistant' && msg.content.startsWith('⚠️')
                  ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-700'
                  : 'bg-app-hover text-app-text dark:bg-elevated'
            } ${grouped ? (msg.role === 'user' ? 'rounded-2xl rounded-tr-md' : 'rounded-2xl rounded-tl-md') : 'rounded-2xl'}`}
            style={{ fontSize: `${fontSize}px`, overflowWrap: 'break-word', wordBreak: 'break-word' }}
          >
            <div className="message-content">
              <MessageContent
                content={msg.content}
                role={msg.role}
                thinking={msg.thinking}
                toolCalls={msg.toolCalls}
                blocks={msg.blocks}
                media={msg.media}
                partial={msg.partial}
                latencyMs={msg.latencyMs}
                usagePromptTokens={msg.usagePromptTokens}
                usageCompletionTokens={msg.usageCompletionTokens}
                costCents={msg.costCents}
                onPlanApprove={onPlanApprove}
                onPlanReject={onPlanReject}
                onOpenSessionViewer={onOpenSessionViewer}
                onMessage={onMessage}
              />
            </div>
          </div>
          )}
          {/* Retry button for error messages */}
          {onRetry && msg.role === 'assistant' && msg.content.startsWith('⚠️') && (
            <button
              onClick={onRetry}
              className="mt-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-700/50 transition-colors"
            >
              ↻ Retry
            </button>
          )}
          {/* Queued indicator for offline messages */}
          {msg.role === 'user' && (msg.queued || msg.partial) && (
            <div className="text-[10px] text-amber-500 mt-0.5 text-right">
              Queued
            </div>
          )}
          {/* Branch navigation arrows */}
          {onSwitchBranch && msg.siblingCount != null && msg.siblingCount > 1 && (
            <div className={`flex items-center gap-1 mt-0.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <button
                onClick={() => {
                  const current = msg.activeBranchIndex ?? 0;
                  if (current > 0) onSwitchBranch(msg.id, current - 1);
                }}
                disabled={(msg.activeBranchIndex ?? 0) === 0}
                className="w-5 h-5 flex items-center justify-center text-app-text-muted hover:text-app-text disabled:opacity-30 disabled:cursor-default rounded transition-colors"
                aria-label="Previous branch"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-[11px] text-app-text-muted font-medium tabular-nums min-w-[2ch] text-center">
                {(msg.activeBranchIndex ?? 0) + 1}/{msg.siblingCount}
              </span>
              <button
                onClick={() => {
                  const current = msg.activeBranchIndex ?? 0;
                  if (current < (msg.siblingCount ?? 1) - 1) onSwitchBranch(msg.id, current + 1);
                }}
                disabled={(msg.activeBranchIndex ?? 0) >= (msg.siblingCount ?? 1) - 1}
                className="w-5 h-5 flex items-center justify-center text-app-text-muted hover:text-app-text disabled:opacity-30 disabled:cursor-default rounded transition-colors"
                aria-label="Next branch"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          {/* Timestamp on hover */}
          {msg.timestamp && !(msg.role === 'user' && (msg.queued || msg.partial)) && (
            <div className={`text-[10px] text-app-placeholder mt-0.5 transition-opacity ${isTouchDevice ? 'opacity-60' : 'opacity-0 group-hover:opacity-100'} ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
              {formatTimestamp(msg.timestamp)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
