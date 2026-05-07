import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, ExternalLink, Edit3, Settings, BarChart3, Kanban, TerminalSquare, Columns2, Rows2 } from 'lucide-react';
import { usePendingActionStatus } from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import type { Pane, PaneType, PaneGroupType } from '../../types';
import { getPaneConfig, type ProjectTabStatus } from '../../state/pane/adapters';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { getFileIconDef } from '../../lib/fileIcons';
import { DND_TYPES } from '../../lib/dndTypes';
import { EDGE_DROP_PX } from './constants';
import { useMobile, haptic } from '../../hooks/useMobile';
import { useGlobalTabIndex } from '../../contexts/GlobalTabIndexContext';

/** Pane types where the "mark as done" / countdown affordance doesn't
 *  fit semantically — they're read-only viewers (a file open in a viewer,
 *  a process-log tail, a recorded session). For those we keep the classic
 *  X close button without the soft-confirm window; closing them is fully
 *  reversible via the Cmd+Shift+T closed-stack so a 3 s grace window adds
 *  no real safety. */
const READ_ONLY_PANE_TYPES: ReadonlySet<PaneType> = new Set<PaneType>([
  'file',
  'session-viewer',
  'process-log',
]);

const ICONS: Record<string, React.FC<{ size: number; className?: string; style?: React.CSSProperties }>> = {
  MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, BarChart3, Kanban,
};

