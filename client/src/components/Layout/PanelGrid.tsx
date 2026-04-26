import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelGridRow, PanelGridCellStack } from '../../types';
import { StandaloneChatGroup } from './StandaloneChatGroup';
import { useGridResize } from '../../hooks/useGridResize';
import { DND_TYPES } from '../../lib/dndTypes';
import { usePanelGridPersistence } from './usePanelGridPersistence';
import { useServerHydrated } from '../../hooks/useServerHydrated';
import { ColumnInsertDivider, RowInsertDivider } from './InsertDividers';
import { CellSubStack } from './CellSubStack';

/**
 * Deep-clone a row preserving its optional `cellStacks` map. Drop handlers
 * historically did `{ itemKeys: [...r.itemKeys], widths: [...r.widths] }`
 * which silently dropped any sub-stacks; this helper is the single point
 * the layout code uses to clone, so adding new fields to `PanelGridRow`
 * doesn't quietly lose them.
 */
function cloneRow(row: PanelGridRow): PanelGridRow {
  const clone: PanelGridRow = {
    itemKeys: [...row.itemKeys],
    widths: [...row.widths],
  };
  if (row.cellStacks) {
    clone.cellStacks = Object.fromEntries(
      Object.entries(row.cellStacks).map(
        ([k, s]) => [k, { items: [...s.items], heights: [...s.heights] }],
      ),
    );
  }
  return clone;
}

/**
 * Walk a list of rows and collect every itemKey that has a presence in the
 * grid — both top-level cell primaries AND items nested inside `cellStacks`.
 * Used by the `naturalGridItems` sync effect to decide which keys are
 * already accounted for vs which need to be appended as fresh top-level
 * cells.
 */
function collectAllPresentKeys(rows: PanelGridRow[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    for (const k of row.itemKeys) out.add(k);
    if (row.cellStacks) {
      for (const stack of Object.values(row.cellStacks)) {
        for (const k of stack.items) out.add(k);
      }
    }
  }
  return out;
}


// Check if running in native macOS app (has webkit message handlers)
const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

const MAX_COLS_PER_ROW = 4;
const MAX_ROWS = 4;

const DROP_EDGE_PX = 30;
type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

/**
 * Compute the drop zone under the cursor at the exact moment of drop.
 * dragover events can lag a frame behind the cursor on fast edge-to-edge
 * drags, so consumers recompute from the live event rather than trusting
 * whatever the last dragover recorded.
 */
