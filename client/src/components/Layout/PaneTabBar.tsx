import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, ExternalLink, Edit3, Settings, BarChart3, Kanban, Columns2, Rows2 } from 'lucide-react';
import { usePanePendingStatus } from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import { PaneAddMenu } from '../Shared/PaneAddMenu';
import type { Pane, PaneType, PaneGroupType } from '../../types';
import { getPaneConfig, getTerminalSessionFromPaneId, type ProjectTabStatus } from '../../state/pane/adapters';
import { signalsActions } from '../../state/signals';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { getFileIconDef } from '../../lib/fileIcons';
import { DND_TYPES, paneTabScopeType, dragMatchesScope } from '../../lib/dndTypes';
import { EDGE_DROP_PX } from './constants';
import { useMobile, haptic } from '../../hooks/useMobile';
import { useGlobalTabIndex } from '../../contexts/GlobalTabIndexContext';
import { TopicClaudePhaseIndicator, ProjectClaudePhaseIndicator } from './ClaudePhaseDot';
import { TopicStreamingSpinner, ProjectStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner, AgentStreamingSpinner } from './StreamingIndicator';
import { NotificationBadge } from '../Shared/NotificationBadge';

// Every pane type closes through the same soft-confirm path: hovering the X
// reveals an empty "mark as done" circle, clicking it starts the 3 s L→R
// progress fill, and a re-click cancels. There used to be a READ_ONLY_PANE_TYPES
// exception (file / session-viewer / process-log) that swapped in a classic X
// with no feedback — but the wired onClose (handleClosePane) defers those
// closes anyway, so the exception just hid the countdown that was already
// running. Closing is reversible via Cmd+Shift+T regardless, so a single
// uniform affordance is both cleaner and less surprising.

const ICONS: Record<string, React.FC<{ size: number; className?: string; style?: React.CSSProperties }>> = {
  MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, BarChart3, Kanban,
};

