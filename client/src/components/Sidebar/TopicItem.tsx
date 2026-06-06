import { useCallback, useRef, useState, memo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, Bot, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Topic } from '@/types';
import { TopicIcon } from '@/lib/topicIcons';
import { DropdownPortal } from '@/components/Shared/DropdownPortal';
import { useTopicPendingStatus } from '@/contexts/PendingActionContext';
import { PendingActionRing } from '@/components/Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '@/components/Shared/PendingActionProgressOverlay';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTopicLoading } from '@/state/signals';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
import { sidebarRowCard } from '@/lib/selectionStyles';
import { SplitMiniMap } from '@/components/Shared/SplitMiniMap';
import { useSplitPosition } from '@/contexts/SplitPositionContext';

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
  /** Unified attention count — server unread OR Claude "needs you". Rendered as
   *  the same NotificationBadge the tab bar uses; the per-Claude phase dot is
   *  gone, folded into this single count. */
  notificationCount?: number;
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
  notificationCount = 0,
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
  // Depth indent lives on the LEFT MARGIN, not padding — so a sub-tab's CARD
  // shifts right (leaving an empty gutter) instead of just indenting its text
  // inside a full-width card. 8px base = the card's own mx-2 inset.
  const marginLeft = 8 + depth * 16;
  // Canonical streaming signal — same context the chat tab reads. No
  // upstream prop needed; deduplicates the wiring across surfaces.
  const isStreaming = useTopicLoading(topic.id);
  // Where this topic's pane sits in the standalone split grid (undefined unless
  // it's open AND the grid is split). Rendered as the same proportional
  // mini-map the tab shows, so the sidebar card mirrors the tab's position cue.
  const splitPosition = useSplitPosition(topic.id);

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
    marginLeft,
  };

  const overflowRef = useRef<HTMLButtonElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // v3 foundations sidebar↔topbar sync: aggregate the topic-level closing
  // countdown across BOTH surfaces. The sidebar row shows the progress
  // overlay whether the close was initiated from:
  //   - the archive icon next to the row     → `archive-topic:<id>`
  //   - the X on the open chat tab (topbar)  → `close-tab:chat:<id>`
  // Without this aggregation the sidebar stays static when the user closes
  // the tab from the topbar, even though the chat-pane countdown is running.
  const pendingArchiveStatus = useTopicPendingStatus(topic.id, {
    isArchived: topic.archived,
  });

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
        // Card rows — same visual language as the tab-bar tabs: a rounded,
        // self-contained surface with its own faint fill, not a full-bleed
        // list row with hairline dividers. `overflow-hidden` clips the
        // soft-archive progress fill to the rounded corners.
        // Shared card styling (see sidebarRowCard) — same look for every
        // sidebar row type. No border (hairlines read as dividing lines); a
        // filled inset rounded surface makes each row a tab-like card.
        'group flex items-center gap-2 min-h-[40px] h-10 md:min-h-[34px] md:h-[34px] px-2 cursor-pointer text-[14px] md:text-[13px] font-medium select-none',
        sidebarRowCard({ focused: isFocused, open: isOpen }),
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
      {/* Pending-action progress fill — runs over the whole row L→R during
          the 3 s soft-archive countdown. Sits behind everything (no z
          index) so the sidebar accent border + content render on top. */}
      {pendingArchiveStatus && (
        <PendingActionProgressOverlay status={pendingArchiveStatus} />
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
        notificationCount > 0 && !isFocused && "font-semibold text-app-text"
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
                className="flex-shrink-0 text-[11px] text-app-text-tertiary tabular-nums"
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
          /* Desktop: timestamp at rest, ARCHIVE control on hover.
             For NOT-archived topics the hover control is an explicit Archive
             icon (NOT a checkbox/empty-circle): the empty ring read as "close
             this tab / mark done", but it actually archives the topic — a
             confusing conflation of two orthogonal states (open/closed tab vs
             archived). Closing a tab is done from the tab bar (X / Cmd+W) and
             never archives. Clicking this still triggers the 3s soft-archive
             countdown (the PendingActionRing in the `pendingArchiveStatus`
             branch above). For archived topics the action is restorative. */
          <span className="flex-shrink-0 flex items-center justify-center w-7 h-7 relative z-10">
            {pendingArchiveStatus ? (
              <PendingActionRing
                status={pendingArchiveStatus}
                size={14}
                pendingTitle="Annulla archiviazione"
                pendingAriaLabel={`Annulla archiviazione ${topic.name}`}
              />
            ) : (
              <>
                {topic.updatedAt && (
                  <span
                    className="text-[11px] text-app-text-tertiary tabular-nums group-hover:hidden"
                    title={new Date(topic.updatedAt).toLocaleString()}
                  >
                    {relativeTime(topic.updatedAt)}
                  </span>
                )}
                {onArchive && !topic.archived && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onArchive(topic.id, true); }}
                    className="hidden group-hover:flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
                    title="Archivia (non chiude la tab)"
                    aria-label={`Archivia ${topic.name}`}
                  >
                    <Archive size={12} className="text-app-text-tertiary" />
                  </button>
                )}
                {onArchive && topic.archived && (
                  <button
                    onClick={handleArchiveClick}
                    className="hidden group-hover:flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
                    title="Unarchive"
                    aria-label={`Unarchive ${topic.name}`}
                  >
                    <ArchiveRestore size={12} className="text-app-text-tertiary" />
                  </button>
                )}
              </>
            )}
          </span>
        )
      )}

      {/* Split position — the same proportional mini-map the tab bar shows,
          this topic's cell lit. Only present when the topic is open in a split
          grid. */}
      {splitPosition && (
        <SplitMiniMap
          rows={splitPosition.rows}
          rowHeights={splitPosition.rowHeights}
          active={splitPosition.active}
          className="flex-shrink-0 text-app-text-tertiary"
        />
      )}

      {/* Assigned agents badge */}
      {assignedAgentCount > 0 && (
        <span
          className="flex-shrink-0 flex items-center gap-0.5 text-[11px] text-purple-500 dark:text-purple-400"
          title={`${assignedAgentCount} agent${assignedAgentCount > 1 ? 's' : ''} assigned`}
        >
          <Bot size={12} />
          {assignedAgentCount > 1 && <span className="font-medium">{assignedAgentCount}</span>}
        </span>
      )}

      {/* Notification badge — hidden when focused so the user doesn't see a
          count for the topic they're actively looking at. */}
      {!isFocused && <NotificationBadge count={notificationCount} />}
    </div>
  );
});

