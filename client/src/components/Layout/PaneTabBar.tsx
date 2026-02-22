import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, ExternalLink, Edit3, Settings } from 'lucide-react';
import type { Pane, PaneType, PaneGroupType } from '../../types';
import { PANE_CONFIG } from '../../lib/paneConfig';
import { getFileIcon } from '../../lib/fileIcons';
import { DND_TYPES } from '../../lib/dndTypes';

const ICONS: Record<string, React.FC<{ size: number; className?: string }>> = {
  MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode,
};

interface PaneTabBarProps {
  panes: Pane[];
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onAddPane: (type: PaneType) => void;
  availableTypes: PaneType[];
  groupType?: PaneGroupType;
  groupId?: string;
  onNewChat?: () => void;
  onReorderPanes?: (newPaneIds: string[]) => void;
  onCrossGroupDrop?: (sourcePaneId: string, sourceGroupId: string, insertIdx: number) => void;
  className?: string;
  contextPercent?: Record<string, number>;
  onContextRingClick?: (paneId: string) => void;
  onCloseOthers?: (paneId: string) => void;
  onDetach?: (paneId: string) => void;
  onRename?: (paneId: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  streamingPaneIds?: Set<string>;
  onStopStreaming?: (paneId: string) => void;
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

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onAddPane, availableTypes, groupType: _groupType, groupId, onNewChat, onReorderPanes, onCrossGroupDrop, className, contextPercent, onContextRingClick, onCloseOthers, onDetach, onRename, onSettings, onPopOut, streamingPaneIds, onStopStreaming }: PaneTabBarProps) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ paneId: string; x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAddMenu) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowAddMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showAddMenu]);

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const h = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ctxMenu]);

  const handleContextMenu = useCallback((paneId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Position menu with edge detection
    const menuWidth = 160;
    const menuHeight = 160;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setCtxMenu({ paneId, x, y });
  }, []);

  const handleTabDragStart = useCallback((paneId: string) => (e: React.DragEvent) => {
    if (!onReorderPanes) return;
    setDraggedPaneId(paneId);
    e.dataTransfer.setData(DND_TYPES.PANE_TAB, paneId);
    if (groupId) {
      e.dataTransfer.setData(DND_TYPES.PANE_TAB_GROUP, groupId);
    }
    // Also set PANEL_ID for cross-panel-type drops (chat panes carry their topicId)
    const pane = panes.find(p => p.id === paneId);
    if (pane?.topicId) {
      e.dataTransfer.setData(DND_TYPES.PANEL_ID, pane.topicId);
    }
    e.dataTransfer.effectAllowed = 'move';
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
  }, []);

  const hasMenuItems = onNewChat || availableTypes.length > 0;

  return (
    <div className={className ?? "flex items-center bg-elevated/60 flex-shrink-0 p-1 gap-0.5 min-w-0"}>
      {/* Scrollable tab area */}
      <div
        className="flex items-center gap-0.5 min-w-0 overflow-x-auto flex-1 scrollbar-none"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
          e.preventDefault();
        }}
        onDrop={handleTabDrop}
      >
      {panes.map((pane, paneIdx) => {
        const config = PANE_CONFIG[pane.type];
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
            style={{ minWidth: 140, flexShrink: 0 }}
            className={`group flex items-center gap-1.5 px-2.5 h-7 text-[11px] font-medium transition-all relative cursor-pointer select-none rounded-md ${
              isActive
                ? 'bg-white dark:bg-white/10 text-app-text ring-1 ring-black/[0.06] shadow-sm'
                : 'text-app-text-tertiary hover:text-app-text bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
            } ${isDragged ? 'opacity-40' : ''}`}
            onClick={() => onActivate(pane.id)}
            onContextMenu={handleContextMenu(pane.id)}
            draggable={!!onReorderPanes}
            onDragStart={handleTabDragStart(pane.id)}
            onDragOver={handleTabDragOver(paneIdx)}
            onDragEnd={handleTabDragEnd}
          >
            {showLeftIndicator && (
              <div className="absolute left-0 top-1 bottom-1 w-[2px] bg-primary rounded z-20" />
            )}
            {pane.type === 'file' && pane.title ? (
              <span className="text-[12px] leading-none flex-shrink-0">{getFileIcon(pane.title)}</span>
            ) : Icon ? (
              <Icon size={13} className="flex-shrink-0" />
            ) : null}
            {pane.type === 'chat' && contextPercent && (
              <ContextRing percent={paneContextPercent ?? 0} onClick={onContextRingClick ? () => onContextRingClick(pane.id) : undefined} />
            )}
            <span className="truncate flex-1">{label}</span>
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
              className="ml-auto w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-app-hover text-app-text-muted hover:text-app-text transition-all flex-shrink-0"
            >
              <X size={10} />
            </button>
            {showRightIndicator && (
              <div className="absolute right-0 top-1 bottom-1 w-[2px] bg-primary rounded z-20" />
            )}
          </div>
        );
      })}
      </div>

      {/* Add pane button — pinned right, hidden when no menu items */}
      {hasMenuItems && (
        <div className="relative flex items-center" ref={menuRef}>
          <button
            ref={buttonRef}
            onClick={() => {
              if (!showAddMenu && buttonRef.current) {
                const rect = buttonRef.current.getBoundingClientRect();
                const menuWidth = 160; // min-w-[140px] + padding
                const left = Math.min(rect.left, window.innerWidth - menuWidth - 8);
                setMenuPos({ top: rect.bottom + 4, left: Math.max(8, left) });
              }
              setShowAddMenu(!showAddMenu);
            }}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-app-text-muted hover:text-app-text transition-colors flex-shrink-0"
            title="Add pane"
          >
            <Plus size={14} />
          </button>
          {showAddMenu && menuPos && (
            <div
              className="fixed bg-surface border border-app-border rounded-lg shadow-lg py-1 z-[9999] min-w-[140px]"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              {onNewChat && (
                <button
                  onClick={() => { onNewChat(); setShowAddMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                >
                  <MessageSquare size={14} />
                  <span>New Chat</span>
                </button>
              )}
              {availableTypes.map(type => {
                const config = PANE_CONFIG[type];
                const Icon = ICONS[config.icon];
                return (
                  <button
                    key={type}
                    onClick={() => { onAddPane(type); setShowAddMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    {Icon && <Icon size={14} />}
                    <span>{config.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
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
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <X size={13} />
            <span>Close</span>
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
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <X size={13} />
              <span>Close Others</span>
            </button>
          )}
          {onDetach && (
            <>
              <div className="h-px bg-app-border my-1" />
              <button
                onClick={() => { onDetach(ctxMenu.paneId); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
              >
                <ExternalLink size={13} />
                <span>Detach</span>
              </button>
            </>
          )}
          {onRename && (
            <button
              onClick={() => { onRename(ctxMenu.paneId); setCtxMenu(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <Edit3 size={13} />
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
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    <Settings size={13} />
                    <span>Settings</span>
                  </button>
                )}
                {showPopOut && (
                  <button
                    onClick={() => { onPopOut!(ctxMenu!.paneId); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    <ExternalLink size={13} />
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
