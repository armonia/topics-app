import { Pin } from 'lucide-react';
import type { ChatMessage } from '../../types';

interface PinnedMessagesProps {
  show: boolean;
  pinnedMessages: ChatMessage[];
}

export function PinnedMessages({ show, pinnedMessages }: PinnedMessagesProps) {
  if (!show || pinnedMessages.length === 0) return null;

  return (
    <div className="border-b border-app-border bg-yellow-50/50 dark:bg-yellow-900/10 p-2 max-h-28 overflow-y-auto flex-shrink-0">
      <div className="text-[10px] font-medium text-yellow-600/70 dark:text-yellow-400/60 mb-1 flex items-center gap-1">
        <Pin size={14} /> Pinned
      </div>
      {pinnedMessages.map(msg => (
        <div key={msg.id} className="text-[11px] text-app-text-secondary bg-surface dark:bg-elevated rounded p-1.5 mb-1 line-clamp-2">
          {msg.content.slice(0, 100)}
        </div>
      ))}
    </div>
  );
}
