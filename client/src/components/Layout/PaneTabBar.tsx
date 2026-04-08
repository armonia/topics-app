import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, ExternalLink, Edit3, Settings, BarChart3, Kanban, TerminalSquare, Columns2, Rows2 } from 'lucide-react';
import type { Pane, PaneType, PaneGroupType } from '../../types';
import type { ProjectTabStatus } from '../../hooks/useProjectTabStatus';
import { PANE_CONFIG } from '../../lib/paneConfig';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { getFileIconDef } from '../../lib/fileIcons';
import { DND_TYPES } from '../../lib/dndTypes';
import { useMobile, haptic } from '../../hooks/useMobile';

const ICONS: Record<string, React.FC<{ size: number; className?: string; style?: React.CSSProperties }>> = {
  MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, BarChart3, Kanban,
};

interface PaneTabBarProps {
  panes: Pane[];
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  onClose: (paneId: string) => void;
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
  /** Reserve left padding for a floating sidebar toggle overlay */
  hasLeftOverlay?: boolean;
}

// Mini context ring SVG for chat tabs
function ContextRing({ percent, onClick }: { percent: number; onClick?: () => void }) {
  const r = 5;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const isCritical = percent > 90;
  const isWarning = percent > 70;
  const color = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : '#3b82f6';
  const bgColor = isCritical ? 'rgba(239,68,68,0.2)' : isWarning ? 'rgba(245,158,11,0.2)' : 'rgba(59,130,246,0.2)';

  return (
    <svg
      width="14" height="14" className={`flex-shrink-0 ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      viewBox="0 0 14 14"
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      aria-label="Context Inspector"
      data-testid="context-ring"
    >
      <circle cx="7" cy="7" r={r} fill="none" stroke={bgColor} strokeWidth="2" />
      <circle
        cx="7" cy="7" r={r} fill="none"
        stroke={color} strokeWidth="2" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={offset}
        transform="rotate(-90 7 7)"
        className="transition-all duration-300"
      />
    </svg>
  );
}

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onAddPane, availableTypes, groupType: _groupType, groupId, onNewChat, onReorderPanes, onCrossGroupDrop, onEdgeSplitDrop, className, contextPercent, onContextRingClick, onCloseOthers, onDetach, onSplitRight, onSplitDown, onRename, onSettings, onPopOut, streamingPaneIds, onStopStreaming, onPinPane, projectStatus, hasLeftOverlay }: PaneTabBarProps) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuContentRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [edgeSplitZone, setEdgeSplitZone] = useState<'left' | 'right' | null>(null);
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

  const handleLongPressStart = useCallback((paneId: string, x: number, y: number) => {
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      haptic('medium');
      longPressFiredRef.current = true;
      const menuWidth = 160;
      const menuHeight = 240;
      const adjX = Math.min(x, window.innerWidth - menuWidth - 8);
      const adjY = Math.min(y, window.innerHeight - menuHeight - 8);
      setCtxMenu({ paneId, x: adjX, y: adjY });
      longPressTimerRef.current = null;
    }, 500);
  }, []);

  const handleLongPressCancel = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleContextMenu = useCallback((paneId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Position menu with edge detection
    const menuWidth = 160;
    const menuHeight = 240;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setCtxMenu({ paneId, x: Math.max(8, x), y: Math.max(8, y) });
  }, []);

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
    // Chat panes use topicId; project panes use paneId (project:path).
    // Terminal/browser/utility panes don't set PANEL_ID — they can't be split to solo.
    // Top-level groups: "standalone", solo groups ("solo:xxx"), or no groupId.
    const isTopLevel = !groupId || groupId === 'standalone' || groupId.startsWith('solo:');
    if (isTopLevel) {
      const pane = panes.find(p => p.id === paneId);
      if (pane?.type === 'chat' && pane?.topicId) {
        e.dataTransfer.setData(DND_TYPES.PANEL_ID, pane.topicId!);
      } else if (pane?.type === 'project') {
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
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    if (!sourcePaneId || dragOverIdx === null) return;

    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    const isCrossGroup = sourceGroupId && groupId && sourceGroupId !== groupId;

    if (isCrossGroup && onCrossGroupDrop) {
      // Cross-group drop: move pane from source group to this group at insertIdx
      onCrossGroupDrop(sourcePaneId, sourceGroupId, dragOverIdx);
    } else if (onReorderPanes) {
      // Same-group reorder
      const currentIds = panes.map(p => p.id);
      const sourceIdx = currentIds.indexOf(sourcePaneId);
      if (sourceIdx === -1) return;

      // No-op: tab dropped at its own position or immediately after itself
      if (sourceIdx === dragOverIdx || sourceIdx + 1 === dragOverIdx) return;

      const newIds = currentIds.filter(id => id !== sourcePaneId);
      let insertIdx = dragOverIdx;
      if (sourceIdx < dragOverIdx) insertIdx--;
      newIds.splice(Math.max(0, insertIdx), 0, sourcePaneId);

      onReorderPanes(newIds);
    }

    setDraggedPaneId(null);
    setDragOverIdx(null);
  }, [panes, dragOverIdx, onReorderPanes, onCrossGroupDrop, groupId]);

  const handleTabDragEnd = useCallback(() => {
    setDraggedPaneId(null);
    setDragOverIdx(null);
    setEdgeSplitZone(null);
    if (dragGhostRef.current) {
      dragGhostRef.current.remove();
      dragGhostRef.current = null;
    }
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+1-9 to select tabs
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
  const isElectron = !!(window as any).electronAPI?.isElectron;

  useEffect(() => {
    if (!isElectron || !panes.length) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9) {
        const idx = n - 1;
        if (idx < panes.length) {
          e.preventDefault();
          onActivate(panes[idx].id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [panes, onActivate, isElectron]);

  const hasMenuItems = onNewChat || availableTypes.length > 0;

  return (
    <div className={className ?? "flex-shrink-0 pt-1 pb-1 pl-1 pr-0 min-w-0 app-drag-region"} data-testid="panel-tab-bar" style={{ position: 'relative' }}>
      {/* Scrollable tab area */}
      <div
        ref={scrollContainerRef}
        className="flex items-center gap-0.5 min-w-0 min-h-7 overflow-x-auto scrollbar-thin"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x', padding: '1px 0 1px 1px', paddingLeft: hasLeftOverlay ? 30 : 1, paddingRight: hasMenuItems ? 30 : 0 }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
          e.preventDefault();
          // Cross-group drag detection (draggedPaneId is only set for same-group drags)
          const isCrossGroupDrag = !draggedPaneId && e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP);
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
            // Non-project groups: edge-only split (30px border zones)
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const edgeSize = 30;
            if (x < edgeSize) {
              setEdgeSplitZone('left');
              setDragOverIdx(null);
              return;
            } else if (x > rect.width - edgeSize) {
              setEdgeSplitZone('right');
              setDragOverIdx(null);
              return;
            }
          }
          setEdgeSplitZone(null);
        }}
        onDragLeave={() => setEdgeSplitZone(null)}
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
            return;
          }
          handleTabDrop(e);
        }}
      >
      {panes.map((pane, paneIdx) => {
        const config = PANE_CONFIG[pane.type] || PANE_CONFIG['chat'];
        const Icon = ICONS[config.icon];
        const isActive = activePaneId === pane.id;
        const label = pane.title || (pane.type === 'chat' ? 'Chat' : config.label);
        const isDragged = draggedPaneId === pane.id;
        const showLeftIndicator = dragOverIdx === paneIdx && draggedPaneId && draggedPaneId !== pane.id;
        const showRightIndicator = paneIdx === panes.length - 1 && dragOverIdx === panes.length && draggedPaneId && draggedPaneId !== pane.id;
        const paneContextPercent = pane.type === 'chat' && contextPercent ? contextPercent[pane.id] : undefined;
        const isPaneStreaming = pane.type === 'chat' && streamingPaneIds?.has(pane.id);

        return (
          <div
            key={pane.id}
            data-pane-id={pane.id}
            style={{ width: 150, minWidth: 150, maxWidth: 150, flexShrink: 0 }}
            className={`group flex items-center gap-1.5 px-2.5 ${isTouch ? 'h-9' : 'h-7'} text-[11px] font-medium transition-all relative cursor-pointer select-none rounded-md app-no-drag ${
              isActive
                ? 'bg-white dark:bg-white/10 text-app-text ring-1 ring-black/[0.06] shadow-sm'
                : 'text-app-text-tertiary hover:text-app-text bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
            } ${isDragged ? 'opacity-40' : ''}`}
            onClick={() => { if (longPressFiredRef.current) { longPressFiredRef.current = false; return; } onActivate(pane.id); }}
            onDoubleClick={() => { if (pane.preview && onPinPane) onPinPane(pane.id); }}
            onContextMenu={handleContextMenu(pane.id)}
            onTouchStart={(e) => handleLongPressStart(pane.id, e.touches[0].clientX, e.touches[0].clientY)}
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
            {pane.type === 'file' && pane.title ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">{(() => { const d = getFileIconDef(pane.title); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
            ) : pane.type === 'terminal' && pane.terminalType === 'claude-code' ? (
              <ClaudeIcon size={14} className="flex-shrink-0 text-[#D97757]" />
            ) : Icon ? (
              <Icon size={14} className="flex-shrink-0" style={pane.color ? { color: pane.color } : undefined} />
            ) : null}
            {pane.type === 'chat' && contextPercent && (
              <ContextRing percent={paneContextPercent ?? 0} onClick={onContextRingClick ? () => onContextRingClick(pane.id) : undefined} />
            )}
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
            <button
              onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
              className={`${'w-5 h-5'} flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted hover:text-app-text transition-all flex-shrink-0`}
            >
              {isElectron && !isTouch && paneIdx < 9 ? (
                <>
                  <kbd className="kbd text-app-text-muted/50 group-hover:hidden">{isMac ? '⌘' : '⌃'}{paneIdx + 1}</kbd>
                  <X size={12} className="hidden group-hover:block" />
                </>
              ) : (
                <X size={12} className={isTouch ? '' : 'opacity-0 group-hover:opacity-100'} />
              )}
            </button>
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
            onClick={() => {
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
              const config = PANE_CONFIG[type];
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

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="fixed bg-surface border border-app-border rounded-lg shadow-xl py-1 z-[9999] min-w-[150px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          <button
            onClick={() => { onClose(ctxMenu.paneId); setCtxMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <X size={14} />
            <span className="flex-1 text-left">Close</span>
            {isElectron && <kbd className="kbd text-app-text-muted">{isMac ? '⌘' : '⌃'}W</kbd>}
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
        </div>
      )}
    </div>
  );
}
