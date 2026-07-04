import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, ExternalLink, Edit3, Settings, BarChart3, Kanban, Columns2, Rows2, Cloud, RotateCw, LayoutGrid, Combine, Layers, Plus, Check, ChevronRight, Pin, PinOff, Clock } from 'lucide-react';
import { usePanePendingStatus } from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import { PaneAddMenu } from '../Shared/PaneAddMenu';
import type { Pane, PaneType, PaneGroupType, AttentionTier } from '../../types';
import { getPaneConfig, getTerminalSessionFromPaneId, isTerminalPaneId, isBrowserPaneId, type ProjectTabStatus, type PaneScope } from '../../state/pane/adapters';
import { signalsActions, useSignalsStore, projectAttentionTier } from '../../state/signals';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { CodexIcon } from '../Shared/CodexIcon';
import { getFileIconDef } from '../../lib/fileIcons';
import { DND_TYPES, paneTabScopeType, paneTabSoloSrcType, dragMatchesScope } from '../../lib/dndTypes';
import { EDGE_DROP_PX } from './constants';
import { SplitRegion, InsertCaret } from './DropOverlay';
import { useMobile, haptic } from '../../hooks/useMobile';
import { TopicStreamingSpinner, ProjectStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner, AgentStreamingSpinner } from './StreamingIndicator';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { useSpawnedBrowserMap } from '../../state/browserSpawner';
import { SELECTED_SURFACE, SELECTED_SURFACE_SOFT, RESTING_SURFACE, ROW_PX, ROW_INSET, attentionSurface, ON_FILL_TEXT_SOFT } from '../../lib/selectionStyles';
import { POPOVER_SURFACE } from '@/lib/popoverStyles';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace, liveSpaceCount } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, SPACES_MAX } from '../../state/pane/types';
import {
  DEFAULT_SPACE_LABEL,
  createSpaceId,
  isDetachedWindow,
  liveSpacesOrdered,
  movePaneToSpace,
  nextSpaceName,
} from './SpaceSwitcher';
import { TopicIcon } from '../../lib/topicIcons';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { releaseNativeFocus } from '../../lib/shell/tauri';

// Every pane type closes through the same soft-confirm path: hovering the X
// reveals an empty "mark as done" circle, clicking it starts the 3 s L→R
// progress fill, and a re-click cancels. There used to be a READ_ONLY_PANE_TYPES
// exception (file / session-viewer / process-log) that swapped in a classic X
// with no feedback — but the wired onClose (handleClosePane) defers those
// closes anyway, so the exception just hid the countdown that was already
// running. Closing is reversible via Cmd+Shift+U regardless, so a single
// uniform affordance is both cleaner and less surprising.

const ICONS: Record<string, React.FC<{ size: number; className?: string; style?: React.CSSProperties }>> = {
  MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, BarChart3, Kanban, Clock,
};

