import { memo } from 'react';
import { Copy, Check, Pin } from 'lucide-react';
import type { Topic, ChatMessage } from '../../types';
import { MessageContent } from '../MessageContent';

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
}: MessageBubbleProps) {
  const grouped = idx > 0 && prev && prev.role === msg.role && msg.timestamp && prev.timestamp && (new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() < 120000);
  const dateSep = getDateSeparator(msg.timestamp, prev?.timestamp);
  const emojiMsg = isEmojiOnly(msg.content);

  return (
    <div className={emojiMsg ? 'mb-1' : isCompact ? 'mb-1' : isMobile ? 'mb-1.5' : 'mb-3'}>
      {/* Date separator */}
      {dateSep && (
        <div className="flex items-center gap-3 my-3">
          <div className="flex-1 h-px bg-[#e8e8e8] dark:bg-[#2a2a2a]" />
          <span className="text-[10px] font-medium text-[#888] dark:text-[#777] uppercase tracking-wider">{dateSep}</span>
          <div className="flex-1 h-px bg-[#e8e8e8] dark:bg-[#2a2a2a]" />
        </div>
      )}

      <div
        className={`group flex gap-1.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'} ${!grouped ? 'message-appear' : ''} ${grouped && isCompact ? 'mt-0.5' : ''}`}
      >
        {msg.role === 'assistant' && !grouped && (
          <div className="flex flex-col gap-0.5 self-start mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => onReply(msg)} className="w-8 h-8 flex items-center justify-center text-[#999] dark:text-[#666] hover:text-[var(--primary)] rounded p-1.5" title="Reply" aria-label="Reply">↩</button>
            <button onClick={() => onCopy(msg)} className="w-8 h-8 flex items-center justify-center text-[#999] dark:text-[#666] hover:text-[var(--primary)] rounded p-1.5" title="Copy" aria-label="Copy message">
              {copiedMsgId === msg.id ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
            </button>
            <button onClick={() => onTogglePin(msg)} className={`w-8 h-8 flex items-center justify-center rounded p-1.5 ${(topic.pinnedMessages || []).includes(msg.id) ? 'text-yellow-500' : 'text-[#999] dark:text-[#666] hover:text-yellow-500'}`} title="Pin" aria-label="Pin message">
              <Pin size={16} />
            </button>
          </div>
        )}
        {msg.role === 'assistant' && grouped && (
          <div className="w-8 flex-shrink-0" />
        )}
        <div className={`flex flex-col ${isMobile ? 'max-w-[92%]' : 'max-w-[85%]'} min-w-0`}>
          {isEmojiOnly(msg.content) ? (
            <div className="text-[32px] leading-none py-0.5">
              {msg.content.trim()}
            </div>
          ) : (
          <div
            className={`px-3 py-2 text-[13px] leading-relaxed overflow-hidden ${
              msg.role === 'user'
                ? 'user-bubble bg-[var(--primary)] text-white shadow-sm'
                : 'bg-[#f5f5f5] dark:bg-[#222] text-[#1a1a1a] dark:text-[#e5e5e5]'
            } ${grouped ? (msg.role === 'user' ? 'rounded-2xl rounded-tr-md' : 'rounded-2xl rounded-tl-md') : 'rounded-2xl'}`}
            style={{ fontSize: `${fontSize}px`, overflowWrap: 'break-word', wordBreak: 'break-word' }}
          >
            <div className="message-content">
              <MessageContent 
                content={msg.content} 
                role={msg.role}
                thinking={msg.thinking}
                toolCalls={msg.toolCalls}
                media={msg.media}
                partial={msg.partial}
              />
            </div>
          </div>
          )}
          {/* Timestamp on hover */}
          {msg.timestamp && (
            <div className={`text-[10px] text-[#b0b0b0] dark:text-[#666] mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
              {formatTimestamp(msg.timestamp)}
            </div>
          )}
        </div>
        {msg.role === 'user' && !grouped && (
          <div className="flex flex-col gap-0.5 self-start mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => onReply(msg)} className="w-8 h-8 flex items-center justify-center text-[#999] dark:text-[#666] hover:text-[var(--primary)] rounded p-1.5" title="Reply" aria-label="Reply">↩</button>
            <button onClick={() => onCopy(msg)} className="w-8 h-8 flex items-center justify-center text-[#999] dark:text-[#666] hover:text-[var(--primary)] rounded p-1.5" title="Copy" aria-label="Copy message">
              {copiedMsgId === msg.id ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
            </button>
            <button onClick={() => onTogglePin(msg)} className={`w-8 h-8 flex items-center justify-center rounded p-1.5 ${(topic.pinnedMessages || []).includes(msg.id) ? 'text-yellow-500' : 'text-[#999] dark:text-[#666] hover:text-yellow-500'}`} title="Pin" aria-label="Pin message">
              <Pin size={16} />
            </button>
          </div>
        )}
        {msg.role === 'user' && grouped && (
          <div className="w-8 flex-shrink-0" />
        )}
      </div>
    </div>
  );
});
