import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelGridRow } from '../../types';
import { ProjectWindow } from './ProjectWindow';
import { StandaloneChatGroup } from './StandaloneChatGroup';
import { getProjectName, hashToColor } from './ProjectHeader';
import { UtilityPanel, isUtilityPanelId, parseUtilityPanelType } from './UtilityPanel';
import { useGridResize } from '../../hooks/useGridResize';
import { DND_TYPES } from '../../lib/dndTypes';

// Check if running in native macOS app (has webkit message handlers)
const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

const STORAGE_KEY = 'topics-panel-grid-layout';

/* ------------------------------------------------------------------ */
/*  Layout model                                                       */
/* ------------------------------------------------------------------ */

interface ProjectGroup {
  projectPath: string | null;
  panels: string[];
}

type GridItemKind = 'utility' | 'project' | 'standalone';

interface GridItem {
  kind: GridItemKind;
  key: string;
  utilityId?: string;
  projectPath?: string;
  topicIds?: string[];
  groupIdx?: number;
}

interface PanelGridProps {
  openPanels: string[];
  focusedPanelId: string | null;
  topics: Record<string, Topic>;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  onReorderPanels: (panels: string[]) => void;
  onOpenPanelAt: (topicId: string, index: number) => void;
  nextPanelMode?: 'side' | 'below';
  onPanelModeUsed?: () => void;
  getSessionMessages: (sessionKey: string) => ChatMessage[];
  isSessionLoading: (sessionKey: string) => boolean;
  isSessionStreaming: (sessionKey: string) => boolean;
  sendMessage: (sessionKey: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  loadHistory: (sessionKey: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  // Cross-window drag
  windowId?: string;
  externalDragTopicId?: string | null;
  onExternalDrop?: () => void;
  // Mobile sidebar toggle
  onToggleSidebar?: () => void;
  // WebSocket connection status
  wsStatus?: import('../../types').ConnectionStatus;
  // Initial tab overrides for standalone panels
  panelInitialTab?: Record<string, import('../../types').PanelTab>;
  onPanelInitialTabConsumed?: (topicId: string) => void;
  // Projects opened without a chat (project-only view)
  openProjects?: string[];
  onCloseProject?: (projectPath: string) => void;
  // Pending pane request for project windows
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType } | null;
  onPendingProjectPaneConsumed?: () => void;
  // Create new chat in a project
  onNewChatInProject?: (projectPath: string) => void;
  // Create new standalone chat
  onNewChat?: () => void;
}

/* ================================================================== */

export function PanelGrid({
  openPanels,
  focusedPanelId,
  topics,
  onFocusPanel,
  onClosePanel,
  onReorderPanels: _onReorderPanels,
  onOpenPanelAt,
  nextPanelMode: _nextPanelMode = 'side',
  onPanelModeUsed: _onPanelModeUsed,
  getSessionMessages,
  isSessionLoading,
  isSessionStreaming,
  sendMessage,
  loadHistory,
  chatError,
  sendWS,
  onWSMessage,
  onUpdateTopic,
  windowId,
  externalDragTopicId,
  onExternalDrop,
  onToggleSidebar,
  panelInitialTab,
  onPanelInitialTabConsumed,
  openProjects,
  onCloseProject,
  pendingProjectPane,
  onPendingProjectPaneConsumed,
  onNewChatInProject,
  onNewChat,
}: PanelGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  /* ---- Separate utility panels from topic panels ---- */
  const { topicPanels, utilityPanelIds } = useMemo(() => {
    const topic: string[] = [];
    const utility: string[] = [];
    for (const id of openPanels) {
      if (isUtilityPanelId(id)) utility.push(id);
      else topic.push(id);
    }
    return { topicPanels: topic, utilityPanelIds: utility };
  }, [openPanels]);

  /* ---- Group panels by project ---- */
  const groupsByProject = useMemo(() => {
    const byProject = new Map<string | null, string[]>();

    // Include standalone open projects (no topics yet)
    if (openProjects) {
      for (const pp of openProjects) {
        if (!byProject.has(pp)) byProject.set(pp, []);
      }
    }

    for (const panelId of topicPanels) {
      const topic = topics[panelId];
      const projectPath = topic?.projectPath || null;

      if (!byProject.has(projectPath)) {
        byProject.set(projectPath, []);
      }
      byProject.get(projectPath)!.push(panelId);
    }
    return byProject;
  }, [topicPanels, topics, openProjects]);

  const groups = useMemo<ProjectGroup[]>(() => {
    const keys = [...groupsByProject.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    });
    return keys.map(projectPath => ({
      projectPath,
      panels: groupsByProject.get(projectPath)!,
    }));
  }, [groupsByProject]);

