import { useCallback, memo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, FolderGit2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Topic } from '@/types';

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
  unreadCount?: number;
  onToggle: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onArchive?: (topicId: string, archive: boolean) => void;
  isDragOver?: boolean;
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
  isProject,
  unreadCount = 0,
  onToggle,
  onClick,
  onDoubleClick,
  onContextMenu,
  onArchive,
  isDragOver,
  onSidebarDragStart,
  onSidebarDragOver,
  onSidebarDrop,
  onSidebarDragEnd,
}: TopicItemProps) {
  const paddingLeft = 8 + depth * 16;

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-panel-id', topic.id);
    e.dataTransfer.setData('application/x-sidebar-reorder', topic.id);
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
    ghost.textContent = `${topic.icon || '💬'} ${topic.name}`;
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
      draggable={!isArchived}
      onDragStart={handleDragStart}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-sidebar-reorder')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onSidebarDragOver?.();
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('application/x-sidebar-reorder')) {
          e.preventDefault();
          onSidebarDrop?.();
        }
      }}
      onDragEnd={() => onSidebarDragEnd?.()}
      className={cn(
        'group flex items-center gap-1.5 min-h-[44px] h-11 pr-2 cursor-pointer text-[13px] font-medium transition-colors duration-100 select-none relative md:min-h-9 md:h-9',
        // Focused (panel open and focused): accent bg + left border
        isFocused && 'bg-[var(--primary)]/8 dark:bg-[var(--primary)]/15 text-[var(--primary)] dark:text-[#5599ff]',
        // Open but not focused
        !isFocused && isOpen && 'bg-[#f0f0f0] dark:bg-[#252525] text-[#1a1a1a] dark:text-[#e5e5e5]',
        // Default (not open)
        !isFocused && !isOpen && 'text-[#555] dark:text-[#999] hover:bg-[#f5f5f5] dark:hover:bg-[#222] hover:text-[#1a1a1a] dark:hover:text-[#e5e5e5]',
        // Preview panels show italic name
        isPreview && 'italic',
        isArchived && 'opacity-60',
        // Drag over indicator
        isDragOver && 'border-t-2 border-[var(--primary)]'
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
      <span className="flex-shrink-0 leading-none flex items-center justify-center w-5 h-5 text-[15px]">
        {isArchived ? (
          <Archive size={14} className="text-[#8b8b8b]" />
        ) : isProject ? (
          <FolderGit2 size={14} className="text-blue-500" />
        ) : (
          topic.icon || '💬'
        )}
      </span>

      {/* Name */}
      <span className={cn(
        "flex-1 truncate leading-none",
        unreadCount > 0 && !isFocused && "font-semibold text-[#1a1a1a] dark:text-[#e5e5e5]"
      )}>
        {topic.name}
      </span>

      {/* Archive/Unarchive button - show on hover */}
      {onArchive && (
        <button
          onClick={handleArchiveClick}
          className="flex-shrink-0 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
          title={topic.archived ? "Unarchive" : "Archive"}
        >
          {topic.archived ? (
            <ArchiveRestore size={12} className="text-[#8b8b8b]" />
          ) : (
            <Archive size={12} className="text-[#8b8b8b]" />
          )}
        </button>
      )}

      {/* Unread badge */}
      {unreadCount > 0 && !isFocused && (
        <span className="flex-shrink-0 bg-[var(--primary)] text-white text-[10px] font-semibold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 leading-none">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </div>
  );
});