function computeDropZone(e: React.DragEvent, cell: HTMLElement): DropZone {
  const rect = cell.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (x < DROP_EDGE_PX) return 'left';
  if (x > rect.width - DROP_EDGE_PX) return 'right';
  if (y < DROP_EDGE_PX) return 'top';
  if (y > rect.height - DROP_EDGE_PX) return 'bottom';
  return 'center';
}

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
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType; terminalSessionId?: string; terminalType?: 'shell' | 'claude-code' } | null;
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
  // Report all open pane IDs inside each project (for sidebar filtering)
  onProjectOpenPanesChange?: (projectPath: string, paneIds: string[]) => void;
  // Terminal sessions for label resolution
  terminalSessions?: import('../../types').TerminalSessionInfo[];
  // Create a new terminal (delegates to App)
  onCreateTerminal?: (type: 'shell' | 'claude-code', skipPermissions?: boolean) => void;
  // Pending browser pane request (from sidebar) — contextId or null
  pendingBrowserPane?: string | null;
  onPendingBrowserPaneConsumed?: () => void;
  // Auto-solo a newly created top-level pane so it lands in its own grid cell
  // instead of joining the standalone group with existing panels.
  pendingSoloPanelId?: string | null;
  onPendingSoloPanelIdConsumed?: () => void;
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
  onProjectActiveTopicChange, onProjectOpenPanesChange,
  terminalSessions,
  onCreateTerminal,
  pendingBrowserPane,
  onPendingBrowserPaneConsumed,
  pendingSoloPanelId,
  onPendingSoloPanelIdConsumed,
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
  /* Device-local layout persistence (rows, row heights, solo IDs) — see
   * usePanelGridPersistence.ts. Review I2: factored out to keep this file
   * focused on layout math / DnD. */
  // The `naturalGridItems` sync effect (below) is gated on this flag so it
  // doesn't prune the saved layout during the boot window when `openPanels`
  // is still empty. Persistence is NOT gated — see usePanelGridPersistence
  // for the rationale.
  const isServerHydrated = useServerHydrated();

  const {
    gridRows,
    setGridRows,
    gridRowHeights,
    setGridRowHeights,
    soloTopicIdsRaw,
    setSoloTopicIds,
  } = usePanelGridPersistence();

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

  // Live ref for the sync effect's setGridRows updater. The updater can run
  // AFTER another setGridRows from a user handler (e.g. handleSplitPane)
  // commits — closing over `naturalGridItems` from the effect schedule
  // would see a one-render-stale snapshot and silently prune just-added
  // sub-stack items. The ref always points at the latest derivation.
  const naturalGridItemsRef = useRef(naturalGridItems);
  naturalGridItemsRef.current = naturalGridItems;

  /* ---- Item lookup map ---- */
  const itemMap = useMemo(() => {
    const m = new Map<string, GridItem>();
    for (const item of naturalGridItems) m.set(item.key, item);
    return m;
  }, [naturalGridItems]);

  /* ---- Grid rows state (initial values come from usePanelGridPersistence above) ---- */

  // Sync gridRows when naturalGridItems change.
  //
  // Two passes — split intentionally:
  //
  // 1. **Additive pass (always safe)**: this effect's only job is to ensure
  //    every key in `naturalGridItems` has a place in `gridRows`. Missing
  //    top-level keys get appended to the first row. This is purely
  //    additive and CANNOT lose user data even if it runs during a
  //    transient state mismatch (e.g. before a soloTopicIds update has
  //    propagated to naturalGridItems).
  //
  // 2. **Pruning pass (gated, deferred)**: stale-key removal happens in a
  //    SEPARATE effect that runs only when the state has stabilized. We
  //    can't safely prune here because this effect's setGridRows updater
  //    can run during the same commit as another updater (e.g.
  //    `handleSplitPane.setGridRows`). The closure-captured `currentKeys`
  //    would then be one render stale relative to the `prev` we receive,
  //    and we'd silently drop just-added sub-stack items.
  //
  // Gated on `isServerHydrated` so we don't run during the boot window
  // when openPanels is still empty.
  useEffect(() => {
    if (!isServerHydrated) return;
    setGridRows(prev => {
      const liveItems = naturalGridItemsRef.current;
      const existing = collectAllPresentKeys(prev);
      const newKeys = liveItems.map(i => i.key).filter(k => !existing.has(k));
      if (newKeys.length === 0) return prev;
      if (prev.length === 0) {
        return [{ itemKeys: newKeys, widths: newKeys.map(() => 1 / newKeys.length) }];
      }
      const first = prev[0];
      const allKeys = [...first.itemKeys, ...newKeys];
      return [
        {
          itemKeys: allKeys,
          widths: allKeys.map(() => 1 / allKeys.length),
          ...(first.cellStacks ? { cellStacks: first.cellStacks } : {}),
        },
        ...prev.slice(1),
      ];
    });
  }, [naturalGridItems, isServerHydrated]);

  // Deferred pruning: run after a tick so any pending setGridRows updaters
  // (from user handlers like handleSplitPane) have fully committed and
  // `naturalGridItemsRef.current` reflects the post-commit state. The
  // setTimeout(0) is intentional — it pushes the pruning work to the next
  // task, after both the additive sync above AND any user-initiated
  // updates have settled. Without this deferral, pruning races with adds
  // and silently drops just-added sub-stack items.
  useEffect(() => {
    if (!isServerHydrated) return;
    const handle = setTimeout(() => {
      setGridRows(prev => {
        const liveItems = naturalGridItemsRef.current;
        const currentKeys = new Set(liveItems.map(i => i.key));
        let mutated = false;
        const next = prev.map(row => {
          let stacksMutated = false;
          let nextStacks: Record<string, PanelGridCellStack> | undefined = row.cellStacks;
          if (row.cellStacks) {
            const out: Record<string, PanelGridCellStack> = {};
            for (const [primary, stack] of Object.entries(row.cellStacks)) {
              if (!currentKeys.has(primary)) { stacksMutated = true; continue; }
              const keptItems: string[] = [];
              const keptHeights: number[] = [stack.heights[0] ?? 1 / (stack.items.length + 1)];
              for (let i = 0; i < stack.items.length; i++) {
                if (currentKeys.has(stack.items[i])) {
                  keptItems.push(stack.items[i]);
                  keptHeights.push(stack.heights[i + 1] ?? 1 / (stack.items.length + 1));
                } else {
                  stacksMutated = true;
                }
              }
              if (keptItems.length === 0) { stacksMutated = true; continue; }
              const sum = keptHeights.reduce((s, h) => s + h, 0) || 1;
              out[primary] = { items: keptItems, heights: keptHeights.map(h => h / sum) };
            }
            nextStacks = Object.keys(out).length > 0 ? out : undefined;
          }

          const kept: number[] = [];
          for (let i = 0; i < row.itemKeys.length; i++) {
            if (currentKeys.has(row.itemKeys[i])) kept.push(i);
          }
          const itemKeysUnchanged = kept.length === row.itemKeys.length;
          if (itemKeysUnchanged && !stacksMutated) return row;
          mutated = true;
          if (kept.length === 0) return { itemKeys: [] as string[], widths: [] as number[] };
          const newItemKeys = kept.map(i => row.itemKeys[i]);
          const newWidths = kept.map(i => row.widths[i]);
          const total = newWidths.reduce((s, w) => s + w, 0);
          const nextRow: PanelGridRow = {
            itemKeys: newItemKeys,
            widths: total > 0
              ? newWidths.map(w => w / total)
              : newItemKeys.map(() => 1 / newItemKeys.length),
          };
          if (nextStacks) nextRow.cellStacks = nextStacks;
          return nextRow;
        }).filter(r => r.itemKeys.length > 0);
        return mutated ? next : prev;
      });
    }, 0);
    return () => clearTimeout(handle);
  }, [naturalGridItems, isServerHydrated]);

  // Sync row heights when row count changes. Same hydrate gate as above —
  // before hydrate, `gridRows` may be the persisted shape and we don't want
  // to overwrite the saved heights with a uniform distribution.
  useEffect(() => {
    if (!isServerHydrated) return;
    setGridRowHeights(prev => {
      if (prev.length === gridRows.length && gridRows.length > 0) return prev;
      return gridRows.map(() => 1 / Math.max(1, gridRows.length));
    });
  }, [gridRows.length, isServerHydrated]);

  // Phase 30 PANE-01: direct server fetches for grid layout have been removed.
  // Server persistence of pane layout flows through state/pane/middleware/syncServer.ts
  // (which writes the reducer snapshot under key `pane-store-v2`). Device-local
  // row/column persistence (so grid-edits survive reload within a single device)
  // is owned by usePanelGridPersistence.ts above.

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

  /* ---- Split pane: move a topic to its own solo pane ----
   *
   * 'right': solo the pane, append it as a new top-level cell in the
   * source's row (creates a new column).
   *
   * 'down': solo the pane, append it to the source cell's vertical
   * sub-stack (`cellStacks[primaryKey].items`), so the new pane lands
   * UNDER the source cell's column rather than spanning the full grid
   * width. When the source cell hosts no stack yet, this initializes
   * one with [primary_height=0.5, new_height=0.5].
   */
  const handleSplitPane = useCallback((topicId: string, direction: 'right' | 'down') => {
    // Check grid limits BEFORE marking as solo to prevent orphaned soloTopicIds
    const currentRows = gridRowsRef.current;
    if (direction === 'right') {
      const firstRow = currentRows[0];
      if (firstRow && firstRow.itemKeys.length >= MAX_COLS_PER_ROW) return;
    }
    // For 'down': cap the in-cell stack depth — beyond ~3 the panes get too
    // squat to be useful. MAX_ROWS no longer applies (we don't add rows).
    const MAX_STACK_DEPTH = 4;

    // Resolve the source CELL: the cell whose primary key the source pane
    // currently belongs to. For a tab dispatched from the standalone group
    // that's the cell with itemKey === 'standalone'; for a tab already in
    // its own solo pane it's the cell whose itemKey === 'solo:<topicId>',
    // OR a cell whose stack already contains 'solo:<topicId>'.
    const soloKey = `solo:${topicId}`;
    let sourceRowIdx = -1;
    let sourceColIdx = -1;
    let sourcePrimary = '';
    for (let r = 0; r < currentRows.length; r++) {
      const row = currentRows[r];
      // Pass 1: source already a top-level solo cell.
      const directIdx = row.itemKeys.indexOf(soloKey);
      if (directIdx >= 0) {
        sourceRowIdx = r;
        sourceColIdx = directIdx;
        sourcePrimary = soloKey;
        break;
      }
      // Pass 2: source nested inside a sibling cell's stack.
      if (row.cellStacks) {
        for (const [primary, stack] of Object.entries(row.cellStacks)) {
          if (stack.items.includes(soloKey)) {
            sourceRowIdx = r;
            sourceColIdx = row.itemKeys.indexOf(primary);
            sourcePrimary = primary;
            break;
          }
        }
        if (sourceRowIdx >= 0) break;
      }
    }
    if (sourceRowIdx === -1) {
      for (let r = 0; r < currentRows.length; r++) {
        const idx = currentRows[r].itemKeys.indexOf('standalone');
        if (idx >= 0) {
          sourceRowIdx = r;
          sourceColIdx = idx;
          sourcePrimary = 'standalone';
          break;
        }
      }
    }

    if (direction === 'down') {
      const sourceRow = currentRows[sourceRowIdx];
      const existingStack = sourceRow?.cellStacks?.[sourcePrimary];
      const currentDepth = (existingStack?.items.length ?? 0) + 1; // primary + items
      if (currentDepth >= MAX_STACK_DEPTH) return;
    }

    // Mark as solo (only after limit checks pass)
    setSoloTopicIds(prev => prev.includes(topicId) ? prev : [...prev, topicId]);

    setGridRows(prev => {
      // Re-check limits in the updater — `prev` may have shifted between
      // the ref read above and React running this updater.
      if (direction === 'right') {
        const firstRow = prev[0];
        if (firstRow && firstRow.itemKeys.length >= MAX_COLS_PER_ROW) return prev;
      }

      // Deep clone — including cellStacks — so we never mutate prev shape.
      let rows = prev.map(cloneRow);

      // Safety: remove soloKey from any top-level itemKeys (e.g. user
      // double-splits the same pane). Stack membership is left intact —
      // we'll handle dedupe inside the target stack below.
      for (const row of rows) {
        const idx = row.itemKeys.indexOf(soloKey);
        if (idx >= 0) {
          row.itemKeys.splice(idx, 1);
          row.widths.splice(idx, 1);
          if (row.cellStacks?.[soloKey]) {
            // Cell was the primary of a stack — drop the stack since the
            // primary is gone. Sub-items would orphan.
            const next = { ...row.cellStacks };
            delete next[soloKey];
            row.cellStacks = Object.keys(next).length > 0 ? next : undefined;
          }
          if (row.itemKeys.length > 0) {
            const total = row.widths.reduce((s, w) => s + w, 0);
            row.widths = total > 0
              ? row.widths.map(w => w / total)
              : row.itemKeys.map(() => 1 / row.itemKeys.length);
          }
        }
      }
      rows = rows.filter(r => r.itemKeys.length > 0);

      if (direction === 'down') {
        if (sourceRowIdx === -1 || rows.length === 0) {
          // No source — bootstrap a single-cell row.
          rows = [{ itemKeys: [soloKey], widths: [1] }];
          return rows;
        }
        const targetRow = rows[Math.min(sourceRowIdx, rows.length - 1)];
        const primaryIdx = sourcePrimary
          ? targetRow.itemKeys.indexOf(sourcePrimary)
          : -1;
        if (primaryIdx === -1) {
          // Fallback: insert as a new top-level cell in the row.
          targetRow.itemKeys.push(soloKey);
          targetRow.widths = targetRow.itemKeys.map(() => 1 / targetRow.itemKeys.length);
          return rows;
        }
        const stacks = targetRow.cellStacks ? { ...targetRow.cellStacks } : {};
        const existing = stacks[sourcePrimary];
        if (existing) {
          // Append to existing stack — re-balance heights uniformly.
          const slots = existing.items.length + 2; // primary + existing items + new
          stacks[sourcePrimary] = {
            items: [...existing.items, soloKey],
            heights: Array.from({ length: slots }, () => 1 / slots),
          };
        } else {
          stacks[sourcePrimary] = {
            items: [soloKey],
            heights: [0.5, 0.5],
          };
        }
        targetRow.cellStacks = stacks;
        return rows;
      }

      // direction === 'right': insert as a new top-level cell
      if (rows.length === 0) {
        rows = [{ itemKeys: [soloKey], widths: [1] }];
      } else {
        const targetRow = sourceRowIdx >= 0 && sourceRowIdx < rows.length
          ? rows[sourceRowIdx]
          : rows[0];
        // Insert immediately to the right of the source column when we
        // have one — better UX than always at the end of the row.
        const insertAt = sourceColIdx >= 0 ? sourceColIdx + 1 : targetRow.itemKeys.length;
        targetRow.itemKeys.splice(insertAt, 0, soloKey);
        targetRow.widths = targetRow.itemKeys.map(() => 1 / targetRow.itemKeys.length);
      }
      return rows;
    });

    // Focus the split-out panel so the source group falls back to its first remaining tab
    onFocusPanel(topicId);
  }, [onFocusPanel]);

  /* ---- Unsolo: merge a solo topic back into the main standalone group ---- */
  const handleUnsoloTopic = useCallback((topicId: string) => {
    setSoloTopicIds(prev => prev.filter(id => id !== topicId));
  }, []);

  /* ---- Auto-solo: a newly created utility pane (terminal/browser) created via
         quick-create should land in its own grid cell rather than join the
         standalone group with existing panels. The parent (App) signals which
         pane to solo via pendingSoloPanelId. We only apply it when there are
         already other panels open — solo'ing a single pane is a no-op visually
         but pollutes the soloTopicIds list. ---- */
  useEffect(() => {
    if (!pendingSoloPanelId) return;
    const id = pendingSoloPanelId;
    // Only auto-solo if there are other panels already open AND this pane is
    // not already solo. A pane that's the only one open doesn't need solo.
    const otherOpen = openPanels.filter(p => p !== id).length > 0;
    if (otherOpen) {
      setSoloTopicIds(prev => prev.includes(id) ? prev : [...prev, id]);
    }
    onPendingSoloPanelIdConsumed?.();
  }, [pendingSoloPanelId, openPanels, onPendingSoloPanelIdConsumed]);

  /* ---- drag state (for cross-window panel drag) ---- */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [emptyDragOver, setEmptyDragOver] = useState(false);
  /**
   * True while a tab or grid-item drag is in progress anywhere within the
   * grid — used by InsertDividers to widen their drop hit-zone (1px → 30px)
   * and render the visible drop indicator. PanelGrid receives `dragstart`
   * via React bubbling from any descendant tab-bar or grid cell. We don't
   * inspect `dataTransfer.types` here (would force preventing fast paths);
   * the divider's own dragover already filters on type before accepting.
   */
  const [isAnyDragActive, setIsAnyDragActive] = useState(false);
  const handleAnyDragStart = useCallback(() => setIsAnyDragActive(true), []);
  const handleAnyDragEnd = useCallback(() => setIsAnyDragActive(false), []);

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

    // Reject tab drags that don't carry PANEL_ID (shouldn't happen, but guard)
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

    // For PANE_TAB drags: let children handle center zone (tab reorder, project drops)
    // and top zone (tab bar lives at top — don't intercept same-cell tab reorders).
    // Only intercept left/right/bottom edges for grid-level splits.
    if (isTabDrag && !isGridDrag && (zone === 'center' || zone === 'top')) {
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

  const handleGridItemDropCapture = useCallback((
    e: React.DragEvent,
    /**
     * Optional explicit drop spec from a non-cell drop surface (e.g. an
     * insert-between divider). When provided, we trust the caller's
     * (rowIdx, colIdx, zone) rather than recomputing from the pointer
     * relative to `e.currentTarget` (which would be the divider, not the
     * target cell). The drag payload (PANE_TAB / GRID_ITEM) on the event
     * is still read normally.
     */
    explicitTarget?: { rowIdx: number; colIdx: number; zone: DropZone; centerSide?: 'left' | 'right' },
  ) => {
    // Read from ref for synchronous access (state may lag behind after dragover)
    const dropTarget = explicitTarget ?? gridDropTargetRef.current;
    if (!dropTarget) return;

    // Re-verify drop zone from actual mouse position at drop time — but only
    // for cell drops. Divider drops pass `explicitTarget`; recomputing from
    // the divider element would always yield a useless 'center'/'left' value.
    const actualZone = explicitTarget
      ? explicitTarget.zone
      : computeDropZone(e, e.currentTarget as HTMLElement);

    let effectiveKey = e.dataTransfer.getData(DND_TYPES.GRID_ITEM);
    const sourcePaneTab = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceTopicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);

    // PANE_TAB drops: edge zones create split + move tab, center lets tab bar handle reorder.
    if (!effectiveKey && sourcePaneTab) {
      // Use actual zone at drop time, not the stale dragover zone
      if (actualZone === 'center') return;
      if (actualZone === 'top') return;
      if (!sourceTopicId) return;
      // Update dropTarget zone to match actual position
      dropTarget.zone = actualZone;
    } else if (effectiveKey) {
      // GRID_ITEM drops suffer the same dragover-lag risk: fast edge-to-edge
      // drags can leave dropTarget.zone one frame behind the cursor. Sync
      // both zone and centerSide from the actual pointer position so the
      // reorder/split below acts on where the mouse actually is at drop —
      // unless the caller explicitly told us where to land (divider drops).
      dropTarget.zone = actualZone;
      if (!explicitTarget && actualZone === 'center') {
        const cell = e.currentTarget as HTMLElement;
        const rect = cell.getBoundingClientRect();
        dropTarget.centerSide =
          e.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
      }
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

        // Mark as solo first — if grid placement fails, the sync effect will clean up
        setSoloTopicIds(prev => prev.includes(sourceTopicId) ? prev : [...prev, sourceTopicId]);

        setGridRows(prev => {
          // Enforce grid limits
          if ((zone === 'top' || zone === 'bottom') && prev.length >= MAX_ROWS) return prev;
          if ((zone === 'left' || zone === 'right' || zone === 'center') && prev[targetRowIdx]?.itemKeys.length >= MAX_COLS_PER_ROW) return prev;

          const targetKey = prev[targetRowIdx]?.itemKeys[targetColIdx];
          if (!targetKey) return prev;

          // ISSUE 8 FIX: Use immutable operations instead of splice()
          let rows = prev.map(cloneRow);

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
          let rows = prev.map(cloneRow);
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
      let rows = prev.map(cloneRow);

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

  /* ---- Insert-between handlers (column / row dividers) ----
   *
   * Both delegate the actual reshape into `setGridRows` to the same logic the
   * cell-edge drop uses (lines ~700-845). Repeating that block inline would
   * accumulate two parallel implementations; instead we synthesize a drop
   * target that the existing handler already understands:
   *
   *   - column divider between cells N and N+1 → target cell N, zone='right'
   *   - row divider between rows N and N+1     → target cell at row N
   *                                              col 0, zone='bottom'
   *
   * The drag's data payload (PANE_TAB / GRID_ITEM) is intact on the event so
   * the existing path picks it up unchanged.
   */

  const handleInsertBetweenColumns = useCallback(
    (rowIdx: number, colIdx: number, e: React.DragEvent) => {
      handleGridItemDropCapture(e, { rowIdx, colIdx, zone: 'right' });
    },
    [handleGridItemDropCapture],
  );

  const handleInsertBetweenRows = useCallback(
    (rowIdx: number, e: React.DragEvent) => {
      // Use col 0 of the row above the divider as the anchor; the existing
      // handler reads `targetKey` from `gridRows[rowIdx].itemKeys[colIdx]`
      // to position the new row, then `zone='bottom'` inserts BELOW it.
      handleGridItemDropCapture(e, { rowIdx, colIdx: 0, zone: 'bottom' });
    },
    [handleGridItemDropCapture],
  );

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

  /**
   * Resize handler invoked by `CellSubStack` when the user drags one of its
   * in-cell vertical dividers. Replaces the heights for the named cell-stack
   * and re-normalizes (defensive — CellSubStack already keeps the sum
   * stable, but rounding drift compounds).
   *
   * MUST be declared BEFORE the empty-state early return below — React's
   * hook-order rules require the same number of hook calls every render,
   * and the empty-state branch returns early before reaching the cell
   * render path. Placing this after that return triggered React error
   * #310 the moment the first pane opened.
   */
  const handleCellStackResize = useCallback(
    (rowIdx: number, primaryKey: string, nextHeights: number[]) => {
      setGridRows(prev => {
        if (rowIdx < 0 || rowIdx >= prev.length) return prev;
        const row = prev[rowIdx];
        const stack = row.cellStacks?.[primaryKey];
        if (!stack) return prev;
        if (nextHeights.length !== stack.items.length + 1) return prev;
        const sum = nextHeights.reduce((s, h) => s + h, 0) || 1;
        const normalized = nextHeights.map(h => h / sum);
        const nextStacks = { ...row.cellStacks, [primaryKey]: { ...stack, heights: normalized } };
        const nextRow: PanelGridRow = { ...row, cellStacks: nextStacks };
        return prev.map((r, i) => (i === rowIdx ? nextRow : r));
      });
    },
    [setGridRows],
  );

  /**
   * Render a `<StandaloneChatGroup>` for a given cell key. Centralizing the
   * prop wiring here lets the cell's primary AND each item in a vertical
   * sub-stack reuse the exact same group configuration without duplicating
   * the ~30-prop call site twice. App-singleton concerns (sidebar toggle,
   * standalone-only utility/browser hooks) are scoped to the primary cell
   * at row 0 col 0; sub-stack items intentionally don't get them.
   *
   * Also pre-empty-state — see `handleCellStackResize` rationale above.
   */
  const renderGroupForKey = useCallback(
    (item: GridItem, key: string, rowIdx: number, colIdx: number) => (
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
        onToggleSidebar={rowIdx === 0 && colIdx === 0 ? onToggleSidebar : undefined}
        panelInitialTab={panelInitialTab}
        onPanelInitialTabConsumed={onPanelInitialTabConsumed}
        onNewChat={onNewChat}
        pendingProjectPane={pendingProjectPane}
        onPendingProjectPaneConsumed={onPendingProjectPaneConsumed}
        onNewChatInProject={onNewChatInProject}
        pendingProjectFocus={pendingProjectFocus}
        onPendingProjectFocusConsumed={onPendingProjectFocusConsumed}
        onProjectActiveTopicChange={onProjectActiveTopicChange}
        onProjectOpenPanesChange={onProjectOpenPanesChange}
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
    ),
    [
      topics, focusedPanelId, onFocusPanel, onClosePanel, handleDragStart,
      handleGridItemDragStart, getSessionMessages, isSessionLoading,
      isSessionStreaming, stopSession, sendMessage, editMessage, switchBranch,
      loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
      onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed, onNewChat,
      pendingProjectPane, onPendingProjectPaneConsumed, onNewChatInProject,
      pendingProjectFocus, onPendingProjectFocusConsumed,
      onProjectActiveTopicChange, onProjectOpenPanesChange, terminalSessions,
      onCreateTerminal, handleStandaloneUtilityChange, pendingBrowserPane,
      onPendingBrowserPaneConsumed, onOpenBrowserContextIds, promoteDraft,
      draftMeta, handleSplitPane, handleUnsoloTopic,
    ],
  );

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
      onDragStartCapture={handleAnyDragStart}
      onDragEnd={(e) => { handleDragEnd(e); handleGridItemDragEnd(); handleAnyDragEnd(); }}
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

              const splitOverlayStyle: React.CSSProperties | null = (zone === 'left' || zone === 'right' || zone === 'top' || zone === 'bottom')
                ? {
                    position: 'absolute',
                    pointerEvents: 'none',
                    zIndex: 40,
                    background: 'color-mix(in srgb, var(--primary) 15%, transparent)',
                    border: '2px dashed var(--primary)',
                    borderRadius: '4px',
                    transition: 'all 150ms ease',
                    top: zone === 'bottom' ? '50%' : 0,
                    bottom: zone === 'top' ? '50%' : 0,
                    left: zone === 'right' ? '50%' : 0,
                    right: zone === 'left' ? '50%' : 0,
                  }
                : null;

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
                    {splitOverlayStyle && (
                      <div
                        data-grid-split-overlay={zone}
                        style={splitOverlayStyle}
                      />
                    )}
                    {/* Unified standalone group (handles chat, utility, and
                        project tabs). When the cell hosts a vertical
                        sub-stack (split-down inside this column), wrap it
                        in <CellSubStack> so the primary sits on top and
                        each stack item renders as its own single-tab group
                        beneath. The stack heights drive flex-grow ratios
                        and the in-cell divider lets the user resize. */}
                    {(() => {
                      const stack = row.cellStacks?.[key];
                      const primaryGroup = renderGroupForKey(item, key, rowIdx, colIdx);
                      if (!stack) return primaryGroup;
                      return (
                        <CellSubStack
                          stack={stack}
                          primary={primaryGroup}
                          renderStackItem={(stackKey) => {
                            const stackItem = itemMap.get(stackKey);
                            if (!stackItem) return null;
                            return renderGroupForKey(stackItem, stackKey, rowIdx, colIdx);
                          }}
                          onResize={(nextHeights) =>
                            handleCellStackResize(rowIdx, key, nextHeights)
                          }
                          isDragActive={isAnyDragActive}
                        />
                      );
                    })()}

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
                    <ColumnInsertDivider
                      rowIdx={rowIdx}
                      colIdx={colIdx}
                      widths={row.widths}
                      isDragActive={isAnyDragActive}
                      onResizeStart={startHorizontalResize(rowIdx, colIdx, row.widths)}
                      onInsertBetween={handleInsertBetweenColumns}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Row divider (between rows) — hidden on mobile */}
          {rowIdx < gridRows.length - 1 && !isMobile && (
            <RowInsertDivider
              rowIdx={rowIdx}
              isDragActive={isAnyDragActive}
              onResizeStart={startVerticalResize(rowIdx, gridRowHeights)}
              onInsertBetween={handleInsertBetweenRows}
            />
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
