import { useState, useCallback, useRef, useEffect, useMemo, Fragment, Suspense, lazy } from 'react';
import type { TerminalAgentType } from '../../../../shared/terminal-session-types';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelGridRow, PanelGridCellStack, CompactionMarker } from '../../types';
import { useTopics } from '../../contexts/TopicsContext';
import { StandaloneChatGroup } from './StandaloneChatGroup';
import type { SplitMapDescriptor } from '../Shared/SplitMiniMap';
import { usePublishSplitPositions } from '../../contexts/SplitPositionContext';
import { getProjectPathFromPaneId } from '../../state/pane/adapters';
import { getProjectGridWeight, subscribeProjectGridWeights, type ProjectGridWeight } from '../../state/projectGridWeights';
import { useGridResize } from '../../hooks/useGridResize';
import { useLayoutMobile } from '../../hooks/useMobile';
import { DND_TYPES, dragMatchesScope, STANDALONE_SCOPE } from '../../lib/dndTypes';
import { usePanelGridPersistence } from './usePanelGridPersistence';
import { startDragPreview } from '../../lib/dragPreview';
import { getProjectLabel } from '../../lib/buildSidebarItems';
import { detachPaneToNewSpace } from '../../lib/popOutSpace';
// A banner for a RARE state (messages that expired unsent): as a static import
// it and its grouping sat in the eager entry for every boot (3 KB raw,
// measured 2026-09-06). Its first mount is an event, not a paint: a fallback
// frame there costs nobody anything.
const UnsentBanner = lazy(async () => ({ default: (await import('./UnsentBanner')).UnsentBanner }));
import { DetachedWindowMarker } from './DetachedWindowMarker';
import { usePaneStore } from '../../state/pane/store';
import { useServerHydrated } from '../../hooks/useServerHydrated';
import { ColumnInsertDivider, RowInsertDivider } from './InsertDividers';
import { CellSubStack } from './CellSubStack';
import { MAX_COLS_PER_ROW, MAX_ROWS, MAX_STACK_DEPTH, MIN_PANE_FRACTION, TAB_BAR_H } from './constants';
import { detectDropZone, type DropZone } from '../../lib/dropZone';
import { SplitRegion, CenterRegion, FullWidthRowZone, RowGapDropZone } from './DropOverlay';
import { splitColumnWidths, appendColumnWidths, chooseSplitOrientation, weightedWidths, equalizeWidths } from './gridWidths';
import { notifyPaneReflow } from './paneReflow';
import { extractToOwnCell, removeTopicFromCells, moveTopicToCell, pruneSoloCells, flattenSoloCells, soloCellKey, primaryFromSoloCellKey, remapTopicInCells, reorderCellPreservingPrimary } from './soloCells';
import { recordSoloTombstones, restoreFromSoloTombstones, type SoloCellTombstone } from './soloCellTombstones';
import { pushUndo } from '../../contexts/UndoContext';
import { useRefMirror } from '../../hooks/useRefMirror';
import { SplitTree } from './SplitTree';
import { type LayoutNode } from '../../state/layout/layoutTree';
import { buildShallowGridTree } from '../../state/layout/legacyAdapters';
import { pxToWeightDelta, resizeWeights } from '../../state/layout/splitController';
import type { SendMessageOptions } from '@/hooks/useChat';
import { shortcut } from '../../lib/shortcutLabel';

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

/** La riga contiene questa cella di primo livello? (Le celle IMPILATE dentro
 *  un'altra non contano: le disegna la loro ospite, che è quella con la chiave
 *  in `itemKeys`.) Serve al ramo telefono, che nasconde le righe senza il
 *  riquadro a fuoco — vedi `mobileVisibleKey`. */
function rowHoldsKey(row: PanelGridRow, key: string): boolean {
  return row.itemKeys.includes(key);
}

/**
 * Remove a top-level cell `key` from a row, preserving the OTHER cells'
 * sub-stacks (a bare `{ itemKeys, widths }` rebuild is the exact data loss
 * cloneRow's contract warns about). If the removed key hosted a sub-stack,
 * that entry is detached and returned so the caller decides its fate:
 * re-attach at the destination for a move, or drop it when the additive
 * sync is about to re-home the orphans anyway.
 */
/** Rename a top-level key in place — slot, width and sub-stack survive.
 *  Used when a multi-tab cell re-keys (its primary left the cell): pruning
 *  the old key and re-appending the new one teleported the cell to row 0. */
function renameKeyInRow(row: PanelGridRow, from: string, to: string): PanelGridRow {
  const idx = row.itemKeys.indexOf(from);
  if (idx < 0) return row;
  const itemKeys = row.itemKeys.map((k, i) => (i === idx ? to : k));
  const next: PanelGridRow = { itemKeys, widths: row.widths };
  if (row.cellStacks) {
    const { [from]: moved, ...rest } = row.cellStacks;
    const stacks = { ...rest, ...(moved ? { [to]: moved } : {}) };
    if (Object.keys(stacks).length > 0) next.cellStacks = stacks;
  }
  return next;
}

/** Remove a key from whichever sub-stack contains it (heights renormalized,
 *  emptied stack entries dropped). Top-level itemKeys are untouched — used
 *  when the dragged key lives INSIDE a cell's stack, which the top-level
 *  removeKeyFromRow can't see. */
function removeKeyFromStacks(row: PanelGridRow, key: string): PanelGridRow {
  if (!row.cellStacks) return row;
  let changed = false;
  const out: Record<string, PanelGridCellStack> = {};
  for (const [primary, stack] of Object.entries(row.cellStacks)) {
    const idx = stack.items.indexOf(key);
    if (idx < 0) { out[primary] = stack; continue; }
    changed = true;
    const items = stack.items.filter((_, i) => i !== idx);
    if (items.length === 0) continue; // stack collapses to just the primary
    // Heights track [primary, ...items] — drop the removed item's slot.
    const heights = stack.heights.filter((_, i) => i !== idx + 1);
    const sum = heights.reduce((s, h) => s + h, 0) || 1;
    out[primary] = { items, heights: heights.map(h => h / sum) };
  }
  if (!changed) return row;
  const next: PanelGridRow = { itemKeys: row.itemKeys, widths: row.widths };
  if (Object.keys(out).length > 0) next.cellStacks = out;
  return next;
}

/** Rename a key ANYWHERE in a row — top-level slot / stack HOST key
 *  (renameKeyInRow) AND stack ITEM lists. Returns the same ref when the key
 *  is absent. Used by the pane-id remap listener (draft → topic promotion),
 *  where the promoted cell may live at top level or inside a sub-stack. */
function renameKeyDeep(row: PanelGridRow, from: string, to: string): PanelGridRow {
  let next = renameKeyInRow(row, from, to);
  if (next.cellStacks) {
    let changed = false;
    const stacks: Record<string, PanelGridCellStack> = {};
    for (const [host, stack] of Object.entries(next.cellStacks)) {
      if (!stack.items.includes(from)) { stacks[host] = stack; continue; }
      changed = true;
      stacks[host] = { ...stack, items: stack.items.map(k => (k === from ? to : k)) };
    }
    if (changed) next = { ...(next === row ? row : next), cellStacks: stacks };
  }
  return next;
}

function removeKeyFromRow(
  row: PanelGridRow,
  key: string,
): { row: PanelGridRow; detachedStack?: PanelGridCellStack } {
  const idx = row.itemKeys.indexOf(key);
  if (idx < 0) return { row };
  const itemKeys = row.itemKeys.filter((_, i) => i !== idx);
  const widths = row.widths.filter((_, i) => i !== idx);
  const total = widths.reduce((s, w) => s + w, 0);
  const next: PanelGridRow = {
    itemKeys,
    widths: itemKeys.length === 0
      ? widths
      : total > 0 ? widths.map(w => w / total) : itemKeys.map(() => 1 / itemKeys.length),
  };
  let detachedStack: PanelGridCellStack | undefined;
  if (row.cellStacks) {
    const { [key]: detached, ...rest } = row.cellStacks;
    detachedStack = detached;
    if (Object.keys(rest).length > 0) next.cellStacks = rest;
  }
  return { row: next, detachedStack };
}


