import { Pin, PinOff } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { ChatMessage } from '../../types';

interface PinnedMessagesProps {
  show: boolean;
  pinnedMessages: ChatMessage[];
  /** Takes the transcript to the message (CMDUI-10). */
  onGoTo: (messageId: string) => void;
  /** Unpins it from here. */
  onUnpin: (message: ChatMessage) => void;
}

/**
 * The pinned messages, opened from the line above the transcript that says how
 * many there are and that they stay in the agent's context (CMDUI-10). Each
 * entry takes the transcript to its message, and unpins from here.
 */
export function PinnedMessages({ show, pinnedMessages, onGoTo, onUnpin }: PinnedMessagesProps) {
  const tr = useT();
  if (!show || pinnedMessages.length === 0) return null;

  return (
    <div data-testid="chat-pinned-list" className="chat-measure border-b border-app-border bg-yellow-50/50 dark:bg-yellow-900/10 p-2 max-h-40 overflow-y-auto flex-shrink-0">
      <div className="text-mini font-medium text-yellow-600/70 dark:text-yellow-400/60 mb-1 flex items-center gap-1">
        <Pin size={14} /> {tr('chat.pinned.title')}
      </div>
      {pinnedMessages.map(msg => (
        <div key={msg.id} data-testid="chat-pinned-entry" data-message-id={msg.id} className="flex items-start gap-1 mb-1">
          <button
            type="button"
            onClick={() => onGoTo(msg.id)}
            className="flex-1 min-w-0 text-left text-mini text-app-text-secondary bg-surface dark:bg-elevated rounded p-1.5 line-clamp-2 hover:text-app-text"
          >
            {msg.content.slice(0, 100)}
          </button>
          <button
            type="button"
            onClick={() => onUnpin(msg)}
            aria-label={tr('chat.pinned.unpin')}
            title={tr('chat.pinned.unpin')}
            data-testid="chat-pinned-unpin"
            className="flex-shrink-0 w-7 h-7 inline-flex items-center justify-center rounded text-app-text-muted hover:text-app-text hover:bg-app-hover"
          >
            <PinOff size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
