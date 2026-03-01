import { useCallback, memo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Topic } from '@/types';
import { DND_TYPES } from '@/lib/dndTypes';
import { TopicIcon } from '@/lib/topicIcons';

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
  isDragOver?: boolean;
  hideIcon?: boolean;
  onSidebarDragStart?: () => void;
  onSidebarDragOver?: () => void;
  onSidebarDrop?: () => void;
  onSidebarDragEnd?: () => void;
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
  hideIcon,
  isDragOver,
  onSidebarDragStart,
  onSidebarDragOver,
  onSidebarDrop,
  onSidebarDragEnd,
}: TopicItemProps) {
  const paddingLeft = 8 + depth * 12;

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(DND_TYPES.PANEL_ID, topic.id);
    e.dataTransfer.setData(DND_TYPES.SIDEBAR_REORDER, topic.id);
    e.dataTransfer.effectAllowed = 'move';

    // Compact ghost
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position:fixed; left:-9999px; top:-9999px;
      display:flex; align-items:center; gap:6px;
      padding:6px 12px; border-radius:8px;
      background:color-mix(in srgb, var(--primary) 90%, transparent); color:#fff;
      font:500 13px/1 Inter,system-ui,sans-serif;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
      white-space:nowrap; pointer-events:none;
    `;
    ghost.textContent = topic.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => document.body.removeChild(ghost));
    onSidebarDragStart?.();
  }, [topic, onSidebarDragStart]);

  const handleArchiveClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onArchive?.(topic.id, !topic.archived);
  }, [topic.id, topic.archived, onArchive]);

  return (
    <div
      role="treeitem"
      aria-selected={isFocused}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-label={topic.name}
      tabIndex={isFocused ? 0 : -1}
      draggable={!isArchived}
      onDragStart={handleDragStart}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPES.SIDEBAR_REORDER)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onSidebarDragOver?.();
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPES.SIDEBAR_REORDER)) {
          e.preventDefault();
          onSidebarDrop?.();
        }
      }}
      onDragEnd={() => onSidebarDragEnd?.()}
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
        'group flex items-center gap-1.5 min-h-[36px] h-9 pr-1.5 cursor-pointer text-[12px] font-medium transition-colors duration-100 select-none relative md:min-h-8 md:h-8 md:gap-2 md:pr-2 md:text-[13px]',
        // Focused (panel open and focused): accent bg + left border
        isFocused && 'bg-primary/8 dark:bg-primary/15 text-primary dark:text-primary-dark',
        // Open but not focused
        !isFocused && isOpen && 'bg-app-hover text-app-text',
        // Default (not open)
        !isFocused && !isOpen && 'text-app-text-secondary hover:bg-app-hover hover:text-app-text',
        // Preview panels show italic name
        isPreview && 'italic',
        isArchived && 'opacity-60',
        // Drag over indicator
        isDragOver && 'border-t-2 border-primary'
      )}
      style={{ paddingLeft }}
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
            strokeWidth={1.5}
            className={cn('transition-transform duration-150', isExpanded && 'rotate-90')}
          />
        </button>
      )}

      {/* Icon */}
      {!hideIcon && (
        <span className="flex-shrink-0 leading-none flex items-center justify-center w-4 h-4 md:w-5 md:h-5">
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
          className="group/stop flex-shrink-0 w-9 h-9 md:w-7 md:h-7 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
          title="Stop generating"
          aria-label="Stop generating"
        >
          <div className="w-3.5 h-3.5 border-[1.5px] border-primary border-t-transparent rounded-full animate-spin group-hover/stop:hidden" />
          <div className="w-2 h-2 bg-primary rounded-[1px] hidden group-hover/stop:block" />
        </button>
      ) : (
        /* Time / Archive — occupy the same slot, swap on hover */
        <span className="flex-shrink-0 flex items-center justify-center w-9 h-9 md:w-7 md:h-7">
          {/* Relative time — default visible, hidden on group hover */}
          {topic.updatedAt && (
            <span
              className="text-[10px] text-app-text-tertiary tabular-nums group-hover:hidden"
              title={new Date(topic.updatedAt).toLocaleString()}
            >
              {relativeTime(topic.updatedAt)}
            </span>
          )}
          {/* Archive button — hidden by default, visible on group hover */}
          {onArchive && (
            <button
              onClick={handleArchiveClick}
              className="hidden group-hover:flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
              title={topic.archived ? "Unarchive" : "Archive"}
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
      )}

      {/* Assigned agents badge */}
      {assignedAgentCount > 0 && (
        <span
          className="flex-shrink-0 flex items-center gap-0.5 text-[10px] text-purple-500 dark:text-purple-400"
          title={`${assignedAgentCount} agent${assignedAgentCount > 1 ? 's' : ''} assigned`}
        >
          <Bot size={11} />
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