  /* ---- Build natural grid items (unordered) ---- */
  const naturalGridItems = useMemo<GridItem[]>(() => {
    const items: GridItem[] = [];

    for (const id of utilityPanelIds) {
      items.push({ kind: 'utility', key: `util:${id}`, utilityId: id });
    }

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.projectPath) {
        items.push({ kind: 'project', key: `proj:${group.projectPath}`, projectPath: group.projectPath, topicIds: group.panels, groupIdx: i });
      } else if (group.panels.length > 0) {
        items.push({ kind: 'standalone', key: 'standalone', topicIds: group.panels, groupIdx: i });
      }
    }

    return items;
  }, [utilityPanelIds, groups]);

  /* ---- Item lookup map ---- */
  const itemMap = useMemo(() => {
    const m = new Map<string, GridItem>();
    for (const item of naturalGridItems) m.set(item.key, item);
    return m;
  }, [naturalGridItems]);

  /* ---- Grid rows state (row-based layout, persisted) ---- */
  const [gridRows, setGridRows] = useState<PanelGridRow[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.gridRows)) return parsed.gridRows;
      }
    } catch {}
    return [];
  });

  const [gridRowHeights, setGridRowHeights] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.gridRowHeights)) return parsed.gridRowHeights;
      }
    } catch {}
    return [];
  });

  // Sync gridRows when naturalGridItems change (add/remove items)
  useEffect(() => {
    const currentKeys = new Set(naturalGridItems.map(i => i.key));

    setGridRows(prev => {
      // 1. Remove stale keys from each row, recalculate widths proportionally
      let rows = prev.map(row => {
        const kept: number[] = [];
        for (let i = 0; i < row.itemKeys.length; i++) {
          if (currentKeys.has(row.itemKeys[i])) kept.push(i);
        }
        if (kept.length === row.itemKeys.length) return row; // unchanged
        if (kept.length === 0) return { itemKeys: [] as string[], widths: [] as number[] };

        const newKeys = kept.map(i => row.itemKeys[i]);
        const newWidths = kept.map(i => row.widths[i]);
        const total = newWidths.reduce((s, w) => s + w, 0);
        return {
          itemKeys: newKeys,
          widths: total > 0 ? newWidths.map(w => w / total) : newKeys.map(() => 1 / newKeys.length),
        };
      });

      // 2. Remove empty rows
      rows = rows.filter(r => r.itemKeys.length > 0);

      // 3. Find new keys not in any row
      const existing = new Set(rows.flatMap(r => r.itemKeys));
      const newKeys = naturalGridItems.map(i => i.key).filter(k => !existing.has(k));

      // 4. Add new keys to first row (or create one)
      if (newKeys.length > 0) {
        if (rows.length === 0) {
          rows = [{ itemKeys: newKeys, widths: newKeys.map(() => 1 / newKeys.length) }];
        } else {
          const first = rows[0];
          const allKeys = [...first.itemKeys, ...newKeys];
          rows = [{ itemKeys: allKeys, widths: allKeys.map(() => 1 / allKeys.length) }, ...rows.slice(1)];
        }
      }

      return rows;
    });
  }, [naturalGridItems]);

  // Sync row heights when row count changes
  useEffect(() => {
    setGridRowHeights(prev => {
      if (prev.length === gridRows.length && gridRows.length > 0) return prev;
      return gridRows.map(() => 1 / Math.max(1, gridRows.length));
    });
  }, [gridRows.length]);

  // Persist layout to localStorage
  useEffect(() => {
    if (gridRows.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ gridRows, gridRowHeights }));
    }
  }, [gridRows, gridRowHeights]);

  /* ---- Resize via useGridResize ---- */
  const resizeCallbacks = useMemo(() => ({
    onHorizontalResize: (rowIdx: number, _divIdx: number, newWidths: number[]) => {
      setGridRows(prev => prev.map((r, i) => i === rowIdx ? { ...r, widths: newWidths } : r));
    },
    onVerticalResize: (_divIdx: number, newHeights: number[]) => {
      setGridRowHeights(newHeights);
    },
  }), []);

  const { startHorizontalResize, startVerticalResize } = useGridResize(containerRef, resizeCallbacks);

  /* ---- drag state (for cross-window panel drag) ---- */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [emptyDragOver, setEmptyDragOver] = useState(false);

  const handleDragStart = useCallback((topicId: string) => (e: React.DragEvent) => {
    setDraggingId(topicId);
    e.dataTransfer.setData(DND_TYPES.PANEL_ID, topicId);
    e.dataTransfer.effectAllowed = 'move';

    const topic = topics[topicId];
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position:fixed;left:-9999px;top:-9999px;
      display:flex;align-items:center;gap:6px;
      padding:6px 14px;border-radius:8px;
      background:color-mix(in srgb, var(--primary) 90%, transparent);color:#fff;
      font:500 13px/1 Inter,system-ui,sans-serif;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
      white-space:nowrap;pointer-events:none;
    `;
    ghost.textContent = `${topic?.icon || '\uD83D\uDCAC'} ${topic?.name || 'Chat'}`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => document.body.removeChild(ghost));

    if (windowId) {
      sendWS({ type: 'drag:start', topicId, windowId });
    }
  }, [topics, windowId, sendWS]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    const draggedId = draggingId;
    setDraggingId(null);
    setEmptyDragOver(false);

    if (windowId && draggedId) {
      sendWS({ type: 'drag:end', topicId: draggedId, windowId });
    }

    // Pop-out to new window if dragged outside (native app only)
    if (isNativeApp && draggedId && e.dataTransfer.dropEffect === 'none') {
      const { clientX, clientY } = e;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      if (clientX < 0 || clientX > windowWidth || clientY < 0 || clientY > windowHeight) {
        const url = `${window.location.origin}?topic=${draggedId}`;
        window.open(url, `topic-${draggedId}`, 'width=900,height=700');
        onClosePanel(draggedId);
      }
    }
  }, [draggingId, onClosePanel, windowId, sendWS]);

  const handleOpenInFinder = useCallback((projectPath: string) => () => {
    const msg = { type: 'exec', command: `open "${projectPath}"` };
    sendWS(msg);
  }, [sendWS]);

  /* ---- Grid item drag & edge-drop ---- */
  const [draggingGridKey, setDraggingGridKey] = useState<string | null>(null);
  const [gridDropTarget, setGridDropTarget] = useState<{
    rowIdx: number;
    colIdx: number;
    zone: 'left' | 'right' | 'top' | 'bottom' | 'center';
    centerSide?: 'left' | 'right';
  } | null>(null);

  const handleGridItemDragStart = useCallback((item: GridItem) => (e: React.DragEvent) => {
    setDraggingGridKey(item.key);
    e.dataTransfer.setData(DND_TYPES.GRID_ITEM, item.key);
    e.dataTransfer.effectAllowed = 'move';

    // Also set legacy type for backward compatibility
    if (item.kind === 'project' && item.projectPath) {
      e.dataTransfer.setData(DND_TYPES.PROJECT_GROUP, item.projectPath);
    }

    // Ghost image based on item kind
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position:fixed;left:-9999px;top:-9999px;
      display:flex;align-items:center;gap:6px;
      padding:6px 14px;border-radius:8px;
      font:500 13px/1 Inter,system-ui,sans-serif;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
      white-space:nowrap;pointer-events:none;
    `;
    if (item.kind === 'project' && item.projectPath) {
      ghost.style.background = hashToColor(item.projectPath);
      ghost.style.color = '#fff';
      ghost.textContent = getProjectName(item.projectPath);
    } else if (item.kind === 'standalone') {
      ghost.style.background = 'color-mix(in srgb, var(--primary) 90%, transparent)';
      ghost.style.color = '#fff';
      ghost.textContent = `\uD83D\uDCAC Chats`;
    } else if (item.kind === 'utility') {
      ghost.style.background = 'color-mix(in srgb, var(--primary) 90%, transparent)';
      ghost.style.color = '#fff';
      ghost.textContent = `\uD83D\uDD27 ${item.utilityId ? parseUtilityPanelType(item.utilityId) || 'Panel' : 'Panel'}`;
    }
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => document.body.removeChild(ghost));
  }, []);

  const handleGridItemDragOver = useCallback((rowIdx: number, colIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const edgeSize = 30;

    let zone: 'left' | 'right' | 'top' | 'bottom' | 'center';
    let centerSide: 'left' | 'right' | undefined;

    if (x < edgeSize) zone = 'left';
    else if (x > rect.width - edgeSize) zone = 'right';
    else if (y < edgeSize) zone = 'top';
    else if (y > rect.height - edgeSize) zone = 'bottom';
    else {
      zone = 'center';
      centerSide = (x / rect.width) < 0.5 ? 'left' : 'right';
    }

    setGridDropTarget({ rowIdx, colIdx, zone, centerSide });
  }, []);

  const handleGridItemDragEnd = useCallback(() => {
    setDraggingGridKey(null);
    setGridDropTarget(null);
  }, []);

  const handleGridItemDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourceKey = e.dataTransfer.getData(DND_TYPES.GRID_ITEM);
    if (!sourceKey || !gridDropTarget) return;

    const { rowIdx: targetRowIdx, colIdx: targetColIdx, zone, centerSide } = gridDropTarget;

    setGridRows(prev => {
      // Find source position
      let srcRow = -1, srcCol = -1;
      for (let r = 0; r < prev.length; r++) {
        const c = prev[r].itemKeys.indexOf(sourceKey);
        if (c >= 0) { srcRow = r; srcCol = c; break; }
      }
      if (srcRow === -1) return prev;

      // Find target key
      const targetKey = prev[targetRowIdx]?.itemKeys[targetColIdx];
      if (!targetKey || sourceKey === targetKey) return prev;

      // Deep copy rows
      let rows = prev.map(r => ({ itemKeys: [...r.itemKeys], widths: [...r.widths] }));

      // Remove source from its row
      rows[srcRow].itemKeys.splice(srcCol, 1);
      rows[srcRow].widths.splice(srcCol, 1);
      // Renormalize source row widths
      if (rows[srcRow].itemKeys.length > 0) {
        const total = rows[srcRow].widths.reduce((s, w) => s + w, 0);
        rows[srcRow].widths = rows[srcRow].widths.map(w => w / total);
      }

      // Remove empty rows (source row may now be empty)
      rows = rows.filter(r => r.itemKeys.length > 0);

      // Find target's new position (may have shifted after removal)
      let tRow = -1, tCol = -1;
      for (let r = 0; r < rows.length; r++) {
        const c = rows[r].itemKeys.indexOf(targetKey);
        if (c >= 0) { tRow = r; tCol = c; break; }
      }
      if (tRow === -1) return rows;

      // Insert source based on zone
      if (zone === 'top' || zone === 'bottom') {
        // Create new row above/below target
        const newRow: PanelGridRow = { itemKeys: [sourceKey], widths: [1] };
        rows.splice(zone === 'top' ? tRow : tRow + 1, 0, newRow);
      } else {
        // left/right/center — insert as column in target's row
        const row = rows[tRow];
        const insertAt = (zone === 'right' || (zone === 'center' && centerSide === 'right'))
          ? tCol + 1
          : tCol;
        row.itemKeys.splice(insertAt, 0, sourceKey);
        row.widths = row.itemKeys.map(() => 1 / row.itemKeys.length);
      }

      return rows;
    });

    setDraggingGridKey(null);
    setGridDropTarget(null);
  }, [gridDropTarget]);

  /* ---- External drop zone (cross-window drag) ---- */
  const [showExternalDropZone, setShowExternalDropZone] = useState(false);
  const externalDropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (externalDragTopicId) {
      // 200ms debounce before showing drop zone to avoid flicker
      externalDropTimerRef.current = setTimeout(() => {
        setShowExternalDropZone(true);
      }, 200);
    } else {
      if (externalDropTimerRef.current) {
        clearTimeout(externalDropTimerRef.current);
        externalDropTimerRef.current = null;
      }
      setShowExternalDropZone(false);
    }
    return () => {
      if (externalDropTimerRef.current) {
        clearTimeout(externalDropTimerRef.current);
      }
    };
  }, [externalDragTopicId]);

  /* ---- Cross-panel-type topic reassignment ---- */
  const handleAssignTopicToProject = useCallback((projectPath: string) => (topicId: string) => {
    onUpdateTopic(topicId, { projectPath });
  }, [onUpdateTopic]);

  const handleRemoveTopicFromProject = useCallback((topicId: string) => {
    // Setting projectPath to empty string removes the association
    onUpdateTopic(topicId, { projectPath: '' });
  }, [onUpdateTopic]);

  /* ---- empty state ---- */
  if (naturalGridItems.length === 0) {
    return (
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center bg-surface dark:bg-app-bg transition-colors ${
          emptyDragOver ? 'bg-primary/5 dark:bg-primary/10' : ''
        }`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
          e.preventDefault();
          setEmptyDragOver(true);
        }}
        onDragLeave={() => setEmptyDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setEmptyDragOver(false);
          const id = e.dataTransfer.getData(DND_TYPES.PANEL_ID);
          if (id) onOpenPanelAt(id, 0);
        }}
      >
        <div className={`text-center transition-all duration-300 max-w-md px-6 ${emptyDragOver ? 'scale-105' : ''}`}>
          {emptyDragOver ? (
            <>
              <div className="text-[40px] mb-3 float-icon">{'\uD83D\uDCCC'}</div>
              <h2 className="text-[16px] font-semibold text-primary">Drop here to open</h2>
            </>
          ) : (
            <>
              <div className="mb-5 opacity-40">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-app-text-muted">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h2 className="text-[17px] font-semibold text-app-text mb-2">Welcome to Topics</h2>
              <p className="text-[13px] text-app-text-muted leading-relaxed mb-6">
                {window.innerWidth < 768
                  ? 'Tap the menu button to browse topics or create a new one.'
                  : 'Select a topic or press \u2318N to start'}
              </p>
              {window.innerWidth >= 768 && (
                <div className="flex flex-wrap gap-3 justify-center text-[12px] text-app-text-muted">
                  <span className="flex items-center gap-1.5 bg-app-hover dark:bg-elevated px-3 py-1.5 rounded-lg"><kbd className="kbd">{'\u2318K'}</kbd> Search</span>
                  <span className="flex items-center gap-1.5 bg-app-hover dark:bg-elevated px-3 py-1.5 rounded-lg"><kbd className="kbd">{'\u2318N'}</kbd> New chat</span>
                  <span className="flex items-center gap-1.5 bg-app-hover dark:bg-elevated px-3 py-1.5 rounded-lg"><kbd className="kbd">{'\u2318B'}</kbd> Sidebar</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  /* ---- render multi-row grid layout ---- */
  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col min-h-0 overflow-auto relative"
      onDragEnd={(e) => { handleDragEnd(e); handleGridItemDragEnd(); }}
    >
      {/* External drop zone overlay (cross-window drag from another window) */}
      {showExternalDropZone && externalDragTopicId && onExternalDrop && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-primary/5 backdrop-blur-[1px] cursor-copy"
          onClick={onExternalDrop}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={(e) => { e.preventDefault(); onExternalDrop(); }}
        >
          <div className="bg-surface border-2 border-dashed border-primary rounded-xl px-8 py-6 text-center shadow-lg">
            <div className="text-[32px] mb-2">{'\uD83D\uDCCC'}</div>
            <div className="text-[15px] font-semibold text-primary mb-1">Drop here</div>
            <div className="text-[12px] text-app-text-muted">
              Move chat to this window
            </div>
          </div>
        </div>
      )}

      {gridRows.map((row, rowIdx) => (
        <Fragment key={rowIdx}>
          <div
            className="flex flex-row min-h-0"
            style={{ flex: `${gridRowHeights[rowIdx] ?? 1 / gridRows.length} 1 0%` }}
          >
            {row.itemKeys.map((key, colIdx) => {
              const item = itemMap.get(key);
              if (!item) return null;

              const width = row.widths[colIdx] ?? 1 / row.itemKeys.length;
              const isDraggingThis = draggingGridKey === key;
              const isTarget = gridDropTarget?.rowIdx === rowIdx && gridDropTarget?.colIdx === colIdx;
              const zone = isTarget ? gridDropTarget!.zone : null;
              const cSide = isTarget ? gridDropTarget!.centerSide : undefined;

              return (
                <Fragment key={key}>
                  <div
                    className={`flex min-h-0 min-w-[200px] relative transition-all ${isDraggingThis ? 'opacity-40' : ''}`}
                    style={{
                      flex: `${width} 1 0%`,
                      boxShadow: zone === 'center'
                        ? (cSide === 'left' ? 'inset 4px 0 0 0 var(--primary)' : 'inset -4px 0 0 0 var(--primary)')
                        : undefined,
                    }}
                    onDragOver={handleGridItemDragOver(rowIdx, colIdx)}
                    onDrop={handleGridItemDrop}
                  >
                    {/* Utility panel */}
                    {item.kind === 'utility' && (() => {
                      const panelType = parseUtilityPanelType(item.utilityId!);
                      if (!panelType) return null;
                      return (
                        <div className="flex-1 min-h-0">
                          <UtilityPanel
                            type={panelType}
                            isFocused={focusedPanelId === item.utilityId}
                            onFocus={() => onFocusPanel(item.utilityId!)}
                            onClose={() => onClosePanel(item.utilityId!)}
                            onNavigateToTopic={(topicId) => onFocusPanel(topicId)}
                            onMessage={onWSMessage}
                          />
                        </div>
                      );
                    })()}

                    {/* Project window */}
                    {item.kind === 'project' && (
                      <ProjectWindow
                        projectPath={item.projectPath!}
                        topicIds={item.topicIds!}
                        topics={topics}
                        focusedPanelId={focusedPanelId}
                        onFocusPanel={onFocusPanel}
                        onClosePanel={onClosePanel}
                        getSessionMessages={getSessionMessages}
                        isSessionLoading={isSessionLoading}
                        isSessionStreaming={isSessionStreaming}
                        sendMessage={sendMessage}
                        loadHistory={loadHistory}
                        chatError={chatError}
                        sendWS={sendWS}
                        onWSMessage={onWSMessage}
                        onUpdateTopic={onUpdateTopic}
                        onOpenInFinder={handleOpenInFinder(item.projectPath!)}
                        onGroupDragStart={handleGridItemDragStart(item)}
                        onCloseProject={onCloseProject ? () => onCloseProject(item.projectPath!) : undefined}
                        pendingPane={pendingProjectPane && pendingProjectPane.projectPath === item.projectPath ? pendingProjectPane.type : undefined}
                        onPendingPaneConsumed={onPendingProjectPaneConsumed}
                        onNewChat={onNewChatInProject ? () => onNewChatInProject(item.projectPath!) : undefined}
                        onAcceptTopicDrop={handleAssignTopicToProject(item.projectPath!)}
                      />
                    )}

                    {/* Standalone chats (tabbed) */}
                    {item.kind === 'standalone' && (
                      <StandaloneChatGroup
                        topicIds={item.topicIds!}
                        topics={topics}
                        focusedPanelId={focusedPanelId}
                        onFocusPanel={onFocusPanel}
                        onClosePanel={onClosePanel}
                        onDragStart={handleDragStart}
                        onGroupDragStart={handleGridItemDragStart(item)}
                        getSessionMessages={getSessionMessages}
                        isSessionLoading={isSessionLoading}
                        isSessionStreaming={isSessionStreaming}
                        sendMessage={sendMessage}
                        loadHistory={loadHistory}
                        chatError={chatError}
                        sendWS={sendWS}
                        onWSMessage={onWSMessage}
                        onUpdateTopic={onUpdateTopic}
                        onToggleSidebar={onToggleSidebar}
                        panelInitialTab={panelInitialTab}
                        onPanelInitialTabConsumed={onPanelInitialTabConsumed}
                        onNewChat={onNewChat}
                        onAcceptProjectTopicDrop={handleRemoveTopicFromProject}
                      />
                    )}

                    {/* Edge drop zone overlay (top/bottom/left/right) */}
                    {zone && zone !== 'center' && (
                      <div
                        className="absolute pointer-events-none z-30"
                        style={{
                          top: zone === 'bottom' ? '50%' : 0,
                          bottom: zone === 'top' ? '50%' : 0,
                          left: zone === 'right' ? '50%' : 0,
                          right: zone === 'left' ? '50%' : 0,
                          background: 'color-mix(in srgb, var(--primary) 15%, transparent)',
                          border: '2px dashed var(--primary)',
                          borderRadius: '4px',
                        }}
                      />
                    )}
                  </div>

                  {/* Column divider (between items in a row) */}
                  {colIdx < row.itemKeys.length - 1 && (
                    <div
                      className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-10"
                      onMouseDown={startHorizontalResize(rowIdx, colIdx, row.widths)}
                    >
                      <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Row divider (between rows) */}
          {rowIdx < gridRows.length - 1 && (
            <div
              className="h-[1px] flex-shrink-0 cursor-row-resize relative bg-app-border hover:bg-primary transition-colors z-10"
              onMouseDown={startVerticalResize(rowIdx, gridRowHeights)}
            >
              <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