// Tab status reads as two orthogonal cues, both shared with the sidebar so the
// surfaces can't drift: a StreamingSpinner ("working right now") and a
// NotificationBadge ("needs you" — Claude awaiting/error, unread, finished
// terminal turn, project rollup). There is no separate Claude phase dot.

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
  /**
   * Merge this tab back into its parent group (a solo split cell's tab
   * returning to the main pool). The inverse of `onDetach` — the two used to
   * share a single 'Detach' entry with opposite semantics per group kind.
   */
  onReattach?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  /**
   * "Reimposta pannelli" — flatten the surrounding split layout back to a
   * single row of equal-width columns (cellStacks dissolve into top-level
   * columns; no tab closes, no groups merge — geometry only). Hosts pass
   * `undefined` when the layout is already flat, so the menu entry hides.
   */
  onResetLayout?: () => void;
  /**
   * Offer "Sposta nello Spazio →" in the tab context menu. Passed ONLY by
   * app-level hosts (StandaloneChatGroup) — Spazi group app-level tabs, so
   * project-inner tab bars never see the entry. The move itself is handled
   * in-place via the pane store (movePaneToSpace).
   */
  canMoveToSpace?: boolean;
  /**
   * Rename a chat tab from its context menu (parity with the terminal tab's
   * inline rename). Reuses the host's canonical topic-update path so the change
   * is optimistic + persisted + broadcast, exactly like a sidebar rename.
   */
  onRenameChat?: (topicId: string, name: string) => void;
  /**
   * Rename a browser tab. Pins pane.title with titleSource='user' so the live
   * page-title poll stops overwriting it (see browserPaneUrl.setBrowserPaneUserTitle).
   */
  onRenameBrowser?: (paneId: string, name: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  onStopStreaming?: (paneId: string) => void;
  onPinPane?: (paneId: string) => void;
  /**
   * Sidebar "Fissati" pin toggle for a tab's underlying subject — DISTINCT from
   * `onPinPane` (which promotes a preview tab to a permanent one). `pinKey` is
   * the sidebar-item id: a chat's bare topicId, or `terminal:<sessionId>` for a
   * terminal. Passed only by app-level hosts (StandaloneChatGroup); project
   * tab bars leave it undefined and the entry hides. Paired with `isFissato`
   * so the entry can render "Fissa" vs "Rimuovi dai Fissati".
   */
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
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
  /** Which of the two canonical add-menu variants this tab bar's "+" opens.
   *  StandaloneChatGroup passes 'standalone' (adds the Apri/Crea Progetto
   *  actions); project tab bars (GroupLayout) default to 'project'. The
   *  variant's items/order/icons live in <PaneAddMenu> — see its docs. */
  addMenuScope?: PaneScope;
}

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onCloseImmediate, onAddPane, availableTypes, groupType: _groupType, groupId, onNewChat, onReorderPanes, onCrossGroupDrop, onEdgeSplitDrop, dndScope, className, contextPercent: _contextPercent, onContextRingClick: _onContextRingClick, onCloseOthers, onDetach, onReattach, onSplitRight, onSplitDown, onResetLayout, canMoveToSpace, onRenameChat, onRenameBrowser, onSettings, onPopOut, onStopStreaming, onPinPane, onToggleFissato, isFissato, projectStatus: _projectStatus, tabNotifications, hasLeftOverlay, groupIsFocused = true, groupIsAppFocused, addMenuScope = 'project' }: PaneTabBarProps) {
  // Default groupIsAppFocused to groupIsFocused so non-project callers
  // (StandaloneChatGroup) keep the existing two-state behavior.
  const isAppFocused = groupIsAppFocused ?? groupIsFocused;
  // Spawner map (chat topicId | terminal paneId → browser contextId) so each
  // tab can show a quiet "opened a browser" cue. One subscription, read per tab.
  const spawnedBrowserMap = useSpawnedBrowserMap();
  // Resolve per-topic icon + colour for chat tabs so the tab bar reads in the
  // SAME visual language as the sidebar (which already shows the topic's own
  // icon). Without this, every chat tab fell back to a generic MessageSquare
  // while the sidebar row showed the real icon — a jarring inconsistency.
  const topics = useTopics();
  // Authoritative claude-code detection: a terminal pane is a Claude Code
  // session if its persisted `terminalType` says so OR the live terminal
  // roster reports that session id as claude-code. The persisted field can be
  // absent on panes created before it was tracked (or not yet rehydrated),
  // which used to make a "Claude Code" tab fall through to the generic
  // Terminal glyph — i.e. Claude Code shown without its own icon. The sidebar
  // already keys off the roster `type`; the tab bar now matches it.
  const terminalSessions = useTerminalSessions();
  // Awaiting-feedback sets, read once here (not per-pane in the map below, which
  // would break the rules-of-hooks). Each pane derives its blue electric-bg
  // state synchronously from these in the loop.
  const awaitingTopics = useSignalsStore((s) => s.awaitingFeedbackTopics);
  const awaitingTermIds = useSignalsStore((s) => s.claudePhaseAwaitingTermIds);
  // The LOUD 'input' tier subsets (amber, act-now) — the rest of the awaiting
  // sets are the calm 'done' tier (blue). Used to pick the tab fill colour.
  const inputTopics = useSignalsStore((s) => s.awaitingInputTopics);
  const inputTermIds = useSignalsStore((s) => s.claudePhaseAwaitingInputTermIds);
  const claudeCodeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of terminalSessions) {
      if (s.type === 'claude-code' || s.type === 'claude-code-team') ids.add(s.id);
    }
    return ids;
  }, [terminalSessions]);
  // Codex sessions get the same authoritative detection (persisted
  // terminalType OR live roster) so their tabs always show the OpenAI
  // glyph instead of the generic Terminal icon.
  const codexSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of terminalSessions) {
      if (s.type === 'codex') ids.add(s.id);
    }
    return ids;
  }, [terminalSessions]);
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
  // "Sposta nello Spazio →" inline submenu (expanded space list inside the
  // context menu). Collapses whenever the menu re-opens on another tab.
  const [spaceSubmenuOpen, setSpaceSubmenuOpen] = useState(false);
  useEffect(() => { setSpaceSubmenuOpen(false); }, [ctxMenu]);
  // Inline "Rinomina" editor for terminal tabs, expanded IN PLACE inside the
  // context menu (mirrors the sidebar ContextMenu rename submenu). null = not
  // editing; a string = the draft label. Collapses whenever the menu re-opens.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setRenameDraft(null); }, [ctxMenu]);
  useEffect(() => {
    if (renameDraft !== null) {
      // Defer focus so the input has mounted; select-all so a re-label is one keystroke.
      const t = window.setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); }, 30);
      return () => window.clearTimeout(t);
    }
  }, [renameDraft]);

  // Persist a terminal-tab rename via PATCH /api/terminal/sessions/:id (marks
  // name_source='user' so the auto-namer leaves it alone) — mirrors the raw
  // fetch the "Ricarica" entry uses. The server re-broadcasts the roster so the
  // tab relabels without a local write.
  const submitRename = useCallback((paneId: string, next: string) => {
    const name = next.replace(/\s+/g, ' ').trim();
    if (name) {
      const pane = panes.find(p => p.id === paneId);
      const sid = getTerminalSessionFromPaneId(paneId);
      if (sid) {
        // Terminal: PATCH the session name (name_source='user') — the server
        // re-broadcasts the roster so the tab relabels without a local write.
        void fetch(`/api/terminal/sessions/${encodeURIComponent(sid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }).catch(() => {});
      } else if (pane?.type === 'chat' && pane.topicId) {
        // Chat: route through the host's canonical topic-update path.
        onRenameChat?.(pane.topicId, name);
      } else if (isBrowserPaneId(paneId)) {
        // Browser: pin the tab title (titleSource='user') via the host.
        onRenameBrowser?.(paneId, name);
      }
    }
    setRenameDraft(null);
    setCtxMenu(null);
  }, [panes, onRenameChat, onRenameBrowser]);
  // Registry read is cheap (identity-stable slice); only consulted when the
  // context menu offers the move entry.
  const spacesRegistry = usePaneStore((s) => s.spaces);
  const showMoveToSpace = !!canMoveToSpace && !isDetachedWindow();

  // Auto-scroll the active tab into view when it changes. The FIRST positioning
  // (mount / reload) must be INSTANT — a tab bar that was already scrolled
  // should reappear already scrolled, not animate from 0. Only genuine tab
  // switches after mount animate. useLayoutEffect runs before paint, so the
  // instant case lands with no visible jump from scrollLeft 0.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);
  useLayoutEffect(() => {
    if (!activePaneId || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector(`[data-pane-id="${CSS.escape(activePaneId)}"]`) as HTMLElement;
    if (el) {
      el.scrollIntoView({
        behavior: didInitialScrollRef.current ? 'smooth' : 'auto',
        block: 'nearest',
        inline: 'nearest',
      });
      didInitialScrollRef.current = true;
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
    // Solo-source marker: this group holds a single pane, so splitting it
    // into ITSELF would be a no-op. Encoded as a per-group TYPE so the
    // group's own content-area dragover (GroupLayout) can suppress the
    // edge-split preview the drop would refuse — no promised-then-broken drop.
    if (groupId && panes.length === 1) {
      e.dataTransfer.setData(paneTabSoloSrcType(groupId), '1');
    }
    e.dataTransfer.effectAllowed = 'move';
    // Custom drag image: a compact tab-like chip instead of the browser's
    // default file icon. The element must be in the DOM AND on-screen at
    // setDragImage time: Chromium snapshots an off-screen element fine, but
    // WKWebView (Tauri) returns an EMPTY image for anything outside the visual
    // viewport and falls back to the generic macOS document icon — the "tab
    // looks like a file while dragging" report. So we render it AT THE CURSOR
    // for the single capture frame (setDragImage's offset governs the final
    // image placement, so this on-screen position causes no perceptible flash)
    // and remove it next frame. Styled to match app chrome (elevated surface +
    // border + a small accent dot); the title is truncated so a long label
    // (e.g. a browser pane's URL) can't blow the chip up into a wall of text.
    const ghost = document.createElement('div');
    const pane = panes.find(p => p.id === paneId);
    ghost.style.cssText = `
      position:fixed;left:${e.clientX}px;top:${e.clientY}px;
      display:inline-flex;align-items:center;gap:7px;
      max-width:240px;padding:5px 11px;border-radius:9px;
      font:500 12px/1.2 Inter,system-ui,sans-serif;
      background:var(--bg-elevated);color:var(--text);
      border:1px solid var(--border);
      box-shadow:0 8px 24px rgba(0,0,0,0.22);
      white-space:nowrap;pointer-events:none;
    `;
    const dot = document.createElement('span');
    dot.style.cssText = 'flex:0 0 auto;width:7px;height:7px;border-radius:9999px;background:var(--primary);';
    const label = document.createElement('span');
    label.textContent = pane?.title || paneId;
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    ghost.append(dot, label);
    document.body.appendChild(ghost);
    // Grab point near the chip's left edge so it trails the cursor like a tab.
    e.dataTransfer.setDragImage(ghost, 14, ghost.offsetHeight / 2);
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
    // WKWebView (Tauri) won't infer dropEffect from preventDefault — without
    // this the source dragend sees 'none' and the standalone pop-out path
    // closes the dragged tab. Signal acceptance for the tab-bar reorder/insert.
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    let idx = xRatio < 0.5 ? paneIdx : paneIdx + 1;
    // Solo split cells clamp CROSS-GROUP inserts to slot ≥ 1: slot 0 is the
    // cell's primary, and landing there would re-key the whole cell mid-drop
    // (moveTopicToCell clamps the same way) — so never paint a slot-0 caret
    // the drop won't honor. Same-group reorders (draggedPaneId set) keep 0.
    if (idx === 0 && !draggedPaneId && groupId?.startsWith('solo:')) idx = 1;
    dragOverIdxRef.current = idx;
    setDragOverIdx(idx);
    // Clear stale edge split zone — cursor is over a tab, not an edge
    setEdgeSplitZone(null);
    // Detect cross-group drag for indicator rendering
    if (!draggedPaneId && e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP)) {
      setCrossGroupDragActive(true);
    }
  }, [draggedPaneId, dndScope, groupId]);

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
  // dragend OR drop. A cross-group move unmounts the source tab inside the drop
  // handler, so the browser may never fire `dragend` on it — the source bar's
  // indicators would then stay painted. `drop` bubbles to the window AFTER
  // React's own onDrop has already read dragOverIdxRef and performed the move,
  // so resetting on it too clears the source bar without eating the drop.
  useEffect(() => {
    const onEnd = () => resetDrag();
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('drop', onEnd);
    };
  }, [resetDrag]);

  // Keyboard shortcut: Cmd/Ctrl+1-9 is owned globally by `useKeyboardShortcuts`
  // — it walks both top-level panels AND project sub-panes so every tab gets
  // a single global slot. The local handler that used to live here was
  // removed; we keep the badges wired up so users still see ⌘N hints, but
  // the indices now reflect the global tab order, not the per-group order.
  const hasMenuItems = onNewChat || availableTypes.length > 0;

  return (
    // `flex-initial` (flex: 0 1 auto), NOT `flex-shrink-0`: as a flex child the
    // root must be allowed to SHRINK below its content width, otherwise the
    // inner `overflow-x-auto` strip never gets a constrained width and the tabs
    // just overflow (and get clipped by the parent's `overflow-hidden`) instead
    // of scrolling. This is the bug where narrowing a split INSIDE a project
    // (GroupLayout, which uses this default className) left the overflowing tabs
    // unreachable — no horizontal scroll. With grow:0 it still sits at content
    // width when there's room, so the trailing add-menu doesn't move; `min-w-0`
    // lets it collapse far enough for the scroll strip to take over. The
    // standalone tab bar already passes its own `flex-1 … min-w-0` and scrolled
    // fine — this brings the project-group default in line.
    <div className={className ?? "flex-initial py-1 pr-0 min-w-0 app-drag-region"} data-testid="panel-tab-bar" data-group-id={groupId ?? ''} style={{ position: 'relative' }}>
      {/* Scrollable tab area */}
      <div
        ref={scrollContainerRef}
        className="flex items-center gap-0.5 min-w-0 min-h-7 overflow-x-auto scrollbar-topbar"
        // Left/right inset = ROW_INSET (4px), the SAME edge inset the sidebar
        // rows use, so the tab list and the sidebar list line up at the sides
        // (was 5px left + a stray 4px root `pl-1` = 9px on project group bars).
        // The 30px overrides stay: left when a floating sidebar-toggle overlays
        // the leftmost bar, right when the add-menu needs clearance for scrolled
        // tabs.
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x', padding: '1px 0 1px 1px', paddingLeft: hasLeftOverlay ? 30 : ROW_INSET, paddingRight: hasMenuItems ? 30 : ROW_INSET }}
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
            // Edge-only split (EDGE_DROP_PX border zones). A former "group
            // holds a project pane → force whole-bar split" branch was dead
            // code: onEdgeSplitDrop only exists on project-INNER groups, and
            // a project wrapper pane can never live inside one (stripped on
            // hydrate, no addableScope, created standalone-only).
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
          // Empty bar area: not over a tab (tabs call stopPropagation) and not
          // in an edge-split zone → treat as "append to the end of this group".
          // Without this, dropping ON the bar (rather than precisely on a tab)
          // showed no indicator and landed nowhere — the reported "dragged onto
          // the tab bar, no indicator" bug. The trailing tab paints the
          // right-edge marker for dragOverIdx === panes.length; mirror into the
          // ref so the drop reads it on the same frame as this dragover.
          setEdgeSplitZone(null);
          dragOverIdxRef.current = panes.length;
          setDragOverIdx(panes.length);
        }}
        onDragLeave={(e) => {
          // Only reset when the pointer truly left the bar. A dragleave fired
          // while crossing from the container into one of its child tabs would
          // otherwise flicker the insert indicator off mid-drag.
          const rt = e.relatedTarget as Node | null;
          if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
          setEdgeSplitZone(null);
          setCrossGroupDragActive(false);
          setDragOverIdx(null);
          dragOverIdxRef.current = null;
        }}
        onDrop={(e) => {
          if (edgeSplitZone && onEdgeSplitDrop) {
            // Re-verify the zone from the cursor's ACTUAL position at drop time.
            // A fast drag can leave `edgeSplitZone` set from an earlier edge
            // frame even though the release happened at center — which used to
            // SPLIT when the user meant to MOVE the tab into this bar. Only
            // split when the cursor is genuinely in the EDGE_DROP_PX band at
            // release. (The old "project groups always split" carve-out keyed
            // on a project pane in THIS group — impossible for the
            // project-inner groups that have onEdgeSplitDrop, see dragover.)
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const doSplit = x < EDGE_DROP_PX || x > rect.width - EDGE_DROP_PX;
            if (doSplit) {
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
            // Center release despite a stale edge zone → fall through to a normal
            // move/reorder, appending to the end of this bar.
            setEdgeSplitZone(null);
            dragOverIdxRef.current = panes.length;
          }
          handleTabDrop(e);
        }}
      >
      {panes.map((pane, paneIdx) => {
        const config = getPaneConfig(pane.type);
        const Icon = ICONS[config.icon];
        // Claude Code / Codex = persisted terminalType OR live roster says so
        // (see memos above).
        const termSid = pane.type === 'terminal' ? (pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id)) : null;
        const isClaudeCodeTab = pane.type === 'terminal' && (pane.terminalType === 'claude-code' || (!!termSid && claudeCodeSessionIds.has(termSid)));
        const isCodexTab = pane.type === 'terminal' && !isClaudeCodeTab && (pane.terminalType === 'codex' || (!!termSid && codexSessionIds.has(termSid)));
        // Selection reads in the SAME visual language as the sidebar (shared
        // SELECTED_SURFACE): the focused tab is a clearly raised NEUTRAL card,
        // every other split group still shows ITS active tab one step softer,
        // and inactive tabs stay quiet. No blue/colour wash anywhere.
        const isSelected = activePaneId === pane.id;
        const isFullyActive = isSelected && groupIsFocused && isAppFocused;
        const isActiveDimmed = isSelected && !(groupIsFocused && isAppFocused);
        // "Awaiting" background split by TIER: amber 'input' (a permission gate,
        // act now) vs blue 'done' (turn finished, look when ready) — a chat /
        // Claude-Code terminal parked for the user, or a project rolling up such
        // a child. Codex/shell never qualify (no Claude phase).
        const attentionTier: AttentionTier | null =
          pane.type === 'chat'
            ? (pane.topicId ? (inputTopics.has(pane.topicId) ? 'input' : awaitingTopics.has(pane.topicId) ? 'done' : null) : null)
            : pane.type === 'terminal'
              ? (isClaudeCodeTab && termSid ? (inputTermIds.has(termSid) ? 'input' : awaitingTermIds.has(termSid) ? 'done' : null) : null)
              : pane.type === 'project'
                ? (pane.projectPath ? projectAttentionTier(pane.projectPath, topics, terminalSessions, awaitingTopics, awaitingTermIds, inputTopics, inputTermIds) : null)
                : null;
        // Focus clears the fill: the tab you're actively viewing (fully active =
        // selected + its group focused + app focused) shows the neutral selected
        // surface, never a flashing attention fill — the fix for "the tab I'm on
        // keeps pulsing". A background/dimmed needy tab keeps its tier fill.
        const onFill = attentionTier !== null && !isFullyActive;
        const label = pane.title || (pane.type === 'chat' ? 'New Chat' : config.label);
        const isDragged = draggedPaneId === pane.id;
        const hasDragSource = draggedPaneId || crossGroupDragActive;
        const isNotSelf = !draggedPaneId || draggedPaneId !== pane.id;
        const showLeftIndicator = dragOverIdx === paneIdx && hasDragSource && isNotSelf;
        const showRightIndicator = paneIdx === panes.length - 1 && dragOverIdx === panes.length && hasDragSource && isNotSelf;
        // Streaming spinner: chat panes pulse during an LLM stream;
        // Loading affordance is owned by the canonical widgets below —
        // each reads from StreamingContext, no upstream prop needed.
        // Suppress the badge for the tab you're looking at — EXCEPT a project
        // tab. A project badge is a ROLLUP of its children (chats / terminals in
        // inner groups you may not be viewing), so selecting the project tab
        // doesn't mean you've seen them. Zeroing it here also made the project
        // tab disagree with the sidebar project row (which never suppresses the
        // rollup): same project, two different numbers. Keep the rollup visible
        // on the selected project tab so the two surfaces always match.
        const suppressOnSelect = isSelected && pane.type !== 'project';
        const badgeCount = !suppressOnSelect && tabNotifications ? (tabNotifications.get(pane.id) || 0) : 0;

        return (
          <div
            // Use stableKey so the tab DOM survives PANE_ID_REMAP (draft → real
            // topic). Otherwise React unmounts/remounts on first message
            // submission and the tab visibly flashes.
            key={pane.stableKey ?? pane.id}
            data-pane-id={pane.id}
            data-active={isSelected ? 'true' : 'false'}
            role="tab"
            // Tauri: exclude this tab from window-drag SYNCHRONOUSLY at mount.
            // The `.app-no-drag` class only becomes a Tauri opt-out once the
            // debounced (250ms) MutationObserver in wireTauriDragRegions mirrors
            // it to this attribute — so a freshly mounted tab (e.g. right after a
            // browser split spawns a new cell + tab strip) spends up to ~250ms
            // inside its `deep` drag-region ancestor: mousedown drags the WINDOW,
            // not the tab, and the tab "feels frozen / won't drag". Setting the
            // attribute declaratively removes that gap. Inert in Electron/web
            // (unknown data-* attribute); the observer's `:not([data-tauri-drag-
            // region])` guard then skips it, so no double-processing.
            data-tauri-drag-region="false"
            style={{ width: 150, minWidth: 150, maxWidth: 150, flexShrink: 0 }}
            // overflow-hidden clips a tab whose trailing widgets (project git
            // status + spinner + notification badge + close) would otherwise
            // sum past the fixed 150px and spill into the next tab. The label
            // already truncates; this guarantees the rest can't escape either.
            className={`group flex items-center gap-1.5 ${ROW_PX} ${isTouch ? 'h-9' : 'h-7'} text-[11px] font-medium transition-all relative cursor-pointer select-none rounded-md overflow-hidden app-no-drag ${
              isFullyActive
                ? SELECTED_SURFACE
                : attentionTier
                  ? attentionSurface(attentionTier)
                  : isActiveDimmed
                    ? SELECTED_SURFACE_SOFT
                    : `text-app-text-tertiary hover:text-app-text ${RESTING_SURFACE}`
            } ${isDragged ? 'opacity-40' : ''}`}
            // Tauri: a native browser pane (sibling WKWebView) can hold AppKit
            // first-responder; yank it back to the chrome on pointer-down so the
            // tab switch isn't swallowed by the pane. No-op off Tauri / fire-and-forget.
            onPointerDown={() => releaseNativeFocus()}
            onClick={() => { if (longPressFiredRef.current) { longPressFiredRef.current = false; return; } if (pane.type === 'terminal') { const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id); if (sid) signalsActions.clearTerminalFinished(sid); } onActivate(pane.id); }}
            onDoubleClick={() => { if (pane.preview && onPinPane) onPinPane(pane.id); }}
            onContextMenu={handleContextMenu(pane.id)}
            data-testid={`pane-tab-${pane.id}`}
            onTouchStart={(e) => handleLongPressStart(pane.id, e.currentTarget)}
            onTouchEnd={handleLongPressCancel}
            onTouchMove={handleLongPressCancel}
            draggable={!isTouch && !!onReorderPanes}
            onDragStart={handleTabDragStart(pane.id)}
            onDragOver={handleTabDragOver(paneIdx)}
            onDragEnd={handleTabDragEnd}
          >
            {showLeftIndicator && <InsertCaret side="left" />}
            {/* No selection colour wash: the tab colour is an auto-assigned
                topic default ("invented"), not a manifest-provided colour, so a
                selected tab just uses the normal selected styling. When a real
                project manifest (icon + colour) is wired, drive the wash from
                that instead. */}
            {/* PendingAction progress fill — covers the tab background L→R
                during the 3 s soft-close countdown. Sub-component subscribes
                to the context per-pane so an unrelated pane's state changes
                don't re-render every other tab. It self-guards on a null
                pending status, so it's safe to mount for every pane type. */}
            <PaneTabPendingOverlay paneId={pane.id} />
            {/* "Awaiting feedback" is now the tab's own electric-blue background
                (see isAwaiting + AWAITING_SURFACE above), not an overlay. */}
            {/* Icon slot. Every branch that ALWAYS resolves to a glyph wraps it
                in a fixed 14×14 box so labels line up across tabs. The project
                branch deliberately does NOT: a project without a shipped
                favicon renders nothing (fallback=null) and must reserve NO
                empty box — otherwise every generic project tab showed a blank
                gap where an icon would be. Claude Code uses the authoritative
                `isClaudeCodeTab` so its tab never falls through to the generic
                Terminal glyph. */}
            {pane.type === 'file' && pane.title ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">{(() => { const d = getFileIconDef(pane.title); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
            ) : isClaudeCodeTab ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                <ClaudeIcon size={14} className="text-[#D97757]" />
              </span>
            ) : isCodexTab ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                {/* Mono ink on purpose — OpenAI's brand is monochrome. */}
                <CodexIcon size={14} />
              </span>
            ) : pane.type === 'chat' && pane.topicId && topics[pane.topicId] ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                <TopicIcon name={topics[pane.topicId].icon} color={topics[pane.topicId].color || undefined} size={14} />
              </span>
            ) : pane.type === 'project' && pane.projectPath ? (
              // Same real project favicon the sidebar shows (GET /api/projects/icon),
              // with the SAME "no fake folder glyph" convention: projects WITHOUT a
              // shipped favicon/manifest icon render nothing (fallback=null) and
              // reserve no space — no fixed-size wrapper here so the slot collapses.
              <ProjectFavicon path={pane.projectPath} size={14} fallback={null} className="flex-shrink-0" />
            ) : Icon ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                <Icon size={14} />
              </span>
            ) : null}
            <span className={`truncate flex-1 min-w-0 ${pane.preview ? 'italic' : ''}`}>{label}</span>
            {/* Project tabs intentionally do NOT show git status numbers (changed
                files / ahead-behind / running processes) — the sidebar project row
                dropped them (cryptic numbers) and the two surfaces must read the
                same: icon + name + notification badge + loading spinner. Git /
                process status lives in the git & terminal panes where it's
                actionable. */}
            {/* Close / ⌘N affordance sits BEFORE the loading + status widgets so
                the spinner and notification badge are the trailing-most things on
                the tab ("loading e stato a fine tab"). The close X is revealed on
                hover in this slot; idle it shows the ⌘N index (Electron). */}
            <PaneCloseButton
              paneId={pane.id}
              onClose={onClose}
              isTouch={isTouch}
            />
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
            {/* Quiet cue: this chat/terminal tab opened a browser. A third,
                independent signal — not attention (NotificationBadge) and not
                loading (spinner) — so it stays muted. Keyed by topicId (chat)
                or pane id (terminal); see browserSpawner registry. */}
            {(() => {
              const spawnerKey = pane.type === 'chat' ? pane.topicId : pane.type === 'terminal' ? pane.id : undefined;
              if (!spawnerKey || !spawnedBrowserMap[spawnerKey]) return null;
              return (
                <span
                  className={`ml-0.5 flex items-center ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70'}`}
                  title="Questa tab ha aperto un browser"
                  data-testid="tab-spawned-browser"
                  aria-label="Ha aperto un browser"
                >
                  <Globe size={11} />
                </span>
              );
            })()}
            {/* Quiet cue: this chat is backed by the cloud (OpenClaw) provider —
                a cloud session, not a local one. Muted, like the browser cue. */}
            {pane.type === 'chat' && pane.topicId && topics[pane.topicId]?.provider === 'openclaw' && (
              <span
                className={`ml-0.5 flex items-center ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70'}`}
                title="Cloud (OpenClaw)"
                data-testid="tab-cloud"
                aria-label="Sessione cloud (OpenClaw)"
              >
                <Cloud size={11} />
              </span>
            )}
            {/* The split position mini-map lives on the SIDEBAR topic cards
                only (user preference), NOT on the top tab bar — see
                Sidebar/TopicItem + SplitMiniMap (fed by SplitPositionContext).
                The tab bar deliberately renders no split schematic. */}
            <NotificationBadge count={badgeCount} className="ml-0.5" variant={onFill ? 'onFill' : 'default'} />
            {showRightIndicator && <InsertCaret side="right" />}
          </div>
        );
      })}
      </div>

      {/* Edge-split preview — a filled half-bar region (the footprint of the new
          column), shared <SplitRegion> primitive: fill + seam, no dashed box.
          Mutually exclusive with the insert caret (the edge zone nulls dragOverIdx). */}
      {edgeSplitZone && <SplitRegion zone={edgeSplitZone} />}

      {/* Add-pane affordance — single canonical component. Owns the
          trigger button, the click handler (web portal AND Electron
          native overlay), the items, and the mobile bottom-sheet. The
          sidebar's project-header "+" renders the SAME component with
          different `availableTypes` and a hover-revealed trigger. */}
      {hasMenuItems && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pr-1">
          <PaneAddMenu
            scope={addMenuScope}
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
          className={`fixed ${POPOVER_SURFACE} z-[9999] min-w-[150px]`}
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          {/* "Fissa" / "Rimuovi dai Fissati" — sidebar pinning parity for tabs.
              Pin key is the sidebar-item id: a chat's bare topicId, or the
              terminal pane id `terminal:<sessionId>` (which is the pane id).
              Only chat + terminal tabs have a pinnable sidebar row. Hidden when
              the host doesn't wire onToggleFissato (project tab bars). */}
          {onToggleFissato && (() => {
            const pane = panes.find(p => p.id === ctxMenu.paneId);
            if (!pane) return null;
            const pinKey = pane.type === 'chat'
              ? pane.topicId
              : isTerminalPaneId(pane.id) ? pane.id : undefined;
            if (!pinKey) return null;
            const pinned = isFissato?.(pinKey) ?? false;
            return (
              <button
                onClick={() => { onToggleFissato(pinKey); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
              >
                {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                <span className="flex-1 text-left">{pinned ? 'Rimuovi dai Fissati' : 'Fissa'}</span>
              </button>
            );
          })()}
          {/* "Ricarica" — terminal panes only (pane id `terminal:<sessionId>`).
              Restarts the session in place via POST /reload: claude/codex resume
              via --resume (conversation preserved, same tab id), shell gets a fresh
              PTY in the same cwd. Unsticks a wedged session (e.g. a claude CLI
              latched on "Not logged in") without CLI surgery or an app restart. */}
          {isTerminalPaneId(ctxMenu.paneId) && (
            <button
              onClick={() => {
                const sid = getTerminalSessionFromPaneId(ctxMenu.paneId);
                if (sid) {
                  // Show a "Riavvio…" overlay over the pane during the kill→respawn
                  // gap (cleared on WS reconnect); safety-clear if it never comes back.
                  signalsActions.markTerminalReloading(sid);
                  window.setTimeout(() => signalsActions.clearTerminalReloading(sid), 15000);
                  void fetch(`/api/terminal/sessions/${encodeURIComponent(sid)}/reload`, { method: 'POST' }).catch(() => {});
                }
                setCtxMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
              title="Riavvia la sessione (Claude/codex riprendono via --resume)"
            >
              <RotateCw size={14} />
              <span className="flex-1 text-left">Ricarica</span>
            </button>
          )}
          {/* "Rinomina" — inline editor (Enter saves, Esc cancels). Terminal
              tabs PATCH the session name (name_source='user'); chat tabs route
              through the host's topic-update path; browser tabs pin pane.title
              (titleSource='user'). The chat/browser entries hide when the host
              doesn't wire the matching callback (e.g. project-inner bars that
              don't thread onRenameChat). */}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            const canRename = isTerminalPaneId(ctxMenu.paneId)
              || (ctxPane?.type === 'chat' && !!ctxPane.topicId && !!onRenameChat)
              || (isBrowserPaneId(ctxMenu.paneId) && !!onRenameBrowser);
            if (!canRename) return null;
            return renameDraft === null ? (
              <button
                onClick={() => setRenameDraft(ctxPane?.title ?? '')}
                className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                title="Rinomina questa scheda"
              >
                <Edit3 size={14} />
                <span className="flex-1 text-left">Rinomina</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2">
                <Edit3 size={14} className="shrink-0 text-app-text-muted" />
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') submitRename(ctxMenu.paneId, renameDraft);
                    else if (e.key === 'Escape') setRenameDraft(null);
                  }}
                  placeholder="Nuovo nome"
                  maxLength={120}
                  className="flex-1 min-w-0 bg-app-input border border-app-border rounded px-2 py-1 text-[13px] md:text-[12px] text-app-text focus:outline-none focus:border-primary"
                />
                <button
                  onClick={() => submitRename(ctxMenu.paneId, renameDraft)}
                  className="shrink-0 p-1 rounded hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors"
                  title="Salva"
                  aria-label="Salva"
                >
                  <Check size={14} />
                </button>
              </div>
            );
          })()}
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
          {/* Layout-actions section (divider owned here): "Reimposta pannelli"
              first, then "Sposta nello Spazio →" (Spazi), then "Sposta in una
              nuova finestra" (pop-out) — coherence ruling 3.2 order. */}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            const showPopOutHere = ctxPane?.type === 'chat' && !!onPopOut;
            return (onResetLayout || showMoveToSpace || showPopOutHere);
          })() && (
            <>
              <div className="h-px bg-app-border my-1" />
              {onResetLayout && (
                <button
                  onClick={() => { onResetLayout(); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  title="Appiattisce gli split su un solo livello (le schede restano aperte)"
                >
                  <LayoutGrid size={14} />
                  <span className="flex-1 text-left">Reimposta pannelli</span>
                </button>
              )}
              {showMoveToSpace && (() => {
                const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
                const currentSpace = resolvePaneSpace(ctxPane, spacesRegistry);
                const targets: { id: string; name: string }[] = [
                  { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_LABEL },
                  ...liveSpacesOrdered(spacesRegistry).map(s => ({ id: s.id, name: s.name || 'Spazio' })),
                ];
                return (
                  <>
                    <button
                      onClick={() => setSpaceSubmenuOpen(open => !open)}
                      className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                      title="Sposta la scheda in un altro Spazio"
                      aria-expanded={spaceSubmenuOpen}
                    >
                      <Layers size={14} />
                      <span className="flex-1 text-left">Sposta nello Spazio</span>
                      <ChevronRight size={12} className={`text-app-text-muted transition-transform ${spaceSubmenuOpen ? 'rotate-90' : ''}`} />
                    </button>
                    {spaceSubmenuOpen && (
                      <>
                        {targets.map(target => {
                          const isCurrent = target.id === currentSpace;
                          return (
                            <button
                              key={target.id}
                              disabled={isCurrent}
                              onClick={() => {
                                movePaneToSpace(ctxMenu.paneId, target.id);
                                setCtxMenu(null);
                              }}
                              className={`w-full flex items-center gap-2 pl-8 pr-3 py-3 md:py-1.5 text-[14px] md:text-[12px] transition-colors ${
                                isCurrent
                                  ? 'text-app-text-muted cursor-default'
                                  : 'text-app-text hover:bg-app-hover'
                              }`}
                            >
                              <span className="flex-1 text-left truncate">{target.name}</span>
                              {isCurrent && <Check size={12} className="text-app-text-muted" />}
                            </button>
                          );
                        })}
                        {liveSpaceCount(spacesRegistry) < SPACES_MAX && (
                          <button
                            onClick={() => {
                              const id = createSpaceId();
                              usePaneStore.getState().dispatch({
                                type: 'SPACE_UPSERT',
                                payload: { space: { id, name: nextSpaceName(spacesRegistry) } },
                              });
                              movePaneToSpace(ctxMenu.paneId, id);
                              setCtxMenu(null);
                            }}
                            className="w-full flex items-center gap-2 pl-8 pr-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                          >
                            <Plus size={12} />
                            <span className="flex-1 text-left">Nuovo Spazio</span>
                          </button>
                        )}
                      </>
                    )}
                  </>
                );
              })()}
              {(() => {
                const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
                if (ctxPane?.type !== 'chat' || !onPopOut) return null;
                return (
                  <button
                    onClick={() => { onPopOut!(ctxMenu!.paneId); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    title="Apre la scheda in una finestra separata"
                  >
                    <ExternalLink size={14} />
                    <span className="flex-1 text-left">Sposta in una nuova finestra</span>
                  </button>
                );
              })()}
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
          {/* Inverse of Detach — a solo split cell's tab merging back into the
              main pool. Distinct label + icon: the two directions used to share
              one 'Detach' entry that meant the OPPOSITE thing per group kind. */}
          {onReattach && (
            <>
              <div className="h-px bg-app-border my-1" />
              <button
                onClick={() => { onReattach(ctxMenu.paneId); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                title="Chiude lo split e riporta la tab nel gruppo principale"
              >
                <Combine size={14} />
                <span>Riporta nel gruppo</span>
              </button>
            </>
          )}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            const isChat = ctxPane?.type === 'chat';
            const showSettings = isChat && onSettings;
            // Pop-out moved into the layout-actions section as "Sposta in una
            // nuova finestra" (ruling 3.2) — this trailing section is now
            // Settings only.
            if (!showSettings) return null;
            return (
              <>
                <div className="h-px bg-app-border my-1" />
                <button
                  onClick={() => { onSettings!(ctxMenu!.paneId); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
                >
                  <Settings size={14} />
                  <span>Settings</span>
                </button>
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
 * Per-tab close button: empty on idle, the soft-close ring (X) revealed on
 * hover. The grey ⌘N keyboard-index badge that used to occupy this slot when
 * idle was removed — it read as a cryptic indicator on the first nine tabs and
 * earned its keep nowhere; the Cmd/Ctrl+1-9 shortcut still works (owned by
 * useKeyboardShortcuts). Pulled out of the main render loop because it calls
 * `usePanePendingStatus` — hooks can't run inside `panes.map(...)`.
 */
function PaneCloseButton({
  paneId, onClose, isTouch,
}: {
  paneId: string;
  onClose: (id: string) => void;
  isTouch: boolean;
}) {
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

  // Idle, soft-destructive: empty "todo" circle on hover (always shown on
  // touch). Click triggers the deferred close (auto-tick → 3 s countdown).
  return (
    <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 relative z-10">
      <span className={`absolute inset-0 flex items-center justify-center ${
        isTouch ? '' : 'opacity-0 group-hover:opacity-100'
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

/**
 * Blue "awaiting feedback" overlay for a chat tab. Co-located (like
 * PaneTabPendingOverlay) so the per-topic signal hook stays out of the parent's
 * `panes.map(...)` loop. Translucent fill + gentle pulse, painted over the tab
 * content so it layers atop the neutral selection surface without clobbering it.
 */

