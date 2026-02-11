import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest } from '../../types';
import { ChatPanel } from './ChatPanel';
import { ProjectHeader, getProjectName, hashToColor } from './ProjectHeader';

// Check if running in native macOS app (has webkit message handlers)
const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

/* ------------------------------------------------------------------ */
/*  Layout model - now per project group                               */
/*  Each group has its own rows layout                                 */
/* ------------------------------------------------------------------ */

interface LayoutRow {
  panels: string[];
  widths: number[];
}

interface ProjectGroup {
  projectPath: string | null;
  panels: string[];
  rows: LayoutRow[];
  rowHeights: number[];
}

interface DropTarget {
  groupIdx: number;
  rowIdx: number;
  panelIdx: number;
  zone: 'left' | 'right' | 'top' | 'bottom' | 'center';
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
  sendMessage: (sessionKey: string, content: string) => Promise<boolean>;
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
  externalDragTopicId: _externalDragTopicId,
  onExternalDrop: _onExternalDrop,
  onToggleSidebar,
}: PanelGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  /* ---- Group order state (for drag reordering) ---- */
  const [groupOrder, setGroupOrder] = useState<(string | null)[]>([]);
  
  /* ---- Group panels by project ---- */
  const groupsByProject = useMemo(() => {
    const byProject = new Map<string | null, string[]>();
    
    for (const panelId of openPanels) {
      const topic = topics[panelId];
      const projectPath = topic?.projectPath || null;
      
      if (!byProject.has(projectPath)) {
        byProject.set(projectPath, []);
      }
      byProject.get(projectPath)!.push(panelId);
    }
    return byProject;
  }, [openPanels, topics]);

  // Sync groupOrder when groups change
  useEffect(() => {
    const currentKeys = [...groupsByProject.keys()];
    setGroupOrder(prev => {
      // Keep existing order for keys that still exist, add new keys at end
      const existing = prev.filter(k => groupsByProject.has(k));
      const newKeys = currentKeys.filter(k => !prev.includes(k));
      // Sort new keys: projects first (alphabetically), null at end
      newKeys.sort((a, b) => {
        if (a === null) return 1;
        if (b === null) return -1;
        return a.localeCompare(b);
      });
      return [...existing, ...newKeys];
    });
  }, [groupsByProject]);

  const groups = useMemo<ProjectGroup[]>(() => {
    // If groupOrder hasn't been initialized yet, use all keys from groupsByProject
    const keysToUse = groupOrder.length > 0 
      ? groupOrder.filter(key => groupsByProject.has(key))
      : [...groupsByProject.keys()].sort((a, b) => {
          if (a === null) return 1;
          if (b === null) return -1;
          return a.localeCompare(b);
        });
    
    return keysToUse.map(projectPath => {
      const panels = groupsByProject.get(projectPath)!;
      return {
        projectPath,
        panels,
        rows: [{ panels: [...panels], widths: panels.map(() => 1 / panels.length) }],
        rowHeights: [1],
      };
    });
  }, [groupOrder, groupsByProject]);

  /* ---- Layout state per group (for resizing) ---- */
  const [groupLayouts, setGroupLayouts] = useState<Map<string | null, { rows: LayoutRow[]; rowHeights: number[] }>>(new Map());

  // Get effective layout for a group (stored state or default)
  const getGroupLayout = useCallback((projectPath: string | null, defaultGroup: ProjectGroup) => {
    const stored = groupLayouts.get(projectPath);
    if (stored) {
      // Validate that stored layout matches current panels
      const storedPanels = new Set(stored.rows.flatMap(r => r.panels));
      const currentPanels = new Set(defaultGroup.panels);
      
      if (storedPanels.size === currentPanels.size && 
          [...storedPanels].every(p => currentPanels.has(p))) {
        return stored;
      }
    }
    return { rows: defaultGroup.rows, rowHeights: defaultGroup.rowHeights };
  }, [groupLayouts]);

  /* ---- drag state ---- */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [emptyDragOver, setEmptyDragOver] = useState(false);

  const handleDragStart = useCallback((topicId: string) => (e: React.DragEvent) => {
    setDraggingId(topicId);
    e.dataTransfer.setData('application/x-panel-id', topicId);
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
    ghost.textContent = `${topic?.icon || '💬'} ${topic?.name || 'Chat'}`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => document.body.removeChild(ghost));
    
    if (windowId) {
      sendWS({ type: 'drag:start', topicId, windowId });
    }
  }, [topics, windowId, sendWS]);

  const handleCellDragOver = useCallback(
    (groupIdx: number, rowIdx: number, panelIdx: number) => (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-panel-id')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const xRatio = (e.clientX - rect.left) / rect.width;
      const yRatio = (e.clientY - rect.top) / rect.height;

      const EDGE = 0.22;
      let zone: DropTarget['zone'] = 'center';
      
      const distLeft = xRatio;
      const distRight = 1 - xRatio;
      const distTop = yRatio;
      const distBottom = 1 - yRatio;
      const minDist = Math.min(distLeft, distRight, distTop, distBottom);
      
      if (minDist < EDGE) {
        if (minDist === distLeft) zone = 'left';
        else if (minDist === distRight) zone = 'right';
        else if (minDist === distTop) zone = 'top';
        else if (minDist === distBottom) zone = 'bottom';
      }

      setDropTarget({ groupIdx, rowIdx, panelIdx, zone });
    },
    [],
  );

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    const draggedId = draggingId;
    setDraggingId(null);
    setDropTarget(null);
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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData('application/x-panel-id');
      const target = dropTarget;
      setDraggingId(null);
      setDropTarget(null);
      if (!sourceId || !target) return;

      // For now, just ensure panel is in openPanels and focus it
      // The grouping is automatic based on projectPath
      if (!openPanels.includes(sourceId)) {
        onOpenPanelAt(sourceId, 0);
      }
      onFocusPanel(sourceId);
    },
    [dropTarget, openPanels, onOpenPanelAt, onFocusPanel],
  );

  /* ---- resize: horizontal divider (within row) ---- */
  const hResizing = useRef<{
    projectPath: string | null;
    rowIdx: number;
    divIdx: number;
    startX: number;
    startWidths: number[];
  } | null>(null);

  /* ---- resize: vertical divider (between rows) ---- */
  const vResizing = useRef<{
    projectPath: string | null;
    divIdx: number;
    startY: number;
    startHeights: number[];
  } | null>(null);

  const handleHDividerDown = useCallback(
    (projectPath: string | null, rowIdx: number, divIdx: number, currentWidths: number[]) => (e: React.MouseEvent) => {
      e.preventDefault();
      hResizing.current = {
        projectPath,
        rowIdx,
        divIdx,
        startX: e.clientX,
        startWidths: [...currentWidths],
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  const handleVDividerDown = useCallback(
    (projectPath: string | null, divIdx: number, currentHeights: number[]) => (e: React.MouseEvent) => {
      e.preventDefault();
      vResizing.current = {
        projectPath,
        divIdx,
        startY: e.clientY,
        startHeights: [...currentHeights],
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // Horizontal resizing
      if (hResizing.current) {
        const { projectPath, rowIdx, divIdx, startX, startWidths } = hResizing.current;
        const cw = containerRef.current?.offsetWidth || 1;
        const delta = (e.clientX - startX) / cw;
        const MIN = 0.1;
        const newW = [...startWidths];
        const l = newW[divIdx] + delta;
        const r = newW[divIdx + 1] - delta;
        if (l >= MIN && r >= MIN) {
          newW[divIdx] = l;
          newW[divIdx + 1] = r;

          setGroupLayouts(prev => {
            const next = new Map(prev);
            const current = next.get(projectPath) || { rows: [], rowHeights: [] };
            const newRows = [...current.rows];
            if (newRows[rowIdx]) {
              newRows[rowIdx] = { ...newRows[rowIdx], widths: newW };
            }
            next.set(projectPath, { ...current, rows: newRows });
            return next;
          });
        }
      }

      // Vertical resizing
      if (vResizing.current) {
        const { projectPath, divIdx, startY, startHeights } = vResizing.current;
        const ch = containerRef.current?.offsetHeight || 1;
        const delta = (e.clientY - startY) / ch;
        const MIN = 0.1;
        const newH = [...startHeights];
        const t = newH[divIdx] + delta;
        const b = newH[divIdx + 1] - delta;
        if (t >= MIN && b >= MIN) {
          newH[divIdx] = t;
          newH[divIdx + 1] = b;

          setGroupLayouts(prev => {
            const next = new Map(prev);
            const current = next.get(projectPath) || { rows: [], rowHeights: [] };
            next.set(projectPath, { ...current, rowHeights: newH });
            return next;
          });
        }
      }
    };
    const onUp = () => {
      hResizing.current = null;
      vResizing.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleOpenInFinder = useCallback((projectPath: string) => () => {
    const msg = { type: 'exec', command: `open "${projectPath}"` };
    sendWS(msg);
  }, [sendWS]);

  /* ---- drop overlay helper ---- */
  const overlayStyle = (zone: DropTarget['zone']): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      background: 'var(--primary-light)',
      border: '2px solid color-mix(in srgb, var(--primary) 50%, transparent)',
      borderRadius: 4,
      zIndex: 20,
      transition: 'all 120ms ease',
      pointerEvents: 'none',
    };
    switch (zone) {
      case 'left':   return { ...base, top: 4, bottom: 4, left: 4, width: '46%' };
      case 'right':  return { ...base, top: 4, bottom: 4, right: 4, width: '46%' };
      case 'top':    return { ...base, left: 4, right: 4, top: 4, height: '46%' };
      case 'bottom': return { ...base, left: 4, right: 4, bottom: 4, height: '46%' };
      case 'center': return { ...base, inset: 4 };
    }
  };

  /* ---- drag state for groups ---- */
  const [draggingGroupPath, setDraggingGroupPath] = useState<string | null>(null);
  const [groupDropTarget, setGroupDropTarget] = useState<{ idx: number; side: 'left' | 'right' } | null>(null);

  const handleGroupDragStart = useCallback((projectPath: string) => (e: React.DragEvent) => {
    setDraggingGroupPath(projectPath);
    e.dataTransfer.setData('application/x-project-group', projectPath);
    e.dataTransfer.effectAllowed = 'move';
    
    // Ghost
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position:fixed;left:-9999px;top:-9999px;
      padding:6px 14px;border-radius:8px;
      background:${hashToColor(projectPath)};color:#fff;
      font:500 13px/1 Inter,system-ui,sans-serif;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
    `;
    ghost.textContent = getProjectName(projectPath);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => document.body.removeChild(ghost));
  }, []);

  const handleGroupDragOver = useCallback((groupIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-project-group')) return;
    e.preventDefault();
    e.stopPropagation();
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const side = xRatio < 0.5 ? 'left' : 'right';
    setGroupDropTarget({ idx: groupIdx, side });
  }, []);

  const handleGroupDragEnd = useCallback(() => {
    setDraggingGroupPath(null);
    setGroupDropTarget(null);
  }, []);

  const handleGroupDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourceProjectPath = e.dataTransfer.getData('application/x-project-group');
    if (!sourceProjectPath || !groupDropTarget) return;
    
    setGroupOrder(prev => {
      const sourceIdx = prev.indexOf(sourceProjectPath);
      if (sourceIdx === -1) return prev;
      
      // Remove source from current position
      const newOrder = prev.filter(p => p !== sourceProjectPath);
      
      // Calculate target index
      let targetIdx = groupDropTarget.idx;
      // Adjust if source was before target
      if (sourceIdx < groupDropTarget.idx) {
        targetIdx--;
      }
      // If dropping on right side, insert after
      if (groupDropTarget.side === 'right') {
        targetIdx++;
      }
      
      // Insert at new position
      newOrder.splice(targetIdx, 0, sourceProjectPath);
      return newOrder;
    });
    
    setDraggingGroupPath(null);
    setGroupDropTarget(null);
  }, [groupDropTarget]);

  /* ---- empty state ---- */
  if (groups.length === 0) {
    return (
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center bg-white dark:bg-[#111] transition-colors ${
          emptyDragOver ? 'bg-[var(--primary)]/5 dark:bg-[var(--primary)]/10' : ''
        }`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-panel-id')) return;
          e.preventDefault();
          setEmptyDragOver(true);
        }}
        onDragLeave={() => setEmptyDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setEmptyDragOver(false);
          const id = e.dataTransfer.getData('application/x-panel-id');
          if (id) onOpenPanelAt(id, 0);
        }}
      >
        <div className={`text-center transition-all duration-300 max-w-md px-6 ${emptyDragOver ? 'scale-105' : ''}`}>
          {emptyDragOver ? (
            <>
              <div className="text-[40px] mb-3 float-icon">📌</div>
              <h2 className="text-[16px] font-semibold text-[var(--primary)]">Drop here to open</h2>
            </>
          ) : (
            <>
              <div className="mb-5 opacity-40">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-[#999] dark:text-[#666]">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h2 className="text-[17px] font-semibold text-[#444] dark:text-[#bbb] mb-2">Welcome to Topics</h2>
              <p className="text-[13px] text-[#999] dark:text-[#666] leading-relaxed mb-6">
                {window.innerWidth < 768 
                  ? 'Tap the menu button to browse topics or create a new one.'
                  : 'Select a topic or press ⌘N to start'}
              </p>
              {window.innerWidth >= 768 && (
                <div className="flex flex-wrap gap-3 justify-center text-[12px] text-[#aaa] dark:text-[#555]">
                  <span className="flex items-center gap-1.5 bg-[#f5f5f5] dark:bg-[#1e1e1e] px-3 py-1.5 rounded-lg"><kbd className="kbd">⌘K</kbd> Search</span>
                  <span className="flex items-center gap-1.5 bg-[#f5f5f5] dark:bg-[#1e1e1e] px-3 py-1.5 rounded-lg"><kbd className="kbd">⌘N</kbd> New chat</span>
                  <span className="flex items-center gap-1.5 bg-[#f5f5f5] dark:bg-[#1e1e1e] px-3 py-1.5 rounded-lg"><kbd className="kbd">⌘B</kbd> Sidebar</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  /* ---- render grouped layout ---- */
  return (
    <div 
      ref={containerRef} 
      className="flex-1 flex flex-row min-h-0 overflow-auto relative gap-1 p-1" 
      onDragEnd={(e) => { handleDragEnd(e); handleGroupDragEnd(); }}
    >
      {groups.map((group, groupIdx) => {
        const layout = getGroupLayout(group.projectPath, group);
        const { rows, rowHeights } = layout;
        const projectColor = group.projectPath ? hashToColor(group.projectPath) : null;
        const isDraggingThis = draggingGroupPath !== null && draggingGroupPath === group.projectPath;
        const isDropLeft = groupDropTarget?.idx === groupIdx && groupDropTarget?.side === 'left';
        const isDropRight = groupDropTarget?.idx === groupIdx && groupDropTarget?.side === 'right';
        
        return (
          <div 
            key={group.projectPath ?? '__ungrouped__'} 
            className={`flex flex-col min-h-0 min-w-[200px] rounded-lg overflow-hidden transition-all ${
              isDraggingThis ? 'opacity-40' : ''
            }`}
            style={{ 
              flex: `${1 / groups.length} 1 0%`,
              border: projectColor ? `2px solid ${projectColor}` : undefined,
              boxShadow: isDropLeft ? `inset 4px 0 0 0 var(--primary)` : isDropRight ? `inset -4px 0 0 0 var(--primary)` : undefined,
            }}
            onDragOver={handleGroupDragOver(groupIdx)}
            onDrop={handleGroupDrop}
          >
            {/* Project header (only if has project) - draggable */}
            {group.projectPath && (
              <div
                draggable
                onDragStart={handleGroupDragStart(group.projectPath)}
                className="cursor-grab active:cursor-grabbing"
              >
                <ProjectHeader
                  projectPath={group.projectPath}
                  projectName={getProjectName(group.projectPath)}
                  color=""
                  onOpenInFinder={handleOpenInFinder(group.projectPath)}
                />
              </div>
            )}
            
            {/* Rows within this group */}
            <div className="flex-1 flex flex-col min-h-0">
              {rows.map((row, rowIdx) => (
                <div key={rowIdx} className="flex flex-col flex-1 min-h-0">
                  {/* The row content */}
                  <div
                    className="flex flex-1 min-h-0 min-w-0"
                    style={{ flex: `${rowHeights[rowIdx] ?? 1 / rows.length} 1 0%` }}
                  >
                    {row.panels.map((topicId, panelIdx) => {
                      const topic = topics[topicId];
                      if (!topic) return null;

                      const isDropHere =
                        dropTarget?.groupIdx === groupIdx &&
                        dropTarget?.rowIdx === rowIdx &&
                        dropTarget?.panelIdx === panelIdx &&
                        draggingId !== topicId;

                      return (
                        <div
                          key={topicId}
                          className="flex min-h-0"
                          style={{ width: `${row.widths[panelIdx] * 100}%` }}
                        >
                          {/* Panel cell */}
                          <div
                            className={`flex-1 flex flex-col min-h-0 min-w-0 relative transition-opacity duration-150 ${
                              draggingId === topicId ? 'opacity-25' : ''
                            }`}
                            onDragOver={handleCellDragOver(groupIdx, rowIdx, panelIdx)}
                            onDrop={handleDrop}
                          >
                            <ChatPanel
                              topic={topic}
                              isFocused={focusedPanelId === topicId}
                              onFocus={() => onFocusPanel(topicId)}
                              onClose={() => onClosePanel(topicId)}
                              onDragStart={handleDragStart(topicId)}
                              onToggleSidebar={onToggleSidebar}
                              isDragOver={!!isDropHere}
                              getSessionMessages={getSessionMessages}
                              isSessionLoading={isSessionLoading}
                              isSessionStreaming={isSessionStreaming}
                              sendMessage={sendMessage}
                              loadHistory={loadHistory}
                              chatError={chatError}
                              sendWS={sendWS}
                              onWSMessage={onWSMessage}
                              onUpdateTopic={onUpdateTopic}
                            />
                            {/* Drop zone overlay */}
                            {isDropHere && dropTarget && (
                              <div style={overlayStyle(dropTarget.zone)} />
                            )}
                          </div>

                          {/* Horizontal divider between panels */}
                          {panelIdx < row.panels.length - 1 && (
                            <div
                              className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-[#e8e8e8] dark:bg-[#2a2a2a] hover:bg-[var(--primary)] dark:hover:bg-[var(--primary)] transition-colors z-10"
                              onMouseDown={handleHDividerDown(group.projectPath, rowIdx, panelIdx, row.widths)}
                            >
                              <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Vertical divider between rows */}
                  {rowIdx < rows.length - 1 && (
                    <div
                      className="h-[1px] flex-shrink-0 cursor-row-resize relative bg-[#e8e8e8] dark:bg-[#2a2a2a] hover:bg-[var(--primary)] dark:hover:bg-[var(--primary)] transition-colors z-10"
                      onMouseDown={handleVDividerDown(group.projectPath, rowIdx, rowHeights)}
                    >
                      <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
                    </div>
                  )}
                </div>
              ))}
            </div>
            
          </div>
        );
      })}
    </div>
  );
}
