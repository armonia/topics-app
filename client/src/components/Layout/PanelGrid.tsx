import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest } from '../../types';
import { ProjectWindow } from './ProjectWindow';
import { StandaloneChatGroup } from './StandaloneChatGroup';
import { getProjectName, hashToColor } from './ProjectHeader';
import { UtilityPanel, isUtilityPanelId, parseUtilityPanelType } from './UtilityPanel';
import { useGridResize } from '../../hooks/useGridResize';

// Check if running in native macOS app (has webkit message handlers)
const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

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
  externalDragTopicId: _externalDragTopicId,
  onExternalDrop: _onExternalDrop,
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

  /* ---- Group order state (for drag reordering) ---- */
  const [groupOrder, setGroupOrder] = useState<(string | null)[]>([]);

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
    const keysToUse = groupOrder.length > 0
      ? groupOrder.filter(key => groupsByProject.has(key))
      : [...groupsByProject.keys()].sort((a, b) => {
          if (a === null) return 1;
          if (b === null) return -1;
          return a.localeCompare(b);
        });

    return keysToUse.map(projectPath => ({
      projectPath,
      panels: groupsByProject.get(projectPath)!,
    }));
  }, [groupOrder, groupsByProject]);

  /* ---- Build unified grid items (utility + project + standalone) ---- */
  const gridItems = useMemo<GridItem[]>(() => {
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

  /* ---- Top-level group widths (fractions summing to 1) ---- */
  const [groupWidths, setGroupWidths] = useState<number[]>([]);

  useEffect(() => {
    setGroupWidths(prev => {
      if (prev.length === gridItems.length && gridItems.length > 0) return prev;
      return gridItems.map(() => 1 / Math.max(1, gridItems.length));
    });
  }, [gridItems.length]);

  /* ---- Top-level resize via useGridResize ---- */
  const resizeCallbacks = useMemo(() => ({
    onHorizontalResize: (_rowIdx: number, _divIdx: number, newWidths: number[]) => {
      setGroupWidths(newWidths);
    },
    onVerticalResize: () => {},
  }), []);

  const { startHorizontalResize } = useGridResize(containerRef, resizeCallbacks);

  /* ---- drag state (for cross-window panel drag) ---- */
  const [draggingId, setDraggingId] = useState<string | null>(null);
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
  if (gridItems.length === 0) {
    return (
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center bg-surface dark:bg-app-bg transition-colors ${
          emptyDragOver ? 'bg-primary/5 dark:bg-primary/10' : ''
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

  /* ---- render unified grid layout ---- */
  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-row min-h-0 overflow-auto relative px-1 pt-1"
      onDragEnd={(e) => { handleDragEnd(e); handleGroupDragEnd(); }}
    >
      {gridItems.map((item, idx) => {
        const width = groupWidths[idx] || (1 / Math.max(1, gridItems.length));
        const groupIdx = item.groupIdx ?? -1;
        const isDraggingThis = item.kind === 'project' && draggingGroupPath !== null && draggingGroupPath === item.projectPath;
        const isDropLeft = item.kind === 'project' && groupDropTarget?.idx === groupIdx && groupDropTarget?.side === 'left';
        const isDropRight = item.kind === 'project' && groupDropTarget?.idx === groupIdx && groupDropTarget?.side === 'right';

        return (
          <Fragment key={item.key}>
            <div
              className={`flex min-h-0 min-w-[200px] transition-all ${isDraggingThis ? 'opacity-40' : ''}`}
              style={{
                flex: `${width} 1 0%`,
                boxShadow: isDropLeft ? `inset 4px 0 0 0 var(--primary)` : isDropRight ? `inset -4px 0 0 0 var(--primary)` : undefined,
              }}
              onDragOver={item.kind === 'project' ? handleGroupDragOver(groupIdx) : undefined}
              onDrop={item.kind === 'project' ? handleGroupDrop : undefined}
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
                  onGroupDragStart={handleGroupDragStart(item.projectPath!)}
                  onCloseProject={onCloseProject ? () => onCloseProject(item.projectPath!) : undefined}
                  pendingPane={pendingProjectPane && pendingProjectPane.projectPath === item.projectPath ? pendingProjectPane.type : undefined}
                  onPendingPaneConsumed={onPendingProjectPaneConsumed}
                  onNewChat={onNewChatInProject ? () => onNewChatInProject(item.projectPath!) : undefined}
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
                />
              )}
            </div>

            {/* Divider between items */}
            {idx < gridItems.length - 1 && (
              <div
                className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-10"
                onMouseDown={startHorizontalResize(0, idx, groupWidths)}
              >
                <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
