import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelGridRow } from '../../types';
import { StandaloneChatGroup } from './StandaloneChatGroup';
import { useGridResize } from '../../hooks/useGridResize';
import { DND_TYPES } from '../../lib/dndTypes';

// Check if running in native macOS app (has webkit message handlers)
const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

const STORAGE_KEY = 'topics-panel-grid-layout';

const MAX_COLS_PER_ROW = 4;
const MAX_ROWS = 4;

/* ------------------------------------------------------------------ */
/*  Layout model                                                       */
/* ------------------------------------------------------------------ */

interface GridItem {
  key: string;
  panelIds: string[];
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
  stopSession: (sessionKey: string) => boolean;
  sendMessage: (sessionKey: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sessionKey: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sessionKey: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sessionKey: string) => Promise<boolean>;
  chatError: string | null;
  expiredMessages?: { sessionKey: string; content: string; timestamp: string; options?: { planMode?: boolean } }[];
  retryExpired?: (item: { sessionKey: string; content: string; timestamp: string; options?: { planMode?: boolean } }) => void;
  clearExpired?: () => void;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  // Cross-window drag
  windowId?: string;
  externalDragTopicId?: string | null;
  onExternalDrop?: () => void;
  // Mobile sidebar toggle
  onToggleSidebar?: () => void;
  // Initial tab overrides for standalone panels
  panelInitialTab?: Record<string, import('../../types').PanelTab>;
  onPanelInitialTabConsumed?: (topicId: string) => void;
  // Pending pane request for project windows
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType; terminalSessionId?: string } | null;
  onPendingProjectPaneConsumed?: () => void;
  // Create new chat in a project
  onNewChatInProject?: (projectPath: string) => void;
  // Create new standalone chat
  onNewChat?: () => void;
  // Pending focus for project tabs (navigate to a topic inside a project)
  pendingProjectFocus?: { projectPath: string; topicId: string } | null;
  onPendingProjectFocusConsumed?: () => void;
  // Report which topic is active inside a project (keyed by projectPath)
  onProjectActiveTopicChange?: (projectPath: string, topicId: string | null) => void;
  // Terminal sessions for label resolution
  terminalSessions?: import('../../types').TerminalSessionInfo[];
  // Create a new terminal (delegates to App)
  onCreateTerminal?: (type: 'shell' | 'claude-code', skipPermissions?: boolean) => void;
  // Pending browser pane request (from sidebar) — contextId or null
  pendingBrowserPane?: string | null;
  onPendingBrowserPaneConsumed?: () => void;
  // Report open browser context IDs for sidebar highlighting
  onOpenBrowserContextIds?: (ids: string[]) => void;
  // Draft chat support
  promoteDraft?: (draftId: string, firstMessage: string, options?: { planMode?: boolean }) => Promise<void>;
  draftMeta?: Record<string, { projectPath?: string }>;
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
  stopSession,
  sendMessage,
  editMessage,
  switchBranch,
  loadHistory,
  chatError,
  expiredMessages,
  retryExpired,
  clearExpired,
  sendWS,
  onWSMessage,
  onUpdateTopic,
  windowId,
  externalDragTopicId,
  onExternalDrop,
  onToggleSidebar,
  panelInitialTab,
  onPanelInitialTabConsumed,
  pendingProjectPane,
  onPendingProjectPaneConsumed,
  onNewChatInProject,
  onNewChat,
  pendingProjectFocus,
  onPendingProjectFocusConsumed,
  onProjectActiveTopicChange,
  terminalSessions,
  onCreateTerminal,
  pendingBrowserPane,
  onPendingBrowserPaneConsumed,
  onOpenBrowserContextIds,
  promoteDraft,
  draftMeta,
}: PanelGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Mobile detection for single-column layout
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  /* ---- All panels are treated flat (no project grouping) ---- */
  /* Solo topic IDs = panels placed independently in the grid */
  const [soloTopicIdsRaw, setSoloTopicIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.soloTopicIds)) return parsed.soloTopicIds;
      }
    } catch {}
    return [];
  });

  // ISSUE 6 FIX: Derive effective soloTopicIds synchronously filtered against openPanels.
  // This avoids the transient render where naturalGridItems includes a solo item
  // for a panel that no longer exists (the old useEffect had a dependency gap).
  const soloTopicIds = useMemo(() => {
    const openSet = new Set(openPanels);
    const filtered = soloTopicIdsRaw.filter(id => openSet.has(id));
    return filtered.length === soloTopicIdsRaw.length ? soloTopicIdsRaw : filtered;
  }, [soloTopicIdsRaw, openPanels]);

  // Track whether standalone group has utility panes (browser/terminal)
  const [standaloneHasUtility, setStandaloneHasUtility] = useState(false);
  const handleStandaloneUtilityChange = useCallback((has: boolean) => setStandaloneHasUtility(has), []);

  // Pending split placement: when a pane is split, we track where the new solo key should go
  // so the sync effect places it correctly instead of dumping into the first row
  const pendingSplitRef = useRef<{ key: string; direction: 'right' | 'down'; nearKey: string } | null>(null);

  /* ---- Build natural grid items (flat) ---- */
  const naturalGridItems = useMemo<GridItem[]>(() => {
    const items: GridItem[] = [];
    const soloSet = new Set(soloTopicIds);

    // Non-solo panels go into main standalone group
    // Also create it when a browser/terminal pane is pending (needs a group to land in)
    const regularPanels = openPanels.filter(id => !soloSet.has(id));
    if (regularPanels.length > 0 || standaloneHasUtility || pendingBrowserPane) {
      items.push({ key: 'standalone', panelIds: regularPanels });
    }

    // Solo panels get their own grid items
    for (const id of openPanels) {
      if (soloSet.has(id)) {
        items.push({ key: `solo:${id}`, panelIds: [id] });
      }
    }

    return items;
  }, [openPanels, soloTopicIds, standaloneHasUtility, pendingBrowserPane]);

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

      // 4. Add new keys — check pendingSplitRef for directed placement
      if (newKeys.length > 0) {
        const pending = pendingSplitRef.current;

        if (rows.length === 0) {
          rows = [{ itemKeys: newKeys, widths: newKeys.map(() => 1 / newKeys.length) }];
          pendingSplitRef.current = null;
        } else if (pending && newKeys.includes(pending.key)) {
          // Place the pending split key according to its direction
          const remainingKeys = newKeys.filter(k => k !== pending.key);

          // Find which row contains the nearKey
          let nearRowIdx = -1, nearColIdx = -1;
          for (let r = 0; r < rows.length; r++) {
            const c = rows[r].itemKeys.indexOf(pending.nearKey);
            if (c >= 0) { nearRowIdx = r; nearColIdx = c; break; }
          }

          if (nearRowIdx >= 0) {
            if (pending.direction === 'right') {
              // Insert as new column to the right in the same row
              const row = rows[nearRowIdx];
              row.itemKeys.splice(nearColIdx + 1, 0, pending.key);
              row.widths = row.itemKeys.map(() => 1 / row.itemKeys.length);
            } else {
              // Create a new row below
              const newRow: PanelGridRow = { itemKeys: [pending.key], widths: [1] };
              rows.splice(nearRowIdx + 1, 0, newRow);
            }
          } else {
            // Fallback: add to first row
            const first = rows[0];
            first.itemKeys.push(pending.key);
            first.widths = first.itemKeys.map(() => 1 / first.itemKeys.length);
          }

          // Add any remaining new keys to first row
          if (remainingKeys.length > 0) {
            const first = rows[0];
            const allKeys = [...first.itemKeys, ...remainingKeys];
            rows[0] = { itemKeys: allKeys, widths: allKeys.map(() => 1 / allKeys.length) };
          }

          pendingSplitRef.current = null;
        } else {
          // Default: add new keys to first row
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

  // --- Server fetch on mount: apply fresh grid layout if it differs from localStorage ---
  const gridUserEditedRef = useRef(false);
  const gridMountedRef = useRef(false);
  useEffect(() => {
    gridUserEditedRef.current = false;
    const cachedRaw = localStorage.getItem(STORAGE_KEY);
    fetch('/api/ui-state/grid-layout')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || gridUserEditedRef.current) return;
        const freshRaw = JSON.stringify(data);
        if (freshRaw === cachedRaw) return; // Same data — no update needed
        // Server data differs from cache — apply it
        if (Array.isArray(data.soloTopicIds)) setSoloTopicIds(data.soloTopicIds);
        if (Array.isArray(data.gridRows)) setGridRows(data.gridRows);
        if (Array.isArray(data.gridRowHeights)) setGridRowHeights(data.gridRowHeights);
        try { localStorage.setItem(STORAGE_KEY, freshRaw); } catch {}
      })
      .catch(() => {});
  }, []);

  // Persist layout to localStorage + server (debounced)
  // ISSUE 11 FIX: Always persist, even when gridRows is empty.
  // Previously, stale layout persisted when all panels were closed because
  // the save was gated on gridRows.length > 0. On load, empty gridRows
  // naturally starts fresh (the sync effect creates rows from naturalGridItems).
  const gridSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Mark user-edited after mount so server fetch callback skips stale overwrites
    if (gridMountedRef.current) gridUserEditedRef.current = true;
    else gridMountedRef.current = true;
    const data = { gridRows, gridRowHeights, soloTopicIds };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    // Debounced server sync (2s to avoid spam during resize)
    if (gridSaveTimerRef.current) clearTimeout(gridSaveTimerRef.current);
    gridSaveTimerRef.current = setTimeout(() => {
      fetch('/api/ui-state/grid-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(() => {});
    }, 2000);
    return () => { if (gridSaveTimerRef.current) clearTimeout(gridSaveTimerRef.current); };
  }, [gridRows, gridRowHeights, soloTopicIds]);

  /* ---- Split pane handler: see handleSplitPane below (with grid limit checks) ---- */

  /* ---- Resize via useGridResize ---- */
  const resizeCallbacks = useMemo(() => ({
    onHorizontalResize: (rowIdx: number, _divIdx: number, newWidths: number[]) => {
      setGridRows(prev => prev.map((r, i) => i === rowIdx ? { ...r, widths: newWidths } : r));
    },
    onVerticalResize: (_divIdx: number, newHeights: number[]) => {
      setGridRowHeights(newHeights);
    },
  }), []);

  // Data-attribute resolvers: dividers and cells use data-panel-* attributes for safe DOM resolution
  // Item wrappers have transition-all (for drag opacity) which must be disabled during resize
  const resizeOptions = useMemo(() => ({
    resolveHorizontal: (divider: HTMLElement) => {
      const rowIdx = divider.getAttribute('data-panel-divider-row');
      const colIdx = divider.getAttribute('data-panel-divider-col');
      if (!rowIdx || !colIdx) return null;
      const container = divider.closest('[data-panel-row]');
      if (!container) return null;
      const leftCol = parseInt(colIdx);
      const rightCol = leftCol + 1;
      const left = container.querySelector(`[data-panel-cell="${rowIdx}-${leftCol}"]`) as HTMLElement;
      const right = container.querySelector(`[data-panel-cell="${rowIdx}-${rightCol}"]`) as HTMLElement;
      if (!left || !right) return null;
      left.style.transition = 'none';
      right.style.transition = 'none';
      return {
        apply: (l: number, r: number) => { left.style.flex = `${l} 1 0%`; right.style.flex = `${r} 1 0%`; },
        cleanup: () => { left.style.transition = ''; right.style.transition = ''; },
      };
    },
    resolveVertical: (divider: HTMLElement) => {
      const rowIdx = divider.getAttribute('data-panel-row-divider');
      if (!rowIdx) return null;
      const container = divider.parentElement;
      if (!container) return null;
      const topRow = parseInt(rowIdx);
      const bottomRow = topRow + 1;
      const top = container.querySelector(`[data-panel-row="${topRow}"]`) as HTMLElement;
      const bottom = container.querySelector(`[data-panel-row="${bottomRow}"]`) as HTMLElement;
      if (!top || !bottom) return null;
      top.style.transition = 'none';
      bottom.style.transition = 'none';
      return {
        apply: (t: number, b: number) => { top.style.flex = `${t} 1 0%`; bottom.style.flex = `${b} 1 0%`; },
        cleanup: () => { top.style.transition = ''; bottom.style.transition = ''; },
      };
    },
  }), []);

  const { startHorizontalResize, startVerticalResize } = useGridResize(containerRef, resizeCallbacks, resizeOptions);

  // ISSUE 19 FIX: Track ghost DOM elements so they can be cleaned up
  // if the component unmounts during a rAF callback.
  const activeGhostsRef = useRef<Set<HTMLElement>>(new Set());
  useEffect(() => {
    return () => {
      // Cleanup any ghost elements still in the DOM on unmount
      for (const ghost of activeGhostsRef.current) {
        if (ghost.parentElement) {
          ghost.parentElement.removeChild(ghost);
        }
      }
      activeGhostsRef.current.clear();
    };
  }, []);

  // Ref to read gridRows synchronously for limit checks
  const gridRowsRef = useRef(gridRows);
  useEffect(() => { gridRowsRef.current = gridRows; }, [gridRows]);

  /* ---- Split pane: move a topic to its own solo grid cell ---- */
  const handleSplitPane = useCallback((topicId: string, direction: 'right' | 'down') => {
    // Check grid limits BEFORE marking as solo to prevent orphaned soloTopicIds
    const currentRows = gridRowsRef.current;
    if (direction === 'down' && currentRows.length >= MAX_ROWS) return;
    if (direction === 'right') {
      const firstRow = currentRows[0];
      if (firstRow && firstRow.itemKeys.length >= MAX_COLS_PER_ROW) return;
    }

    // Mark as solo (only after limit check passes)
    setSoloTopicIds(prev => {
      if (prev.includes(topicId)) return prev;
      return [...prev, topicId];
    });

    // Place in grid
    const soloKey = `solo:${topicId}`;
    setGridRows(prev => {
      // Double-check limits (state may have changed between ref read and updater)
      if (direction === 'down' && prev.length >= MAX_ROWS) return prev;
      if (direction === 'right') {
        const firstRow = prev[0];
        if (firstRow && firstRow.itemKeys.length >= MAX_COLS_PER_ROW) return prev;
      }

      // Deep copy
      let rows = prev.map(r => ({ itemKeys: [...r.itemKeys], widths: [...r.widths] }));

      // Safety: remove soloKey if already present
      for (const row of rows) {
        const idx = row.itemKeys.indexOf(soloKey);
        if (idx >= 0) {
          row.itemKeys.splice(idx, 1);
          row.widths.splice(idx, 1);
          if (row.itemKeys.length > 0) {
            const total = row.widths.reduce((s, w) => s + w, 0);
            row.widths = row.widths.map(w => w / total);
          }
        }
      }
      rows = rows.filter(r => r.itemKeys.length > 0);

      if (direction === 'down') {
        rows.push({ itemKeys: [soloKey], widths: [1] });
      } else {
        if (rows.length === 0) {
          rows = [{ itemKeys: [soloKey], widths: [1] }];
        } else {
          const first = rows[0];
          first.itemKeys.push(soloKey);
          first.widths = first.itemKeys.map(() => 1 / first.itemKeys.length);
        }
      }

      return rows;
    });
    // Note: gridRowHeights sync is handled by the effect on [gridRows.length].
    // The rendering fallback `gridRowHeights[rowIdx] ?? 1 / gridRows.length` covers
    // the first render cycle before the effect runs.
  }, []);

  /* ---- Unsolo: merge a solo topic back into the main standalone group ---- */
  const handleUnsoloTopic = useCallback((topicId: string) => {
    setSoloTopicIds(prev => prev.filter(id => id !== topicId));
  }, []);

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
    activeGhostsRef.current.add(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => {
      if (ghost.parentElement) document.body.removeChild(ghost);
      activeGhostsRef.current.delete(ghost);
    });

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

  /* ---- Grid item drag & edge-drop ---- */
  const [draggingGridKey, setDraggingGridKey] = useState<string | null>(null);
  const [gridDropTarget, setGridDropTarget] = useState<{
    rowIdx: number;
    colIdx: number;
    zone: 'left' | 'right' | 'top' | 'bottom' | 'center';
    centerSide?: 'left' | 'right';
  } | null>(null);
  // Ref mirror: updated synchronously so the drop handler always has the latest value
  // (React state may not be committed yet when drop fires immediately after dragover)
  const gridDropTargetRef = useRef(gridDropTarget);
  gridDropTargetRef.current = gridDropTarget;

  const handleGridItemDragStart = useCallback((item: GridItem) => (e: React.DragEvent) => {
    setDraggingGridKey(item.key);
    e.dataTransfer.setData(DND_TYPES.GRID_ITEM, item.key);
    e.dataTransfer.effectAllowed = 'move';

    // Ghost image
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position:fixed;left:-9999px;top:-9999px;
      display:flex;align-items:center;gap:6px;
      padding:6px 14px;border-radius:8px;
      font:500 13px/1 Inter,system-ui,sans-serif;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
      white-space:nowrap;pointer-events:none;
      background:color-mix(in srgb, var(--primary) 90%, transparent);color:#fff;
    `;
    ghost.textContent = `\uD83D\uDCAC Chats`;
    document.body.appendChild(ghost);
    activeGhostsRef.current.add(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => {
      if (ghost.parentElement) document.body.removeChild(ghost);
      activeGhostsRef.current.delete(ghost);
    });
  }, []);

  // Capture phase: fires BEFORE children, so we can intercept edge drags
  // even when StandaloneChatGroup/GroupLayout consume bubble-phase events
  const handleGridItemDragOverCapture = useCallback((rowIdx: number, colIdx: number) => (e: React.DragEvent) => {
    const isGridDrag = e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM);
    const isTabDrag = e.dataTransfer.types.includes(DND_TYPES.PANE_TAB);
    if (!isGridDrag && !isTabDrag) return;

    // Browser/terminal tabs don't carry PANEL_ID — can't be split to solo
    if (isTabDrag && !isGridDrag && !e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) {
      setGridDropTarget(null);
      gridDropTargetRef.current = null;
      return;
    }

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

    // For PANE_TAB drags at center: let children handle (tab reorder, project drops)
    if (isTabDrag && !isGridDrag && zone === 'center') {
      setGridDropTarget(null);
      gridDropTargetRef.current = null;
      return;
    }

    // Edge zone (or any GRID_ITEM drag): handle at grid level
    e.preventDefault();
    e.stopPropagation(); // Prevent children from also handling this edge drag
    const target = { rowIdx, colIdx, zone, centerSide };
    setGridDropTarget(target);
    gridDropTargetRef.current = target; // sync update for immediate drop access
  }, []);

  const handleGridItemDragEnd = useCallback(() => {
    setDraggingGridKey(null);
    setGridDropTarget(null);
    gridDropTargetRef.current = null;
  }, []);

  const handleGridItemDropCapture = useCallback((e: React.DragEvent) => {
    // Read from ref for synchronous access (state may lag behind after dragover)
    const dropTarget = gridDropTargetRef.current;
    if (!dropTarget) return;

    // Re-verify drop zone from actual mouse position at drop time.
    // The dragover ref may be stale if the mouse moved between last dragover and drop.
    const cell = (e.currentTarget as HTMLElement);
    const rect = cell.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const edgeSize = 30;
    let actualZone: 'left' | 'right' | 'top' | 'bottom' | 'center';
    if (x < edgeSize) actualZone = 'left';
    else if (x > rect.width - edgeSize) actualZone = 'right';
    else if (y < edgeSize) actualZone = 'top';
    else if (y > rect.height - edgeSize) actualZone = 'bottom';
    else actualZone = 'center';

    let effectiveKey = e.dataTransfer.getData(DND_TYPES.GRID_ITEM);
    const sourcePaneTab = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceTopicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);

    // PANE_TAB drops: edge zones create split + move tab, center lets tab bar handle reorder.
    if (!effectiveKey && sourcePaneTab) {
      // Use actual zone at drop time, not the stale dragover zone
      if (actualZone === 'center') return; // let tab bar handle reorder
      if (!sourceTopicId) return; // no PANEL_ID means project-internal tab — skip
      // Update dropTarget zone to match actual position
      dropTarget.zone = actualZone;
    }

    e.preventDefault();
    e.stopPropagation(); // Prevent children from also handling this drop

    // Tab drag → create a solo standalone item at the target position
    if (!effectiveKey && sourcePaneTab && sourceTopicId) {
      const soloKey = `solo:${sourceTopicId}`;

      // Guard: don't split a solo item onto its own edge (self-drop)
      const targetKey = gridRowsRef.current[dropTarget.rowIdx]?.itemKeys[dropTarget.colIdx];
      if (targetKey === soloKey) {
        setDraggingGridKey(null);
        setGridDropTarget(null);
        gridDropTargetRef.current = null;
        return;
      }

      if (itemMap.has(soloKey)) {
        // Already a solo item — reorder via the grid path below
        effectiveKey = soloKey;
      } else {
        // Make it solo
        const { rowIdx: targetRowIdx, colIdx: targetColIdx, zone, centerSide } = dropTarget;

        // Use a flag to track whether grid placement succeeded (checked via ref for sync)
        let placed = false;

        setGridRows(prev => {
          // Enforce grid limits
          if ((zone === 'top' || zone === 'bottom') && prev.length >= MAX_ROWS) return prev;
          if ((zone === 'left' || zone === 'right' || zone === 'center') && prev[targetRowIdx]?.itemKeys.length >= MAX_COLS_PER_ROW) return prev;

          const targetKey = prev[targetRowIdx]?.itemKeys[targetColIdx];
          if (!targetKey) return prev;

          placed = true;
          // ISSUE 8 FIX: Use immutable operations instead of splice()
          let rows = prev.map(r => ({ itemKeys: [...r.itemKeys], widths: [...r.widths] }));

          // Safety: remove soloKey if already present (immutably)
          rows = rows.map(row => {
            const idx = row.itemKeys.indexOf(soloKey);
            if (idx < 0) return row;
            const newKeys = row.itemKeys.filter((_, i) => i !== idx);
            const newWidths = row.widths.filter((_, i) => i !== idx);
            if (newKeys.length > 0) {
              const total = newWidths.reduce((s, w) => s + w, 0);
              return { itemKeys: newKeys, widths: total > 0 ? newWidths.map(w => w / total) : newKeys.map(() => 1 / newKeys.length) };
            }
            return { itemKeys: newKeys, widths: newWidths };
          });
          rows = rows.filter(r => r.itemKeys.length > 0);

          let tRow = -1, tCol = -1;
          for (let r = 0; r < rows.length; r++) {
            const c = rows[r].itemKeys.indexOf(targetKey);
            if (c >= 0) { tRow = r; tCol = c; break; }
          }
          if (tRow === -1) return rows;

          if (zone === 'top' || zone === 'bottom') {
            const newRow: PanelGridRow = { itemKeys: [soloKey], widths: [1] };
            const insertIdx = zone === 'top' ? tRow : tRow + 1;
            rows = [...rows.slice(0, insertIdx), newRow, ...rows.slice(insertIdx)];
          } else {
            const row = rows[tRow];
            const insertAt = (zone === 'right' || (zone === 'center' && centerSide === 'right'))
              ? tCol + 1
              : tCol;
            const newKeys = [...row.itemKeys.slice(0, insertAt), soloKey, ...row.itemKeys.slice(insertAt)];
            rows = rows.map((r, i) => i === tRow ? { itemKeys: newKeys, widths: newKeys.map(() => 1 / newKeys.length) } : r);
          }

          return rows;
        });

        // Only mark as solo if grid placement succeeded
        if (placed) {
          setSoloTopicIds(prev => prev.includes(sourceTopicId) ? prev : [...prev, sourceTopicId]);
        }

        setDraggingGridKey(null);
        setGridDropTarget(null);
        return;
      }
    }

    // GRID_ITEM drag (or existing solo item reorder) — reorder in the grid
    if (!effectiveKey) return;

    const { rowIdx: targetRowIdx, colIdx: targetColIdx, zone, centerSide } = dropTarget;

    setGridRows(prev => {
      // ISSUE 18 FIX: Validate drop target against current grid state at drop time.
      // If the target row/column is invalid, fall back to "add to end" behavior.
      const targetKey = prev[targetRowIdx]?.itemKeys[targetColIdx];

      // Find source position
      let srcRow = -1, srcCol = -1;
      for (let r = 0; r < prev.length; r++) {
        const c = prev[r].itemKeys.indexOf(effectiveKey);
        if (c >= 0) { srcRow = r; srcCol = c; break; }
      }
      if (srcRow === -1) return prev;

      if (!targetKey || effectiveKey === targetKey) {
        // ISSUE 18: Invalid target — fall back to "add to end" if target disappeared
        if (!targetKey && prev.length > 0) {
          // Move source to end of last row
          let rows = prev.map(r => ({ itemKeys: [...r.itemKeys], widths: [...r.widths] }));
          // Remove source immutably
          rows = rows.map((r, i) => {
            if (i !== srcRow) return r;
            const newKeys = r.itemKeys.filter((_, j) => j !== srcCol);
            const newWidths = r.widths.filter((_, j) => j !== srcCol);
            if (newKeys.length > 0) {
              const total = newWidths.reduce((s, w) => s + w, 0);
              return { itemKeys: newKeys, widths: total > 0 ? newWidths.map(w => w / total) : newKeys.map(() => 1 / newKeys.length) };
            }
            return { itemKeys: newKeys, widths: newWidths };
          }).filter(r => r.itemKeys.length > 0);
          // Append to last row
          const lastRow = rows[rows.length - 1];
          const newKeys = [...lastRow.itemKeys, effectiveKey];
          rows = rows.map((r, i) => i === rows.length - 1 ? { itemKeys: newKeys, widths: newKeys.map(() => 1 / newKeys.length) } : r);
          return rows;
        }
        return prev;
      }

      // ISSUE 8 FIX: Use immutable operations instead of splice()
      // Deep copy rows
      let rows = prev.map(r => ({ itemKeys: [...r.itemKeys], widths: [...r.widths] }));

      // Remove source from its row (immutably)
      rows = rows.map((r, i) => {
        if (i !== srcRow) return r;
        const newKeys = r.itemKeys.filter((_, j) => j !== srcCol);
        const newWidths = r.widths.filter((_, j) => j !== srcCol);
        if (newKeys.length > 0) {
          const total = newWidths.reduce((s, w) => s + w, 0);
          return { itemKeys: newKeys, widths: total > 0 ? newWidths.map(w => w / total) : newKeys.map(() => 1 / newKeys.length) };
        }
        return { itemKeys: newKeys, widths: newWidths };
      });

      // Remove empty rows (source row may now be empty)
      rows = rows.filter(r => r.itemKeys.length > 0);

      // Find target's new position (may have shifted after removal)
      let tRow = -1, tCol = -1;
      for (let r = 0; r < rows.length; r++) {
        const c = rows[r].itemKeys.indexOf(targetKey);
        if (c >= 0) { tRow = r; tCol = c; break; }
      }
      if (tRow === -1) return rows;

      // Enforce grid limits
      if ((zone === 'top' || zone === 'bottom') && rows.length >= MAX_ROWS) return rows;
      if ((zone === 'left' || zone === 'right' || zone === 'center') && rows[tRow].itemKeys.length >= MAX_COLS_PER_ROW) return rows;

      // Insert source based on zone (immutably)
      if (zone === 'top' || zone === 'bottom') {
        // Create new row above/below target
        const newRow: PanelGridRow = { itemKeys: [effectiveKey], widths: [1] };
        const insertIdx = zone === 'top' ? tRow : tRow + 1;
        rows = [...rows.slice(0, insertIdx), newRow, ...rows.slice(insertIdx)];
      } else {
        // left/right/center — insert as column in target's row
        const row = rows[tRow];
        const insertAt = (zone === 'right' || (zone === 'center' && centerSide === 'right'))
          ? tCol + 1
          : tCol;
        const newKeys = [...row.itemKeys.slice(0, insertAt), effectiveKey, ...row.itemKeys.slice(insertAt)];
        rows = rows.map((r, i) => i === tRow ? { itemKeys: newKeys, widths: newKeys.map(() => 1 / newKeys.length) } : r);
      }

      return rows;
    });

    setDraggingGridKey(null);
    setGridDropTarget(null);
    gridDropTargetRef.current = null;
  }, [itemMap]);

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

  /* ---- empty state ---- */
  if (naturalGridItems.length === 0) {
    return (
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center bg-surface transition-colors ${
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
                  : 'Select a topic to start'}
              </p>
              {window.innerWidth >= 768 && (
                <div className="flex flex-wrap gap-3 justify-center text-[12px] text-app-text-muted">
                  <span className="flex items-center gap-1.5 bg-app-hover dark:bg-elevated px-3 py-1.5 rounded-lg"><kbd className="kbd">{'\u2318K'}</kbd> Search</span>
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
      className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative"
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
            className={`flex ${isMobile ? 'flex-col' : 'flex-row'} min-h-0 min-w-0 overflow-hidden`}
            style={{ flex: `${gridRowHeights[rowIdx] ?? 1 / gridRows.length} 1 0%` }}
            data-panel-row={rowIdx}
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
                    className={`flex min-h-0 min-w-0 overflow-hidden relative transition-all ${isDraggingThis ? 'opacity-40' : ''}`}
                    style={{
                      flex: isMobile ? '1 1 0%' : `${width} 1 0%`,
                      boxShadow: zone === 'center'
                        ? (cSide === 'left' ? 'inset 4px 0 0 0 var(--primary)' : 'inset -4px 0 0 0 var(--primary)')
                        : undefined,
                    }}
                    data-panel-cell={`${rowIdx}-${colIdx}`}
                    onDragOverCapture={handleGridItemDragOverCapture(rowIdx, colIdx)}
                    onDropCapture={handleGridItemDropCapture}
                  >
                    {/* Unified standalone group (handles chat, utility, and project tabs) */}
                    <StandaloneChatGroup
                      topicIds={item.panelIds}
                      topics={topics}
                      focusedPanelId={focusedPanelId}
                      onFocusPanel={onFocusPanel}
                      onClosePanel={onClosePanel}
                      onDragStart={handleDragStart}
                      onGroupDragStart={handleGridItemDragStart(item)}
                      getSessionMessages={getSessionMessages}
                      isSessionLoading={isSessionLoading}
                      isSessionStreaming={isSessionStreaming}
                      stopSession={stopSession}
                      sendMessage={sendMessage}
                      editMessage={editMessage}
                      switchBranch={switchBranch}
                      loadHistory={loadHistory}
                      chatError={chatError}
                      sendWS={sendWS}
                      onWSMessage={onWSMessage}
                      onUpdateTopic={onUpdateTopic}
                      onToggleSidebar={onToggleSidebar}
                      panelInitialTab={panelInitialTab}
                      onPanelInitialTabConsumed={onPanelInitialTabConsumed}
                      onNewChat={onNewChat}
                      pendingProjectPane={pendingProjectPane}
                      onPendingProjectPaneConsumed={onPendingProjectPaneConsumed}
                      onNewChatInProject={onNewChatInProject}
                      pendingProjectFocus={pendingProjectFocus}
                      onPendingProjectFocusConsumed={onPendingProjectFocusConsumed}
                      onProjectActiveTopicChange={onProjectActiveTopicChange}
                      terminalSessions={terminalSessions}
                      onCreateTerminal={onCreateTerminal}
                      onUtilityPaneChange={key === 'standalone' ? handleStandaloneUtilityChange : undefined}
                      pendingBrowserPane={key === 'standalone' ? pendingBrowserPane : undefined}
                      onPendingBrowserPaneConsumed={key === 'standalone' ? onPendingBrowserPaneConsumed : undefined}
                      onOpenBrowserContextIds={key === 'standalone' ? onOpenBrowserContextIds : undefined}
                      promoteDraft={promoteDraft}
                      draftMeta={draftMeta}
                      onSplitPane={handleSplitPane}
                      persistOrder={key === 'standalone'}
                      gridItemKey={key}
                      onUnsolo={key.startsWith('solo:') ? handleUnsoloTopic : undefined}
                      onAcceptSoloDrop={handleUnsoloTopic}
                    />

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

                  {/* Column divider (between items in a row) — hidden on mobile */}
                  {colIdx < row.itemKeys.length - 1 && !isMobile && (
                    <div
                      className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-10"
                      data-panel-divider-row={rowIdx}
                      data-panel-divider-col={colIdx}
                      onMouseDown={startHorizontalResize(rowIdx, colIdx, row.widths)}
                    >
                      <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Row divider (between rows) — hidden on mobile */}
          {rowIdx < gridRows.length - 1 && !isMobile && (
            <div
              className="h-[1px] flex-shrink-0 cursor-row-resize relative bg-app-border hover:bg-primary transition-colors z-10"
              data-panel-row-divider={rowIdx}
              onMouseDown={startVerticalResize(rowIdx, gridRowHeights)}
            >
              <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
            </div>
          )}
        </Fragment>
      ))}

      {/* Expired messages banner */}
      {expiredMessages && expiredMessages.length > 0 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-[12px] shadow-lg backdrop-blur-sm">
          <span>{expiredMessages.length} message{expiredMessages.length > 1 ? 's' : ''} not sent</span>
          {retryExpired && (
            <button
              onClick={() => expiredMessages.forEach(m => retryExpired(m))}
              className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 font-medium transition-colors"
            >
              Retry
            </button>
          )}
          {clearExpired && (
            <button
              onClick={clearExpired}
              className="px-1.5 py-0.5 rounded hover:bg-amber-500/20 transition-colors"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
