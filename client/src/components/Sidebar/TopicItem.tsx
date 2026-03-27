import { useCallback, useRef, useState, memo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, Bot, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Topic } from '@/types';
import { TopicIcon } from '@/lib/topicIcons';
import { DropdownPortal } from '@/components/Shared/DropdownPortal';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const isTouchDevice = typeof window !== 'undefined' && (
  'ontouchstart' in window || navigator.maxTouchPoints > 0
);

function relativeTime(dateStr: string): string {
  const diffS = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffS < 60) return 'now';
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d`;
  return `${Math.floor(diffD / 30)}mo`;
}

interface TopicItemProps {
  topic: Topic;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isOpen: boolean;
  isFocused: boolean;
  isPreview?: boolean;
  isArchived?: boolean;
  isProject?: boolean;
  isStreaming?: boolean;
  unreadCount?: number;
  assignedAgentCount?: number;
  onToggle: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onArchive?: (topicId: string, archive: boolean) => void;
  onStopStreaming?: () => void;
  sortable?: boolean;
  hideIcon?: boolean;
}

export const TopicItem = memo(function TopicItem({
  topic,
  depth,
  hasChildren,
  isExpanded,
  isOpen,
  isFocused,
  isPreview,
  isArchived,
  isProject: _isProject,
  isStreaming,
  unreadCount = 0,
  assignedAgentCount = 0,
  onToggle,
  onClick,
  onDoubleClick,
  onContextMenu,
  onArchive,
  onStopStreaming,
  sortable,
  hideIcon,
}: TopicItemProps) {
  const paddingLeft = 12 + depth * 16;

  const { attributes: sortableAttributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: topic.id,
    disabled: !sortable,
  });
  // Exclude aria-disabled from sortable attributes — it prevents Playwright clicks
  // and isn't meaningful for treeitem semantics (the item is always interactive, just not always draggable)
  const { 'aria-disabled': _ariaDisabled, role: _role, ...attributes } = sortableAttributes;

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    paddingLeft,
  };

  const overflowRef = useRef<HTMLButtonElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const handleArchiveClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onArchive?.(topic.id, !topic.archived);
  }, [topic.id, topic.archived, onArchive]);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="treeitem"
      aria-selected={isFocused}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-label={topic.name}
      tabIndex={isFocused ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        }
        if (e.key === 'ArrowRight' && hasChildren && !isExpanded) {
          e.preventDefault();
          onToggle();
        }
        if (e.key === 'ArrowLeft' && hasChildren && isExpanded) {
          e.preventDefault();
          onToggle();
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement;
          next?.focus();
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement;
          prev?.focus();
        }
      }}
      className={cn(
        'group flex items-center gap-2 min-h-[32px] h-8 pr-1 cursor-pointer text-[12px] font-medium transition-colors duration-100 select-none relative md:text-[13px]',
        // Focused (panel open and focused): accent bg + left border
        isFocused && 'bg-primary/8 dark:bg-primary/15 text-primary dark:text-primary-dark',
        // Open but not focused
        !isFocused && isOpen && 'bg-app-hover text-app-text',
        // Default (not open)
        !isFocused && !isOpen && 'text-app-text-secondary hover:bg-app-hover hover:text-app-text',
        // Preview panels show italic name
        isPreview && 'italic',
        isArchived && 'opacity-60',
        isDragging && 'opacity-50'
      )}
      style={sortableStyle}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/* Left accent border for focused */}
      {isFocused && (
        <div
          className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full"
          style={{ backgroundColor: topic.color || 'var(--primary)' }}
        />
      )}

      {/* Toggle button — only show if has children */}
      {hasChildren && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className="flex items-center justify-center w-4 h-4 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
        >
          <ChevronRight
            size={12}
            className={cn('transition-transform duration-150', isExpanded && 'rotate-90')}
          />
        </button>
      )}

      {/* Icon */}
      {!hideIcon && (
        <span className="flex-shrink-0 leading-none flex items-center justify-center w-5 h-5">
          {isArchived ? (
            <Archive size={14} className="text-app-text-tertiary" />
          ) : (
            <TopicIcon name={topic.icon} size={14} color={topic.color || undefined} />
          )}
        </span>
      )}

      {/* Name */}
      <span className={cn(
        "flex-1 truncate leading-none",
        unreadCount > 0 && !isFocused && "font-semibold text-app-text"
      )}>
        {topic.name}
      </span>

      {/* Streaming spinner */}
      {isStreaming ? (
        <button
          onClick={(e) => { e.stopPropagation(); onStopStreaming?.(); }}
          className="group/stop flex-shrink-0 w-7 h-7 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
          title="Stop generating"
          aria-label="Stop generating"
        >
          <div className="w-3.5 h-3.5 border-[1.5px] border-primary border-t-transparent rounded-full animate-spin group-hover/stop:hidden" />
          <div className="w-2 h-2 bg-primary rounded-[1px] hidden group-hover/stop:block" />
        </button>
      ) : (
        isTouchDevice ? (
          /* Touch: timestamp always visible + ... button always visible */
          <>
            {topic.updatedAt && (
              <span
                className="flex-shrink-0 text-[10px] text-app-text-tertiary tabular-nums"
                title={new Date(topic.updatedAt).toLocaleString()}
              >
                {relativeTime(topic.updatedAt)}
              </span>
            )}
            {onArchive && (
              <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 relative">
                <button
                  ref={overflowRef}
                  onClick={(e) => { e.stopPropagation(); setOverflowOpen(o => !o); }}
                  className="flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all text-app-text-tertiary hover:text-app-text"
                  title="More options"
                  aria-label={`More options for ${topic.name}`}
                >
                  <MoreHorizontal size={12} />
                </button>
                <DropdownPortal open={overflowOpen} anchorRef={overflowRef} onClose={() => setOverflowOpen(false)}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleArchiveClick(e); setOverflowOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    {topic.archived ? <ArchiveRestore size={14} className="flex-shrink-0" /> : <Archive size={14} className="flex-shrink-0" />}
                    <span>{topic.archived ? 'Unarchive' : 'Archive'}</span>
                  </button>
                </DropdownPortal>
              </span>
            )}
          </>
        ) : (
          /* Desktop: old swap — timestamp visible at rest, archive button on hover */
          <span className="flex-shrink-0 flex items-center justify-center w-7 h-7">
            {topic.updatedAt && (
              <span
                className="text-[10px] text-app-text-tertiary tabular-nums group-hover:hidden"
                title={new Date(topic.updatedAt).toLocaleString()}
              >
                {relativeTime(topic.updatedAt)}
              </span>
            )}
            {onArchive && (
              <button
                onClick={handleArchiveClick}
                className="hidden group-hover:flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
                title={topic.archived ? 'Unarchive' : 'Archive'}
                aria-label={topic.archived ? `Unarchive ${topic.name}` : `Archive ${topic.name}`}
              >
                {topic.archived ? (
                  <ArchiveRestore size={12} className="text-app-text-tertiary" />
                ) : (
                  <Archive size={12} className="text-app-text-tertiary" />
                )}
              </button>
            )}
          </span>
        )
      )}

      {/* Assigned agents badge */}
      {assignedAgentCount > 0 && (
        <span
          className="flex-shrink-0 flex items-center gap-0.5 text-[10px] text-purple-500 dark:text-purple-400"
          title={`${assignedAgentCount} agent${assignedAgentCount > 1 ? 's' : ''} assigned`}
        >
          <Bot size={12} />
          {assignedAgentCount > 1 && <span className="font-medium">{assignedAgentCount}</span>}
        </span>
      )}

      {/* Unread badge */}
      {unreadCount > 0 && !isFocused && (
        <span className="flex-shrink-0 bg-primary text-white text-[10px] font-semibold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 leading-none">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </div>
  );
});