interface PaneTabBarProps {
  panes: Pane[];
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  /** Default close — typically deferred via the PendingAction countdown. */
  onClose: (paneId: string) => void;
  /** Optional immediate close — invoked by right-click "Close now" so the
   *  user can opt out of the countdown when they're sure. Falls back to
   *  `onClose` when not provided (legacy callers). */
  onCloseImmediate?: (paneId: string) => void;
  onAddPane: (type: PaneType, subType?: string) => void;
  availableTypes: PaneType[];
  groupType?: PaneGroupType;
  groupId?: string;
  onNewChat?: () => void;
  onReorderPanes?: (newPaneIds: string[]) => void;
  onCrossGroupDrop?: (sourcePaneId: string, sourceGroupId: string, insertIdx: number) => void;
  onEdgeSplitDrop?: (sourcePaneId: string, sourceGroupId: string, edge: 'left' | 'right') => void;
  className?: string;
  contextPercent?: Record<string, number>;
  onContextRingClick?: (paneId: string) => void;
  onCloseOthers?: (paneId: string) => void;
  onDetach?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  onRename?: (paneId: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  streamingPaneIds?: Set<string>;
  onStopStreaming?: (paneId: string) => void;
  onPinPane?: (paneId: string) => void;
  projectStatus?: Record<string, ProjectTabStatus>;
  /** Notification badge counts per pane ID */
  tabNotifications?: Map<string, number>;
  /** Reserve left padding for a floating sidebar toggle overlay */
  hasLeftOverlay?: boolean;
  /**
   * Whether THIS group currently owns focus. When false, the tab-bar still
   * renders `activePaneId` as the local-active fallback (for content render
   * downstream) but suppresses the visual highlight so the user doesn't see
   * two simultaneously "selected" tabs across split groups. Default: true,
   * so legacy callers that don't pass this prop keep the old behavior.
   */
  groupIsFocused?: boolean;
  /**
   * Whether the panel hosting THIS group is the App-level focused panel.
   * When `groupIsFocused` is true but `groupIsAppFocused` is false the
   * active tab renders in a dimmed-active state (visible enough to identify
   * "this is the tab here" but clearly less prominent than full focus).
   * Defaults to `groupIsFocused`'s value for legacy callers.
   */
  groupIsAppFocused?: boolean;
}

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onCloseImmediate, onAddPane, availableTypes, groupType: _groupType, groupId, onNewChat, onReorderPanes, onCrossGroupDrop, onEdgeSplitDrop, className, contextPercent: _contextPercent, onContextRingClick: _onContextRingClick, onCloseOthers, onDetach, onSplitRight, onSplitDown, onRename, onSettings, onPopOut, streamingPaneIds, onStopStreaming, onPinPane, projectStatus, tabNotifications, hasLeftOverlay, groupIsFocused = true, groupIsAppFocused }: PaneTabBarProps) {
  // Default groupIsAppFocused to groupIsFocused so non-project callers
  // (StandaloneChatGroup) keep the existing two-state behavior.
  const isAppFocused = groupIsAppFocused ?? groupIsFocused;
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuContentRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [edgeSplitZone, setEdgeSplitZone] = useState<'left' | 'right' | null>(null);
  const [crossGroupDragActive, setCrossGroupDragActive] = useState(false);
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();

  const { isTouch, isMobile } = useMobile();

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ paneId: string; x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAddMenu) return;
    const h = (e: Event) => {
      const target = e.target as Node;
      if (menuContentRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setShowAddMenu(false);
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('touchstart', h, { passive: true });
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); };
  }, [showAddMenu]);

  // Auto-scroll active tab into view when it changes
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activePaneId || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector(`[data-pane-id="${CSS.escape(activePaneId)}"]`) as HTMLElement;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activePaneId]);

  // Close context menu on click/touch outside
  useEffect(() => {
    if (!ctxMenu) return;
    const h = (e: Event) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('touchstart', h, { passive: true });
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); };
  }, [ctxMenu]);

  // Long-press for context menu on touch devices
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  // Anchor menu to the tab's bottom-left edge with viewport-aware flipping.
  const positionMenuForTab = useCallback((tabEl: HTMLElement) => {
    const menuWidth = 160;
    const menuHeight = 240;
    const rect = tabEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight - 8;
    const top = fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - menuHeight - 4);
    return { x: left, y: top };
  }, []);

  const handleLongPressStart = useCallback((paneId: string, tabEl: HTMLElement) => {
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      haptic('medium');
      longPressFiredRef.current = true;
      const { x, y } = positionMenuForTab(tabEl);
      setCtxMenu({ paneId, x, y });
      longPressTimerRef.current = null;
    }, 500);
  }, [positionMenuForTab]);

  const handleLongPressCancel = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleContextMenu = useCallback((paneId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = positionMenuForTab(e.currentTarget as HTMLElement);
    setCtxMenu({ paneId, x, y });
  }, [positionMenuForTab]);

  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  // Cleanup ghost element if component unmounts during drag
  useEffect(() => {
    return () => {
      if (dragGhostRef.current) {
        dragGhostRef.current.remove();
        dragGhostRef.current = null;
      }
    };
  }, []);
  const handleTabDragStart = useCallback((paneId: string) => (e: React.DragEvent) => {
    if (!onReorderPanes) return;
    setDraggedPaneId(paneId);
    e.dataTransfer.setData(DND_TYPES.PANE_TAB, paneId);
    if (groupId) {
      e.dataTransfer.setData(DND_TYPES.PANE_TAB_GROUP, groupId);
    }
    // Set PANEL_ID for edge-split drops at the PanelGrid level.
    // Chat panes use topicId; all other panes use paneId.
    // Top-level groups: "standalone", solo groups ("solo:xxx"), or no groupId.
    const isTopLevel = !groupId || groupId === 'standalone' || groupId.startsWith('solo:');
    if (isTopLevel) {
      const pane = panes.find(p => p.id === paneId);
      if (pane?.type === 'chat' && pane?.topicId) {
        e.dataTransfer.setData(DND_TYPES.PANEL_ID, pane.topicId!);
      } else if (pane) {
        e.dataTransfer.setData(DND_TYPES.PANEL_ID, pane.id);
      }
    }
    e.dataTransfer.effectAllowed = 'move';
    // Custom drag image: styled tab preview instead of browser default file icon.
    // The element must be in the DOM and rendered at setDragImage time.
    // We remove it after one frame (browser captures the image synchronously).
    const ghost = document.createElement('div');
    const pane = panes.find(p => p.id === paneId);
    ghost.textContent = pane?.title || paneId;
    ghost.style.cssText = `
      position:fixed;left:-200px;top:-200px;
      padding:6px 14px;border-radius:8px;
      font:500 13px/1 Inter,system-ui,sans-serif;
      background:color-mix(in srgb, var(--primary) 90%, transparent);color:#fff;
      white-space:nowrap;pointer-events:none;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
    `;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    dragGhostRef.current = ghost;
    // Remove after browser captures the image (next frame)
    requestAnimationFrame(() => {
      if (dragGhostRef.current === ghost) {
        ghost.remove();
        dragGhostRef.current = null;
      }
    });
  }, [onReorderPanes, groupId, panes]);

  const handleTabDragOver = useCallback((paneIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    setDragOverIdx(xRatio < 0.5 ? paneIdx : paneIdx + 1);
    // Clear stale edge split zone — cursor is over a tab, not an edge
    setEdgeSplitZone(null);
    // Detect cross-group drag for indicator rendering
    if (!draggedPaneId && e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP)) {
      setCrossGroupDragActive(true);
    }
  }, [draggedPaneId]);

  const handleTabDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    if (!sourcePaneId || dragOverIdx === null) return;

    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    const isCrossGroup = sourceGroupId && groupId && sourceGroupId !== groupId;

    let didDrop = false;
    if (isCrossGroup && onCrossGroupDrop) {
      // Cross-group drop: move pane from source group to this group at insertIdx
      onCrossGroupDrop(sourcePaneId, sourceGroupId, dragOverIdx);
      didDrop = true;
    } else if (onReorderPanes) {
      // Same-group reorder
      const currentIds = panes.map(p => p.id);
      const sourceIdx = currentIds.indexOf(sourcePaneId);
      if (sourceIdx === -1) {
        setDraggedPaneId(null);
        setDragOverIdx(null);
        setEdgeSplitZone(null);
        setCrossGroupDragActive(false);
        return;
      }

      // No-op: tab dropped at its own position or immediately after itself
      if (sourceIdx === dragOverIdx || sourceIdx + 1 === dragOverIdx) {
        setDraggedPaneId(null);
        setDragOverIdx(null);
        setEdgeSplitZone(null);
        setCrossGroupDragActive(false);
        return;
      }

      const newIds = currentIds.filter(id => id !== sourcePaneId);
      let insertIdx = dragOverIdx;
      if (sourceIdx < dragOverIdx) insertIdx--;
      newIds.splice(Math.max(0, insertIdx), 0, sourcePaneId);

      onReorderPanes(newIds);
      didDrop = true;
    }

    // After a successful drop, activate the dropped pane so focus matches
    // the visual position. Two guards:
    //   1. Skip when the dropped pane is already active in THIS group — calling
    //      onActivate would re-fire FOCUS_PANE and steal focus away from a
    //      different group that currently owns the cursor (review B1).
    //   2. Cross-group drops always activate, since the pane just moved here.
    if (didDrop && onActivate) {
      const isCrossGroupDrop = !!(isCrossGroup && onCrossGroupDrop);
      if (isCrossGroupDrop || sourcePaneId !== activePaneId) {
        onActivate(sourcePaneId);
      }
    }

    setDraggedPaneId(null);
    setDragOverIdx(null);
    setEdgeSplitZone(null);
    setCrossGroupDragActive(false);
  }, [panes, dragOverIdx, onReorderPanes, onCrossGroupDrop, groupId, onActivate, activePaneId]);

  const handleTabDragEnd = useCallback(() => {
    setDraggedPaneId(null);
    setDragOverIdx(null);
    setEdgeSplitZone(null);
    setCrossGroupDragActive(false);
    if (dragGhostRef.current) {
      dragGhostRef.current.remove();
      dragGhostRef.current = null;
    }
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+1-9 is owned globally by `useKeyboardShortcuts`
  // — it walks both top-level panels AND project sub-panes so every tab gets
  // a single global slot. The local handler that used to live here was
  // removed; we keep the badges wired up so users still see ⌘N hints, but
  // the indices now reflect the global tab order, not the per-group order.
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
  const isElectron = !!(window as any).electronAPI?.isElectron;

  const hasMenuItems = onNewChat || availableTypes.length > 0;

  return (
    <div className={className ?? "flex-shrink-0 pt-1 pb-1 pl-1 pr-0 min-w-0 app-drag-region"} data-testid="panel-tab-bar" data-group-id={groupId ?? ''} style={{ position: 'relative' }}>
      {/* Scrollable tab area */}
      <div
        ref={scrollContainerRef}
        className="flex items-center gap-0.5 min-w-0 min-h-7 overflow-x-auto scrollbar-thin"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x', padding: '1px 0 1px 1px', paddingLeft: hasLeftOverlay ? 30 : 5, paddingRight: hasMenuItems ? 30 : 0 }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
          e.preventDefault();
          // Cross-group drag detection (draggedPaneId is only set for same-group drags)
          const isCrossGroupDrag = !draggedPaneId && e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP);
          if (isCrossGroupDrag) setCrossGroupDragActive(true);
          if (onEdgeSplitDrop && isCrossGroupDrag) {
            // If this group has a project pane, force split (no move-into project)
            const hasProjectPane = panes.some(p => p.type === 'project');
            if (hasProjectPane) {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const x = e.clientX - rect.left;
              setEdgeSplitZone(x < rect.width / 2 ? 'left' : 'right');
              setDragOverIdx(null);
              return;
            }
            // Non-project groups: edge-only split (EDGE_DROP_PX border zones)
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            if (x < EDGE_DROP_PX) {
              setEdgeSplitZone('left');
              setDragOverIdx(null);
              return;
            } else if (x > rect.width - EDGE_DROP_PX) {
              setEdgeSplitZone('right');
              setDragOverIdx(null);
              return;
            }
          }
          setEdgeSplitZone(null);
        }}
        onDragLeave={() => { setEdgeSplitZone(null); setCrossGroupDragActive(false); }}
        onDrop={(e) => {
          if (edgeSplitZone && onEdgeSplitDrop) {
            e.preventDefault();
            const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
            const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
            if (sourcePaneId && sourceGroupId) {
              onEdgeSplitDrop(sourcePaneId, sourceGroupId, edgeSplitZone);
            }
            setEdgeSplitZone(null);
            setDraggedPaneId(null);
            setDragOverIdx(null);
            setCrossGroupDragActive(false);
            return;
          }
          handleTabDrop(e);
        }}
      >
      {panes.map((pane, paneIdx) => {
        const config = getPaneConfig(pane.type);
        const Icon = ICONS[config.icon];
        // Only render the visual "active tab" highlight when this group
        // actually owns focus. Otherwise the local-active fallback used by
        // the content router would also paint a selected tab, producing two
        // simultaneous highlights across split groups. See `groupIsFocused`
        // prop docstring above.
        const isActive = groupIsFocused && activePaneId === pane.id;
        // Tri-state: full highlight when fully focused, dimmed-active when
        // the tab is the active one in this group but the App focus is
        // elsewhere (e.g. project sits next to a focused sibling in split
        // view), inactive otherwise.
        const isActiveDimmed = isActive && !isAppFocused;
        const label = pane.title || (pane.type === 'chat' ? 'Chat' : config.label);
        const isDragged = draggedPaneId === pane.id;
        const hasDragSource = draggedPaneId || crossGroupDragActive;
        const isNotSelf = !draggedPaneId || draggedPaneId !== pane.id;
        const showLeftIndicator = dragOverIdx === paneIdx && hasDragSource && isNotSelf;
        const showRightIndicator = paneIdx === panes.length - 1 && dragOverIdx === panes.length && hasDragSource && isNotSelf;
        const isPaneStreaming = pane.type === 'chat' && streamingPaneIds?.has(pane.id);
        const badgeCount = !isActive && tabNotifications ? (tabNotifications.get(pane.id) || 0) : 0;

        return (
          <div
            // Use stableKey so the tab DOM survives PANE_ID_REMAP (draft → real
            // topic). Otherwise React unmounts/remounts on first message
            // submission and the tab visibly flashes.
            key={pane.stableKey ?? pane.id}
            data-pane-id={pane.id}
            data-active={isActive ? 'true' : 'false'}
            style={{ width: 150, minWidth: 150, maxWidth: 150, flexShrink: 0 }}
            className={`group flex items-center gap-1.5 px-2.5 ${isTouch ? 'h-9' : 'h-7'} text-[11px] font-medium transition-all relative cursor-pointer select-none rounded-md app-no-drag ${
              isActive && !isActiveDimmed
                ? 'bg-white dark:bg-white/10 text-app-text ring-1 ring-black/[0.06] shadow-sm'
                : isActiveDimmed
                  ? 'bg-black/[0.05] dark:bg-white/[0.06] text-app-text-secondary ring-1 ring-black/[0.03]'
                  : 'text-app-text-tertiary hover:text-app-text bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
            } ${isDragged ? 'opacity-40' : ''}`}
            onClick={() => { if (longPressFiredRef.current) { longPressFiredRef.current = false; return; } onActivate(pane.id); }}
            onDoubleClick={() => { if (pane.preview && onPinPane) onPinPane(pane.id); }}
            onContextMenu={handleContextMenu(pane.id)}
            onTouchStart={(e) => handleLongPressStart(pane.id, e.currentTarget)}
            onTouchEnd={handleLongPressCancel}
            onTouchMove={handleLongPressCancel}
            draggable={!isTouch && !!onReorderPanes}
            onDragStart={handleTabDragStart(pane.id)}
            onDragOver={handleTabDragOver(paneIdx)}
            onDragEnd={handleTabDragEnd}
          >
            {showLeftIndicator && (
              <div className="absolute left-0 top-1 bottom-1 w-[2px] bg-primary rounded z-20" />
            )}
            {isActive && pane.color && (
              <div className="absolute inset-0 rounded-md pointer-events-none" style={{ backgroundColor: pane.color, opacity: 0.10 }} />
            )}
            {/* PendingAction progress fill — covers the tab background L→R
                during the 3 s soft-close countdown. Sub-component subscribes
                to the context per-pane so an unrelated pane's state changes
                don't re-render every other tab. Read-only viewer tabs don't
                participate in the countdown (mirrored in PaneCloseButton). */}
            {!READ_ONLY_PANE_TYPES.has(pane.type) && <PaneTabPendingOverlay paneId={pane.id} />}
            {pane.type === 'file' && pane.title ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">{(() => { const d = getFileIconDef(pane.title); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
            ) : pane.type === 'terminal' && pane.terminalType === 'claude-code' ? (
              <ClaudeIcon size={14} className="flex-shrink-0 text-[#D97757]" />
            ) : Icon ? (
              <Icon size={14} className="flex-shrink-0" style={pane.color ? { color: pane.color } : undefined} />
            ) : null}
            <span className={`truncate flex-1 ${pane.preview ? 'italic' : ''}`}>{label}</span>
            {pane.type === 'project' && projectStatus?.[pane.id] && (() => {
              const ps = projectStatus[pane.id];
              const showBranch = ps.gitBranch && ps.gitBranch !== 'main' && ps.gitBranch !== 'master';
              return (
                <span className="flex items-center gap-1 flex-shrink-0 text-[10px] font-medium min-w-0">
                  {showBranch && (
                    <span className="truncate max-w-[80px] text-app-text-tertiary" title={ps.gitBranch}>{ps.gitBranch}</span>
                  )}
                  {ps.gitFileCount > 0 && (
                    <span className="px-1 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 leading-none py-px">{ps.gitFileCount}</span>
                  )}
                  {(ps.gitAhead > 0 || ps.gitBehind > 0) && (
                    <span className="text-blue-500 dark:text-blue-400 leading-none whitespace-nowrap">
                      {ps.gitAhead > 0 && <>{ps.gitAhead}↑</>}
                      {ps.gitBehind > 0 && <>{ps.gitAhead > 0 ? ' ' : ''}{ps.gitBehind}↓</>}
                    </span>
                  )}
                  {ps.runningProcessCount > 0 && (
                    <span className="flex items-center gap-0.5 text-green-500 dark:text-green-400 leading-none">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                      {ps.runningProcessCount}
                    </span>
                  )}
                </span>
              );
            })()}
            {isPaneStreaming && (
              <button
                onClick={(e) => { e.stopPropagation(); onStopStreaming?.(pane.id); }}
                className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer group/stop"
                title="Stop generating"
              >
                <div className="w-3 h-3 border-[1.5px] border-primary border-t-transparent rounded-full animate-spin group-hover/stop:hidden" />
                <div className="w-[7px] h-[7px] bg-primary rounded-[1px] hidden group-hover/stop:block" />
              </button>
            )}
            {badgeCount > 0 && (
              <span className="ml-0.5 px-1 min-w-[16px] h-4 text-[10px] font-semibold bg-primary text-white rounded-full flex items-center justify-center flex-shrink-0 leading-none">
                {badgeCount > 99 ? '99+' : badgeCount}
              </span>
            )}
            <PaneCloseButton
              paneId={pane.id}
              paneType={pane.type}
              onClose={onClose}
              isElectron={isElectron}
              isTouch={isTouch}
              isAppFocused={isAppFocused}
              isMac={isMac}
            />
            {showRightIndicator && (
              <div className="absolute right-0 top-1 bottom-1 w-[2px] bg-primary rounded z-20" />
            )}
          </div>
        );
      })}
      </div>

      {/* Edge split indicator overlay */}
      {edgeSplitZone && (
        <div
          className="absolute pointer-events-none z-30"
          style={{
            top: 0,
            bottom: 0,
            left: edgeSplitZone === 'left' ? 0 : '50%',
            right: edgeSplitZone === 'right' ? 0 : '50%',
            background: 'color-mix(in srgb, var(--primary) 15%, transparent)',
            border: '2px dashed var(--primary)',
            borderRadius: '4px',
          }}
        />
      )}

      {/* Add pane button — floating at the right edge with fade mask */}
      {hasMenuItems && (
        <div
          className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pr-1"
          ref={menuRef}
        >
          <button
            ref={buttonRef}
            onClick={async () => {
              // Phase 30.1 polish — when Electron's native browser is in use,
              // the WebContentsView is OS-level and covers any DOM portal.
              // Use the transparent overlay BrowserWindow API instead so the
              // menu appears ABOVE the WebContentsView. Web mode (no
              // electronAPI.overlay) falls through to the existing portal.
              const overlayApi = window.electronAPI?.overlay;
              const hasNativeBrowser = !!window.electronAPI?.browserNative?.isAvailable;
              if (overlayApi && hasNativeBrowser && buttonRef.current && !showAddMenu) {
                const rect = buttonRef.current.getBoundingClientRect();
                const items: Array<{ id: string; label: string; iconName?: 'globe' | 'terminal' | 'message-square' | 'folder' | 'bot' | 'file-text' | 'layout' | 'list' | 'plus-square'; divider?: boolean }> = [];
                if (onNewChat) {
                  items.push({ id: 'new-chat', label: 'New Chat', iconName: 'message-square' });
                }
                for (const type of availableTypes) {
                  if (type === 'terminal') {
                    items.push({ id: 'terminal-shell', label: 'Shell', iconName: 'terminal', divider: items.length > 0 });
                    items.push({ id: 'terminal-claude-code', label: 'Claude Code', iconName: 'bot' });
                  } else {
                    const cfg = getPaneConfig(type);
                    // Map lucide icon name → overlay icon keyword (subset).
                    const iconMap: Record<string, 'globe' | 'terminal' | 'message-square' | 'folder' | 'bot' | 'file-text' | 'layout' | 'list' | 'plus-square'> = {
                      Globe: 'globe',
                      Terminal: 'terminal',
                      TerminalSquare: 'terminal',
                      MessageSquare: 'message-square',
                      Folder: 'folder',
                      FolderOpen: 'folder',
                      Bot: 'bot',
                      FileText: 'file-text',
                      Layout: 'layout',
                      List: 'list',
                    };
                    const iconName = iconMap[cfg.icon] ?? 'plus-square';
                    items.push({ id: type, label: cfg.label, iconName, divider: type !== availableTypes[0] && availableTypes[0] !== 'terminal' });
                  }
                }
                const isDark = document.documentElement.classList.contains('dark');
                const selectedId = await overlayApi.showMenu({
                  anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                  items,
                  side: 'bottom',
                  theme: isDark ? 'dark' : 'light',
                  estimatedWidth: 180,
                  estimatedItemHeight: 28,
                });
                if (!selectedId) return;
                if (selectedId === 'new-chat') {
                  onNewChat?.();
                } else if (selectedId === 'terminal-shell') {
                  onAddPane('terminal', 'shell');
                } else if (selectedId === 'terminal-claude-code') {
                  onAddPane('terminal', 'claude-code');
                } else {
                  onAddPane(selectedId as PaneType);
                }
                return;
              }
              // Web mode (or no native browser active) — original portal logic.
              if (!showAddMenu && buttonRef.current) {
                const rect = buttonRef.current.getBoundingClientRect();
                const menuWidth = 160;
                const menuHeight = 200;
                const left = Math.min(rect.left, window.innerWidth - menuWidth - 8);
                // Flip menu above button if it would overflow the viewport bottom
                const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight - 8;
                const top = fitsBelow
                  ? rect.bottom + 4
                  : Math.max(8, rect.top - menuHeight - 4);
                setMenuPos({ top, left: Math.max(8, left) });
              }
              setShowAddMenu(!showAddMenu);
            }}
            className="w-6 h-6 flex items-center justify-center rounded-md bg-surface hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors"
            title="Add pane"
          >
            <Plus size={14} />
          </button>
        </div>
      )}

      {/* Add pane dropdown menu — portaled to avoid overflow clipping */}
      {hasMenuItems && showAddMenu && (isMobile || menuPos) && createPortal(
        <>
          {isMobile && <div className="fixed inset-0 z-[9998]" onClick={() => setShowAddMenu(false)} />}
          <div
            ref={menuContentRef}
            className={isMobile
              ? 'fixed bottom-0 left-0 right-0 bg-surface border-t border-app-border rounded-t-xl shadow-lg py-2 z-[9999] bottom-sheet'
              : 'fixed bg-surface border border-app-border rounded-lg shadow-lg py-1 z-[9999] min-w-[140px]'}
            style={!isMobile ? { top: menuPos!.top, left: menuPos!.left } : { paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' }}
          >
            {onNewChat && (
              <button
                onClick={() => { onNewChat(); setShowAddMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
              >
                <MessageSquare size={14} />
                <span className="flex-1 text-left">New Chat</span>
                {isElectron && <kbd className="kbd text-app-text-muted">{isMac ? '⌘' : '⌃'}N</kbd>}
              </button>
            )}
            {availableTypes.map(type => {
              if (type === 'terminal') {
                return (
                  <div key={type}>
                    <button
                      onClick={() => { onAddPane('terminal', 'shell'); setShowAddMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    >
                      <TerminalSquare size={14} />
                      <span>Shell</span>
                    </button>
                    <button
                      onClick={() => { onAddPane('terminal', 'claude-code'); setShowAddMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    >
                      <ClaudeIcon size={14} className="text-[#D97757]" />
                      <span className="flex-1 text-left">Claude Code</span>
                      <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
                        <span>yolo</span>
                      </label>
                    </button>
                  </div>
                );
              }
              const config = getPaneConfig(type);
              const Icon = ICONS[config.icon];
              return (
                <button
                  key={type}
                  onClick={() => { onAddPane(type); setShowAddMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                >
                  {Icon && <Icon size={14} />}
                  <span>{config.label}</span>
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}

      {/* Right-click context menu — portaled so position:fixed escapes transformed ancestors */}
      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          className="fixed bg-surface border border-app-border rounded-lg shadow-xl py-1 z-[9999] min-w-[150px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          {/* Right-click "Close" is the explicit-confirmation path — bypass
              the PendingAction countdown that gates the default X button.
              Falls back to onClose for legacy callers that don't pass
              onCloseImmediate. */}
          <button
            onClick={() => {
              (onCloseImmediate ?? onClose)(ctxMenu.paneId);
              setCtxMenu(null);
            }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <X size={14} />
            <span className="flex-1 text-left">Close now</span>
            {isElectron && <kbd className="kbd text-app-text-muted">{isMac ? '⌘' : '⌃'}W</kbd>}
          </button>
          <button
            onClick={() => { onClose(ctxMenu.paneId); setCtxMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            title="Queues a 3-second confirmation toast"
          >
            <X size={14} />
            <span className="flex-1 text-left">Close (with countdown)</span>
          </button>
          {panes.length > 1 && (
            <button
              onClick={() => {
                if (onCloseOthers) {
                  onCloseOthers(ctxMenu.paneId);
                } else {
                  // Fallback: close all except the targeted pane
                  panes.forEach(p => { if (p.id !== ctxMenu.paneId) onClose(p.id); });
                }
                setCtxMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <X size={14} />
              <span>Close Others</span>
            </button>
          )}
          {(onSplitRight || onSplitDown) && (
            <>
              <div className="h-px bg-app-border my-1" />
              {onSplitRight && (
                <button
                  onClick={() => { onSplitRight(ctxMenu.paneId); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                >
                  <Columns2 size={14} />
                  <span>Split Right</span>
                </button>
              )}
              {onSplitDown && (
                <button
                  onClick={() => { onSplitDown(ctxMenu.paneId); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                >
                  <Rows2 size={14} />
                  <span>Split Down</span>
                </button>
              )}
            </>
          )}
          {onDetach && (
            <>
              <div className="h-px bg-app-border my-1" />
              <button
                onClick={() => { onDetach(ctxMenu.paneId); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
              >
                <ExternalLink size={14} />
                <span>Detach</span>
              </button>
            </>
          )}
          {onRename && (
            <button
              onClick={() => { onRename(ctxMenu.paneId); setCtxMenu(null); }}
              className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <Edit3 size={14} />
              <span>Rename</span>
            </button>
          )}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            const isChat = ctxPane?.type === 'chat';
            const showSettings = isChat && onSettings;
            const showPopOut = isChat && onPopOut;
            if (!showSettings && !showPopOut) return null;
            return (
              <>
                <div className="h-px bg-app-border my-1" />
                {showSettings && (
                  <button
                    onClick={() => { onSettings!(ctxMenu!.paneId); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    <Settings size={14} />
                    <span>Settings</span>
                  </button>
                )}
                {showPopOut && (
                  <button
                    onClick={() => { onPopOut!(ctxMenu!.paneId); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    <ExternalLink size={14} />
                    <span>Pop Out</span>
                  </button>
                )}
              </>
            );
          })()}
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * Per-tab close button. Shows the global ⌘N badge (sourced from
 * GlobalTabIndexContext) when idle and an X on hover. Pulled out of the main
 * render loop so each tab can call `useGlobalTabIndex` — calling hooks inside
 * `panes.map(...)` is forbidden.
 */
function PaneCloseButton({
  paneId, paneType, onClose, isElectron, isTouch, isAppFocused, isMac,
}: {
  paneId: string;
  paneType: PaneType;
  onClose: (id: string) => void;
  isElectron: boolean;
  isTouch: boolean;
  isAppFocused: boolean;
  isMac: boolean;
}) {
  const globalIdx = useGlobalTabIndex(paneId);
  const showBadge = isElectron && !isTouch && isAppFocused && globalIdx >= 0 && globalIdx < 9;
  const isReadOnly = READ_ONLY_PANE_TYPES.has(paneType);
  // Read-only tabs short-circuit to the legacy X immediately. They never
  // appear in PendingActionContext because the App-level deferred wrappers
  // only get called from the inline check button, and read-only tabs use
  // this raw `onClose` path — closing them is fully reversible via the
  // Cmd+Shift+T closed-stack, no countdown needed.
  const pendingStatus = usePendingActionStatus(isReadOnly ? null : `close-tab:${paneId}`);

  // While pending, the slot is the filled check (cancels on click).
  if (pendingStatus) {
    return (
      <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 relative z-10">
        <PendingActionRing
          status={pendingStatus}
          size={14}
          pendingTitle="Annulla chiusura"
          pendingAriaLabel="Annulla chiusura"
        />
      </span>
    );
  }

  if (isReadOnly) {
    // Classic X (no countdown) for read-only viewers.
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClose(paneId); }}
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted hover:text-app-text transition-all flex-shrink-0"
        title="Close"
        aria-label={`Close ${paneId}`}
      >
        {showBadge ? (
          <>
            <kbd className="kbd text-app-text-muted/50 group-hover:hidden">{isMac ? '⌘' : '⌃'}{globalIdx + 1}</kbd>
            <X size={12} className="hidden group-hover:block" />
          </>
        ) : (
          <X size={12} className={isTouch ? '' : 'opacity-0 group-hover:opacity-100'} />
        )}
      </button>
    );
  }

  // Idle, soft-destructive: empty "todo" circle on hover. Click triggers
  // the deferred close (auto-tick → 3 s countdown).
  return (
    <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 relative z-10">
      {showBadge ? (
        <kbd className="kbd text-app-text-muted/50 group-hover:hidden">
          {isMac ? '⌘' : '⌃'}{globalIdx + 1}
        </kbd>
      ) : null}
      <span className={`absolute inset-0 flex items-center justify-center ${
        showBadge ? 'opacity-0 group-hover:opacity-100' : (isTouch ? '' : 'opacity-0 group-hover:opacity-100')
      } transition-opacity`}>
        <PendingActionRing
          status={null}
          size={14}
          onIdleClick={() => onClose(paneId)}
          idleTitle="Chiudi tab"
          idleAriaLabel={`Chiudi tab ${paneId}`}
        />
      </span>
    </span>
  );
}

/**
 * Sub-component co-located in this file because it needs to live as a
 * direct child of the per-pane `<button>` (so the absolute overlay covers
 * just that tab) and needs its own subscription to PendingActionContext
 * keyed by paneId. Module scope keeps the hook out of the parent's
 * `panes.map(...)` loop.
 */
function PaneTabPendingOverlay({ paneId }: { paneId: string }) {
  const status = usePendingActionStatus(`close-tab:${paneId}`);
  if (!status) return null;
  return <PendingActionProgressOverlay status={status} className="rounded-md" />;
}
