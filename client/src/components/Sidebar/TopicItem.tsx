import { useCallback, useRef, useState, memo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, Bot, MoreHorizontal, Cloud, Pin, PinOff, AppWindow } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Topic } from '@/types';
import { DropdownPortal } from '@/components/Shared/DropdownPortal';
import { useTopicPendingStatus } from '@/contexts/PendingActionContext';
import { PendingActionRing } from '@/components/Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '@/components/Shared/PendingActionProgressOverlay';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DND_TYPES } from '@/lib/dndTypes';
import { useTopicLoading, useTopicAttentionFill, useSeenDwell } from '@/state/signals';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
import { SessionActivity } from '@/components/Shared/SessionActivity';
import { RelativeTime } from '@/components/Shared/RelativeTime';
import { TopicStreamingSpinner } from '@/components/Layout/StreamingIndicator';
import { sidebarRowCard, ROW_PX, ROW_INSET, SIDEBAR_INDENT_STEP, ON_FILL_TEXT, ON_FILL_TEXT_SOFT } from '@/lib/selectionStyles';
import { SplitMiniMap } from '@/components/Shared/SplitMiniMap';
import { useSplitPosition } from '@/contexts/SplitPositionContext';

const isTouchDevice = typeof window !== 'undefined' && (
  'ontouchstart' in window || navigator.maxTouchPoints > 0
);

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
  /** Pinned ("Fissati") — renders the Pin glyph in the trailing rail and the
   *  row survives tab close (see buildSidebarItems pinnedIds gates). */
  pinned?: boolean;
  /** Pin/unpin this topic ("Fissa" / "Rimuovi dai Fissati") — surfaced in the
   *  touch overflow menu; desktop uses the App-level context menu. */
  onTogglePin?: () => void;
  /** Set when this topic is open in ANOTHER window (pop-out presence). Renders
   *  the trailing AppWindow glyph; the row click focuses that window. */
  detachedWindowLabel?: string;
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
  pinned,
  onTogglePin,
  detachedWindowLabel,
  sortable,
  hideIcon,
}: TopicItemProps) {
  // Depth indent lives on the LEFT MARGIN, not padding — so a sub-tab's CARD
  // shifts right (leaving an empty gutter) instead of just indenting its text
  // inside a full-width card. Base = the card's own inset (ROW_INSET),
  // so depth-0 children line up with the card edge.
  const marginLeft = ROW_INSET + depth * SIDEBAR_INDENT_STEP;
  // Canonical streaming signal — same context the chat tab reads. No
  // upstream prop needed; deduplicates the wiring across surfaces.
  const isStreaming = useTopicLoading(topic.id);
  // Attention TIER — amber 'input' (a permission gate, act now) vs blue 'done'
  // (turn finished, look when ready), or null. Same signal/look the chat tab
  // uses, so the sidebar row and the tab can't drift (tabbar ≡ sidebar
  // invariant).
  //
  // Il FILL cade quando la riga è stata VISTA, non quando è selezionata: prima il
  // gate era `!isFocused`, e un clic di passaggio spegneva il fill di una chat mai
  // letta. `useSeenDwell` arma la soglia mentre la riga è davanti e la finestra è
  // sveglia; `useTopicAttentionFill` applica FOCUS WINS in un posto solo.
  useSeenDwell(topic.id, isFocused);
  const attentionTier = useTopicAttentionFill(topic.id);
  const onFill = attentionTier !== null;
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

  // Native HTML5 drag SOURCE for the sidebar row (restores the drag that a
  // dnd-kit migration + DndContext removal left dead — see PanelGrid's sidebar
  // drop path). Carries PANEL_ID so the grid's cell drop-targets can OPEN the
  // topic and MERGE it into the group it's dropped on ("raggruppa da sidebar").
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(DND_TYPES.PANEL_ID, topic.id);
    e.dataTransfer.effectAllowed = 'move';
    // Compact drag ghost (matches the pre-regression look).
    const ghost = document.createElement('div');
    ghost.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;display:flex;align-items:center;' +
      'padding:6px 12px;border-radius:8px;font:500 13px/1 Inter,system-ui,sans-serif;' +
      'color:#fff;white-space:nowrap;pointer-events:none;' +
      'background:color-mix(in srgb, var(--primary) 90%, transparent);' +
      'box-shadow:0 4px 12px rgba(0,0,0,0.15);';
    ghost.textContent = topic.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => { try { document.body.removeChild(ghost); } catch { /* already gone */ } });
  }, [topic.id, topic.name]);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      draggable={!isArchived}
      onDragStart={handleDragStart}
      role="treeitem"
      aria-selected={isFocused}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-label={topic.name}
      tabIndex={isFocused ? 0 : -1}
      data-pinned={pinned ? 'true' : undefined}
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
        `group flex items-center gap-2 min-h-[40px] h-10 md:min-h-[34px] md:h-[34px] ${ROW_PX} cursor-pointer text-[14px] md:text-[13px] font-medium select-none`,
        sidebarRowCard({ focused: isFocused, open: isOpen, attention: attentionTier }),
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

      {/* "Awaiting feedback" is the row's own electric-blue background now
          (see sidebarRowCard awaiting flag), not an overlay. */}

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

      {/* Icon — archived rows keep the Archive glyph; live topic chats carry NO
          leading icon (name flush-left). Brand marks (Claude / Codex) live only
          on the agent sessions themselves — the Claude Code / Codex terminal
          rows — never on topic chats. */}
      {!hideIcon && isArchived && (
        <span className="flex-shrink-0 leading-none flex items-center justify-center w-5 h-5">
          <Archive size={14} className={onFill ? ON_FILL_TEXT_SOFT : "text-app-text-tertiary"} />
        </span>
      )}

      {/* Name + live "what it's doing" subline. The subline (SessionActivity)
          self-hides when the session is idle, so idle rows stay single-line; on
          the mobile full-screen sidebar it's the primary "what is it doing"
          surface. On an attention fill the name goes white (fixes grey-on-blue). */}
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <span className={cn(
          "truncate leading-none",
          onFill && cn("font-semibold", ON_FILL_TEXT),
          !onFill && notificationCount > 0 && !isFocused && "font-semibold text-app-text"
        )}>
          {topic.name}
        </span>
        <SessionActivity subjectId={topic.id} onFill={onFill} className="mt-[3px]" />
      </div>

      {/* Cloud (OpenClaw) attribute — a quiet glyph marking this row as a cloud
          session, not a local one. Muted tone (not the attention axis). */}
      {topic.provider === 'openclaw' && (
        <span className={cn("flex-shrink-0 flex items-center", onFill ? ON_FILL_TEXT_SOFT : "text-app-text-tertiary")} title="Cloud (OpenClaw)" aria-label="Sessione cloud (OpenClaw)">
          <Cloud size={12} />
        </span>
      )}

      {/* Split position — the same proportional mini-map the tab bar shows,
          this topic's cell lit. Only present when the topic is open in a split
          grid. Rendered BEFORE the spinner/timestamp slot so the streaming
          spinner lands at the row's trailing edge (see below). */}
      {splitPosition && (
        <SplitMiniMap
          rows={splitPosition.rows}
          rowHeights={splitPosition.rowHeights}
          active={splitPosition.active}
          // The map draws from currentColor, so on an attention fill it MUST
          // inherit the fill's high-contrast tone (white on blue / dark on amber)
          // instead of a fixed grey that vanishes on the fill — the grey-on-blue bug.
          className={cn("flex-shrink-0", onFill ? ON_FILL_TEXT_SOFT : "text-app-text-tertiary")}
        />
      )}

      {/* Assigned agents badge */}
      {assignedAgentCount > 0 && (
        <span
          className={cn("flex-shrink-0 flex items-center gap-0.5 text-[11px]", onFill ? ON_FILL_TEXT_SOFT : "text-purple-500 dark:text-purple-400")}
          title={`${assignedAgentCount} agent${assignedAgentCount > 1 ? 's' : ''} assigned`}
        >
          <Bot size={12} />
          {assignedAgentCount > 1 && <span className="font-medium">{assignedAgentCount}</span>}
        </span>
      )}

      {/* Streaming spinner (when working) XOR timestamp/archive (at rest).
          Pinned AFTER the split-map + agents badge so the "working" cue sits at
          the END of the row — matching the tab bar and the terminal/browser
          sidebar rows. The notification badge below is the only trailing
          element after it. */}
      {isStreaming ? (
        /* The SAME shared loader the tab bar renders (GridLoader + hover-stop via
           LoaderSlot), just a bigger 28px box for the sidebar hit target — so the
           sidebar chat row and its tab can't drift in glyph, animation, or stop
           affordance. */
        <TopicStreamingSpinner
          topicId={topic.id}
          onStop={onStopStreaming}
          size={28}
          variant="labeled"
          lastActivity={new Date(topic.updatedAt || topic.createdAt).getTime()}
          // La durata del turno la dice già `SessionActivity` sotto al nome. Qui
          // resta il solo campanello dello STALLO — vedi `quiet`.
          quiet
          className="flex-shrink-0"
        />
      ) : (
        isTouchDevice ? (
          /* Touch: timestamp always visible + ... button always visible */
          <>
            <RelativeTime
              at={topic.updatedAt}
              className={cn("flex-shrink-0 text-[11px] tabular-nums", onFill ? ON_FILL_TEXT_SOFT : "text-app-text-tertiary")}
            />
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
                  {/* Pin entry first — touch has no right-click context menu,
                      so this overflow menu is the only pin affordance <768px. */}
                  {onTogglePin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onTogglePin(); setOverflowOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    >
                      {pinned ? <PinOff size={14} className="flex-shrink-0" /> : <Pin size={14} className="flex-shrink-0" />}
                      <span>{pinned ? 'Rimuovi dai Fissati' : 'Fissa'}</span>
                    </button>
                  )}
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
                <RelativeTime
                  at={topic.updatedAt}
                  className={cn("text-[11px] tabular-nums group-hover:hidden", onFill ? ON_FILL_TEXT_SOFT : "text-app-text-tertiary")}
                />
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

      {/* Trailing-glyph RAIL — fixed order: Pin → AppWindow (detached, future
          pop-out slice inserts here) → NotificationBadge. New trailing glyphs
          join THIS rail, they don't invent a new slot (ruling 3.1). Glyphs
          inherit the on-fill treatment via ON_FILL_TEXT_SOFT — never a
          hardcoded colour on an attention fill. */}
      {pinned && (
        <span
          className={cn('flex-shrink-0 flex items-center', onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary')}
          title="Fissato"
          aria-label="Fissato"
        >
          <Pin size={12} />
        </span>
      )}
      {detachedWindowLabel !== undefined && (
        <span
          className={cn('flex-shrink-0 flex items-center', onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary')}
          title="Aperto in un'altra finestra"
          aria-label="Aperto in un'altra finestra"
        >
          <AppWindow size={12} />
        </span>
      )}
      {/* Notification badge — hidden when focused so the user doesn't see a
          count for the topic they're actively looking at. The last element of
          the trailing rail, so "working" reads at the row end. */}
      {!isFocused && <NotificationBadge count={notificationCount} variant={onFill ? 'onFill' : 'default'} />}
    </div>
  );
});