// Tab-bar Claude indicators live in ClaudePhaseDot.tsx (TopicClaudePhaseIndicator
// for chat tabs, ProjectClaudePhaseIndicator for project tabs). Don't roll
// your own here — single source of truth so sidebar + tabs report identically.

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
  /**
   * Drag scope — the window/project this tab bar belongs to. Tab drags only
   * reorder/move within the same scope: "main" for the top-level standalone
   * (and solo) groups, the projectPath for a project's groups. A drag from a
   * different scope shows no drop indicators here and is ignored on drop, so a
   * main tab can only land in main and a project tab only within that project.
   * Undefined keeps the legacy unrestricted behavior (no scope enforcement).
   */
  dndScope?: string;
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

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onCloseImmediate, onAddPane, availableTypes, groupType: _groupType, groupId, onNewChat, onReorderPanes, onCrossGroupDrop, onEdgeSplitDrop, dndScope, className, contextPercent: _contextPercent, onContextRingClick: _onContextRingClick, onCloseOthers, onDetach, onSplitRight, onSplitDown, onRename, onSettings, onPopOut, onStopStreaming, onPinPane, projectStatus, tabNotifications, hasLeftOverlay, groupIsFocused = true, groupIsAppFocused }: PaneTabBarProps) {
  // Default groupIsAppFocused to groupIsFocused so non-project callers
  // (StandaloneChatGroup) keep the existing two-state behavior.
  const isAppFocused = groupIsAppFocused ?? groupIsFocused;
  // Add-pane menu (button + portal + items + Electron overlay path) is
  // entirely owned by <PaneAddMenu>. PaneTabBar used to inline the
  // button + click handler + portal + outside-click effect — all of that
  // moved into the shared component so the sidebar's "+" button and this
  // one are byte-identical.
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [edgeSplitZone, setEdgeSplitZone] = useState<'left' | 'right' | null>(null);
  const [crossGroupDragActive, setCrossGroupDragActive] = useState(false);
  // Mirror the hovered insert position into a ref so the drop handler reads the
  // latest value even when `drop` fires in the same frame as the final
  // `dragover` (React state may not have committed yet — the "drop lands
  // nowhere / needs a second try" bug, same fix GroupLayout/PanelGrid use).
  const dragOverIdxRef = useRef<number | null>(null);

  const { isTouch } = useMobile();

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ paneId: string; x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

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
    // Tag the drag with this tab bar's scope so only same-scope drop targets
    // (this window / this project) accept it. Encoded as a type (readable in
    // dragover) AND a value (readable on drop) — see lib/dndTypes.
    if (dndScope) {
      e.dataTransfer.setData(paneTabScopeType(dndScope), '1');
      e.dataTransfer.setData(DND_TYPES.PANE_TAB_SCOPE, dndScope);
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
  }, [onReorderPanes, groupId, panes, dndScope]);

  const handleTabDragOver = useCallback((paneIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Scope guard: a tab from another window/project must not paint insert
    // indicators here — we'd only reject it on drop. (No preventDefault, so the
    // browser shows "no-drop" and the foreign tab bar stays inert.)
    if (!dragMatchesScope(e.dataTransfer.types, dndScope)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const idx = xRatio < 0.5 ? paneIdx : paneIdx + 1;
    dragOverIdxRef.current = idx;
    setDragOverIdx(idx);
    // Clear stale edge split zone — cursor is over a tab, not an edge
    setEdgeSplitZone(null);
    // Detect cross-group drag for indicator rendering
    if (!draggedPaneId && e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP)) {
      setCrossGroupDragActive(true);
    }
  }, [draggedPaneId, dndScope]);

  // Single reset for every drag-end path (successful drop, cancel, foreign
  // drag, and the window-level `dragend` below). Clears both the state and the
  // ref mirror so no insert indicator or stale index survives the gesture.
  const resetDrag = useCallback(() => {
    dragOverIdxRef.current = null;
    setDraggedPaneId(null);
    setDragOverIdx(null);
    setEdgeSplitZone(null);
    setCrossGroupDragActive(false);
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    // Read the insert position from the ref (state may lag a frame behind the
    // final dragover, which silently dropped the tab nowhere before).
    const overIdx = dragOverIdxRef.current;
    if (!sourcePaneId || overIdx === null) { resetDrag(); return; }

    // Scope guard: reject a tab dragged in from another window/project. Belt to
    // the dragover suspenders — getData is only readable here, on drop.
    const sourceScope = e.dataTransfer.getData(DND_TYPES.PANE_TAB_SCOPE);
    if (dndScope && sourceScope && sourceScope !== dndScope) { resetDrag(); return; }

    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    const isCrossGroup = sourceGroupId && groupId && sourceGroupId !== groupId;

    let didDrop = false;
    if (isCrossGroup && onCrossGroupDrop) {
      // Cross-group drop: move pane from source group to this group at insertIdx
      onCrossGroupDrop(sourcePaneId, sourceGroupId, overIdx);
      didDrop = true;
    } else if (onReorderPanes) {
      // Same-group reorder
      const currentIds = panes.map(p => p.id);
      const sourceIdx = currentIds.indexOf(sourcePaneId);
      if (sourceIdx === -1) { resetDrag(); return; }

      // No-op: tab dropped at its own position or immediately after itself
      if (sourceIdx === overIdx || sourceIdx + 1 === overIdx) { resetDrag(); return; }

      const newIds = currentIds.filter(id => id !== sourcePaneId);
      let insertIdx = overIdx;
      if (sourceIdx < overIdx) insertIdx--;
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

    resetDrag();
  }, [panes, onReorderPanes, onCrossGroupDrop, groupId, onActivate, activePaneId, dndScope, resetDrag]);

  const handleTabDragEnd = useCallback(() => {
    resetDrag();
    if (dragGhostRef.current) {
      dragGhostRef.current.remove();
      dragGhostRef.current = null;
    }
  }, [resetDrag]);

  // Belt-and-suspenders cleanup: a TARGET group never receives `onDragEnd`
  // (that only fires on the source element), so a cross-group drag that ended
  // without a clean `dragleave` here (escape-cancel, drop elsewhere, a flaky
  // boundary) used to leave this bar's insert indicators painted. `dragend`
  // bubbles to the window for EVERY drag, so one window listener resets every
  // mounted tab bar — source and target alike.
  useEffect(() => {
    const onWindowDragEnd = () => resetDrag();
    window.addEventListener('dragend', onWindowDragEnd);
    return () => window.removeEventListener('dragend', onWindowDragEnd);
  }, [resetDrag]);

  // Keyboard shortcut: Cmd/Ctrl+1-9 is owned globally by `useKeyboardShortcuts`
  // — it walks both top-level panels AND project sub-panes so every tab gets
  // a single global slot. The local handler that used to live here was
  // removed; we keep the badges wired up so users still see ⌘N hints, but
  // the indices now reflect the global tab order, not the per-group order.
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
  // `window.electronAPI` is typed in client/src/types/electron.d.ts.
  const isElectron = !!window.electronAPI?.isElectron;

  const hasMenuItems = onNewChat || availableTypes.length > 0;

  return (
    <div className={className ?? "flex-shrink-0 pt-1 pb-1 pl-1 pr-0 min-w-0 app-drag-region"} data-testid="panel-tab-bar" data-group-id={groupId ?? ''} style={{ position: 'relative' }}>
      {/* Scrollable tab area */}
      <div
        ref={scrollContainerRef}
        className="flex items-center gap-0.5 min-w-0 min-h-7 overflow-x-auto scrollbar-topbar"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x', padding: '1px 0 1px 1px', paddingLeft: hasLeftOverlay ? 30 : 5, paddingRight: hasMenuItems ? 30 : 0 }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
          // Scope guard: ignore drags from another window/project entirely (no
          // edge-split overlay, no preventDefault → browser shows "no drop").
          if (!dragMatchesScope(e.dataTransfer.types, dndScope)) return;
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
        // Streaming spinner: chat panes pulse during an LLM stream;
        // Loading affordance is owned by the canonical widgets below —
        // each reads from StreamingContext, no upstream prop needed.
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
            // overflow-hidden clips a tab whose trailing widgets (project git
            // status + spinner + notification badge + close) would otherwise
            // sum past the fixed 150px and spill into the next tab. The label
            // already truncates; this guarantees the rest can't escape either.
            className={`group flex items-center gap-1.5 px-2.5 ${isTouch ? 'h-9' : 'h-7'} text-[11px] font-medium transition-all relative cursor-pointer select-none rounded-md overflow-hidden app-no-drag ${
              isActive && !isActiveDimmed
                ? 'bg-white dark:bg-white/10 text-app-text ring-1 ring-black/[0.06] shadow-sm'
                : isActiveDimmed
                  ? 'bg-black/[0.05] dark:bg-white/[0.06] text-app-text-secondary ring-1 ring-black/[0.03]'
                  : 'text-app-text-tertiary hover:text-app-text bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
            } ${isDragged ? 'opacity-40' : ''}`}
            onClick={() => { if (longPressFiredRef.current) { longPressFiredRef.current = false; return; } if (pane.type === 'terminal') { const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id); if (sid) signalsActions.clearTerminalFinished(sid); } onActivate(pane.id); }}
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
                don't re-render every other tab. It self-guards on a null
                pending status, so it's safe to mount for every pane type. */}
            <PaneTabPendingOverlay paneId={pane.id} />
            {pane.type === 'file' && pane.title ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">{(() => { const d = getFileIconDef(pane.title); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
            ) : pane.type === 'terminal' && pane.terminalType === 'claude-code' ? (
              <ClaudeIcon size={14} className="flex-shrink-0 text-[#D97757]" />
            ) : Icon ? (
              <Icon size={14} className="flex-shrink-0" style={pane.color ? { color: pane.color } : undefined} />
            ) : null}
            <span className={`truncate flex-1 ${pane.preview ? 'italic' : ''}`}>{label}</span>
            {/* Claude Code session phase indicator — runs/tools/approvals.
                Only chat panes have a tracked Claude session (terminal
                claude-code panes have a different sessionKey shape that the
                tracker doesn't index by topicId yet). */}
            {pane.type === 'chat' && pane.topicId && <TopicClaudePhaseIndicator topicId={pane.topicId} />}
            {/* Project pane: aggregate phase across every chat inside the
                project so the user sees "a Claude is running here" without
                drilling in. */}
            {pane.type === 'project' && pane.projectPath && <ProjectClaudePhaseIndicator projectPath={pane.projectPath} />}
            {pane.type === 'project' && projectStatus?.[pane.id] && (() => {
              const ps = projectStatus[pane.id];
              const showBranch = ps.gitBranch && ps.gitBranch !== 'main' && ps.gitBranch !== 'master';
              return (
                <span className="flex items-center gap-1 min-w-0 overflow-hidden text-[10px] font-medium">
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
            {/* Loading spinner — one canonical widget per pane kind.
                All three read from StreamingContext; rendering only when
                the corresponding signal is on. Chat is interruptible
                (onStop wired), project + terminal are read-only. */}
            {pane.type === 'chat' && pane.topicId && (
              <TopicStreamingSpinner
                topicId={pane.topicId}
                onStop={onStopStreaming ? () => onStopStreaming(pane.id) : undefined}
              />
            )}
            {pane.type === 'project' && pane.projectPath && (
              <ProjectStreamingSpinner projectPath={pane.projectPath} />
            )}
            {pane.type === 'terminal' && (() => {
              // Terminal panes are created at several sites that don't set
              // terminalSessionId; derive it from the pane id (`terminal:<id>`)
              // so the tab's own spinner isn't gated out. Mirrors the rollup
              // in ProjectWindow + useProjectLayout's terminal sync.
              const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id);
              return sid ? <TerminalStreamingSpinner sessionId={sid} /> : null;
            })()}
            {pane.type === 'browser' && <BrowserStreamingSpinner paneId={pane.id} />}
            {pane.type === 'agents' && <AgentStreamingSpinner />}
            <NotificationBadge count={badgeCount} className="ml-0.5" />
            <PaneCloseButton
              paneId={pane.id}
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

      {/* Add-pane affordance — single canonical component. Owns the
          trigger button, the click handler (web portal AND Electron
          native overlay), the items, and the mobile bottom-sheet. The
          sidebar's project-header "+" renders the SAME component with
          different `availableTypes` and a hover-revealed trigger. */}
      {hasMenuItems && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pr-1">
          <PaneAddMenu
            onNewChat={onNewChat}
            onAddPane={onAddPane}
            availableTypes={availableTypes}
            // Cmd/Ctrl+N targets the focused group's New Chat — true here.
            showShortcuts
            noElectronDrag
          />
        </div>
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
  paneId, onClose, isElectron, isTouch, isAppFocused, isMac,
}: {
  paneId: string;
  onClose: (id: string) => void;
  isElectron: boolean;
  isTouch: boolean;
  isAppFocused: boolean;
  isMac: boolean;
}) {
  const globalIdx = useGlobalTabIndex(paneId);
  const showBadge = isElectron && !isTouch && isAppFocused && globalIdx >= 0 && globalIdx < 9;
  // v3 sidebar↔topbar sync: usePanePendingStatus also picks up the
  // sidebar-side keys (`archive-topic:<id>` for chat panes,
  // `close-terminal:<id>` / `close-browser:<id>`) so the topbar tab shows
  // the same countdown regardless of which surface kicked it off.
  const pendingStatus = usePanePendingStatus(paneId);

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
  // v3 sidebar↔topbar sync: the overlay paints the per-pane countdown
  // regardless of whether the close was initiated from the topbar (X)
  // or from the sidebar (archive icon / close-terminal / close-browser).
  const status = usePanePendingStatus(paneId);
  if (!status) return null;
  return <PendingActionProgressOverlay status={status} className="rounded-md" />;
}