// Check if running in native macOS app (has webkit message handlers)
const isNativeApp = typeof window !== 'undefined' && !!(window as Window & { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers;

/**
 * Compute the drop zone under the cursor at the exact moment of drop.
 * dragover events can lag a frame behind the cursor on fast edge-to-edge
 * drags, so consumers recompute from the live event rather than trusting
 * whatever the last dragover recorded.
 */
function computeDropZone(e: React.DragEvent, cell: HTMLElement): DropZone {
  // 5-zone (edges + center) — the inner area is meaningful here for tab
  // reorder/merge intent. Non-null because mode is 'edges+center'.
  return detectDropZone(e, cell.getBoundingClientRect(), 'edges+center')!;
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
  onFocusPanel: (topicId: string) => void;
  /** Default close — typically deferred via the PendingAction countdown. */
  onClosePanel: (topicId: string) => void;
  /** Optional immediate close (bypass countdown). Wired by App so the
   *  right-click "Close now" entry on standalone top-level tabs skips the
   *  toast. Falls back to onClosePanel if not provided. */
  onClosePanelImmediate?: (topicId: string) => void;
  onReorderPanels: (panels: string[]) => void;
  onOpenPanelAt: (topicId: string, index: number) => void;
  nextPanelMode?: 'side' | 'below';
  onPanelModeUsed?: () => void;
  getSessionMessages: (sessionKey: string) => ChatMessage[];
  getCompactionMarkers?: (sessionKey: string) => CompactionMarker[];
  isSessionLoading: (sessionKey: string) => boolean;
  isSessionStreaming: (sessionKey: string) => boolean;
  wasSessionStopped: (sessionKey: string) => boolean;
  stopSession: (sessionKey: string) => Promise<boolean>;
  sendMessage: (sessionKey: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  editMessage?: (sessionKey: string, messageId: string, newContent: string) => Promise<boolean>;
  regenerateMessage?: (sessionKey: string, messageId: string) => Promise<boolean>;
  deleteMessage?: (sessionKey: string, messageId: string) => Promise<boolean>;
  switchBranch?: (sessionKey: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sessionKey: string) => Promise<boolean>;
  chatError: Record<string, string | null>;
  expiredMessages?: { sessionKey: string; content: string; timestamp: string; options?: SendMessageOptions }[];
  retryExpired?: (item: { sessionKey: string; content: string; timestamp: string; options?: SendMessageOptions }) => void;
  clearExpired?: () => void;
  /** Discard the expired messages of ONE chat (the banner is per chat). */
  dismissExpiredSession?: (sessionKey: string) => void;
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
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType; terminalSessionId?: string; terminalType?: TerminalAgentType } | null;
  onPendingProjectPaneConsumed?: () => void;
  // Create new chat in a project
  onNewChatInProject?: (projectPath: string, groupId?: string) => void;
  // Create new standalone chat
  onNewChat?: () => void;
  // Pending focus for project tabs (navigate to a topic inside a project)
  pendingProjectFocus?: { projectPath: string; topicId: string; targetGroupId?: string } | null;
  onPendingProjectFocusConsumed?: () => void;
  // Report which topic is active inside a project (keyed by projectPath)
  onProjectActiveTopicChange?: (projectPath: string, topicId: string | null) => void;
  // Report all open pane IDs inside each project (for sidebar filtering)
  onProjectOpenPanesChange?: (projectPath: string, paneIds: string[]) => void;
  // Create a new terminal (delegates to App)
  onCreateTerminal?: (type: TerminalAgentType, skipPermissions?: boolean) => void | Promise<string | null>;
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
  promoteDraft?: (draftId: string, firstMessage: string, options?: SendMessageOptions) => Promise<void>;
  draftMeta?: Record<string, { projectPath?: string }>;
  // Sidebar "Fissati" pin toggle + state for a tab's subject (chat topicId or
  // `terminal:<sessionId>`), forwarded to each StandaloneChatGroup → PaneTabBar.
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
}

/* ================================================================== */

export function PanelGrid({
  openPanels,
  focusedPanelId,
  onFocusPanel,
  onClosePanel,
  onClosePanelImmediate,
  onToggleFissato,
  isFissato,
  onReorderPanels,
  onOpenPanelAt,
  nextPanelMode: _nextPanelMode = 'side',
  onPanelModeUsed: _onPanelModeUsed,
  getSessionMessages,
  getCompactionMarkers,
  isSessionLoading,
  isSessionStreaming,
  wasSessionStopped,
  stopSession,
  sendMessage,
  editMessage,
  regenerateMessage,
  deleteMessage,
  switchBranch,
  loadHistory,
  chatError,
  expiredMessages,
  retryExpired,
  clearExpired,
  dismissExpiredSession,
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
  onCreateTerminal,
  pendingBrowserPane,
  onPendingBrowserPaneConsumed,
  pendingSoloPanelId,
  onPendingSoloPanelIdConsumed,
  onOpenBrowserContextIds,
  promoteDraft,
  draftMeta,
}: PanelGridProps) {
  // Topics + terminal sessions come from TopicsContext — both used to be
  // drilled here as props. Single read at the top so the rest of the
  // function reads them by name as before.
  const topics = useTopics();
  const containerRef = useRef<HTMLDivElement>(null);

  // Mobile detection for single-column layout: the shared layout predicate,
  // so that «are there splits here?» has one answer and not one per file.
  const isMobile = useLayoutMobile();

  /* ---- All panels are treated flat (no project grouping) ---- */
  /* Device-local layout persistence (rows, row heights, solo IDs) — see
   * usePanelGridPersistence.ts. Review I2: factored out to keep this file
   * focused on layout math / DnD. */
  // The `naturalGridItems` sync effect (below) is gated on this flag so it
  // doesn't prune the saved layout during the boot window when `openPanels`
  // is still empty. Persistence is NOT gated — see usePanelGridPersistence
  // for the rationale.
  const isServerHydrated = useServerHydrated();

  // Active Spazio — the grid layout is PER-SPACE (App remounts this component
  // via key={activeSpaceId}, so the value is mount-stable and the persistence
  // initializers re-read the per-space key on every switch).
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);

  const {
    gridRows,
    setGridRows,
    gridRowHeights,
    setGridRowHeights,
    soloCellsRaw,
    setSoloCells,
  } = usePanelGridPersistence(activeSpaceId);

  // Effective split cells, pruned to currently-open panels (drops closed topics
  // and any emptied cell) so naturalGridItems never references a gone pane.
  // A cell may hold MULTIPLE tabs (multi-tab split column), coherent with the
  // project groups model — see soloCells.ts.
  const soloCells = useMemo(
    () => pruneSoloCells(soloCellsRaw, new Set(openPanels)),
    [soloCellsRaw, openPanels],
  );
  // Previous render's cell composition — lets the additive sync detect a
  // RE-KEYED cell (primary closed → next member became primary) and rename
  // it in place instead of treating it as removed+new. Updated in an effect
  // placed AFTER the two grid-sync effects so they read the pre-change value.
  const prevSoloCellsRef = useRef<string[][]>(soloCells);
  // Flat set of solo'd topics — what the rest of the grid checks membership on.
  const soloTopicIds = useMemo(() => flattenSoloCells(soloCells), [soloCells]);

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

    // One grid cell per SOLO CELL. A cell may hold multiple tabs (multi-tab
    // split column), keyed by its primary (first) topic — `solo:<primary>`.
    // A single-topic cell renders exactly like the old `solo:<id>`.
    for (const cell of soloCells) {
      items.push({ key: soloCellKey(cell), panelIds: cell });
    }

    return items;
  }, [openPanels, soloCells, soloTopicIds, standaloneHasUtility, pendingBrowserPane]);

  // (The workspaceGroups mirror lived here: an ephemeral publish of this
  // window's grid cells, read by the old "Finestre" sidebar section. Both are
  // gone — the sidebar groups by SPAZIO now, which is synced state with an
  // identity, not a device-local echo of the current split geometry.)

  // Live ref for the sync effect's setGridRows updater. The updater can run
  // AFTER another setGridRows from a user handler (e.g. handleSplitPane)
  // commits — closing over `naturalGridItems` from the effect schedule
  // would see a one-render-stale snapshot and silently prune just-added
  // sub-stack items. The ref always points at the latest derivation.
  const naturalGridItemsRef = useRefMirror(naturalGridItems);

  /* ---- Item lookup map ---- */
  const itemMap = useMemo(() => {
    const m = new Map<string, GridItem>();
    for (const item of naturalGridItems) m.set(item.key, item);
    return m;
  }, [naturalGridItems]);

  // Read-time self-heal (CHAT-REL-02): `gridRows` absorbs naturalGridItems in a
  // POST-render effect gated on isServerHydrated (additive sync below). On the
  // very render where an item first appears — e.g. a fresh "New Chat" draft —
  // or on a cold client whose hydrate hasn't flipped yet, gridRows can lack the
  // item's key entirely. Rendering straight from gridRows then paints NOTHING:
  // the app looks blank (no other tabs) or the click looks like a no-op (other
  // tabs present) while the pane store already holds the pane. Derive the rows
  // the RENDER uses by appending a synthetic row for any item key missing from
  // every row and cellStack; the additive sync persists the real row next tick
  // and converges with what was already painted (same key → no remount).
  const effectiveGridRows = useMemo<PanelGridRow[]>(() => {
    const present = collectAllPresentKeys(gridRows);
    const missing = naturalGridItems.map(i => i.key).filter(k => !present.has(k));
    if (missing.length === 0) return gridRows;
    return [...gridRows, { itemKeys: missing, widths: missing.map(() => 1 / missing.length) }];
  }, [gridRows, naturalGridItems]);

  // ── UNA SUPERFICIE ALLA VOLTA, SUL TELEFONO ─────────────────────────────
  // Il ramo mobile impila i riquadri in colonna (`flex-col`, in fondo al file):
  // con la striscia delle tab tolta da ogni gruppo, una pila di due o piu'
  // riquadri sarebbe una pila ANONIMA. E la pila non nasce da un gesto fatto
  // sul telefono, la eredita dal layout del desktop, che si sincronizza.
  // Quindi qui si disegna il riquadro che ha il fuoco e gli altri restano
  // montati ma `display:none` (stessa tecnica di `PaneKeepAlive`: lo stato,
  // scroll della chat, buffer del terminale, form a meta', non muore quando
  // cambi superficie, cosa che smontarli farebbe).
  //
  // Il fuoco puo' stare in un riquadro IMPILATO dentro una cella
  // (`cellStacks`): in quel caso si mostra la cella che lo ospita, perche' e'
  // lei a disegnarlo.
  const mobileVisibleKey = useMemo<string | null>(() => {
    if (!isMobile) return null;
    const firstKey = effectiveGridRows[0]?.itemKeys[0] ?? null;
    if (!focusedPanelId) return firstKey;
    for (const row of effectiveGridRows) {
      for (const key of row.itemKeys) {
        if (itemMap.get(key)?.panelIds.includes(focusedPanelId)) return key;
        for (const stacked of row.cellStacks?.[key]?.items ?? []) {
          if (itemMap.get(stacked)?.panelIds.includes(focusedPanelId)) return key;
        }
      }
    }
    return firstKey;
  }, [isMobile, effectiveGridRows, itemMap, focusedPanelId]);

  // Weighted "equalize": a cell that hosts a PROJECT with internal splits should
  // claim more of the row/column than a single-pane cell, so that double-clicking
  // an outer divider makes the LEAF panes equal — not the top-level cells. Each
  // cell's weight is its project's leaf count (cols for horizontal, rows for
  // vertical) read from the projectGridWeights registry, or 1 for a plain
  // chat/utility cell. The weight arrays are built at render to feed the
  // onEqualize closures (a few cheap Map lookups), but the registry is a plain
  // module store — NOT reactive — so a project's internal resize publishing a
  // new weight never re-renders this grid; the fresh value is simply read on the
  // next equalize click.
  //
  // A cell can hold MANY project tabs (a multi-tab split column), but only the
  // ACTIVE one is mounted and publishes its split extent — background tabs have
  // no registry entry. So we must weight by the *visible* project, NOT the first
  // pane id: the old code returned `panelIds[0]`'s path, which on a multi-project
  // column was usually a hidden background tab → its weight was absent → the cell
  // counted as 1 and the outer equalize ignored the active project's split (the
  // "non bilancia più i pesi" regression). Pick the project pane that actually
  // has a published weight — that's the mounted/active one.
  const cellProjectWeight = useCallback((key: string): ProjectGridWeight => {
    const item = itemMap.get(key);
    if (!item) return { cols: 1, rows: 1 };
    for (const pid of item.panelIds) {
      const pp = getProjectPathFromPaneId(pid);
      if (!pp) continue;
      const w = getProjectGridWeight(pp);
      if (w) return w;
    }
    return { cols: 1, rows: 1 };
  }, [itemMap]);
  const rowColumnWeights = useCallback((row: PanelGridRow): number[] =>
    row.itemKeys.map((key) => cellProjectWeight(key).cols), [cellProjectWeight]);
  const rowHeightWeights = useCallback((rowsForWeight: PanelGridRow[]): number[] =>
    rowsForWeight.map((row) => {
      // A row is as tall as its tallest cell wants to be (max leaf rows), so a
      // project with a deep internal stack pulls its whole row taller.
      let w = 1;
      for (const key of row.itemKeys) {
        const r = cellProjectWeight(key).rows;
        if (r > w) w = r;
      }
      return w;
    }), [cellProjectWeight]);

  // True when a cell hosts any of the given project paths (active OR background
  // tab) — used to scope an auto-rebalance to only the rows that actually
  // changed, leaving unrelated rows' manual widths untouched.
  const cellReferencesProject = useCallback((key: string, paths: ReadonlySet<string>): boolean => {
    const item = itemMap.get(key);
    if (!item) return false;
    for (const pid of item.panelIds) {
      const pp = getProjectPathFromPaneId(pid);
      if (pp && paths.has(pp)) return true;
    }
    return false;
  }, [itemMap]);

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
      // Re-keyed cells: when a multi-tab cell's PRIMARY closes, the cell
      // re-keys to its next member (soloCellKey = first topic). To this sync
      // that looks like "old key gone, brand-new key appeared" — the cell
      // got pruned from its slot and re-appended to the end of row 0,
      // losing position and width. Detect the re-key by matching the new
      // key's topic against the PREVIOUS soloCells composition and rename
      // in place instead. (Drag-extracting a primary renames at the drop
      // site — there the old key survives as the extracted cell, which the
      // liveKeys guard below correctly skips.)
      const liveKeys = new Set(liveItems.map(i => i.key));
      const prevCells = prevSoloCellsRef.current;
      const renames = new Map<string, string>();
      for (const k of newKeys) {
        const topic = primaryFromSoloCellKey(k);
        if (!topic) continue;
        const oldCell = prevCells.find(c => c.includes(topic));
        if (!oldCell) continue;
        const oldKey = soloCellKey(oldCell);
        if (oldKey === k || liveKeys.has(oldKey) || !existing.has(oldKey)) continue;
        renames.set(oldKey, k);
      }
      let base = prev;
      if (renames.size > 0) {
        base = prev.map(row => {
          let r = row;
          for (const [from, to] of renames) r = renameKeyInRow(r, from, to);
          return r;
        });
      }
      const renamedTo = new Set(renames.values());
      const appendKeys = newKeys.filter(k => !renamedTo.has(k));
      if (appendKeys.length === 0) return base;
      if (base.length === 0) {
        return [{ itemKeys: appendKeys, widths: appendColumnWidths([], appendKeys.length) }];
      }
      const first = base[0];
      const allKeys = [...first.itemKeys, ...appendKeys];
      return [
        {
          itemKeys: allKeys,
          // Give the new keys a fair share but keep the existing columns' manual
          // widths in proportion (was `1/n` — reset the row on every pane add).
          widths: appendColumnWidths(first.widths, appendKeys.length),
          ...(first.cellStacks ? { cellStacks: first.cellStacks } : {}),
        },
        ...base.slice(1),
      ];
    });
  }, [naturalGridItems, isServerHydrated, naturalGridItemsRef, setGridRows]);

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
          // Dead primary whose stack still has live members → promote the
          // first survivor to primary in its place. Discarding the whole
          // stack (the old behavior) silently dropped open panes that were
          // perfectly valid; the additive sync won't resurrect them because
          // naturalGridItems didn't change.
          const promoted = new Map<string, string>();
          if (row.cellStacks) {
            const out: Record<string, PanelGridCellStack> = {};
            for (const [primary, stack] of Object.entries(row.cellStacks)) {
              const keptItems: string[] = [];
              const keptHeights: number[] = [];
              for (let i = 0; i < stack.items.length; i++) {
                if (currentKeys.has(stack.items[i])) {
                  keptItems.push(stack.items[i]);
                  keptHeights.push(stack.heights[i + 1] ?? 1 / (stack.items.length + 1));
                } else {
                  stacksMutated = true;
                }
              }
              if (!currentKeys.has(primary)) {
                stacksMutated = true;
                if (keptItems.length === 0) continue;
                const [newPrimary, ...restItems] = keptItems;
                promoted.set(primary, newPrimary);
                if (restItems.length > 0) {
                  const sum = keptHeights.reduce((s, h) => s + h, 0) || 1;
                  out[newPrimary] = { items: restItems, heights: keptHeights.map(h => h / sum) };
                }
                continue;
              }
              if (keptItems.length === 0) { stacksMutated = true; continue; }
              const heights = [stack.heights[0] ?? 1 / (stack.items.length + 1), ...keptHeights];
              const sum = heights.reduce((s, h) => s + h, 0) || 1;
              out[primary] = { items: keptItems, heights: heights.map(h => h / sum) };
            }
            nextStacks = Object.keys(out).length > 0 ? out : undefined;
          }

          const newItemKeys: string[] = [];
          const newWidths: number[] = [];
          for (let i = 0; i < row.itemKeys.length; i++) {
            const key = row.itemKeys[i];
            if (currentKeys.has(key)) {
              newItemKeys.push(key);
              newWidths.push(row.widths[i]);
            } else if (promoted.has(key)) {
              // Promoted survivor inherits the dead primary's slot + width.
              newItemKeys.push(promoted.get(key)!);
              newWidths.push(row.widths[i]);
            }
          }
          const itemKeysUnchanged =
            newItemKeys.length === row.itemKeys.length &&
            newItemKeys.every((k, i) => k === row.itemKeys[i]);
          if (itemKeysUnchanged && !stacksMutated) return row;
          mutated = true;
          if (newItemKeys.length === 0) return { itemKeys: [] as string[], widths: [] as number[] };
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
  }, [naturalGridItems, isServerHydrated, naturalGridItemsRef, setGridRows]);

  // Record this render's cell composition for the NEXT additive sync's
  // re-key detection. Placed after both grid-sync effects (effects run in
  // definition order) so they always read the pre-change composition.
  useEffect(() => {
    prevSoloCellsRef.current = soloCells;
  }, [soloCells]);

  // Sync row heights when row count changes. Same hydrate gate as above —
  // before hydrate, `gridRows` may be the persisted shape and we don't want
  // to overwrite the saved heights with a uniform distribution.
  useEffect(() => {
    if (!isServerHydrated) return;
    setGridRowHeights(prev => {
      if (prev.length === gridRows.length && gridRows.length > 0) return prev;
      if (gridRows.length === 0) return [];
      // Rows ADDED (e.g. a split-down created a row): keep the existing rows'
      // manual heights in proportion and give the new rows a fair share —
      // instead of flattening every row back to 1/n (the vertical-axis twin of
      // the "split resets my layout" bug gridWidths.ts fixed for columns).
      if (gridRows.length > prev.length) {
        return appendColumnWidths(prev, gridRows.length - prev.length);
      }
      // Rows removed: the dropped index isn't recoverable from this
      // count-keyed effect, so fall back to an equal split.
      return gridRows.map(() => 1 / Math.max(1, gridRows.length));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- full `gridRows` omitted on purpose: this effect must re-run only on row-COUNT change (dep `gridRows.length`), not on every width edit, else heights reset on each column resize; setGridRowHeights is a stable setter
  }, [gridRows.length, isServerHydrated, setGridRowHeights]);

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
  }), [setGridRows, setGridRowHeights]);

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

  const { startHorizontalResize, startVerticalResize, equalizeHorizontal, equalizeVertical } = useGridResize(containerRef, resizeCallbacks, resizeOptions);

  // Render-time mirror so handlers reading the ref always see the current
  // render's value — not the previously-committed one. The earlier effect-
  // based assignment lagged a commit behind, which mattered if a handler
  // dispatched a setGridRows then synchronously read the ref before the
  // effect ran (e.g. drop → reorder → re-validate).
  const gridRowsRef = useRefMirror(gridRows);
  // Snapshot sources for split-undo records (plain data, cheap mirrors).
  const gridRowHeightsRef = useRefMirror(gridRowHeights);
  const soloCellsRawRef = useRefMirror(soloCellsRaw);

  /* ---- Draft promotion remap (finding: split cell self-destructs on first
   *      message). promoteDraft swaps draft:<x> → topic.id in openPanels and
   *      the pane store, but soloCells / gridRows key split cells by pane id
   *      — the stale draft id got pruned and the promoted topic landed back
   *      in the pool. Rename BOTH in place (cell membership + grid slot keys)
   *      so a draft created in a split cell stays there across promotion. ---- */
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ from?: string; to?: string }>).detail;
      const from = detail?.from;
      const to = detail?.to;
      if (!from || !to || from === to) return;
      setSoloCells(prev => remapTopicInCells(prev, from, to));
      const fromKey = `solo:${from}`;
      const toKey = `solo:${to}`;
      setGridRows(prev => {
        let changed = false;
        const next = prev.map(row => {
          const r = renameKeyDeep(row, fromKey, toKey);
          if (r !== row) changed = true;
          return r;
        });
        return changed ? next : prev;
      });
    };
    window.addEventListener('topics:pane-id-remap', handler);
    return () => window.removeEventListener('topics:pane-id-remap', handler);
  }, [setSoloCells, setGridRows]);

  /* ---- Solo-cell close tombstones: remember which split cell a closing tab
   *      lived in, and put it back if the tab reopens (⌘Z, closed-tab
   *      history, sidebar unarchive) within the TTL window — the standalone
   *      twin of the project closedStack's group restore. Pure record/restore
   *      logic lives in soloCellTombstones.ts. ---- */
  const soloTombstonesRef = useRef<readonly SoloCellTombstone[]>([]);
  const prevCellsForTombstonesRef = useRef<string[][]>(soloCells);
  useEffect(() => {
    const prev = prevCellsForTombstonesRef.current;
    prevCellsForTombstonesRef.current = soloCells;
    const now = Date.now();
    soloTombstonesRef.current = recordSoloTombstones(
      soloTombstonesRef.current, prev, soloCells, new Set(openPanels), now,
    );
    const res = restoreFromSoloTombstones(soloCells, soloTombstonesRef.current, openPanels, now);
    soloTombstonesRef.current = res.tombstones;
    if (res.cellsChanged) setSoloCells(res.cells);
  }, [soloCells, openPanels, setSoloCells]);

  // Auto-rebalance: when a project's internal split count changes (a column/row
  // added or removed, or the visible project in a multi-tab cell swapped), reflow
  // the OUTER columns/rows so every leaf pane stays equal — the no-double-click
  // twin of the weighted equalize. Scoped to rows hosting the changed project, so
  // an unrelated split keeps its manual sizes. A same-value re-publish / inner
  // RESIZE never fires (computeProjectGridWeight ignores widths), so dragging an
  // inner divider doesn't fight the user's outer sizing.
  useEffect(() => subscribeProjectGridWeights((changed) => {
    setGridRows(prev => {
      let mutated = false;
      const next = prev.map(row => {
        if (!row.itemKeys.some(k => cellReferencesProject(k, changed))) return row;
        const nw = weightedWidths(rowColumnWeights(row));
        if (nw.length !== row.widths.length || nw.every((x, i) => Math.abs(x - row.widths[i]) < 1e-4)) return row;
        mutated = true;
        return { ...row, widths: nw };
      });
      return mutated ? next : prev;
    });
    const rows = gridRowsRef.current;
    if (rows.some(row => row.itemKeys.some(k => cellReferencesProject(k, changed)))) {
      setGridRowHeights(prev => {
        const nh = weightedWidths(rowHeightWeights(rows));
        if (nh.length !== prev.length || nh.every((x, i) => Math.abs(x - prev[i]) < 1e-4)) return prev;
        return nh;
      });
    }
  }), [cellReferencesProject, rowColumnWeights, rowHeightWeights, setGridRows, setGridRowHeights, gridRowsRef]);

  /* ---- Split pane: move a topic into its own solo cell ----
   *
   * 'right': solo the pane, insert it as a new top-level cell next to the
   * source cell's column (creates a new column).
   *
   * 'down': solo the pane, append it to the source cell's vertical
   * sub-stack (`cellStacks[primaryKey].items`), so the new pane lands
   * UNDER the source cell's column rather than spanning the full grid
   * width. When the source cell hosts no stack yet, this initializes
   * one with [primary_height=0.5, new_height=0.5].
   *
   * The "source cell" is wherever the pane lives TODAY: the main pool, or
   * a multi-tab solo cell it shares — a member of a multi-tab cell splits
   * OUT into its own new cell (extractToOwnCell, like the drag path), and
   * extracting the PRIMARY re-keys the remainder in place so it keeps its
   * slot/width/sub-stack.
   */
  // Latest-closure mirror so the split-undo record's redo can re-run the
  // split without capturing a stale handler (same pattern as
  // useProjectLayout's handleSplitGroupRef). Assigned right after the
  // callback below.
  const handleSplitPaneRef = useRef<((topicId: string, direction: 'right' | 'down') => void) | null>(null);
  const handleSplitPane = useCallback((topicId: string, direction: 'right' | 'down') => {
    // Single-tab UX: if `topicId` is the only regular (non-solo) panel in
    // the standalone group, splitting it would leave the standalone group
    // empty and the user would see no visible split — just a single solo
    // cell. Spawn a fresh draft chat in standalone *before* splitting, so
    // the result is two visible cells: the original topic (now solo)
    // alongside the new draft (in standalone). Mirrors how editor "split
    // right" creates a usable second pane instead of just relabeling the
    // source cell. Skipped when `onNewChat` isn't wired (graceful fallback
    // to the legacy "silent solo" behavior — preserves the original
    // contract for any caller that opts out of auto-spawn).
    const soloSet = new Set(soloTopicIds);
    const regularPanelsCount = openPanels.filter(id => !soloSet.has(id)).length;
    if (regularPanelsCount <= 1 && !soloSet.has(topicId) && onNewChat) {
      // Synchronously inserts a draft pane id into openPanels via
      // handleQuickCreateTopic → openPanel('permanent', autoFocus=true).
      // The draft sits in standalone alongside what's about to be solo'd.
      onNewChat();
    }

    const soloKey = `solo:${topicId}`;
    // The cell the pane belongs to right now. A multi-tab solo cell is keyed
    // by its PRIMARY (first) topic — extracting a non-primary member leaves
    // the key alone; extracting the primary re-keys the remainder.
    const sourceCell = soloCells.find(c => c.includes(topicId));
    const isPrimaryOfMultiTab = !!sourceCell && sourceCell.length > 1 && sourceCell[0] === topicId;
    const remainderKey = isPrimaryOfMultiTab ? soloCellKey(sourceCell.slice(1)) : null;
    const sourceKey = sourceCell ? soloCellKey(sourceCell) : 'standalone';

    const currentRows = gridRowsRef.current;

    // Resolve the source cell's grid position: its top-level slot, or the
    // host column when the source cell lives inside another cell's stack.
    let sourceRowIdx = -1;
    let sourceColIdx = -1;
    let sourcePrimary = '';
    for (let r = 0; r < currentRows.length; r++) {
      const row = currentRows[r];
      // Pass 1: source cell is a top-level cell.
      const directIdx = row.itemKeys.indexOf(sourceKey);
      if (directIdx >= 0) {
        sourceRowIdx = r;
        sourceColIdx = directIdx;
        sourcePrimary = sourceKey;
        break;
      }
      // Pass 2: source cell nested inside a sibling cell's stack.
      if (row.cellStacks) {
        for (const [primary, stack] of Object.entries(row.cellStacks)) {
          if (stack.items.includes(sourceKey)) {
            sourceRowIdx = r;
            sourceColIdx = row.itemKeys.indexOf(primary);
            sourcePrimary = primary;
            break;
          }
        }
        if (sourceRowIdx >= 0) break;
      }
    }

    // Check grid limits BEFORE marking as solo to prevent orphaned solo ids.
    // The column cap gates the SOURCE row — the row the new column joins —
    // not row 0 (with multiple rows the old check gated the wrong row: a
    // full row 0 blocked splits in a roomy row 1 and vice versa). Matches
    // the drag path's targetRowIdx-based guard.
    if (direction === 'right') {
      const targetRow = sourceRowIdx >= 0 ? currentRows[sourceRowIdx] : currentRows[0];
      if (targetRow && targetRow.itemKeys.length >= MAX_COLS_PER_ROW) return;
    }
    if (direction === 'down') {
      // Cap the in-cell stack depth — beyond ~3 the panes get too squat to
      // be useful. MAX_ROWS doesn't apply (we don't add rows).
      const sourceRow = currentRows[sourceRowIdx];
      const existingStack = sourceRow?.cellStacks?.[sourcePrimary];
      const currentDepth = (existingStack?.items.length ?? 0) + 1; // primary + items
      if (currentDepth >= MAX_STACK_DEPTH) return;
    }

    // Split is undoable: snapshot the three layout slices (plain data) —
    // ⌘Z after a split used to silently undo the previous CLOSE instead.
    {
      const prevRowsSnap = currentRows;
      const prevHeightsSnap = gridRowHeightsRef.current;
      const prevSoloSnap = soloCellsRawRef.current;
      pushUndo({
        description: 'Split pane',
        undo: () => {
          setSoloCells(prevSoloSnap);
          setGridRows(prevRowsSnap);
          setGridRowHeights(prevHeightsSnap);
        },
        redo: () => { handleSplitPaneRef.current?.(topicId, direction); },
      });
    }

    // Mark as solo (only after limit checks pass). extractToOwnCell REMOVES the
    // topic from any cell it currently shares before giving it its own — the
    // right primitive for "split a member out of a multi-tab solo cell" (a naive
    // add-if-absent would no-op there and silently drop the split).
    setSoloCells(prev => extractToOwnCell(prev, topicId));

    // Dispatched past every limit guard above so a no-op split never flashes
    // the native browser views. See paneReflow.ts for the full rationale.
    notifyPaneReflow();

    setGridRows(prev => {
      // Re-check limits in the updater — `prev` may have shifted between
      // the ref read above and React running this updater.
      if (direction === 'right') {
        const guardRow = sourceRowIdx >= 0 && sourceRowIdx < prev.length ? prev[sourceRowIdx] : prev[0];
        if (guardRow && guardRow.itemKeys.length >= MAX_COLS_PER_ROW) return prev;
      }

      // Deep clone — including cellStacks — so we never mutate prev shape.
      let rows = prev.map(cloneRow);

      // Multi-tab source cell whose PRIMARY is splitting out: the remainder
      // re-keys to its next member — rename it in place (slot, width and
      // sub-stack survive), exactly like the drag-extract path. Deep rename:
      // the source cell may itself live inside another cell's sub-stack.
      if (remainderKey) {
        rows = rows.map(row => renameKeyDeep(row, sourceKey, remainderKey));
      }

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

      // Post-rename anchor: when the source cell just re-keyed, its (possibly
      // stacked-host) primary follows the rename.
      const effectivePrimary =
        remainderKey && sourcePrimary === sourceKey ? remainderKey : sourcePrimary;

      if (direction === 'down') {
        if (sourceRowIdx === -1 || rows.length === 0) {
          // Bootstrap: gridRows is empty (first split). The user's source
          // pane lives inside a group that hasn't been materialized into
          // gridRows yet — typically the standalone group. We need to
          // stack the new pane *under* that group, not strand it in a
          // single-cell row (which leaves the source group invisible until
          // the additive sync re-adds it as a sibling column on the next
          // render — i.e. the user sees a horizontal split on click 1 and
          // has to repeat the action to actually get the vertical split).
          // Pick the host cell key based on what naturalGridItems exposes.
          // We restrict the fallback to the well-known 'standalone' cell —
          // earlier we picked "any non-solo cell" which could land the new
          // pane stacked under an unrelated solo cell (e.g. a project pane)
          // when standalone was absent. Better to fall through to a
          // single-cell row than to attach to the wrong host.
          const liveItems = naturalGridItemsRef.current;
          const hostKey =
            (effectivePrimary && effectivePrimary !== soloKey ? effectivePrimary : null) ||
            (remainderKey && remainderKey !== soloKey ? remainderKey : null) ||
            (liveItems.find(i => i.key === 'standalone')?.key ?? null);
          const bootstrapRow = hostKey
            ? {
                itemKeys: [hostKey],
                widths: [1],
                cellStacks: {
                  [hostKey]: { items: [soloKey], heights: [0.5, 0.5] },
                },
              }
            : { itemKeys: [soloKey], widths: [1] };
          // Only a TRULY empty grid is a full replace. When rows already exist
          // (sourceRowIdx === -1 because the source group just isn't
          // materialized yet), APPEND the bootstrap row — the old `rows =
          // [bootstrapRow]` wiped every existing split (e.g. two side-by-side
          // project windows) whenever the source wasn't in gridRows. Mirrors the
          // 'right' branch, which never wipes existing rows. Worst case is a
          // cosmetically extra bottom row, never lost layout.
          rows = rows.length === 0 ? [bootstrapRow] : [...rows, bootstrapRow];
          return rows;
        }
        const targetRow = rows[Math.min(sourceRowIdx, rows.length - 1)];
        const primaryIdx = effectivePrimary
          ? targetRow.itemKeys.indexOf(effectivePrimary)
          : -1;
        if (primaryIdx === -1) {
          // Fallback: insert as a new top-level cell in the row, keeping the
          // existing columns' manual widths in proportion.
          const prevWidths = targetRow.widths;
          targetRow.itemKeys.push(soloKey);
          targetRow.widths = appendColumnWidths(prevWidths, 1);
          return rows;
        }
        const stacks = targetRow.cellStacks ? { ...targetRow.cellStacks } : {};
        const existing = stacks[effectivePrimary];
        if (existing) {
          // Append to existing stack — re-balance heights uniformly.
          const slots = existing.items.length + 2; // primary + existing items + new
          stacks[effectivePrimary] = {
            items: [...existing.items, soloKey],
            heights: Array.from({ length: slots }, () => 1 / slots),
          };
        } else {
          stacks[effectivePrimary] = {
            items: [soloKey],
            heights: [0.5, 0.5],
          };
        }
        targetRow.cellStacks = stacks;
        return rows;
      }

      // direction === 'right': insert as a new top-level cell
      if (rows.length === 0) {
        // Mirror the down-bootstrap fix: when gridRows hasn't materialized
        // yet, the source group is invisible to us — naively `[soloKey]`
        // strands the source until additive-sync re-adds it as a sibling
        // on the next render (one click → no visible split, second click
        // needed to see the column actually split). Seed with the host
        // cell + soloKey so the split is visible on click 1.
        const liveItems = naturalGridItemsRef.current;
        const hostKey =
          (effectivePrimary && effectivePrimary !== soloKey ? effectivePrimary : null) ||
          (remainderKey && remainderKey !== soloKey ? remainderKey : null) ||
          (liveItems.find(i => i.key === 'standalone')?.key ?? null);
        rows = hostKey
          ? [{ itemKeys: [hostKey, soloKey], widths: [0.5, 0.5] }]
          : [{ itemKeys: [soloKey], widths: [1] }];
      } else {
        const targetRow = sourceRowIdx >= 0 && sourceRowIdx < rows.length
          ? rows[sourceRowIdx]
          : rows[0];
        // Insert immediately to the right of the source column when we
        // have one — better UX than always at the end of the row.
        const insertAt = sourceColIdx >= 0 ? sourceColIdx + 1 : targetRow.itemKeys.length;
        // Split the source column's width with the new pane; siblings keep their
        // manual sizes (was `1/n` — the menu "Split Right" reset the whole row).
        const donorIdx = sourceColIdx >= 0 ? sourceColIdx : Math.max(0, targetRow.itemKeys.length - 1);
        const prevWidths = targetRow.widths;
        targetRow.itemKeys.splice(insertAt, 0, soloKey);
        targetRow.widths = splitColumnWidths(prevWidths, donorIdx, insertAt);
      }
      return rows;
    });

    // Focus the split-out panel so the source group falls back to its first remaining tab
    onFocusPanel(topicId);
  }, [onFocusPanel, openPanels, soloTopicIds, soloCells, onNewChat, gridRowsRef, gridRowHeightsRef, soloCellsRawRef, naturalGridItemsRef, setGridRows, setGridRowHeights, setSoloCells]);
  handleSplitPaneRef.current = handleSplitPane;

  /* ---- Unsolo: merge a solo topic back into the main standalone group ---- */
  const handleUnsoloTopic = useCallback((topicId: string) => {
    setSoloCells(prev => removeTopicFromCells(prev, topicId));
  }, [setSoloCells]);

  /* ---- Persist a main-pool tab reorder into App.openPanels.
         The pool's ordered ids are a SUBSET of openPanels (solo cells and
         local-managed panes excluded), so the new order must be MERGED:
         pool members take their new relative order, every other entry keeps
         its slot. Replacing openPanels with the subset outright would close
         every split cell. Without this persist the reorder lived only in
         usePaneOrdering's local state — gone on reload, unlike the identical
         gesture in project groups. ---- */
  const handlePersistPoolReorder = useCallback((newOrder: string[]) => {
    const inPanels = new Set(openPanels);
    const orderable = newOrder.filter(id => inPanels.has(id));
    if (orderable.length === 0) return;
    const poolSet = new Set(orderable);
    let i = 0;
    const merged = openPanels.map(id => (poolSet.has(id) ? orderable[i++] : id));
    onReorderPanels(merged);
  }, [openPanels, onReorderPanels]);

  /* ---- Persist a SOLO cell's tab reorder into soloCells (whose member
         order IS the cell's persisted tab order — without this the reorder
         lived only in the group's local ordering state and silently undid
         itself on reload, unlike the identical gesture in the pool and in
         project groups). The primary stays pinned at slot 0: it is the
         cell's grid key, and re-keying on every reorder would remount the
         column. ---- */
  const handlePersistCellOrder = useCallback((cellKey: string, newOrder: string[]) => {
    setSoloCells(prev => {
      let changed = false;
      const next = prev.map(cell => {
        if (soloCellKey(cell) !== cellKey) return cell;
        const reordered = reorderCellPreservingPrimary(cell, newOrder);
        if (reordered !== cell) changed = true;
        return reordered as string[];
      });
      return changed ? next : prev;
    });
  }, [setSoloCells]);

  /* ---- Merge a tab INTO an existing split cell (multi-tab column).
         Dropping a tab onto another split cell's bar lands it there as the
         cell's next tab — coherent with project groups, no collapse. ---- */
  const handleMergeIntoCell = useCallback((topicId: string, targetPrimary: string, insertIdx?: number) => {
    setSoloCells(prev => moveTopicToCell(prev, topicId, targetPrimary, insertIdx));
    onFocusPanel(topicId);
  }, [onFocusPanel, setSoloCells]);

  /* ---- Dove ATTERRA una cosa lasciata cadere dalla SIDEBAR.
     Stessa semantica del drop di una TAB sul corpo di una cella (vedi il ramo
     `actualZone === 'center'` del drop handler): sulla cella divisa si entra
     come sua prossima tab, sul serbatoio principale si torna nel serbatoio.
     `targetPrimary === null` = il serbatoio. ---- */
  const landSidebarDrop = useCallback((topicId: string, targetPrimary: string | null) => {
    if (targetPrimary && targetPrimary !== topicId) handleMergeIntoCell(topicId, targetPrimary);
    else handleUnsoloTopic(topicId);
  }, [handleMergeIntoCell, handleUnsoloTopic]);

  /* ---- L'atterraggio in SOSPESO di un drop dalla sidebar.
     Una riga della sidebar può essere una chat NON aperta: la pane nasce solo
     quando `topics:open-topic` è stato processato, e `soloCells` viene POTATO
     su `openPanels` a ogni derivazione (`pruneSoloCells`) — mettere l'id in una
     cella prima che la pane esista lo farebbe cancellare nello stesso render.
     Quindi si registra l'intenzione e la si applica quando la pane compare,
     con la stessa forma del `pendingSoloPanelId` qui sotto. ---- */
  const pendingSidebarLandingRef = useRef<{ topicId: string; targetPrimary: string | null } | null>(null);
  useEffect(() => {
    const pending = pendingSidebarLandingRef.current;
    if (!pending) return;
    if (!openPanels.includes(pending.topicId)) return;
    pendingSidebarLandingRef.current = null;
    landSidebarDrop(pending.topicId, pending.targetPrimary);
  }, [openPanels, landSidebarDrop]);

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
    // not already solo. A pane that's the only one open doesn't need solo;
    // one that's already in its own cell must not be re-split (idempotent —
    // an agent re-opening/refreshing the same browser navigates in place).
    const otherOpen = openPanels.filter(p => p !== id).length > 0;
    const alreadySolo = soloTopicIds.includes(id);
    if (otherOpen && !alreadySolo) {
      // Choose orientation from the grid's available space: a wide window
      // splits side-by-side ('right'), a narrow/tall one stacks ('down').
      const rect = containerRef.current?.getBoundingClientRect() ?? null;
      const dir = chooseSplitOrientation(rect) === 'side' ? 'right' : 'down';
      handleSplitPane(id, dir);
    }
    onPendingSoloPanelIdConsumed?.();
  }, [pendingSoloPanelId, openPanels, soloTopicIds, onPendingSoloPanelIdConsumed, handleSplitPane]);

  /* ---- drag state (for cross-window panel drag) ---- */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Set the instant an in-app drop target consumes the current drag (the grid
  // drop-capture). The drag-out pop-out in handleDragEnd reads this so a drop
  // that landed on a split/cell is NEVER mistaken for a drag outside the window
  // — defense-in-depth on top of the dropEffect='move' signal, since WKWebView
  // can still report a stale dragend dropEffect/coords. Reset on every dragstart.
  const dropConsumedRef = useRef(false);
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
  /**
   * True while a STANDALONE-scope tab drag is live (project-internal tab
   * drags don't count — their strips belong to the project's GroupLayout).
   * Gates the full-width row drop strips. Set on the container's capture-
   * phase dragenter (types are readable there, unlike dragstart-capture),
   * cleared by every drag-reset path below.
   */
  const [tabDragActive, setTabDragActive] = useState(false);
  // Which strip the pointer is on: 'top' | 'bottom' = the extreme strips,
  // a number = the interior gap below that row index.
  const [fullRowDrop, setFullRowDrop] = useState<'top' | 'bottom' | number | null>(null);
  const fullRowDropRef = useRefMirror(fullRowDrop);

  const handleDragStart = useCallback((topicId: string) => (e: React.DragEvent) => {
    setDraggingId(topicId);
    dropConsumedRef.current = false;
    e.dataTransfer.setData(DND_TYPES.PANEL_ID, topicId);
    e.dataTransfer.effectAllowed = 'move';

    const topic = topics[topicId];
    // La scheda intera, decisa in un posto solo (`lib/dragPreview`). Il registro
    // dei nodi da drenare non serve più: l'anteprima non si smonta a un rAF di
    // distanza, resta viva per tutto il gesto e si spegne da sé su cinque porte
    // agganciate al documento — comprese quelle per il `dragend` che nella
    // WKWebView non arriva.
    startDragPreview(e, {
      title: topic?.name || 'Chat',
      subtitle: topic?.projectPath ? getProjectLabel(topic.projectPath) : undefined,
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

    // Pop-out to new window if dragged outside (native app only). Skip entirely
    // when an in-app drop target already consumed this drag — on WKWebView the
    // dragend dropEffect can read 'none' even after a successful in-window split
    // (the bug that closed panes dropped onto a split). dropConsumedRef is the
    // reliable signal; dropEffect alone is not, on WebKit.
    if (isNativeApp && draggedId && !dropConsumedRef.current && e.dataTransfer.dropEffect === 'none') {
      const { clientX, clientY } = e;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      if (clientX < 0 || clientX > windowWidth || clientY < 0 || clientY > windowHeight) {
        // FUORI dalla finestra = la tab vuole una casa sua: le si dà un GRUPPO
        // nuovo e la finestra di quel gruppo (`detachPaneToNewSpace`). Prima
        // qui nasceva una pop-out `?topics=`, cioè una vista morta senza
        // pane-store, e la pane di partenza andava chiusa a mano. Ora non si
        // chiude niente: cambiando gruppo la tab lascia da sola l'insieme
        // visibile di questa finestra, e se la finestra non si apre il gruppo
        // si scioglie e la tab torna dov'era.
        void detachPaneToNewSpace(draggedId);
      }
    }
    // `onClosePanel` NON è più una dipendenza: era il residuo del vecchio
    // pop-out, che dopo aver aperto la finestra nuova chiudeva a mano la pane di
    // partenza. Da quando fuori dalla finestra si va con `detachPaneToNewSpace`
    // (vedi il commento sopra) questo corpo non lo legge più, quindi non c'è
    // nessuna closure da tenere fresca — solo un'identità che cambiava a ogni
    // render del padre e riarmava il callback per niente.
  }, [draggingId, windowId, sendWS]);

  /* ---- Grid item drag & edge-drop ---- */
  const [draggingGridKey, setDraggingGridKey] = useState<string | null>(null);
  const [gridDropTarget, setGridDropTarget] = useState<{
    rowIdx: number;
    colIdx: number;
    zone: 'left' | 'right' | 'top' | 'bottom' | 'center';
    centerSide?: 'left' | 'right';
    /** True when the drag is a PANE_TAB (not a GRID_ITEM). A tab over the
     *  cell's `top` zone is aiming at the tab bar that lives there, not asking
     *  to split the cell — the drop handler no-ops that case (it returns on
     *  `top`/`center`), so we must NOT paint the rectangular split overlay for
     *  it either, or the user sees a phantom "area" preview while just adding a
     *  tab. Edge splits (left/right/bottom) still paint. */
    isTab?: boolean;
  } | null>(null);
  // Ref mirror so the drop handler always has the latest value — React
  // state may not be committed yet when drop fires immediately after
  // dragover (the "drop twice to land" class of bug).
  const gridDropTargetRef = useRefMirror(gridDropTarget);

  // (A former handleGridItemDragStart \u2014 the GRID_ITEM drag-start with its own
  // ghost image \u2014 was dead wiring: StandaloneChatGroup received it as
  // onGroupDragStart and never attached it to any element, so GRID_ITEM data
  // was never set. Whole-cell movement happens via tab drags, which the
  // reorder path below handles through `effectiveKey = soloKey`.)

  // Capture phase: fires BEFORE children, so we can intercept edge drags
  // even when StandaloneChatGroup/GroupLayout consume bubble-phase events
  const handleGridItemDragOverCapture = useCallback((rowIdx: number, colIdx: number) => (e: React.DragEvent) => {
    const isGridDrag = e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM);
    const isTabDrag = e.dataTransfer.types.includes(DND_TYPES.PANE_TAB);
    // A drag straight from the sidebar tree carries PANEL_ID only (no GRID_ITEM,
    // no PANE_TAB): dropping it onto a cell OPENS the topic and MERGES it into
    // that cell's group ("raggruppa da sidebar"). Whole-cell merge target — no
    // edge/split semantics — so it stays out of the fragile tab-split path.
    const isSidebarDrag = !isGridDrag && !isTabDrag && e.dataTransfer.types.includes(DND_TYPES.PANEL_ID);
    if (!isGridDrag && !isTabDrag && !isSidebarDrag) return;

    // A PANE_TAB drag from a PROJECT window carries that project's scope. Every
    // tab drag also carries PANEL_ID (for the standalone edge-split), so PANEL_ID
    // alone can't tell a standalone tab from a project's internal one. The grid
    // must ignore project tabs entirely — otherwise it paints its OWN cell
    // drop-zone overlay on top of the project's edge-split preview (two feedbacks
    // at once) and even on a *different* project's cell as the pointer passes it
    // (the reported "split-area preview of another project"). Only standalone
    // ("main"-scoped) tab drags concern the grid; project drags are owned by the
    // project's GroupLayout/PaneTabBar, whose own drop still fires (we return
    // without preventDefault, so the event keeps bubbling).
    if (isTabDrag && !isGridDrag && !dragMatchesScope(e.dataTransfer.types, STANDALONE_SCOPE)) {
      if (gridDropTargetRef.current) { setGridDropTarget(null); gridDropTargetRef.current = null; }
      return;
    }

    // Reject tab drags that don't carry PANEL_ID (shouldn't happen, but guard)
    if (isTabDrag && !isGridDrag && !e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) {
      setGridDropTarget(null);
      gridDropTargetRef.current = null;
      return;
    }

    // Commit the hover target, but DEDUP: dragover fires ~60fps+ and re-creating the
    // same target object every event re-rendered the whole grid each frame — the
    // "preview delle aree di drop laggano". Only setState when the zone/cell actually
    // changes, so a steady cursor produces zero re-renders.
    const commitTarget = (target: { rowIdx: number; colIdx: number; zone: DropZone; centerSide?: 'left' | 'right'; isTab: boolean }) => {
      const p = gridDropTargetRef.current;
      if (p && p.rowIdx === target.rowIdx && p.colIdx === target.colIdx && p.zone === target.zone && p.centerSide === target.centerSide && p.isTab === target.isTab) return;
      setGridDropTarget(target);
      gridDropTargetRef.current = target;
    };

    // Sidebar drag: paint a whole-cell merge preview (reusing the tab
    // center-merge look) and stop here — the drop opens the topic and merges it
    // into this cell's group. No edge/split for sidebar drags.
    if (isSidebarDrag) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      commitTarget({ rowIdx, colIdx, zone: 'center', centerSide: undefined, isTab: true });
      return;
    }

    // The tab bar owns its own band: a PANE_TAB dragged ANYWHERE over a tab bar
    // (including its left/right corners, where detectDropZone returns 'left'/
    // 'right' rather than the suppressed 'top') must show ONLY the bar's insert
    // caret — never a cell split rectangle on top of it. This `closest` test is
    // exact (the pointer is genuinely over the bar element), replacing the leaky
    // 'top'-only `suppressSplitOverlay` heuristic that left the corners double-
    // painting. GRID_ITEM whole-cell drags still split from the bar.
    if (isTabDrag && !isGridDrag && (e.target as HTMLElement).closest?.('[data-testid="panel-tab-bar"]')) {
      if (gridDropTargetRef.current) { setGridDropTarget(null); gridDropTargetRef.current = null; }
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = detectDropZone(e, rect, 'edges+center')!;
    let centerSide: 'left' | 'right' | undefined;
    if (zone === 'center') {
      centerSide = (e.clientX - rect.left) / rect.width < 0.5 ? 'left' : 'right';
    }

    // HTML5 DnD: the LAST dragover before mouseup MUST call preventDefault or
    // the drop event never fires on any handler. We always preventDefault for
    // pane-tab/grid-item drags (whatever zone the cursor is in) so a release
    // at the wobble moment between two edge frames still produces a `drop`.
    e.preventDefault();

    // For PANE_TAB drags over a cell's CENTER: commit the target (paints the
    // merge preview) but don't stopPropagation — if the pointer is over the
    // tab bar its own dragover/caret must still run (the closest() guard above
    // already returns for genuine bar hovers, so this is the pane BODY).
    // Signal acceptance for WKWebView: without dropEffect the source's dragend
    // reads 'none' and the pop-out path would close the pane on a center drop.
    // 'top' is NOT special-cased anymore: it falls through to the edge path
    // below and previews/act as a real stack-above split (the old routing sent
    // it to the bar, making "split up" unreachable from a tab drag).
    if (isTabDrag && !isGridDrag && zone === 'center') {
      e.dataTransfer.dropEffect = 'move';
      commitTarget({ rowIdx, colIdx, zone, centerSide, isTab: true });
      return;
    }

    // Edge zone (or any GRID_ITEM drag): handle at grid level
    e.stopPropagation(); // Prevent children from also handling this edge drag
    // WKWebView (Tauri) does NOT infer dropEffect from preventDefault the way
    // Chromium does — if the accepting target never sets it, the SOURCE's
    // `dragend` reports dropEffect:'none', which the pop-out path
    // (handleDragEnd) reads as "dropped outside the app" and CLOSES the pane.
    // Signal acceptance explicitly so an in-window split drop is never mistaken
    // for a drag-out. (effectAllowed is 'move' for all our drags.)
    e.dataTransfer.dropEffect = 'move';
    // A GRID drag's top/bottom drop inserts a FULL-WIDTH row — light the row
    // strip/gap band as the preview (the honest footprint of the action) and
    // let the cell paint nothing: the old half-cell region promised a
    // per-column split the drop never performed.
    if (isGridDrag && (zone === 'top' || zone === 'bottom')) {
      const rowCount = gridRowsRef.current.length;
      const strip: 'top' | 'bottom' | number =
        zone === 'top'
          ? (rowIdx === 0 ? 'top' : rowIdx - 1)
          : (rowIdx >= rowCount - 1 ? 'bottom' : rowIdx);
      if (fullRowDropRef.current !== strip) { fullRowDropRef.current = strip; setFullRowDrop(strip); }
    } else if (fullRowDropRef.current !== null) {
      fullRowDropRef.current = null;
      setFullRowDrop(null);
    }
    commitTarget({ rowIdx, colIdx, zone, centerSide, isTab: isTabDrag && !isGridDrag });
  }, [gridDropTargetRef, gridRowsRef, fullRowDropRef]);

  const handleGridItemDragEnd = useCallback(() => {
    setDraggingGridKey(null);
    setGridDropTarget(null);
    gridDropTargetRef.current = null;
  }, [gridDropTargetRef]);

  // Clear the per-cell split-region preview. An insert divider calls this when
  // it claims the drop, so its bar and a stale cell region never show together.
  const clearGridDropTarget = useCallback(() => {
    setGridDropTarget(null);
    gridDropTargetRef.current = null;
  }, [gridDropTargetRef]);

  // Belt-and-suspenders: a cross-cell move unmounts the dragged item inside its
  // drop handler, so the browser may never fire `dragend` on the now-detached
  // source — leaving the grid's edge-drop preview and the drag-active
  // affordances painted. `drop` still bubbles to the window AFTER React's own
  // onDrop has consumed gridDropTargetRef, so resetting the VISUAL drag state on
  // both events guarantees nothing is left over. `draggingId` is intentionally
  // NOT cleared here — handleDragEnd owns it for the WS drag:end signal and the
  // pop-out-on-drag-outside path (where no `drop` event fires at all).
  useEffect(() => {
    const clearDragVisuals = () => {
      setGridDropTarget(null);
      gridDropTargetRef.current = null;
      setDraggingGridKey(null);
      setIsAnyDragActive(false);
      setEmptyDragOver(false);
      setTabDragActive(false);
      setFullRowDrop(null);
      fullRowDropRef.current = null;
    };
    window.addEventListener('dragend', clearDragVisuals);
    window.addEventListener('drop', clearDragVisuals);
    return () => {
      window.removeEventListener('dragend', clearDragVisuals);
      window.removeEventListener('drop', clearDragVisuals);
    };
  }, [gridDropTargetRef, fullRowDropRef]);

  // Belt-and-suspenders: a `tabDragActive`/`isAnyDragActive` flag that never saw
  // its `dragend`/`drop` (WKWebView can drop both when a native browser view is
  // under the release point, or on an off-window drop) leaves the full-width row
  // strips mounted as live pointer-events:auto hit targets over the first row's
  // tab bar — swallowing clicks and tab-move drops. HTML5 DnD suppresses pointer
  // events during the drag, so the first `pointermove` with no button (or any
  // `pointerup`/blur) proves the gesture is over. Mirrors GroupLayout's guard.
  useEffect(() => {
    if (!tabDragActive && !isAnyDragActive) return;
    const clear = () => {
      setGridDropTarget(null);
      gridDropTargetRef.current = null;
      setDraggingGridKey(null);
      setIsAnyDragActive(false);
      setEmptyDragOver(false);
      setTabDragActive(false);
      setFullRowDrop(null);
      fullRowDropRef.current = null;
    };
    const onMove = (e: PointerEvent) => { if ((e.buttons & 1) === 0) clear(); };
    window.addEventListener('pointerup', clear, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerup', clear, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('blur', clear);
    };
  }, [tabDragActive, isAnyDragActive, gridDropTargetRef, fullRowDropRef]);

  const handleGridItemDropCapture = useCallback((
    e: React.DragEvent,
    /**
     * Optional explicit drop spec from a non-cell drop surface (e.g. an
     * insert-between divider or a full-width row strip). When provided, we
     * trust the caller's (rowIdx, colIdx, zone) rather than recomputing from
     * the pointer relative to `e.currentTarget` (which would be the divider,
     * not the target cell). The drag payload (PANE_TAB / GRID_ITEM) on the
     * event is still read normally. `fullRow: true` makes a top/bottom zone
     * insert a FULL-WIDTH row (the strips' intent) — a bare cell bottom-edge
     * tab drop instead stacks under just that cell's column.
     */
    explicitTarget?: { rowIdx: number; colIdx: number; zone: DropZone; centerSide?: 'left' | 'right'; fullRow?: boolean },
  ) => {
    // Read from ref for synchronous access (state may lag behind after dragover)
    const rawDropTarget = explicitTarget ?? gridDropTargetRef.current;
    if (!rawDropTarget) return;

    // Re-verify drop zone from actual mouse position at drop time — but only
    // for cell drops. Divider drops pass `explicitTarget`; recomputing from
    // the divider element would always yield a useless 'center'/'left' value.
    const actualZone = explicitTarget
      ? explicitTarget.zone
      : computeDropZone(e, e.currentTarget as HTMLElement);

    let effectiveKey = e.dataTransfer.getData(DND_TYPES.GRID_ITEM);
    const sourcePaneTab = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceTopicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);

    // Build a corrected drop target immutably rather than mutating the ref
    // object (gridDropTargetRef.current must not be reassigned in place —
    // react-hooks/immutability). The corrected zone/centerSide flow into the
    // destructures below; rowIdx/colIdx pass through unchanged.
    let dropTarget = rawDropTarget;

    // PANE_TAB drops: edge zones create split + move tab; center on the pane
    // BODY merges the tab into the target cell's group; a drop physically on
    // the tab bar stays the bar's (it owns the precise insertIdx merge and
    // this capture handler must not steal it).
    if (!effectiveKey && sourcePaneTab) {
      if (!sourceTopicId) return;
      if (!explicitTarget && (e.target as HTMLElement).closest?.('[data-testid="panel-tab-bar"]')) return;
      // Use actual zone at drop time, not the stale dragover zone
      if (actualZone === 'center') {
        // Merge-as-tab into the target cell (add at the end). Previously this
        // was a bare `return`: the drop was consumed by nobody, nothing
        // happened, and on WKWebView the source's dragend could even read it
        // as a drag-out and close the pane.
        e.preventDefault();
        e.stopPropagation();
        setIsAnyDragActive(false);
        setTabDragActive(false);
        setFullRowDrop(null);
        fullRowDropRef.current = null;
        dropConsumedRef.current = true;
        const targetKey = gridRowsRef.current[dropTarget.rowIdx]?.itemKeys[dropTarget.colIdx];
        if (targetKey?.startsWith('solo:')) {
          const targetPrimary = targetKey.slice('solo:'.length);
          if (targetPrimary !== sourceTopicId) handleMergeIntoCell(sourceTopicId, targetPrimary);
        } else if (targetKey) {
          // The main pool cell: un-solo the tab back into it (no-op if it
          // already lives there).
          handleUnsoloTopic(sourceTopicId);
        }
        setDraggingGridKey(null);
        setGridDropTarget(null);
        gridDropTargetRef.current = null;
        return;
      }
      // Update dropTarget zone to match actual position
      dropTarget = { ...dropTarget, zone: actualZone };
    } else if (effectiveKey) {
      // GRID_ITEM drops suffer the same dragover-lag risk: fast edge-to-edge
      // drags can leave dropTarget.zone one frame behind the cursor. Sync
      // both zone and centerSide from the actual pointer position so the
      // reorder/split below acts on where the mouse actually is at drop —
      // unless the caller explicitly told us where to land (divider drops).
      dropTarget = { ...dropTarget, zone: actualZone };
      if (!explicitTarget && actualZone === 'center') {
        const cell = e.currentTarget as HTMLElement;
        const rect = cell.getBoundingClientRect();
        dropTarget = {
          ...dropTarget,
          centerSide: e.clientX - rect.left < rect.width / 2 ? 'left' : 'right',
        };
      }
    }

    e.preventDefault();
    e.stopPropagation(); // Prevent children from also handling this drop
    // This drop is now consumed — stopPropagation defeats the window 'drop'
    // reset, and a tab-extract below can unmount the dragged source (swallowing
    // 'dragend'). Clear the global drag flags here or the InsertDividers /
    // full-width strips keep their drop affordances painted after the drop.
    setIsAnyDragActive(false);
    setTabDragActive(false);
    setFullRowDrop(null);
    fullRowDropRef.current = null;
    // The drag landed on an in-app target — the dragend pop-out must NOT treat
    // it as a drag-out-of-window (which would close the pane after the split).
    dropConsumedRef.current = true;

    // Sidebar drag (PANEL_ID only — no GRID_ITEM, no PANE_TAB): OPEN the topic
    // into the workspace E LASCIARLA NELLA CELLA SU CUI È CADUTA.
    //
    // L'apertura passa dall'evento condiviso `topics:open-topic` con
    // `mode: 'permanent'`, che il listener canonico (usePanelLifecycle) traduce
    // in openPanel — l'imbuto che REGISTRA la pane nel pane-store (una
    // setOpenPanels/onOpenPanelAt nuda NO: REORDER_PANES scarta poi l'id non
    // registrato e non si disegna niente). Il `permanent` tiene questo drop un
    // impegno, mentre lo sbirciare dalla board resta un'anteprima.
    //
    // MA L'APERTURA DA SOLA NON BASTAVA, ed è il difetto che questo ramo
    // portava: il `dragover` dipinge l'anteprima di fusione sulla CELLA sotto
    // il cursore (vedi `isSidebarDrag` in handleGridItemDragOverCapture, che
    // promette «questa cosa entra QUI»), poi il drop ignorava riga e colonna e
    // apriva la chat nel serbatoio principale. Su una griglia con una sola
    // cella non si vedeva; appena la griglia è divisa, trascinare una riga o
    // una tessera fissata dentro una finestra non ci metteva niente — mentre
    // lo STESSO gesto partendo da una tab della barra funzionava. Ora le due
    // sorgenti atterrano nello stesso posto: quello indicato.
    if (!effectiveKey && !sourcePaneTab && sourceTopicId) {
      const targetKey = gridRowsRef.current[dropTarget.rowIdx]?.itemKeys[dropTarget.colIdx];
      const targetPrimary = targetKey?.startsWith('solo:') ? targetKey.slice('solo:'.length) : null;
      if (openPanels.includes(sourceTopicId)) {
        // Già aperta: la si sposta e basta — nessuna attesa da aspettare.
        landSidebarDrop(sourceTopicId, targetPrimary);
      } else {
        pendingSidebarLandingRef.current = { topicId: sourceTopicId, targetPrimary };
        window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: sourceTopicId, mode: 'permanent' } }));
      }
      setDraggingGridKey(null);
      setGridDropTarget(null);
      gridDropTargetRef.current = null;
      return;
    }

    // Tab drag → create a solo standalone item at the target position
    if (!effectiveKey && sourcePaneTab && sourceTopicId) {
      const soloKey = `solo:${sourceTopicId}`;

      // Only a SINGLE-topic cell reorders as a whole cell. itemMap keys
      // cells by their PRIMARY topic, so dragging the primary tab of a
      // multi-tab cell [A,B] used to match `itemMap.has('solo:A')` and move
      // the entire cell — extract the tab instead, exactly like dragging a
      // non-primary member.
      const sourceCell = soloCells.find(c => c.includes(sourceTopicId));
      const isPrimaryOfMultiTab =
        !!sourceCell && sourceCell.length > 1 && sourceCell[0] === sourceTopicId;

      // Guard: don't split a solo item onto its own edge (self-drop no-op).
      // The PRIMARY of a MULTI-tab cell is the exception: its cell key
      // matches, but extracting it onto its own cell's edge is a real split
      // (the remainder re-keys in place and the new cell lands beside/under
      // it) — the drag twin of the menu Split Right/Down inside a cell.
      const targetKey = gridRowsRef.current[dropTarget.rowIdx]?.itemKeys[dropTarget.colIdx];
      if (targetKey === soloKey && !isPrimaryOfMultiTab) {
        setDraggingGridKey(null);
        setGridDropTarget(null);
        gridDropTargetRef.current = null;
        return;
      }

      if (itemMap.has(soloKey) && !isPrimaryOfMultiTab) {
        // Already a standalone solo cell — reorder via the grid path below
        effectiveKey = soloKey;
      } else {
        // Make it solo (or extract it from the multi-tab cell it shares)
        const { rowIdx: targetRowIdx, colIdx: targetColIdx, zone, centerSide } = dropTarget;

        // Row-insert (full-width strips) vs in-cell column stack: a bare
        // bottom-edge tab drop stacks UNDER the target cell's column (the
        // same shape the menu "Split Down" builds) and a bare top-edge drop
        // stacks ABOVE it (the new pane becomes the column's primary);
        // only the strips' fullRow intent inserts a grid row.
        const isFullRowInsert = (zone === 'top' || zone === 'bottom') && !!explicitTarget?.fullRow;
        const isColumnStack = zone === 'bottom' && !explicitTarget?.fullRow;
        const isColumnStackAbove = zone === 'top' && !explicitTarget?.fullRow;

        // Enforce grid limits BEFORE mutating soloCells: extracting first
        // and bailing inside the setGridRows updater left the topic marked
        // solo with no grid slot, and the additive sync then appended it to
        // row 0 PAST the column cap (limit bypass).
        {
          const rowsNow = gridRowsRef.current;
          let overLimit = false;
          if (isFullRowInsert) {
            overLimit = rowsNow.length >= MAX_ROWS;
          } else if (isColumnStack || isColumnStackAbove) {
            const tKey = rowsNow[targetRowIdx]?.itemKeys[targetColIdx];
            const depth = tKey
              ? (rowsNow[targetRowIdx]?.cellStacks?.[tKey]?.items.length ?? 0) + 1
              : 1;
            overLimit = depth >= MAX_STACK_DEPTH;
          } else {
            overLimit = (rowsNow[targetRowIdx]?.itemKeys.length ?? 0) >= MAX_COLS_PER_ROW;
          }
          if (overLimit) {
            setDraggingGridKey(null);
            setGridDropTarget(null);
            gridDropTargetRef.current = null;
            return;
          }
        }

        // Extracting the PRIMARY re-keys the remaining cell to its next
        // member — rename it in place below so the remainder keeps its
        // slot/width/sub-stack instead of teleporting to row 0 via the
        // additive sync.
        const remainderKey = isPrimaryOfMultiTab ? soloCellKey(sourceCell.slice(1)) : null;

        setSoloCells(prev => extractToOwnCell(prev, sourceTopicId));

        setGridRows(prev => {
          const targetKey = prev[targetRowIdx]?.itemKeys[targetColIdx];
          if (!targetKey) return prev;

          // Enforce grid limits (kept as in-updater defense — the pre-check
          // above reads a ref that could lag a concurrent update)
          if (isFullRowInsert && prev.length >= MAX_ROWS) return prev;
          if ((isColumnStack || isColumnStackAbove) && ((prev[targetRowIdx]?.cellStacks?.[targetKey]?.items.length ?? 0) + 1) >= MAX_STACK_DEPTH) return prev;
          if (!isFullRowInsert && !isColumnStack && !isColumnStackAbove && (prev[targetRowIdx]?.itemKeys.length ?? 0) >= MAX_COLS_PER_ROW) return prev;

          // ISSUE 8 FIX: Use immutable operations instead of splice()
          let rows = prev.map(cloneRow);

          if (remainderKey) {
            // Primary extraction: the source cell survives under its new
            // key, in place (deep — it may sit inside another cell's stack).
            rows = rows.map(row => renameKeyDeep(row, soloKey, remainderKey));
          } else {
            // Safety: remove soloKey if already present (immutably). Sibling
            // cells' sub-stacks survive; soloKey's own stale stack entry is
            // dropped — the soloCells change above reruns the additive sync,
            // which re-homes any live orphans (mirrors handleSplitPane).
            rows = rows.map(row => removeKeyFromRow(row, soloKey).row);
            rows = rows.filter(r => r.itemKeys.length > 0);
          }

          // The target may BE the source cell (primary self-extraction) —
          // after the rename above it lives under `remainderKey`.
          const findKey = remainderKey && targetKey === soloKey ? remainderKey : targetKey;
          let tRow = -1, tCol = -1;
          for (let r = 0; r < rows.length; r++) {
            const c = rows[r].itemKeys.indexOf(findKey);
            if (c >= 0) { tRow = r; tCol = c; break; }
          }
          if (tRow === -1) return rows;

          if (isFullRowInsert) {
            const newRow: PanelGridRow = { itemKeys: [soloKey], widths: [1] };
            const insertIdx = zone === 'top' ? tRow : tRow + 1;
            rows = [...rows.slice(0, insertIdx), newRow, ...rows.slice(insertIdx)];
          } else if (isColumnStack) {
            // Stack UNDER the target cell's column (cellStacks sub-stack) —
            // exactly what the SplitRegion preview painted on the cell's
            // bottom half promised, and what the menu "Split Down" builds.
            const row = rows[tRow];
            const stacks = row.cellStacks ? { ...row.cellStacks } : {};
            const existing = stacks[findKey];
            if (existing) {
              const slots = existing.items.length + 2; // primary + items + new
              stacks[findKey] = {
                items: [...existing.items, soloKey],
                heights: Array.from({ length: slots }, () => 1 / slots),
              };
            } else {
              stacks[findKey] = { items: [soloKey], heights: [0.5, 0.5] };
            }
            rows = rows.map((r, i) => (i === tRow ? { ...r, cellStacks: stacks } : r));
          } else if (isColumnStackAbove) {
            // Stack ABOVE the target cell's column — the mirror of the bottom
            // stack, previously impossible from a drag (a bare top drop was
            // routed to the tab bar and silently dropped). cellStacks are
            // keyed by the column's PRIMARY (its itemKey), and items render
            // BELOW the primary — so "above" means the dropped pane becomes
            // the new primary: it takes the column's slot in itemKeys and the
            // old primary (plus its former stack) moves into its items.
            const row = rows[tRow];
            const stacks = row.cellStacks ? { ...row.cellStacks } : {};
            const existing = stacks[findKey];
            const items = existing ? [findKey, ...existing.items] : [findKey];
            const slots = items.length + 1; // new primary + demoted items
            delete stacks[findKey];
            stacks[soloKey] = {
              items,
              heights: Array.from({ length: slots }, () => 1 / slots),
            };
            rows = rows.map((r, i) => (i === tRow
              ? {
                  ...r,
                  itemKeys: r.itemKeys.map(k => (k === findKey ? soloKey : k)),
                  cellStacks: stacks,
                }
              : r));
          } else {
            const row = rows[tRow];
            const insertAt = (zone === 'right' || (zone === 'center' && centerSide === 'right'))
              ? tCol + 1
              : tCol;
            const newKeys = [...row.itemKeys.slice(0, insertAt), soloKey, ...row.itemKeys.slice(insertAt)];
            // Split the target column's width with the new one; siblings keep
            // their manual sizes (was `1/n`, which flattened the whole row).
            rows = rows.map((r, i) => i === tRow
              ? {
                  itemKeys: newKeys,
                  widths: splitColumnWidths(r.widths, tCol, insertAt),
                  ...(r.cellStacks ? { cellStacks: r.cellStacks } : {}),
                }
              : r);
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

      // Find source position — top-level itemKeys OR inside a cell's
      // sub-stack. A pane that was split DOWN lives only in
      // cellStacks[host].items; searching itemKeys alone made every drag of
      // a sub-stacked pane a silent no-op (indicators painted, drop did
      // nothing).
      let srcRow = -1;
      let srcInStack = false;
      for (let r = 0; r < prev.length; r++) {
        if (prev[r].itemKeys.includes(effectiveKey)) { srcRow = r; break; }
        const stacks = prev[r].cellStacks;
        if (stacks && Object.values(stacks).some(s => s.items.includes(effectiveKey))) {
          srcRow = r;
          srcInStack = true;
          break;
        }
      }
      if (srcRow === -1) return prev;

      if (!targetKey || effectiveKey === targetKey) {
        // ISSUE 18: Invalid target — fall back to "add to end" if target disappeared
        if (!targetKey && prev.length > 0) {
          // Move source to end of last row. Its sub-stack travels with it;
          // sibling cells' stacks survive (removeKeyFromRow, not a bare
          // itemKeys/widths rebuild). A sub-stacked source is pulled out of
          // its host's stack instead (it has no own stack to carry).
          let rows = prev.map(cloneRow);
          let movedStack: PanelGridCellStack | undefined;
          rows = rows.map((r, i) => {
            if (i !== srcRow) return r;
            if (srcInStack) return removeKeyFromStacks(r, effectiveKey);
            const res = removeKeyFromRow(r, effectiveKey);
            movedStack = res.detachedStack;
            return res.row;
          }).filter(r => r.itemKeys.length > 0);
          // Append to last row — but respect MAX_COLS_PER_ROW. The bottom cap
          // guard sits after this branch's early return, so the fallback was the
          // one insert site that could push the last row past the column cap
          // (producing slivers the rest of the code assumes can't exist). If the
          // last row is full, spill into a new single-cell row when there's room,
          // else drop the move — mirroring the other insert sites.
          const lastRow = rows[rows.length - 1];
          if (lastRow.itemKeys.length >= MAX_COLS_PER_ROW) {
            if (rows.length >= MAX_ROWS) return prev;
            return [...rows, {
              itemKeys: [effectiveKey],
              widths: [1],
              ...(movedStack ? { cellStacks: { [effectiveKey]: movedStack } } : {}),
            }];
          }
          const newKeys = [...lastRow.itemKeys, effectiveKey];
          rows = rows.map((r, i) => {
            if (i !== rows.length - 1) return r;
            const stacks = { ...(r.cellStacks ?? {}), ...(movedStack ? { [effectiveKey]: movedStack } : {}) };
            return {
              itemKeys: newKeys,
              // Give the appended column a fair share while preserving the
              // surviving columns' relative weights (was `1/n`, which flattened
              // the whole last row) — matches every other insert path.
              widths: appendColumnWidths(lastRow.widths, 1),
              ...(Object.keys(stacks).length > 0 ? { cellStacks: stacks } : {}),
            };
          });
          return rows;
        }
        return prev;
      }

      // ISSUE 8 FIX: Use immutable operations instead of splice()
      // Deep copy rows
      let rows = prev.map(cloneRow);

      // Remove source from its row. The moved cell's own sub-stack is
      // detached here and re-attached at the destination below; sibling
      // cells' stacks are untouched (removeKeyFromRow preserves them). A
      // sub-stacked source is pulled out of its host's stack instead.
      let movedStack: PanelGridCellStack | undefined;
      rows = rows.map((r, i) => {
        if (i !== srcRow) return r;
        if (srcInStack) return removeKeyFromStacks(r, effectiveKey);
        const res = removeKeyFromRow(r, effectiveKey);
        movedStack = res.detachedStack;
        return res.row;
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

      // Insert source based on zone (immutably). The detached sub-stack
      // re-attaches under the moved key at its new home.
      if (zone === 'top' || zone === 'bottom') {
        // Create new row above/below target
        const newRow: PanelGridRow = {
          itemKeys: [effectiveKey],
          widths: [1],
          ...(movedStack ? { cellStacks: { [effectiveKey]: movedStack } } : {}),
        };
        const insertIdx = zone === 'top' ? tRow : tRow + 1;
        rows = [...rows.slice(0, insertIdx), newRow, ...rows.slice(insertIdx)];
      } else {
        // left/right/center — insert as column in target's row
        const row = rows[tRow];
        const insertAt = (zone === 'right' || (zone === 'center' && centerSide === 'right'))
          ? tCol + 1
          : tCol;
        const newKeys = [...row.itemKeys.slice(0, insertAt), effectiveKey, ...row.itemKeys.slice(insertAt)];
        // Split the target column's width with the inserted one; leave siblings'
        // manual widths intact (was `1/n`, which reset the whole row).
        rows = rows.map((r, i) => {
          if (i !== tRow) return r;
          const stacks = { ...(r.cellStacks ?? {}), ...(movedStack ? { [effectiveKey]: movedStack } : {}) };
          return {
            itemKeys: newKeys,
            widths: splitColumnWidths(r.widths, tCol, insertAt),
            ...(Object.keys(stacks).length > 0 ? { cellStacks: stacks } : {}),
          };
        });
      }

      return rows;
    });

    setDraggingGridKey(null);
    setGridDropTarget(null);
    gridDropTargetRef.current = null;
    // soloCells IS read directly (sourceCell lookup), so it must be a dep —
    // omitting it captured a stale soloCells in the drop handler. The handler is
    // only a JSX prop / wrapped by other callbacks (never an effect dep), so
    // recreating it on soloCells change has no re-render/loop cost.
  }, [itemMap, gridDropTargetRef, gridRowsRef, fullRowDropRef, setGridRows, setSoloCells, soloCells, handleMergeIntoCell, handleUnsoloTopic, openPanels, landSidebarDrop]);

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
      handleGridItemDropCapture(e, { rowIdx, colIdx: 0, zone: 'bottom', fullRow: true });
    },
    [handleGridItemDropCapture],
  );

  /* ---- Full-width row drop strips (split "sopra/sotto TUTTE le colonne") ----
   *
   * The project surface's two-intent model, ported here: a cell's bottom
   * edge stacks under JUST that column, while these strips insert a row
   * spanning EVERY column — at the container's extremes (FullWidthRowZone)
   * or between two existing rows (RowGapDropZone). The top strip is also the
   * only way to split a tab UPWARD at all: the in-cell 'top' band belongs to
   * the tab bar, so tab drops there are (correctly) refused.
   *
   * Only live during a standalone-scope tab drag (`tabDragActive`), so the
   * bands never swallow normal clicks — same gating as GroupLayout's strips.
   * (State lives up next to `isAnyDragActive` so the drag-reset paths that
   * are declared earlier can clear it.)
   */
  const isStandaloneTabDrag = useCallback((e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    return (
      t.includes(DND_TYPES.PANE_TAB) &&
      !t.includes(DND_TYPES.GRID_ITEM) &&
      t.includes(DND_TYPES.PANEL_ID) &&
      dragMatchesScope(t, STANDALONE_SCOPE)
    );
  }, []);

  const handleFullRowDragOver = useCallback((strip: 'top' | 'bottom' | number) => (e: React.DragEvent) => {
    // Tab drags (standalone scope) AND whole-cell GRID drags both insert a
    // full-width row here — grid drags previously had no physical strip
    // target at all (their only row-insert gesture was the dishonest
    // half-cell top/bottom preview).
    if (!isStandaloneTabDrag(e) && !e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move'; // WKWebView: signal acceptance (see cell dragover)
    // The strip overlays a cell's edge band — clear the per-cell preview so
    // only ONE intent (full-width row) shows while the pointer is on it.
    if (gridDropTargetRef.current) { setGridDropTarget(null); gridDropTargetRef.current = null; }
    if (fullRowDropRef.current !== strip) { fullRowDropRef.current = strip; setFullRowDrop(strip); }
  }, [isStandaloneTabDrag, gridDropTargetRef, fullRowDropRef]);

  const handleFullRowDragLeave = useCallback((e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null;
    if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
    fullRowDropRef.current = null;
    setFullRowDrop(null);
  }, [fullRowDropRef]);

  const handleFullRowDrop = useCallback((strip: 'top' | 'bottom' | number) => (e: React.DragEvent) => {
    fullRowDropRef.current = null;
    setFullRowDrop(null);
    setTabDragActive(false);
    const rows = gridRowsRef.current;
    if (rows.length === 0) return;
    // Anchor: extreme strips target the first/last row; a gap strip targets
    // the row ABOVE it. Zone top/bottom + fullRow makes the shared drop
    // handler insert the new full-width row on the right side of the anchor.
    const target = strip === 'top'
      ? { rowIdx: 0, colIdx: 0, zone: 'top' as DropZone, fullRow: true }
      : strip === 'bottom'
        ? { rowIdx: rows.length - 1, colIdx: 0, zone: 'bottom' as DropZone, fullRow: true }
        : { rowIdx: Math.min(strip, rows.length - 1), colIdx: 0, zone: 'bottom' as DropZone, fullRow: true };
    handleGridItemDropCapture(e, target);
  }, [fullRowDropRef, gridRowsRef, handleGridItemDropCapture]);

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
  // Split mini-map descriptor — real column widths per row + row heights, so
  // the schematic mirrors the actual split proportions. Top-level cells only
  // (vertical sub-stacks aren't represented); enough to orient "which pane in
  // the grid is this". Omitted for single-cell grids. Memoized so
  // `renderGroupForKey` keeps a stable identity across renders.
  const splitRowWidths = useMemo(() => effectiveGridRows.map((r) => r.widths), [effectiveGridRows]);
  const hasGridSplit = useMemo(() => splitRowWidths.reduce((a, r) => a + r.length, 0) > 1, [splitRowWidths]);

  // "Reimposta pannelli" — COLLAPSE the whole standalone grid to ONE full cell.
  // Every side-by-side column AND every vertical stack folds into the single
  // 'standalone' pool cell, where the panes live as TABS (StandaloneChatGroup is
  // tab-based). Emptying soloCells re-absorbs every solo pane into the pool —
  // they're already in openPanels, so nothing is closed or lost — and a lone
  // 'standalone' cell is a fixed point of every grid sync effect (additive
  // naturalGridItems sync, deferred prune, rowHeights sync, project-weight
  // rebalance all no-op on it), so nothing re-splits afterwards. Undoable;
  // writes go through the usePanelGridPersistence setters only. This is
  // deliberately stronger than the old flatten-to-one-row-of-columns: horizontal
  // columns collapse into tabs too (the reported "toglie solo i verticali").
  const isGridCollapsed = useMemo(() => {
    if (soloCellsRaw.length > 0) return false;
    if (gridRows.length !== 1) return false;
    const only = gridRows[0];
    return only.itemKeys.length === 1 && only.itemKeys[0] === 'standalone' && !only.cellStacks;
  }, [soloCellsRaw, gridRows]);
  const canFlattenGrid = !isGridCollapsed;
  const handleResetGridLayout = useCallback(() => {
    if (isGridCollapsed) return; // already a single full pane → no-op (ctx-menu entry also hides)
    const prevRows = gridRowsRef.current;
    const prevHeights = gridRowHeightsRef.current;
    const prevSolo = soloCellsRawRef.current;
    const applyCollapsed = () => {
      // Batched (React 18) → naturalGridItems recomputes once to the lone pool cell.
      setSoloCells([]);
      setGridRows([{ itemKeys: ['standalone'], widths: [1] }]);
      setGridRowHeights([1]);
    };
    // Collapse discards manual widths/heights/stacks AND the solo extraction, so
    // make it undoable — ⌘Z restores the exact prior geometry and solo cells.
    pushUndo({
      description: 'Reimposta pannelli',
      undo: () => {
        setSoloCells(prevSolo);
        setGridRows(prevRows);
        setGridRowHeights(prevHeights);
      },
      redo: applyCollapsed,
    });
    applyCollapsed();
  }, [isGridCollapsed, gridRowsRef, gridRowHeightsRef, soloCellsRawRef, setSoloCells, setGridRows, setGridRowHeights]);

  // Palette / Topics-menu path — same per-window CustomEvent GroupLayout listens
  // to. A focused PROJECT window owns the event (its GroupLayout flattens), so we
  // bail only when the focused pane IS a project pane. Otherwise — a focused
  // standalone grid item OR NOTHING focused at all — the standalone grid is the
  // default target. The old extra `!focusedPanelId` bail made "Reimposta pannelli"
  // from the header menu / palette a silent no-op whenever no pane happened to be
  // focused (nothing clicked yet), which read as "it does nothing". GroupLayout's
  // gate is `focusedPanelId === wrapperPaneId`, so a null focus never flattens a
  // project — the two still never act together.
  // Global "Reimposta pannelli" (header menu / ⌘K) — flatten the standalone grid
  // too. handleResetGridLayout no-ops when the grid is already flat, so it's safe
  // to run unconditionally alongside every GroupLayout surface; each flattens its
  // own model and already-flat surfaces do nothing.
  useEffect(() => {
    const handler = () => handleResetGridLayout();
    window.addEventListener('topics:reset-split-layout', handler);
    return () => window.removeEventListener('topics:reset-split-layout', handler);
  }, [handleResetGridLayout]);

  // "Disponi automaticamente" — auto-tile: explode EVERY open standalone pane
  // into its own cell laid out in a balanced ~square grid (ceil(√n) columns).
  // The inverse of collapse ("Reimposta pannelli"): from one pool full of tabs
  // to all panes visible side-by-side. The first pane stays in the 'standalone'
  // pool; the rest each become a single-topic solo cell — so every open topic
  // maps 1:1 to a grid cell. naturalGridItems emits 'standalone' first then one
  // cell per solo cell, and gridRows lists exactly those keys in row-major
  // order, so no sync effect heals or prunes. Undoable; nothing is closed.
  const handleAutoTileGrid = useCallback(() => {
    const panes = openPanels;
    const n = panes.length;
    if (n < 2) return; // nothing to spread
    const cols = Math.min(Math.ceil(Math.sqrt(n)), MAX_COLS_PER_ROW);
    // First pane keeps the pool; the others each get their own single-topic cell.
    const nextSolo: string[][] = panes.slice(1).map((id) => [id]);
    const cellKeys = ['standalone', ...panes.slice(1).map((id) => soloCellKey([id]))];
    const rows: PanelGridRow[] = [];
    for (let i = 0; i < cellKeys.length; i += cols) {
      const chunk = cellKeys.slice(i, i + cols);
      rows.push({ itemKeys: chunk, widths: equalizeWidths(chunk.length) });
    }
    const rowHeights = equalizeWidths(rows.length);
    const prevRows = gridRowsRef.current;
    const prevHeights = gridRowHeightsRef.current;
    const prevSolo = soloCellsRawRef.current;
    const apply = () => {
      // Batched (React 18) → naturalGridItems recomputes once to the tiled grid.
      setSoloCells(nextSolo);
      setGridRows(rows);
      setGridRowHeights(rowHeights);
    };
    pushUndo({
      description: 'Disponi automaticamente',
      undo: () => {
        setSoloCells(prevSolo);
        setGridRows(prevRows);
        setGridRowHeights(prevHeights);
      },
      redo: apply,
    });
    apply();
  }, [openPanels, gridRowsRef, gridRowHeightsRef, soloCellsRawRef, setSoloCells, setGridRows, setGridRowHeights]);

  useEffect(() => {
    const handler = () => handleAutoTileGrid();
    window.addEventListener('topics:auto-tile-layout', handler);
    return () => window.removeEventListener('topics:auto-tile-layout', handler);
  }, [handleAutoTileGrid]);

  // Publish each open topic's grid position so the SIDEBAR cards can render the
  // same proportional mini-map with that topic's cell lit (not just the tab
  // bar). Every topic in a cell — including those stacked in a vertical
  // sub-stack under that cell — maps to the cell's [row, col]. Empty (→ no
  // sidebar maps) when the grid isn't split.
  const publishSplitPositions = usePublishSplitPositions();
  const topicPositions = useMemo<Map<string, SplitMapDescriptor>>(() => {
    const out = new Map<string, SplitMapDescriptor>();
    if (!hasGridSplit) return out;
    const assign = (key: string, rowIdx: number, colIdx: number) => {
      const item = itemMap.get(key);
      if (!item) return;
      const desc: SplitMapDescriptor = { rows: splitRowWidths, rowHeights: gridRowHeights, active: [rowIdx, colIdx] };
      for (const paneId of item.panelIds) {
        // Key by the chat topic id (sidebar chat rows read this) AND, for a
        // project pane, by its project path — so the sidebar PROJECT row can
        // show where that project window sits in the tiled top-level split
        // ("posizione della finestra"). Topic ids are UUIDs and project paths
        // are filesystem paths, so the two key spaces never collide.
        out.set(paneId, desc);
        const projectPath = getProjectPathFromPaneId(paneId);
        if (projectPath) out.set(projectPath, desc);
      }
    };
    effectiveGridRows.forEach((row, rowIdx) => {
      row.itemKeys.forEach((key, colIdx) => {
        assign(key, rowIdx, colIdx);
        // Vertical sub-stack items share the host cell's coordinates.
        const stack = row.cellStacks?.[key];
        if (stack) for (const stackedKey of stack.items) assign(stackedKey, rowIdx, colIdx);
      });
    });
    return out;
  }, [hasGridSplit, effectiveGridRows, itemMap, splitRowWidths, gridRowHeights]);
  useEffect(() => {
    publishSplitPositions(topicPositions);
  }, [topicPositions, publishSplitPositions]);

  const renderGroupForKey = useCallback(
    (item: GridItem, key: string, rowIdx: number, colIdx: number) => (
      <StandaloneChatGroup
        topicIds={item.panelIds}
        focusedPanelId={focusedPanelId}
        onFocusPanel={onFocusPanel}
        onClosePanel={onClosePanel}
        onClosePanelImmediate={onClosePanelImmediate}
        onDragStart={handleDragStart}
        getSessionMessages={getSessionMessages}
        getCompactionMarkers={getCompactionMarkers}
        isSessionLoading={isSessionLoading}
        isSessionStreaming={isSessionStreaming}
        wasSessionStopped={wasSessionStopped}
        stopSession={stopSession}
        sendMessage={sendMessage}
        editMessage={editMessage}
        regenerateMessage={regenerateMessage}
        deleteMessage={deleteMessage}
        switchBranch={switchBranch}
        loadHistory={loadHistory}
        chatError={chatError}
        sendWS={sendWS}
        onWSMessage={onWSMessage}
        onUpdateTopic={onUpdateTopic}
        mobile={isMobile}
        // Il comando che riapre la colonna sta sul riquadro in alto a sinistra,
        // che è quello che l'occhio guarda per primo. Sul telefono i riquadri
        // non sono affiancati e se ne vede UNO: se restasse legato alla cella
        // (0,0) il comando starebbe su quella nascosta, e la lista — con la
        // striscia delle tab tolta — non avrebbe più un tasto per riaprirsi.
        onToggleSidebar={
          (isMobile ? key === mobileVisibleKey : rowIdx === 0 && colIdx === 0)
            ? onToggleSidebar
            : undefined
        }
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
        onCreateTerminal={onCreateTerminal}
        onUtilityPaneChange={key === 'standalone' ? handleStandaloneUtilityChange : undefined}
        pendingBrowserPane={key === 'standalone' ? pendingBrowserPane : undefined}
        onPendingBrowserPaneConsumed={key === 'standalone' ? onPendingBrowserPaneConsumed : undefined}
        onOpenBrowserContextIds={key === 'standalone' ? onOpenBrowserContextIds : undefined}
        promoteDraft={promoteDraft}
        draftMeta={draftMeta}
        onSplitPane={handleSplitPane}
        onResetLayout={canFlattenGrid ? handleResetGridLayout : undefined}
        persistOrder={key === 'standalone'}
        gridItemKey={key}
        onUnsolo={key.startsWith('solo:') ? handleUnsoloTopic : undefined}
        onAcceptSoloDrop={handleUnsoloTopic}
        onMergeIntoCell={handleMergeIntoCell}
        onToggleFissato={onToggleFissato}
        isFissato={isFissato}
        // Pool reorders merge back into App.openPanels; a SOLO cell's reorder
        // rewrites its cell in soloCells (its persisted tab order) — without
        // this only solo cells silently lost the reorder on reload.
        onPersistReorder={
          key === 'standalone'
            ? handlePersistPoolReorder
            : key.startsWith('solo:')
              ? (ids: string[]) => handlePersistCellOrder(key, ids)
              : undefined
        }
      />
    ),
    [
      focusedPanelId, onFocusPanel, onClosePanel, handleDragStart,
      getSessionMessages, getCompactionMarkers, isSessionLoading,
      isSessionStreaming, wasSessionStopped, stopSession, sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch,
      loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
      onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed, onNewChat,
      pendingProjectPane, onPendingProjectPaneConsumed, onNewChatInProject,
      pendingProjectFocus, onPendingProjectFocusConsumed,
      onProjectActiveTopicChange, onProjectOpenPanesChange,
      onCreateTerminal, handleStandaloneUtilityChange, pendingBrowserPane,
      onPendingBrowserPaneConsumed, onOpenBrowserContextIds, promoteDraft,
      draftMeta, handleSplitPane, handleUnsoloTopic,
      canFlattenGrid, handleResetGridLayout,
      handleMergeIntoCell, handlePersistPoolReorder, handlePersistCellOrder,
      onClosePanelImmediate, onToggleFissato, isFissato,
      isMobile, mobileVisibleKey,
    ],
  );

  /* ================================================================== */
  /*  Split-tree render path (desktop)                                    */
  /* ================================================================== */
  //
  // Renders the grid through the unified <SplitTree> engine — the desktop
  // renderer (the legacy row/column JSX below is kept ONLY for the mobile <768px
  // layout, which the tree doesn't model). The tree mirrors gridRows 1:1 (a
  // col-split of rows, each a row-split of columns) so a divider's (path, idx)
  // maps straight back to (rowIdx, colIdx). Every gesture reuses the existing
  // handlers:
  //   - drop / split / move / reorder  → handleGridItemDragOverCapture/DropCapture
  //   - vertical sub-stacks            → <CellSubStack> inside the column leaf
  //   - divider resize / equalize      → mapped onto gridRows widths / heights
  // Geometry is byte-identical to the old desktop path (golden-geometry gate).
  // Insert-between-divider drops are reached via the cell edge instead (same
  // target cell + zone — no insert position is lost, just a redundant drop strip).

  // key → [rowIdx, colIdx] for the top-level cells (sub-stack members aren't tree
  // leaves here — they live inside their host cell's <CellSubStack>).
  const keyPos = useMemo<ReadonlyMap<string, [number, number]>>(() => {
    const m = new Map<string, [number, number]>();
    effectiveGridRows.forEach((row, r) => row.itemKeys.forEach((k, c) => { if (!m.has(k)) m.set(k, [r, c]); }));
    return m;
  }, [effectiveGridRows]);

  // Shallow tree, 1:1 with gridRows (never drops/reorders rows or columns, so the
  // tree path === gridRows index). Missing / duplicate slots become inert
  // `__skip:*` placeholder leaves (rendered null) with weight 0 — they keep the
  // index stable AND reserve no space, so a transient stale key leaves no blank
  // gap (it self-heals on the next prune).
  const treeRoot = useMemo<LayoutNode | null>(
    () =>
      buildShallowGridTree(
        effectiveGridRows.map((r) => ({ keys: r.itemKeys, widths: r.widths })),
        gridRowHeights,
        (key) => itemMap.has(key),
      ),
    [effectiveGridRows, gridRowHeights, itemMap],
  );

  // Divider drag → shift weight on the matching gridRows band, preserving
  // cellStacks (so persistence + sub-stacks survive). path [] = row heights;
  // path [rowIdx] = that row's column widths.
  const handleTreeResize = useCallback((path: number[], dividerIdx: number, deltaPx: number, bandPx: number) => {
    const wd = pxToWeightDelta(bandPx, deltaPx);
    if (wd === 0) return;
    if (path.length === 0) {
      setGridRowHeights(prev => resizeWeights(prev, dividerIdx, wd, MIN_PANE_FRACTION));
    } else if (path.length === 1) {
      const rowIdx = path[0];
      setGridRows(prev => prev.map((r, i) => (i === rowIdx ? { ...r, widths: resizeWeights(r.widths, dividerIdx, wd, MIN_PANE_FRACTION) } : r)));
    }
  }, [setGridRowHeights, setGridRows]);

  // Double-click a divider → weighted equalize (same semantics as the legacy
  // equalizeHorizontal/Vertical: balances LEAF panes, not just cells).
  const handleTreeEqualize = useCallback((path: number[]) => {
    if (path.length === 0) {
      setGridRowHeights(weightedWidths(rowHeightWeights(gridRowsRef.current)));
    } else if (path.length === 1) {
      const rowIdx = path[0];
      setGridRows(prev => prev.map((r, i) => (i === rowIdx ? { ...r, widths: weightedWidths(rowColumnWeights(r)) } : r)));
    }
  }, [setGridRowHeights, setGridRows, rowHeightWeights, rowColumnWeights, gridRowsRef]);

  // One leaf = one top-level cell. Reuses renderGroupForKey + the exact legacy
  // drop-capture wrapper + <CellSubStack>, so DnD and sub-stacks behave as today.
  const renderTreeLeaf = useCallback((key: string): React.ReactNode => {
    if (key.startsWith('__skip:')) return null;
    const item = itemMap.get(key);
    if (!item) return null;
    const pos = keyPos.get(key);
    const rowIdx = pos ? pos[0] : 0;
    const colIdx = pos ? pos[1] : 0;
    const isTarget = gridDropTarget?.rowIdx === rowIdx && gridDropTarget?.colIdx === colIdx;
    const zone = isTarget ? gridDropTarget!.zone : null;
    const cSide = isTarget ? gridDropTarget!.centerSide : undefined;
    const isTabTarget = isTarget && !!gridDropTarget!.isTab;
    // Every edge zone previews for tab drags now — 'top' is a real
    // stack-above split (the bar's own hover is intercepted upstream by the
    // closest() guard, so no double indicator over the bar). GRID drags'
    // top/bottom insert a FULL-WIDTH row, so their preview is the row
    // strip/gap band (lit from the cell's dragover), NOT a half-cell region —
    // the half-cell promised a per-column split the drop never performed.
    const showSplitRegion = zone === 'left' || zone === 'right'
      || (isTabTarget && (zone === 'top' || zone === 'bottom'));
    const stack = effectiveGridRows[rowIdx]?.cellStacks?.[key];
    const primaryGroup = renderGroupForKey(item, key, rowIdx, colIdx);
    return (
      <div
        className={`flex w-full h-full min-h-0 min-w-0 overflow-hidden relative ${draggingGridKey === key ? 'opacity-40' : ''}`}
        style={{
          boxShadow: zone === 'center' && !isTabTarget
            ? (cSide === 'left' ? 'inset 4px 0 0 0 var(--primary)' : 'inset -4px 0 0 0 var(--primary)')
            : undefined,
        }}
        data-panel-cell={`${rowIdx}-${colIdx}`}
        onDragOverCapture={handleGridItemDragOverCapture(rowIdx, colIdx)}
        onDropCapture={handleGridItemDropCapture}
      >
        {showSplitRegion && <SplitRegion zone={zone as 'left' | 'right' | 'top' | 'bottom'} />}
        {isTabTarget && zone === 'center' && <CenterRegion />}
        {stack ? (
          <CellSubStack
            stack={stack}
            primary={primaryGroup}
            primaryKey={key}
            renderStackItem={(stackKey) => {
              const stackItem = itemMap.get(stackKey);
              if (!stackItem) return null;
              return renderGroupForKey(stackItem, stackKey, rowIdx, colIdx);
            }}
            onResize={(nextHeights) => handleCellStackResize(rowIdx, key, nextHeights)}
            isDragActive={isAnyDragActive}
          />
        ) : primaryGroup}
      </div>
    );
  }, [itemMap, keyPos, effectiveGridRows, gridDropTarget, draggingGridKey, handleGridItemDragOverCapture, handleGridItemDropCapture, renderGroupForKey, handleCellStackResize, isAnyDragActive]);

  /* ---- empty state ---- */
  if (naturalGridItems.length === 0) {
    // I gruppi non stanno più qui sopra: stanno in fondo alla SIDEBAR, accanto
    // alle tab che governano (SpaceBar). Una striscia di chip in cima alla
    // griglia, a destra, era il posto più lontano possibile dalla lista che
    // decideva.
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center bg-surface transition-colors ${
          emptyDragOver ? 'bg-primary/5 dark:bg-primary/10' : ''
        }`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move'; // WKWebView: signal accept so dragend doesn't pop-out-close
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
                  {/* `shortcut()` and not `⌘` written out: on Windows that glyph
                      names a key the keyboard does not have, and this is the FIRST
                      screen anyone sees. The binding is unchanged — the handlers
                      accept `metaKey || ctrlKey` — only the caption follows the
                      system. */}
                  <span className="flex items-center gap-1.5 bg-app-hover dark:bg-elevated px-3 py-1.5 rounded-lg"><kbd className="kbd">{shortcut('K')}</kbd> Search</span>
                  <span className="flex items-center gap-1.5 bg-app-hover dark:bg-elevated px-3 py-1.5 rounded-lg"><kbd className="kbd">{shortcut('B')}</kbd> Sidebar</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      </div>
    );
  }

  /* ---- render multi-row grid layout ---- */
  // Render-time dedup guard (mirrors GroupLayout): a key present in two gridRows
  // rows — e.g. additive sync appended it to row 0 while a stale row still holds
  // it — would render the same window twice. Skip any key already painted. Reset
  // per render; purely subtractive by exact key.
  const seenGridKeys = new Set<string>();
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
    <div
      ref={containerRef}
      data-split-surface
      // Mid tab-drag, neutralise the divider grab band (CSS below) so a tab
      // dropped onto a pane's inner edge that abuts a divider still splits —
      // the built-in SplitTree divider is z-50 pointer-events:auto but has no
      // drop handler, so it silently ate left/right edge drops otherwise.
      data-drag-active={isAnyDragActive || undefined}
      className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative"
      onDragStartCapture={handleAnyDragStart}
      // Types are readable on dragenter (not on the capture-phase dragstart
      // above) — flags a STANDALONE tab drag so the full-width row strips
      // mount for it and only it (project-internal drags keep their own).
      onDragEnterCapture={(e) => { if (isStandaloneTabDrag(e)) setTabDragActive(true); }}
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

      {/* Full-width row drop strips — the project surface's two-intent model:
          a cell's bottom edge stacks under JUST that column, these strips
          insert a row spanning EVERY column. Extremes when some row has >1
          column (with a single column the per-cell stack already spans full
          width); interior gap strips whenever there are ≥2 rows — the only
          gesture that inserts a full-width row BETWEEN rows. Drag-only. */}
      {(tabDragActive || !!draggingGridKey) && !isMobile && gridRows.some(r => r.itemKeys.length > 1) &&
        (['top', 'bottom'] as const).map((side) => (
          <FullWidthRowZone
            key={side}
            side={side}
            active={fullRowDrop === side}
            // Clear the first row's tab bar, exactly like the project layout:
            // a strip laid over that bar takes the drops meant for it, so
            // moving a tab into the first row's group was unreachable.
            edgeOffset={side === 'top' ? TAB_BAR_H : 0}
            onDragOver={handleFullRowDragOver(side)}
            onDragLeave={handleFullRowDragLeave}
            onDrop={handleFullRowDrop(side)}
          />
        ))}
      {(tabDragActive || !!draggingGridKey) && !isMobile && gridRows.length > 1 && (() => {
        const total = gridRowHeights.reduce((s, h) => s + (Number.isFinite(h) && h > 0 ? h : 1 / gridRows.length), 0) || 1;
        let acc = 0;
        return gridRows.slice(0, -1).map((_, i) => {
          const h = gridRowHeights[i];
          acc += (Number.isFinite(h) && h > 0 ? h : 1 / gridRows.length) / total;
          return (
            <RowGapDropZone
              key={`gap-${i}`}
              topPct={acc * 100}
              active={fullRowDrop === i}
              onDragOver={handleFullRowDragOver(i)}
              onDragLeave={handleFullRowDragLeave}
              onDrop={handleFullRowDrop(i)}
            />
          );
        });
      })()}
      {treeRoot && !isMobile ? (
        // The split-tree engine is the desktop renderer. On a narrow/mobile
        // viewport the legacy path stacks columns vertically and equalizes them;
        // the tree has no mobile mode, so we keep the legacy branch below ONLY as
        // the mobile (<768px) renderer (matches isMobile in that branch).
        <SplitTree
          node={treeRoot}
          renderLeaf={renderTreeLeaf}
          onResize={handleTreeResize}
          onEqualize={handleTreeEqualize}
          gutter={1}
        />
      ) : effectiveGridRows.map((row, rowIdx) => (
        <Fragment key={rowIdx}>
          <div
            className={`flex ${isMobile ? 'flex-col' : 'flex-row'} min-h-0 min-w-0 overflow-hidden`}
            style={{
              flex: `${gridRowHeights[rowIdx] ?? 1 / effectiveGridRows.length} 1 0%`,
              // Sul telefono si vede una superficie sola: la riga che non
              // ospita il riquadro a fuoco esce dal layout senza smontarsi
              // (vedi `mobileVisibleKey`).
              ...(isMobile && mobileVisibleKey && !rowHoldsKey(row, mobileVisibleKey)
                ? { display: 'none' }
                : null),
            }}
            data-panel-row={rowIdx}
          >
            {row.itemKeys.map((key, colIdx) => {
              const item = itemMap.get(key);
              if (!item || seenGridKeys.has(key)) return null;
              seenGridKeys.add(key);

              const width = row.widths[colIdx] ?? 1 / row.itemKeys.length;
              const isDraggingThis = draggingGridKey === key;
              const isTarget = gridDropTarget?.rowIdx === rowIdx && gridDropTarget?.colIdx === colIdx;
              const zone = isTarget ? gridDropTarget!.zone : null;
              const cSide = isTarget ? gridDropTarget!.centerSide : undefined;
              const isTabTarget = isTarget && !!gridDropTarget!.isTab;
              // Same overlay law as the tree renderer above: tab drags preview
              // every edge (top = stack-above now); grid drags' top/bottom are
              // full-width row inserts previewed by the strip/gap bands, so
              // the half-cell region stays off for those.
              const showSplitRegion = zone === 'left' || zone === 'right'
                || (isTabTarget && (zone === 'top' || zone === 'bottom'));

              return (
                <Fragment key={key}>
                  <div
                    className={`flex min-h-0 min-w-0 overflow-hidden relative transition-all ${isDraggingThis ? 'opacity-40' : ''}`}
                    style={{
                      flex: isMobile ? '1 1 0%' : `${width} 1 0%`,
                      // Vedi `mobileVisibleKey`: gli altri riquadri restano
                      // montati (lo stato vive) ma fuori dal layout.
                      ...(isMobile && mobileVisibleKey && key !== mobileVisibleKey
                        ? { display: 'none' }
                        : null),
                      // Center inset = "reorder within / merge as tab" cue. Only
                      // for GRID_ITEM drags: a PANE_TAB over center no-ops on drop
                      // (the bar owns add-as-tab), so painting it would over-promise.
                      boxShadow: zone === 'center' && !isTabTarget
                        ? (cSide === 'left' ? 'inset 4px 0 0 0 var(--primary)' : 'inset -4px 0 0 0 var(--primary)')
                        : undefined,
                    }}
                    data-panel-cell={`${rowIdx}-${colIdx}`}
                    onDragOverCapture={handleGridItemDragOverCapture(rowIdx, colIdx)}
                    onDropCapture={handleGridItemDropCapture}
                  >
                    {showSplitRegion && <SplitRegion zone={zone as 'left' | 'right' | 'top' | 'bottom'} />}
                    {isTabTarget && zone === 'center' && <CenterRegion />}
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
                          primaryKey={key}
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

                    {/* The edge-split preview is painted once via <SplitRegion>
                        above (z-40, animated, fill + seam — no dashed perimeter).
                        A second identical overlay used to render here too. Removed. */}
                  </div>

                  {/* Column divider (between items in a row) — hidden on mobile */}
                  {colIdx < row.itemKeys.length - 1 && !isMobile && (
                    <ColumnInsertDivider
                      rowIdx={rowIdx}
                      colIdx={colIdx}
                      widths={row.widths}
                      isDragActive={isAnyDragActive}
                      onResizeStart={startHorizontalResize(rowIdx, colIdx, row.widths)}
                      onEqualize={equalizeHorizontal(rowIdx, row.itemKeys.length, () => rowColumnWeights(row))}
                      onInsertBetween={handleInsertBetweenColumns}
                      onClaimDropTarget={clearGridDropTarget}
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
              onEqualize={equalizeVertical(gridRows.length, () => rowHeightWeights(gridRows))}
              onInsertBetween={handleInsertBetweenRows}
              onClaimDropTarget={clearGridDropTarget}
            />
          )}
        </Fragment>
      ))}

      {/* Pop-out presence markers — one card per detached OS window on this
          device, AFTER the grid rows. Space-agnostic (ruling 3.5): renders in
          every Spazio. Pure presence projection, disappears when the window
          dies. Click focuses the window or reopens its topics here on false. */}
      <DetachedWindowMarker topics={topics} onReopenTopic={(id) => onOpenPanelAt(id, openPanels.length)} />

      {/* Unsent messages: one row per chat, click opens that chat. */}
      {expiredMessages && expiredMessages.length > 0 && (
        <Suspense fallback={null}>
          <UnsentBanner
            messages={expiredMessages}
            topics={topics}
            mobile={isMobile}
            onRetrySession={(sessionKey) => {
              expiredMessages
                .filter((m) => m.sessionKey === sessionKey)
                .forEach((m) => retryExpired?.(m));
            }}
            onDismissSession={dismissExpiredSession}
            onDismissAll={clearExpired}
            onOpenChat={(topicId) => {
              // Same funnel as a notification click: usePanelLifecycle's
              // `topics:open-topic` listener opens the topic through openPanel,
              // which routes a project topic to its project pane (switching
              // project) instead of leaving a ghost tab behind.
              window.dispatchEvent(
                new CustomEvent('topics:open-topic', { detail: { topicId, mode: 'permanent' } }),
              );
            }}
          />
        </Suspense>
      )}
    </div>
    </div>
  );
}
