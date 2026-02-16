import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode } from 'lucide-react';
import type { Pane, PaneType, PaneGroupType } from '../../types';
import { PANE_CONFIG } from '../../lib/paneConfig';
import { getFileIcon } from '../../lib/fileIcons';

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
  onNewChat?: () => void;
  onReorderPanes?: (newPaneIds: string[]) => void;
  className?: string;
}

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onAddPane, availableTypes, groupType: _groupType, onNewChat, onReorderPanes, className }: PaneTabBarProps) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);

  useEffect(() => {
    if (!showAddMenu) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowAddMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showAddMenu]);

  const handleTabDragStart = useCallback((paneId: string) => (e: React.DragEvent) => {
    if (!onReorderPanes) return;
    setDraggedPaneId(paneId);
    e.dataTransfer.setData('application/x-pane-tab', paneId);
    e.dataTransfer.effectAllowed = 'move';
  }, [onReorderPanes]);

  const handleTabDragOver = useCallback((paneIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-pane-tab')) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    setDragOverIdx(xRatio < 0.5 ? paneIdx : paneIdx + 1);
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourcePaneId = e.dataTransfer.getData('application/x-pane-tab');
    if (!sourcePaneId || dragOverIdx === null || !onReorderPanes) return;

    const currentIds = panes.map(p => p.id);
    const sourceIdx = currentIds.indexOf(sourcePaneId);
    if (sourceIdx === -1) return;

    const newIds = currentIds.filter(id => id !== sourcePaneId);
    let insertIdx = dragOverIdx;
    if (sourceIdx < dragOverIdx) insertIdx--;
    newIds.splice(Math.max(0, insertIdx), 0, sourcePaneId);

    onReorderPanes(newIds);
    setDraggedPaneId(null);
    setDragOverIdx(null);
  }, [panes, dragOverIdx, onReorderPanes]);

  const handleTabDragEnd = useCallback(() => {
    setDraggedPaneId(null);
    setDragOverIdx(null);
  }, []);

  const hasMenuItems = onNewChat || availableTypes.length > 0;

  return (
    <div
      className={className ?? "flex items-center bg-elevated flex-shrink-0 px-1 gap-0.5 overflow-x-auto"}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-pane-tab')) return;
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

        return (
          <div
            key={pane.id}
            className={`group flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium transition-colors relative cursor-pointer select-none min-w-0 ${
              isActive ? 'text-primary dark:text-primary-dark' : 'text-app-text-tertiary hover:text-app-text'
            } ${isDragged ? 'opacity-40' : ''}`}
            onClick={() => onActivate(pane.id)}
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
            <span className="truncate max-w-[100px]">{label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
              className="w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-app-hover text-app-text-muted hover:text-app-text transition-all flex-shrink-0"
            >
              <X size={10} />
            </button>
            {isActive && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-primary dark:bg-primary-dark rounded-t" />}
            {showRightIndicator && (
              <div className="absolute right-0 top-1 bottom-1 w-[2px] bg-primary rounded z-20" />
            )}
          </div>
        );
      })}

      {/* Add pane button — hidden when no menu items */}
      {hasMenuItems && (
        <div className="relative" ref={menuRef}>
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
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors flex-shrink-0 ml-1"
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
    </div>
  );
}
