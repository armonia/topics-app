import { useState, useCallback, useRef, useMemo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, MessageSquare, TerminalSquare, Globe, FolderOpen, MoreHorizontal, X, CheckCheck, Pin, PinOff, LayoutGrid, Activity, BookOpen, Cpu, BarChart3, Clock, Kanban, Wrench, type LucideIcon } from 'lucide-react';
import {
  usePendingActionStatus,
  useTerminalPendingStatus,
  useBrowserPendingStatus,
} from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import { PaneAddMenu, PaneAddMenuItems } from '../Shared/PaneAddMenu';
import { TopicItem } from './TopicItem';
import { topicsApi } from '@/lib/api';
import { createPaneId, resolvePinnedBrowserOrigin, useClosedTabs, type BrowserOrigin } from '@/state/pane/adapters';
import type { Topic, UnreadData, PaneType, TerminalSessionInfo } from '@/types';
import { useTabNotifications } from '@/hooks/useTabNotifications';
import { ClaudeIcon } from '@/components/Shared/ClaudeIcon';
import { CodexIcon } from '@/components/Shared/CodexIcon';
import { ProjectFavicon } from '@/components/Shared/ProjectFavicon';
import { ProjectStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner } from '@/components/Layout/StreamingIndicator';
import { SplitMiniMap } from '@/components/Shared/SplitMiniMap';
import { useSplitPosition } from '@/contexts/SplitPositionContext';
import { useAttentionSignals, signalsActions, useTerminalAttentionTier, useSignalsStore, projectAttentionTier, useSessionLastActivity } from '@/state/signals';
import { useExternalSessionsStore, externalSessionsForProject } from '@/state/externalSessions';
import { useProjectFocusStore } from '@/state/projectFocus';
import { usePaneStore } from '@/state/pane/store';
import { useShallow } from 'zustand/react/shallow';
import { useDetachedTopicMap } from '@/state/windowPresence';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { ContextMenuPortal } from '@/components/Shared/ContextMenuPortal';
import { tauriInvoke } from '@/lib/shell/tauri';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
import { sidebarRowCard, ROW_PX, ROW_INSET, SIDEBAR_INDENT_STEP, ON_FILL_TEXT, ON_FILL_TEXT_SOFT, SELECTED_SURFACE } from '@/lib/selectionStyles';
import { SessionActivity } from '@/components/Shared/SessionActivity';
import { DropdownPortal } from '@/components/Shared/DropdownPortal';
import { useMobile } from '@/hooks/useMobile';
import type { SidebarViewMode } from '@/hooks/useSidebarState';
import { buildSidebarItems, filterSidebarItems, groupSidebarItems, type SidebarItem, type BrowserContextInfo } from '@/lib/buildSidebarItems';

// ── Helpers ────────────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diffS = Math.floor((Date.now() - ts) / 1000);
  if (diffS < 60) return 'now';
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d`;
  return `${Math.floor(diffD / 30)}mo`;
}

const TYPE_ICONS = {
  chat: MessageSquare,
  terminal: TerminalSquare,
  browser: Globe,
  project: FolderOpen,
  utility: Wrench,
} as const;

// Section headings for the by-type view. All Italian: they used to read
// "Projects / Chats / Terminals / Browsers / Strumenti" — four English labels
// next to one Italian one, in the same tree as the Italian "Finestre" and
// "Fissati" sections.
const TYPE_LABELS: Record<SidebarItem['type'], string> = {
  project: 'Progetti',
  chat: 'Chat',
  terminal: 'Terminali',
  browser: 'Browser',
  utility: 'Strumenti',
};

// Utility-row glyphs, keyed by the icon NAME the builder lifts from
// PANE_CONFIG — one lookup shared with the tab bar's config, no re-mapping
// per utility type at the call sites.
const UTILITY_ROW_ICONS: Record<string, LucideIcon> = {
  Kanban, BarChart3, Activity, BookOpen, Cpu, Clock, LayoutGrid,
};

// ── Props ──────────────────────────────────────────────────────────────────────

export interface TopicTreeProps {
  topics: Record<string, Topic>;
  workspaceProjects?: string[];
  searchQuery: string;
  expandedNodes: Set<string>;
  onToggleNode?: (id: string) => void;
  focusedTopicId: string | null;
  projectActiveTopics?: Record<string, string | null>;
  previewPanelId: string | null;
  openPanels: string[];
  onTopicClick: (topicId: string, e?: React.MouseEvent) => void;
  onTopicDoubleClick: (topicId: string, e?: React.MouseEvent) => void;
  onTopicContextMenu: (e: React.MouseEvent, topic: Topic) => void;
  unreadData: UnreadData;
  onArchiveTopic: (topicId: string, archive: boolean) => Promise<boolean>;
  onArchiveProject?: (projectPath: string, archive: boolean) => Promise<boolean>;
  onNewTopicInProject?: (projectPath: string) => void;
  onAddProjectPane?: (projectPath: string, type: PaneType, subType?: string) => void;
  onProjectClick?: (projectPath: string) => void;
  stopSession?: (sessionKey: string) => boolean;
  onNewChat?: () => void;
  onNewBrowser?: () => void;
  terminalSessions?: TerminalSessionInfo[];
  browserContexts?: BrowserContextInfo[];
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onNewTerminal?: (type: 'shell' | 'claude-code' | 'codex' | 'opencode', skipPermissions?: boolean) => void;
  onCloseTerminal?: (sessionId: string) => void;
  onOpenAsProject?: (path: string) => void;
  onOpenBrowser?: (contextId: string) => void;
  onCloseBrowser?: (contextId: string) => void;
  // New sidebar state
  viewMode: SidebarViewMode;
  showArchived: boolean;
  // Project accordion state (lifted to App to survive remounts)
  expandedProjects: string[];
  onToggleProject: React.Dispatch<React.SetStateAction<string[]>>;
  // Open pane IDs inside each project (from ProjectWindow callback)
  projectOpenPanes?: Record<string, string[]>;
  /** Pinned ("Fissati") item ids in USER PIN ORDER (useSidebarState.pinnedItems).
   *  The pinned block renders in this order, exempt from the notification-first
   *  sort. Chats pin by raw topic id, projects by `project:<rawPath>`. */
  pinnedItems?: string[];
  /** Pin/unpin an item ("Fissa" / "Rimuovi dai Fissati") — App-level wrapper
   *  owns the unpin-while-closed archive semantics. */
  onTogglePin?: (id: string) => void;
  /** Active (non-done) task count across all projects. When > 0, a
   *  "Board generale" row is shown above the Fissati block. */
  boardTaskCount?: number;
  /** True while the Board generale tab is open — makes the row tab-aware (it is
   *  the ONLY sidebar row for the board, so it must show selection like a tab). */
  boardOpen?: boolean;
  /** Opens the global board pane (the '__board__' utility tab). */
  onOpenBoard?: () => void;
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function TopicTree({
  topics,
  workspaceProjects = [],
  searchQuery,
  expandedNodes: _expandedNodes,
  onToggleNode: _onToggleNode,
  focusedTopicId,
  projectActiveTopics,
  previewPanelId,
  openPanels,
  onTopicClick,
  onTopicDoubleClick,
  onTopicContextMenu,
  unreadData,
  onArchiveTopic,
  onArchiveProject,
  onNewTopicInProject,
  onAddProjectPane,
  onProjectClick,
  stopSession,
  onNewChat: _onNewChat,
  onNewBrowser: _onNewBrowser,
  terminalSessions = [],
  browserContexts = [],
  onTerminalClick,
  onNewTerminal: _onNewTerminal,
  onCloseTerminal,
  onOpenAsProject,
  onOpenBrowser,
  onCloseBrowser,
  viewMode,
  showArchived,
  expandedProjects: expandedProjectsProp,
  onToggleProject,
  projectOpenPanes = {},
  pinnedItems = [],
  onTogglePin,
  boardTaskCount = 0,
  boardOpen = false,
  onOpenBoard,
}: TopicTreeProps) {
  // Claude "yolo" toggle state lives inside <PaneAddMenu> now (via
  // useClaudeSkipPermissions in PaneAddMenuItems). No longer threaded
  // through here. The legacy `projectAddMenu` / `addBtnRef` state is
  // also gone — the canonical <PaneAddMenu> component owns its own
  // button ref and open/close state.
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; projectPath: string; projectName: string; allArchived: boolean; unreadTopicIds: string[]; pinned: boolean } | null>(null);
  const expandedProjects = useMemo(() => new Set(expandedProjectsProp), [expandedProjectsProp]);
  const { isTouch } = useMobile();
  // Awaiting-feedback sets, read once here so the (non-component) renderProjectItem
  // closure can derive a project's electric-blue rollup synchronously.
  const awaitingTopics = useSignalsStore((s) => s.awaitingFeedbackTopics);
  const awaitingTermIds = useSignalsStore((s) => s.claudePhaseAwaitingTermIds);
  // The LOUD 'input' tier subsets (amber) — the rest of the awaiting sets are the
  // calm 'done' tier (blue). Feed projectAttentionTier so a project row picks the
  // colour of its loudest child.
  const inputTopics = useSignalsStore((s) => s.awaitingInputTopics);
  const inputTermIds = useSignalsStore((s) => s.claudePhaseAwaitingInputTermIds);
  // Claude sessions running OUTSIDE Topics (bare terminal `claude`) — the
  // per-project "attività esterna" badge is read-only awareness, deliberately
  // separate from the attention tier (it demands nothing from the user).
  const externalSessions = useExternalSessionsStore((s) => s.sessions);

  const toggleProject = useCallback((projectId: string) => {
    onToggleProject(prev => {
      const set = new Set(prev);
      if (set.has(projectId)) set.delete(projectId);
      else set.add(projectId);
      return Array.from(set);
    });
  }, [onToggleProject]);

  // ── Build unified items ──────────────────────────────────────────────────

  const { lastNotifiedAt } = useTabNotifications();
  // Attention signals — fed into buildSidebarItems so the sidebar badge counts
  // the same thing the tab bar does (Claude needs-you, finished terminal turns),
  // not just raw server unread.
  const { claudeAttentionTopics, terminalFinishedIds } = useAttentionSignals();
  // Real last-touched timestamp per claude-code terminal (idle/finished
  // sessions included — see deriveSessionLastActivity) so a terminal row sorts
  // and displays by actual Claude activity, not just when the session opened.
  const sessionLastActivityById = useSessionLastActivity();
  // Active inner pane per open project (reported by each ProjectWindow). Lets a
  // project's child row (chat/terminal) light up when that project is the
  // focused pane — focusedPanelId stays the project pane, so without this only
  // the folder would highlight. See state/projectFocus.ts.
  const activePaneByProject = useProjectFocusStore(s => s.activePaneByProject);
  const isActiveInnerChild = useCallback((projectPath: string | undefined, innerPaneId: string) => {
    if (!projectPath) return false;
    if (focusedTopicId !== createPaneId('project', projectPath)) return false;
    return activePaneByProject[projectPath] === innerPaneId;
  }, [focusedTopicId, activePaneByProject]);
  // Pinned ids as React state through props (NOT a localStorage read inside
  // the builder) so pin toggles repaint — pinnedIds joins the memo deps.
  const pinnedIds = useMemo(() => new Set(pinnedItems), [pinnedItems]);
  // Topics open in ANOTHER window (pop-out presence). A zustand hook = React
  // state, so this memo re-fires when a window detaches/closes.
  const detachedTopicIds = useDetachedTopicMap();
  // Live page titles of top-level browser panes, straight from the global pane
  // store. The server can't title native WKWebView panes, so this is the only
  // source that matches what the tab bar shows. `useShallow` over a titles-only
  // projection means a navigation/scroll that leaves the title set unchanged
  // does NOT repaint the (hot) sidebar tree — only an actual title change does.
  const browserPaneTitles = usePaneStore(useShallow((s) => {
    const m: Record<string, string> = {};
    for (const p of Object.values(s.panes)) {
      if (p.type === 'browser' && typeof p.title === 'string' && p.title.trim()) m[p.id] = p.title.trim();
    }
    return m;
  }));
  const paneTitleById = useMemo(() => new Map(Object.entries(browserPaneTitles)), [browserPaneTitles]);
  // Durable origin for pinned browsers whose tab is CLOSED — resolved from the
  // origin store ∪ closedStack so the row nests back under its project WITH its
  // title instead of leaking to the top-level Fissati block. Recomputes when a
  // pin toggles or a tab closes (closedTabs is a reactive closedStack view).
  const { closedTabs } = useClosedTabs();
  const browserOriginById = useMemo(() => {
    const m = new Map<string, BrowserOrigin>();
    for (const id of pinnedItems) {
      if (!id.startsWith('browser:')) continue;
      const o = resolvePinnedBrowserOrigin(id, closedTabs);
      if (o) m.set(id, o);
    }
    return m;
  }, [pinnedItems, closedTabs]);
  const allItems = useMemo(() => buildSidebarItems({
    topics,
    workspaceProjects,
    terminalSessions,
    browserContexts,
    unreadData,
    showArchived,
    openPanels,
    projectOpenPanes,
    lastNotifiedAt,
    claudeAttentionTopics,
    terminalFinishedIds,
    pinnedIds,
    detachedTopicIds,
    paneTitleById,
    browserOriginById,
    sessionLastActivityById,
  }), [topics, workspaceProjects, terminalSessions, browserContexts, unreadData, showArchived, openPanels, projectOpenPanes, lastNotifiedAt, claudeAttentionTopics, terminalFinishedIds, pinnedIds, detachedTopicIds, paneTitleById, browserOriginById, sessionLastActivityById]);

  // Union of every open pane id — top-level panes AND panes open inside any
  // project window. The sidebar used to check only the top-level `openPanels`,
  // so a terminal/browser opened *inside a project* never lit up as open in the
  // sidebar even though its tab was clearly mounted: the sidebar and the tab
  // bars disagreed. Folding in `projectOpenPanes` keeps the two in sync.
  const allOpenPaneIds = useMemo(() => {
    const s = new Set<string>(openPanels);
    for (const ids of Object.values(projectOpenPanes)) {
      for (const id of ids) s.add(id);
    }
    return s;
  }, [openPanels, projectOpenPanes]);

  const filteredItems = useMemo(
    () => filterSidebarItems(allItems, searchQuery),
    [allItems, searchQuery]
  );

  // ── Fissati partition (render-side; the builder's sort stays untouched) ──
  // The pinned block lists EVERY pinned item — top-level rows AND project
  // children — ordered by pin order (pinnedItems index), NOT the
  // notification-first activity sort. A pinned project child ALSO keeps its
  // nested row (Finder-favorites semantics: the pin is a shortcut, the item
  // still lives in its place); before this, a pinned chat inside a COLLAPSED
  // project was completely invisible, which defeated the point of pinning.
  // Search still applies: an item filtered out by the query drops from the
  // block too.
  const pinnedBlock = useMemo(() => {
    if (pinnedItems.length === 0) return [];
    const byId = new Map<string, SidebarItem>();
    for (const item of filteredItems) {
      if (item.pinned) byId.set(item.id, item);
      for (const child of item.children ?? []) {
        if (child.pinned) byId.set(child.id, child);
      }
    }
    return pinnedItems.flatMap(id => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }, [filteredItems, pinnedItems]);
  const unpinnedItems = useMemo(
    () => filteredItems.filter(i => !i.pinned),
    [filteredItems]
  );

  const groupedItems = useMemo(
    () => viewMode === 'grouped' ? groupSidebarItems(unpinnedItems) : null,
    [unpinnedItems, viewMode]
  );

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleArchive = useCallback(async (topicId: string, archive: boolean) => {
    await onArchiveTopic(topicId, archive);
  }, [onArchiveTopic]);

  // ── Render: single sidebar item ──────────────────────────────────────────

  const renderItem = (item: SidebarItem) => {
    switch (item.type) {
      case 'project':
        return renderProjectItem(item);
      case 'chat':
        return renderChatItem(item);
      case 'terminal':
        return renderTerminalItem(item);
      case 'browser':
        return renderBrowserItem(item);
      case 'utility':
        return renderUtilityItem(item);
    }
  };

  // ── Utility item (Board generale, Statistics, …) ─────────────────────────
  // Tab-driven row like every other type: shows while the `__<type>__` tab is
  // open, focuses it on click. Opening goes through the same global event the
  // "+" menus use (usePanelLifecycle listens and calls handleOpenAsPage, which
  // is an idempotent open-or-focus).
  const renderUtilityItem = (item: SidebarItem) => {
    const Icon = UTILITY_ROW_ICONS[item.icon] ?? LayoutGrid;
    const utilType = item.id.slice(2, -2);
    const isFocused = focusedTopicId === item.id;
    return (
      <button
        key={item.id}
        type="button"
        role="treeitem"
        aria-selected={isFocused}
        data-testid={`sidebar-utility-${utilType}`}
        onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: utilType } }))}
        className={`flex items-center gap-1.5 mx-1.5 my-px px-1.5 h-8 rounded-md select-none text-app-text transition-colors ${
          isFocused ? SELECTED_SURFACE : 'hover:bg-app-hover'
        }`}
        style={{ width: 'calc(100% - 12px)' }}
      >
        <Icon size={13} className="flex-shrink-0 text-emerald-400" />
        <span className="text-[12px] flex-1 text-left truncate">{item.name}</span>
      </button>
    );
  };

  // ── Chat item ────────────────────────────────────────────────────────────

  // Sidebar click decision ladder, step (a): a topic detached in ANOTHER window
  // focuses that OS window rather than reopening here. On false (window died /
  // on another machine) fall through to the normal open/focus path — which
  // resolves the remaining space/active/closed steps (b–d) inside usePanelLifecycle.
  const handleChatRowClick = useCallback(
    (topicId: string, detachedWindowLabel: string | undefined, e?: React.MouseEvent) => {
      if (detachedWindowLabel) {
        void tauriInvoke<boolean>('window_focus_label', { label: detachedWindowLabel })
          .then((focused) => {
            if (!focused) onTopicClick(topicId, e);
          })
          .catch(() => onTopicClick(topicId, e));
        return;
      }
      onTopicClick(topicId, e);
    },
    [onTopicClick],
  );

  const renderChatItem = (item: SidebarItem, depth = 0) => {
    const topic = item.topic!;
    const isOpen = openPanels.includes(topic.id);
    // Focused directly, OR the active inner chat of the focused project.
    const isFocused = focusedTopicId === topic.id
      || isActiveInnerChild(topic.projectPath, createPaneId('chat', topic.id));
    // Sub-agents this chat spawned as an orchestrator (MCP spawn_agent) render
    // nested one level deeper — same pattern as a parent terminal's sub-agents.
    const subAgents = item.subAgents || [];

    const row = (
      <TopicItem
        key={item.id}
        topic={topic}
        depth={depth}
        hasChildren={false}
        isExpanded={false}
        isOpen={isOpen}
        isFocused={isFocused}
        isPreview={previewPanelId === topic.id}
        /* isStreaming is now read from StreamingContext inside TopicItem —
           no need to drill it through. */
        notificationCount={item.notificationCount}
        assignedAgentCount={topic.assignedAgents?.length || 0}
        onToggle={() => {}}
        onClick={(e) => handleChatRowClick(topic.id, item.detachedWindowLabel, e)}
        onDoubleClick={(e) => onTopicDoubleClick(topic.id, e)}
        onContextMenu={(e) => onTopicContextMenu(e, topic)}
        onArchive={handleArchive}
        onStopStreaming={stopSession ? () => {
          const isFirst = stopSession(topic.sessionKey);
          // Route through the same deferred wrapper the row's Archive button
          // uses (not a raw onArchiveTopic call) so both paths share one
          // contract; surface a failed archive instead of dropping it silently.
          if (isFirst) handleArchive(topic.id, true).catch(() => {});
        } : undefined}
        isArchived={item.archived}
        pinned={!!item.pinned}
        detachedWindowLabel={item.detachedWindowLabel}
        onTogglePin={onTogglePin ? () => onTogglePin(item.id) : undefined}
        hideIcon={depth > 0}
      />
    );
    if (subAgents.length === 0) return row;
    return (
      <div key={item.id}>
        {row}
        {subAgents.map(child => renderTerminalItem(child, depth + 1))}
      </div>
    );
  };

  // ── Terminal item ────────────────────────────────────────────────────────

  const renderTerminalItem = (item: SidebarItem, depth = 0) => {
    const ts = item.terminal!;
    const paneId = `terminal:${ts.id}`;
    // Highlight ONLY the focused (current) terminal: either it's the App-focused
    // pane, OR it's the active inner pane of the focused project (terminals open
    // INSIDE a project, so focusedPanelId stays the project pane — without this
    // only the folder would light). A merely-open-elsewhere terminal gets the
    // subtle "open" styling.
    const isFocused = focusedTopicId === paneId || isActiveInnerChild(item.projectPath, paneId);
    const isOpen = allOpenPaneIds.has(paneId);
    const subAgents = item.subAgents || [];

    const row = (
      <TerminalSidebarItem
        key={item.id}
        session={ts}
        isFocused={isFocused}
        isOpen={isOpen}
        notificationCount={item.notificationCount}
        isTouch={isTouch}
        depth={depth}
        pinned={!!item.pinned}
        lastActivity={item.lastActivity}
        onTerminalClick={onTerminalClick}
        onCloseTerminal={onCloseTerminal}
        onOpenAsProject={onOpenAsProject}
        onTogglePin={onTogglePin ? () => onTogglePin(paneId) : undefined}
      />
    );
    if (subAgents.length === 0) return row;
    // Sub-agents (orchestrator-spawned) render nested one level deeper.
    return (
      <div key={item.id}>
        {row}
        {subAgents.map(child => renderTerminalItem(child, depth + 1))}
      </div>
    );
  };

  // ── Browser item ─────────────────────────────────────────────────────────

  const renderBrowserItem = (item: SidebarItem, depth = 0) => {
    const bc = item.browser!;
    const paneId = `browser:${bc.id}`;
    // Focused directly, OR the active inner browser of the focused project —
    // mirrors the chat/terminal rows. Behavior-preserving today (the builder
    // doesn't tag browser items with a projectPath, so isActiveInnerChild is a
    // no-op), correct once browsers can nest inside a project window.
    const isFocused = focusedTopicId === paneId || isActiveInnerChild(item.projectPath, paneId);
    const isOpen = !isFocused && allOpenPaneIds.has(paneId);
    return (
      <BrowserSidebarItem
        key={item.id}
        bc={bc}
        itemName={item.name}
        depth={depth}
        isFocused={isFocused}
        isOpen={isOpen}
        pinned={!!item.pinned}
        onOpenBrowser={onOpenBrowser}
        onCloseBrowser={onCloseBrowser}
        onTogglePin={onTogglePin ? () => onTogglePin(paneId) : undefined}
      />
    );
  };

  // ── Project item (accordion) ─────────────────────────────────────────────

  const renderProjectItem = (item: SidebarItem) => {
    const pp = item.projectPath!;
    const isExpanded = expandedProjects.has(item.id);
    const projectPaneId = createPaneId('project', pp);
    const isProjectFocused = focusedTopicId === projectPaneId;
    const isProjectOpen = openPanels.includes(projectPaneId);
    const allArchived = item.archived;
    const children = item.children || [];
    const allChats = children.filter(c => c.type === 'chat').map(c => c.topic!);
    // The folder is selected whenever its project is the focused pane — exactly
    // like the project's tab in the tab bar. Its active inner child also lights
    // (below): now that selection is a flat fill (no ring/shadow), folder + child
    // read as one clean nested-selection block, not overlapping rows.
    const folderFilled = isProjectFocused;
    // Attention TIER rolled up from the project's children (amber 'input' beats
    // blue 'done'). Fill only shows on an UNfocused folder (focus clears it), so
    // the name/badge must switch to the on-fill treatment then — otherwise the
    // hardcoded muted name colour + default blue badge render grey-on-fill /
    // blue-on-blue, the exact illegibility this redesign removes.
    const projTier = projectAttentionTier(pp, topics, terminalSessions, awaitingTopics, awaitingTermIds, inputTopics, inputTermIds);
    const projOnFill = !isProjectFocused && projTier !== null;
    // Claude sessions alive on this repo but NOT managed by Topics — surfaced
    // as a quiet count so an "idle-looking" project with three bare-terminal
    // sessions reads as the busiest one, not the stillest.
    const extSessions = externalSessionsForProject(externalSessions, pp);

    return (
      <div key={item.id}>
        {/* Project header */}
        <div
          // `pl-1 pr-2` (not the shared `px-2`): the accordion chevron is the
          // leading control, and a full 8px left pad + the chevron button's own
          // centring pushed it ~12px in from the card edge — too much dead space
          // before the arrow. Tighten the LEFT only; the RIGHT keeps `pr-2`
          // (= ROW_PX) so the trailing loader/badge stay column-aligned with the
          // child rows.
          className={`group/proj flex items-center h-11 md:h-8 pl-1 pr-2 select-none ${
            sidebarRowCard({ focused: folderFilled, attention: projTier })
          }`}
          data-pinned={item.pinned ? 'true' : undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            const unreadTopicIds = allChats.filter(t => (unreadData[t.id]?.unreadCount || 0) > 0).map(t => t.id);
            setProjectContextMenu({ x: e.clientX, y: e.clientY, projectPath: pp, projectName: item.name, allArchived, unreadTopicIds, pinned: !!item.pinned });
          }}
        >
          <ProjectRowPendingOverlay projectPath={pp} />
          {/* Chevron is its own control — toggles the accordion ONLY (expand /
              collapse), never moves focus. Separating it from the name button
              means clicking the row to focus a project can't accidentally
              collapse it. */}
          <button
            onClick={(e) => { e.stopPropagation(); toggleProject(item.id); }}
            className="flex items-center justify-center w-5 h-full flex-shrink-0 text-app-text-secondary hover:text-app-text transition-colors"
            aria-label={isExpanded ? `Collapse ${item.name}` : `Expand ${item.name}`}
            aria-expanded={isExpanded}
          >
            <ChevronRight size={12} className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
          {/* Name button:
              - not selected → FOCUS the project + EXPAND it (show children).
              - already selected → a repeat click TOGGLES the accordion, so
                clicking the current project again closes it (and re-opens it).
              The chevron always toggles regardless of selection. */}
          <button
            onClick={() => {
              if (isProjectFocused) {
                // Already the focused project — repeat click collapses/expands.
                toggleProject(item.id);
              } else {
                if (onProjectClick) onProjectClick(pp);
                if (!isExpanded) toggleProject(item.id);
              }
            }}
            className={`flex items-center gap-2 h-full flex-1 min-w-0 text-left text-[13px] font-medium transition-colors ${
              projOnFill ? `${ON_FILL_TEXT} font-semibold` : isProjectFocused ? 'text-app-text' : allArchived ? 'text-app-text-muted' : 'text-app-text-secondary hover:text-app-text'
            }`}
            title={pp}
            aria-label={`${item.name} project`}
            data-testid={`project-toggle-${item.name}`}
          >
            {/* Real project icon when the folder ships a favicon / web-manifest
                / index.html <link rel=icon> (resolved by /api/projects/icon).
                Folders without one render nothing — zero footprint, no fake
                glyph, no monogram (decisione Attilio 2026-07-16). */}
            <ProjectFavicon path={pp} size={14} className="mr-0.5" />
            <span className="truncate flex-1">{item.name}</span>
          </button>
          <div className="flex items-center flex-shrink-0">
            {/* Window-position mini-map: where THIS project's window sits in the
                tiled top-level split (PanelGrid publishes it keyed by project
                path). Only present when more than one window is open — a single
                window has nothing to orient against. Lives on the sidebar row
                only (user preference), never on the top tab bar. */}
            <ProjectSplitMiniMap projectPath={pp} onFill={projOnFill} />
            {/* External-session count — Claude running on this repo OUTSIDE
                Topics (bare terminal). Awareness only: muted, non-clickable,
                never an attention fill (nothing here is waiting on the user). */}
            {extSessions.length > 0 && (
              <span
                className={`flex items-center gap-0.5 flex-shrink-0 ml-1 ${projOnFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
                title={`${extSessions.length === 1 ? 'Una sessione Claude attiva' : `${extSessions.length} sessioni Claude attive`} fuori da Topics:\n${extSessions
                  .map((s) => `· ${s.title ?? s.claudeSessionId.slice(0, 8)} — ${Math.max(0, Math.round((Date.now() - s.lastActivityAt) / 60000))} min fa`)
                  .join('\n')}`}
                aria-label={`${extSessions.length} sessioni Claude esterne attive`}
                data-testid={`external-sessions-badge-${item.name}`}
              >
                <Activity size={11} />
                <span className="text-[10px] font-medium tabular-nums">{extSessions.length}</span>
              </span>
            )}
            {/* Pin glyph — trailing rail, before the loader/badge (same fixed
                Pin → … → NotificationBadge order as the chat rows). Inherits
                the on-fill treatment on attention fills, never a hardcoded
                colour. */}
            {item.pinned && (
              <span
                className={`flex-shrink-0 flex items-center ml-0.5 ${projOnFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
                title="Fissato"
                aria-label="Fissato"
              >
                <Pin size={12} />
              </span>
            )}
            {/* Project loading indicator — same component the project tab uses
                (PaneTabBar): a spinner while any child is producing output.
                "Needs you" (Claude awaiting, finished turns) is NOT a separate
                dot anymore — it rolls up into the notification badge below, so
                the sidebar row and the project tab show one consistent count.
                `ml-0.5` (NOT `mr-1.5`): the trailing margin pushed this loader
                6px in from the row edge, so the PROJECT row's spinner sat left of
                the CHILD (terminal/browser) rows' spinners, which are flush. With
                no right margin every sidebar loader lands at the same trailing
                offset — the row's loaders line up in one column. */}
            {/* Last-update timestamp — the SAME trailing "agg. X fa" the chat,
                terminal and browser rows all show (relativeTime of the row's real
                last activity). The project row was the ONLY sidebar row without it,
                so a project's last update wasn't visible at a glance. `item.lastActivity`
                is the project's aggregate (max over its children, per buildSidebarItems).
                Hidden on hover to free room for the action buttons, like the badge below. */}
            {item.lastActivity > 0 && (
              <span
                className={`flex-shrink-0 text-[11px] tabular-nums group-hover/proj:hidden mr-1 ${projOnFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
                title={new Date(item.lastActivity).toLocaleString()}
              >
                {relativeTime(item.lastActivity)}
              </span>
            )}
            <ProjectStreamingSpinner projectPath={pp} className="ml-0.5" />
            {/* Numeric status indicators (git changed-files / ahead-behind /
                running processes / open-chat count) were removed from the
                sidebar project header — they read as cryptic numbers. Only the
                notification badge (unread / "needs you" attention) stays. Git
                and process status live where they're actionable (git/terminal
                panes + the project tab). */}
            {item.notificationCount > 0 && (
              <NotificationBadge count={item.notificationCount} className={`ml-0.5 ${isTouch ? '' : 'group-hover/proj:hidden'}`} variant={projOnFill ? 'onFill' : 'default'} />
            )}
            {/* Action buttons on hover */}
            {!isTouch && (
              <>
                {onArchiveProject && (
                  <ProjectArchiveButton
                    projectPath={pp}
                    allArchived={allArchived}
                    onArchive={onArchiveProject}
                  />
                )}
                {(onNewTopicInProject || onAddProjectPane) && (
                  <div className="relative hidden group-hover/proj:flex">
                    {/* Same canonical add-pane affordance as the top tab
                        bar's "+" — single component, single rendering
                        contract. Trigger button visibility is the only
                        thing the parent customises (hover-revealed here,
                        always-visible in the tab bar). */}
                    <PaneAddMenu
                      scope="project"
                      onNewChat={onNewTopicInProject ? () => onNewTopicInProject(pp) : undefined}
                      onAddPane={onAddProjectPane ? (type, subType) => onAddProjectPane(pp, type, subType) : undefined}
                      // Cmd+N targets the focused group's New Chat, not
                      // this specific project's — kbd hint would lie.
                      showShortcuts={false}
                      triggerTitle="Add to project"
                    />
                  </div>
                )}
              </>
            )}
            {/* Touch: overflow menu */}
            {isTouch && (onNewTopicInProject || onAddProjectPane || onArchiveProject) && (
              <TouchProjectMenu
                pp={pp}
                allArchived={allArchived}
                onNewTopicInProject={onNewTopicInProject}
                onAddProjectPane={onAddProjectPane}
                onArchiveProject={onArchiveProject}
              />
            )}
          </div>
        </div>

        {/* Accordion children */}
        {isExpanded && children.length > 0 && (
          <div>
            {children.map(child => {
              if (child.type === 'chat') return renderChatItem(child, 2);
              if (child.type === 'terminal') return renderTerminalItem(child, 2);
              if (child.type === 'browser') return renderBrowserItem(child, 2);
              return null;
            })}
          </div>
        )}

        {/* Pinned active topic when collapsed */}
        {!isExpanded && (() => {
          const activeTopicId = projectActiveTopics?.[pp];
          if (!activeTopicId || (!isProjectOpen && !isProjectFocused)) return null;
          const activeChild = children.find(c => c.id === activeTopicId);
          if (!activeChild || activeChild.type !== 'chat') return null;
          return renderChatItem(activeChild, 2);
        })()}
      </div>
    );
  };

  // ── Collapsible section for grouped view (mirrors old sidebar design) ────

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  // Generic collapsible section — shared by the per-type groups AND the
  // Fissati pseudo-section. 'pinned' is a SECTION KEY only, never a
  // SidebarItemType (pinning is orthogonal to type; groupSidebarItems and
  // filterSidebarItems must never see it).
  const renderSection = (sectionKey: string, Icon: LucideIcon, label: string, items: SidebarItem[]) => {
    const isCollapsed = collapsedSections.has(sectionKey);
    const totalUnread = items.reduce((sum, item) => sum + item.notificationCount, 0);

    return (
      <div key={sectionKey} className="flex-shrink-0 border-t border-app-border first:border-t-0">
        {/* Section header — collapsible, matches old sidebar design */}
        <div className="group flex items-center h-11 md:h-8 hover:bg-app-hover transition-colors">
          <button
            onClick={() => toggleSection(sectionKey)}
            aria-expanded={!isCollapsed}
            aria-label={`sezione ${label}`}
            className="flex items-center gap-2 flex-1 h-full text-left"
            style={{ paddingLeft: 12 }}
          >
            <Icon size={14} className="text-app-text-secondary flex-shrink-0" />
            <span className="text-[13px] text-app-text">{label}</span>
            {items.length > 0 && (
              <span className="text-[11px] text-app-text-tertiary">{items.length}</span>
            )}
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={`transition-transform duration-150 text-app-text-tertiary ${!isCollapsed ? 'rotate-90' : ''}`}
            />
          </button>
          <div className="flex items-center gap-1 pr-1">
            <NotificationBadge count={totalUnread} />
          </div>
        </div>
        {/* Section content */}
        {!isCollapsed && (
          <div>
            {items.map(item => renderItem(item))}
          </div>
        )}
      </div>
    );
  };

  const renderGroupSection = (type: SidebarItem['type'], items: SidebarItem[]) =>
    renderSection(type, TYPE_ICONS[type], TYPE_LABELS[type], items);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div role="tree" aria-label="Sidebar" className="flex flex-col h-full min-h-0">
      {/* paddingBlock (ROW_INSET − 1) + each card's my-px (1px) = ROW_INSET
          above the first row and below the last — the SAME 6px the cards keep
          laterally (mx-1.5) and the tab bar keeps around its tabs, so the
          sidebar's padding reads identical on every axis. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto sidebar-scroll"
        style={{ paddingBlock: ROW_INSET - 1 }}
      >
        {/* Board generale — THE single sidebar row for the board, above the
            Fissati block. Shown when there is active (non-done) work across all
            projects OR while its tab is open, so an open board is never without
            a sidebar presence (the guarantee the generic utility row used to
            provide before it was suppressed as a duplicate — see
            buildSidebarItems §5b). Being the only row, it is tab-aware:
            aria-selected + a selected surface while open, exactly like the tab
            rows below. Position is fixed at the top either way, so opening the
            board never makes its row jump. */}
        {(boardTaskCount > 0 || boardOpen) && onOpenBoard && (
          <button
            type="button"
            onClick={onOpenBoard}
            data-testid="sidebar-board-generale"
            aria-selected={boardOpen}
            className={`w-full flex items-center gap-1.5 px-3 h-8 mb-1 select-none text-app-text transition-colors ${
              boardOpen ? SELECTED_SURFACE : 'hover:bg-app-hover'
            }`}
          >
            <LayoutGrid size={13} className="flex-shrink-0 text-emerald-400" />
            <span className="text-[12px] font-medium flex-1 text-left">Board generale</span>
            {boardTaskCount > 0 && (
              <span className="ml-auto min-w-[16px] h-[16px] flex items-center justify-center bg-emerald-500 text-white text-[9px] font-bold rounded-full leading-none px-1">
                {boardTaskCount}
              </span>
            )}
          </button>
        )}
        {viewMode === 'timeline' ? (
          // Timeline: the Fissati block first (user pin order), then the flat
          // list sorted by activity. Pinned rows keep badges/attention fills —
          // they just don't jump position with the notification-first sort.
          <>
            {pinnedBlock.length > 0 && (
              <div data-testid="sidebar-pinned-section">
                <div className="flex items-center gap-1.5 px-3 h-6 select-none">
                  <Pin size={10} className="text-app-text-tertiary flex-shrink-0" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-tertiary">Fissati</span>
                </div>
                {pinnedBlock.map(item => renderItem(item))}
                {/* Hairline divider between the pinned block and the timeline
                    (same grammar as POPOVER_DIVIDER). */}
                {unpinnedItems.length > 0 && <div className="h-px bg-app-border mx-3 my-1" />}
              </div>
            )}
            {unpinnedItems.map(item => renderItem(item))}
          </>
        ) : (
          // Grouped: the Fissati pseudo-section first, then the collapsible
          // per-type sections (fed the UNpinned items so nothing double-renders).
          groupedItems && (
            <>
              {pinnedBlock.length > 0 && (
                <div data-testid="sidebar-pinned-section">
                  {renderSection('pinned', Pin, 'Fissati', pinnedBlock)}
                </div>
              )}
              {(['project', 'chat', 'terminal', 'browser', 'utility'] as const).map(type => {
                const items = groupedItems[type];
                if (items.length === 0) return null;
                return renderGroupSection(type, items);
              })}
            </>
          )
        )}

        {filteredItems.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-app-text-muted">
            {searchQuery ? 'No results' : 'No active items'}
          </div>
        )}
      </div>

      {/* Project context menu */}
      {projectContextMenu && (
        <ContextMenuPortal
          open
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          onClose={() => setProjectContextMenu(null)}
          minWidth={160}
        >
          {projectContextMenu.unreadTopicIds.length > 0 && (
            <button
              onClick={() => {
                for (const id of projectContextMenu.unreadTopicIds) {
                  topicsApi.markRead(id).catch(() => {});
                }
                setProjectContextMenu(null);
              }}
              className={POPOVER_ITEM}
            >
              <CheckCheck size={14} />
              <span>Mark all as read</span>
            </button>
          )}
          {onTogglePin && (
            <button
              onClick={() => {
                // Pin key = the sidebar item id form (`project:<rawPath>`),
                // NOT the encodeURIComponent pane id.
                onTogglePin(`project:${projectContextMenu.projectPath}`);
                setProjectContextMenu(null);
              }}
              className={POPOVER_ITEM}
            >
              {projectContextMenu.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              <span>{projectContextMenu.pinned ? 'Rimuovi dai Fissati' : 'Fissa'}</span>
            </button>
          )}
          {onArchiveProject && (
            <button
              onClick={() => {
                onArchiveProject(projectContextMenu.projectPath, !projectContextMenu.allArchived);
                setProjectContextMenu(null);
              }}
              className={POPOVER_ITEM}
            >
              {projectContextMenu.allArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              <span>{projectContextMenu.allArchived ? 'Restore Project' : 'Archive Project'}</span>
            </button>
          )}
        </ContextMenuPortal>
      )}
    </div>
  );
}

// ── Terminal sidebar item ──────────────────────────────────────────────────────

interface TerminalSidebarItemProps {
  session: TerminalSessionInfo;
  /** Currently-viewed terminal → blue accent (mirrors chat rows). */
  isFocused: boolean;
  /** Open as a tab somewhere but not the focused one → subtle "open" styling. */
  isOpen: boolean;
  /** Unified attention count (finished claude-code turn) — rendered as the same
   *  NotificationBadge every other surface uses, instead of a one-off dot. */
  notificationCount?: number;
  isTouch: boolean;
  depth?: number;
  projectName?: string;
  /** Pinned ("Fissati") — renders the trailing Pin glyph and the row survives
   *  tab close (see buildSidebarItems pinnedIds escape for `terminal:<id>`). */
  pinned?: boolean;
  /** Real last-touched timestamp (createdAt, or the Claude session's own
   *  phaseUpdatedAt/updatedAt when more recent — see buildSidebarItems'
   *  terminalLastActivity). Rendered as a relative-time label so it's visible
   *  WHY this row sorts above/below another, mirroring BrowserSidebarItem. */
  lastActivity: number;
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onCloseTerminal?: (sessionId: string) => void;
  onOpenAsProject?: (path: string) => void;
  /** Pin/unpin this terminal ("Fissa" / "Rimuovi dai Fissati") — surfaced in
   *  the right-click context menu and the touch overflow menu. */
  onTogglePin?: () => void;
}

function TerminalSidebarItem({ session: s, isFocused, isOpen, notificationCount = 0, isTouch, depth = 0, projectName, pinned, lastActivity, onTerminalClick, onCloseTerminal, onOpenAsProject, onTogglePin }: TerminalSidebarItemProps) {
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Desktop right-click menu (touch uses the overflow "…" DropdownPortal). null
  // = closed; positioned at the cursor, viewport-clamped like the project menu.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // v3 sidebar↔topbar sync: also check `close-tab:terminal:<id>` so that
  // closing the terminal pane via the topbar X shows the countdown in
  // the sidebar terminal row too.
  const pendingClose = useTerminalPendingStatus(s.id);
  // Attention TIER — amber 'input' (permission gate) vs blue 'done' (turn
  // finished), or null. The fill only shows on an UNfocused row (focus clears it).
  const attentionTier = useTerminalAttentionTier(s.id);
  const onFill = attentionTier !== null && !isFocused;
  // Split schematic, same as chat rows (TopicItem) and projects. The standalone
  // terminal pane is published in SplitPositionContext under its pane-id
  // `terminal:<id>` (PanelGrid keys every open pane by paneId), so a topicless
  // terminal — which has no topic UUID key — still resolves its cell here.
  const splitPosition = useSplitPosition(`terminal:${s.id}`);

  return (
    <div
      // Same three-state model as chat (TopicItem) so selection means the SAME
      // thing on every sidebar row: the focused item gets the shared neutral
      // SELECTED_SURFACE (= the focused tab), merely-open is subtle, else quiet.
      className={[
        `group/terminal flex items-center h-11 md:h-8 ${ROW_PX}`,
        sidebarRowCard({ focused: isFocused, open: isOpen, attention: attentionTier }),
      ].filter(Boolean).join(' ')}
      style={{ marginLeft: ROW_INSET + depth * SIDEBAR_INDENT_STEP }}
      data-pinned={pinned ? 'true' : undefined}
      onContextMenu={onTogglePin ? (e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); } : undefined}
    >
      {pendingClose && <PendingActionProgressOverlay status={pendingClose} />}
      <button
        onClick={() => { signalsActions.clearTerminalFinished(s.id); onTerminalClick?.(s.id, s.name); }}
        className="flex items-center gap-2 flex-1 min-w-0 h-full text-left"
        title={`${s.name} — ${s.cwd}`}
      >
        {s.type === 'claude-code'
          ? <ClaudeIcon size={13} className="flex-shrink-0 text-[#D97757]" />
          : s.type === 'codex'
            ? <CodexIcon size={13} className="flex-shrink-0" />
            : <TerminalSquare size={13} className="flex-shrink-0 text-app-text-tertiary" />}
        {/* Name + live "what it's doing" subline (self-hides when idle). */}
        <span className="flex-1 min-w-0 flex flex-col justify-center">
          <span className={`text-[12px] truncate leading-none ${onFill ? 'font-semibold' : ''}`}>{s.name}</span>
          <SessionActivity subjectId={s.id} onFill={onFill} className="mt-[3px]" />
        </span>
        {projectName && (
          <span className={`text-[11px] truncate max-w-[80px] mr-1 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`} title={s.cwd}>
            {projectName}
          </span>
        )}
        {/* Connected-client count removed from the sidebar — it was almost
            always "1" (one viewer per session) and read as a cryptic grey
            number, same noise we already stripped from the project header
            (see the comment near the project row). The live socket count is
            still available server-side if a surface ever genuinely needs it. */}
        {/* Relative last-activity — same trailing timestamp BrowserSidebarItem
            shows, so it's visible AT A GLANCE why this row sorts above/below
            another (real last touch, not frozen createdAt). */}
        <span className={`flex-shrink-0 text-[11px] tabular-nums group-hover/terminal:hidden mr-1 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}>
          {relativeTime(lastActivity)}
        </span>
        {/* Loading spinner + status pinned to the END of the row (after the cwd
            metadata) so "what's working" reads at the trailing edge, mirroring
            the tab bar. A finished turn surfaces as the notification badge, not
            a separate dot. */}
        <TerminalStreamingSpinner sessionId={s.id} className="ml-0.5" />
        <NotificationBadge count={notificationCount} className="ml-0.5" variant={onFill ? 'onFill' : 'default'} />
      </button>

      {/* Split schematic — same placement/treatment as the chat row's minimap. */}
      {splitPosition && (
        <SplitMiniMap
          rows={splitPosition.rows}
          rowHeights={splitPosition.rowHeights}
          active={splitPosition.active}
          className={`flex-shrink-0 mr-1.5 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
        />
      )}

      {/* Pinned ("Fissato") trailing glyph — mirrors the chat row's rail. */}
      {pinned && (
        <span
          className={`flex-shrink-0 flex items-center ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
          title="Fissato"
          aria-label="Fissato"
        >
          <Pin size={12} />
        </span>
      )}

      {/* Inline "Open as project" icon removed — it competed with the
          close-button slot for hover attention and made the row noisy.
          The action is still reachable from the touch overflow menu
          (DropdownPortal below) and from the right-click context menu. */}

      {onCloseTerminal && (
        // The close affordance only takes layout space on hover (or when a
        // close is pending / on touch). At rest it's `hidden` → zero width, so
        // the spinner + badge inside the flex-1 button above sit FLUSH at the
        // row's trailing edge. Reserving it always (the old behaviour) pushed
        // the loading spinner ~28px in from the edge — the "spinner non in
        // fondo" bug. Same hover-reveal pattern the project row already uses.
        <span className={`flex-shrink-0 items-center justify-center w-6 h-6 relative mr-1 ${isTouch || pendingClose ? 'flex' : 'hidden group-hover/terminal:flex'}`}>
          {isTouch ? (
            <>
              <button
                ref={overflowRef}
                onClick={(e) => { e.stopPropagation(); setOverflowOpen(o => !o); }}
                className="flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all text-app-text-tertiary hover:text-app-text"
                title="More options"
              >
                <MoreHorizontal size={12} />
              </button>
              <DropdownPortal open={overflowOpen} anchorRef={overflowRef} onClose={() => setOverflowOpen(false)}>
                {onTogglePin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onTogglePin(); setOverflowOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    {pinned ? <PinOff size={14} className="flex-shrink-0" /> : <Pin size={14} className="flex-shrink-0" />}
                    <span>{pinned ? 'Rimuovi dai Fissati' : 'Fissa'}</span>
                  </button>
                )}
                {onOpenAsProject && !projectName && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onOpenAsProject(s.cwd); setOverflowOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                  >
                    <FolderOpen size={14} className="flex-shrink-0" />
                    <span>Open as project</span>
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onCloseTerminal(s.id); setOverflowOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <X size={14} className="flex-shrink-0" />
                  <span>Close</span>
                </button>
              </DropdownPortal>
            </>
          ) : pendingClose ? (
            <span className="flex items-center justify-center w-full h-full relative z-10">
              <PendingActionRing
                status={pendingClose}
                size={14}
                pendingTitle="Annulla chiusura"
                pendingAriaLabel={`Annulla chiusura ${s.name}`}
              />
            </span>
          ) : (
            <span className="hidden group-hover/terminal:flex items-center justify-center w-full h-full">
              <PendingActionRing
                status={null}
                size={14}
                onIdleClick={() => onCloseTerminal(s.id)}
                idleTitle="Chiudi terminale"
                idleAriaLabel={`Chiudi terminale ${s.name}`}
              />
            </span>
          )}
        </span>
      )}

      {/* Desktop right-click menu — the pin affordance for terminal rows on
          desktop (touch uses the overflow "…" above). Reuses the shared popover
          tokens like the project header menu. Rendered inline (not a portal): a
          fixed-position node clamped to the viewport, same as the project menu. */}
      {ctxMenu && onTogglePin && (
          <ContextMenuPortal
            open
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            minWidth={200}
          >
            <button
              role="menuitem"
              onClick={() => { onTogglePin(); setCtxMenu(null); }}
              className={POPOVER_ITEM}
            >
              {pinned ? <PinOff size={14} className="text-app-text-tertiary" /> : <Pin size={14} className="text-app-text-tertiary" />}
              {pinned ? 'Rimuovi dai Fissati' : 'Fissa'}
            </button>
            {onOpenAsProject && !projectName && (
              <button
                role="menuitem"
                onClick={() => { onOpenAsProject(s.cwd); setCtxMenu(null); }}
                className={POPOVER_ITEM}
              >
                <FolderOpen size={14} className="text-app-text-tertiary" />
                Open as project
              </button>
            )}
            {onCloseTerminal && (
              <button
                role="menuitem"
                onClick={() => { onCloseTerminal(s.id); setCtxMenu(null); }}
                className={POPOVER_ITEM}
              >
                <X size={14} className="text-app-text-tertiary" />
                Close
              </button>
            )}
          </ContextMenuPortal>
      )}
    </div>
  );
}

// ── Touch project overflow menu ────────────────────────────────────────────────

interface TouchProjectMenuProps {
  pp: string;
  allArchived: boolean;
  // Note: claudeSkipPermissions state is owned inside PaneAddMenuItems via
  // useClaudeSkipPermissions(); we don't thread it through here anymore.
  onNewTopicInProject?: (projectPath: string) => void;
  onAddProjectPane?: (projectPath: string, type: PaneType, subType?: string) => void;
  onArchiveProject?: (projectPath: string, archive: boolean) => Promise<boolean>;
}

function TouchProjectMenu({ pp, allArchived, onNewTopicInProject, onAddProjectPane, onArchiveProject }: TouchProjectMenuProps) {
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const hasAddItems = !!(onNewTopicInProject || onAddProjectPane);
  const hasProjectActions = !!onArchiveProject;

  return (
    <div className="relative">
      <button
        ref={overflowBtnRef}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-surface hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors"
        title="More options"
      >
        <MoreHorizontal size={14} />
      </button>
      <DropdownPortal open={open} anchorRef={overflowBtnRef} onClose={close}>
        {/* Add-pane rows: same shared component as the desktop "+" menu so a
            new pane type added to PANE_CONFIG appears here automatically. */}
        <PaneAddMenuItems
          scope="project"
          onNewChat={onNewTopicInProject ? () => onNewTopicInProject(pp) : undefined}
          onAddPane={onAddProjectPane ? (type, subType) => onAddProjectPane(pp, type, subType) : undefined}
          showShortcuts={false}
          onClose={close}
        />
        {/* Divider before project-level actions — only when both halves render. */}
        {hasAddItems && hasProjectActions && <div className="h-px bg-app-border mx-2 my-1" />}
        {onArchiveProject && (
          <button onClick={(e) => { e.stopPropagation(); onArchiveProject(pp, !allArchived); close(); }} className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors">
            {allArchived ? <ArchiveRestore size={14} className="flex-shrink-0" /> : <Archive size={14} className="flex-shrink-0" />}
            <span className="flex-1 text-left">{allArchived ? 'Restore Project' : 'Archive Project'}</span>
          </button>
        )}
      </DropdownPortal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Project archive button — extracted so we can call usePendingActionStatus
 * for the inline check + countdown ring (replaces the Archive icon during
 * the 3 s soft-archive window). Lives at module scope because hooks can't
 * be called inside the projects.map(...) render loop above. */

interface ProjectArchiveButtonProps {
  projectPath: string;
  allArchived: boolean;
  onArchive: (projectPath: string, archive: boolean) => Promise<boolean>;
}

function ProjectArchiveButton({ projectPath, allArchived, onArchive }: ProjectArchiveButtonProps) {
  // Only the archive direction goes through the countdown — restoring is
  // immediate (consistent with TopicItem and the App-level wrappers).
  const status = usePendingActionStatus(allArchived ? null : `archive-project:${projectPath}`);

  // Pending: filled check (cancels on click).
  if (status) {
    return (
      <span className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center relative z-10">
        <PendingActionRing
          status={status}
          size={14}
          pendingTitle="Annulla archiviazione"
          pendingAriaLabel={`Annulla archiviazione progetto ${projectPath}`}
        />
      </span>
    );
  }

  // Idle, archived → restore icon (no countdown — restoration is safe).
  if (allArchived) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onArchive(projectPath, false); }}
        className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
        title="Restore Project"
      >
        <ArchiveRestore size={12} />
      </button>
    );
  }

  // Idle, not archived → empty "todo" circle. Click queues the soft-archive.
  return (
    <span className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center relative z-10">
      <PendingActionRing
        status={null}
        size={14}
        onIdleClick={() => onArchive(projectPath, true)}
        idleTitle="Archivia progetto"
        idleAriaLabel={`Archivia progetto ${projectPath}`}
      />
    </span>
  );
}

/**
 * Sub-component used as a direct child of the project header row in
 * TopicTree (pos: relative on that row) so the progress fill aligns to
 * the row's bounds. Lives at module scope for the same hook-rule reason
 * as ProjectArchiveButton.
 */
function ProjectRowPendingOverlay({ projectPath }: { projectPath: string }) {
  const status = usePendingActionStatus(`archive-project:${projectPath}`);
  if (!status) return null;
  return <PendingActionProgressOverlay status={status} />;
}


/**
 * The project window's position mini-map for its sidebar row. Reads the
 * project path's cell in the published top-level split (undefined unless more
 * than one window is open), and renders the same proportional SplitMiniMap the
 * sidebar chat rows use, with this window's cell lit. Module-scope sub-component
 * because it calls a hook — can't run inside the projects render loop above.
 */
function ProjectSplitMiniMap({ projectPath, onFill }: { projectPath: string; onFill?: boolean }) {
  const pos = useSplitPosition(projectPath);
  if (!pos) return null;
  return (
    <SplitMiniMap
      rows={pos.rows}
      rowHeights={pos.rowHeights}
      active={pos.active}
      // currentColor-driven: on the attention fill inherit its high-contrast tone
      // instead of a fixed grey (the grey-on-blue bug), matching the chat row.
      className={`flex-shrink-0 mr-1.5 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
    />
  );
}


/**
 * Browser sidebar item — extracted from the parent's `renderBrowserItem`
 * inline closure so we can call `usePendingActionStatus` per browser.
 * Otherwise hooks live inside a function called conditionally inside the
 * parent's render, which violates the rules of hooks across re-renders.
 */
interface BrowserSidebarItemProps {
  bc: BrowserContextInfo;
  itemName: string;
  depth: number;
  isFocused: boolean;
  isOpen: boolean;
  pinned?: boolean;
  onOpenBrowser?: (id: string) => void;
  onCloseBrowser?: (id: string) => void;
  onTogglePin?: () => void;
}

function BrowserSidebarItem({ bc, itemName, depth, isFocused, isOpen, pinned, onOpenBrowser, onCloseBrowser, onTogglePin }: BrowserSidebarItemProps) {
  // v3 sidebar↔topbar sync: also check `close-tab:browser:<id>` so the
  // sidebar browser row shows the countdown when the close is initiated
  // from the topbar.
  const pendingClose = useBrowserPendingStatus(bc.id);
  // Desktop right-click menu — parity with the chat/terminal rows (which had one
  // while browser rows did not). Cursor-positioned, portaled via ContextMenuPortal.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const hasMenu = !!onTogglePin || !!onCloseBrowser;
  return (
    <div
      className={[
        `group flex items-center h-11 md:h-8 cursor-pointer text-[14px] md:text-[13px] ${ROW_PX}`,
        sidebarRowCard({ focused: isFocused, open: isOpen }),
      ].filter(Boolean).join(' ')}
      style={{ marginLeft: ROW_INSET + depth * SIDEBAR_INDENT_STEP }}
      data-pinned={pinned ? 'true' : undefined}
      onClick={() => onOpenBrowser?.(bc.id)}
      onContextMenu={hasMenu ? (e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); } : undefined}
    >
      {pendingClose && <PendingActionProgressOverlay status={pendingClose} />}
      <Globe size={14} className="flex-shrink-0 mr-2 opacity-60" />
      <span className="flex-1 truncate" title={bc.url}>
        {itemName}
      </span>
      <span className="flex-shrink-0 text-[11px] text-app-text-tertiary tabular-nums group-hover:hidden mr-1">
        {relativeTime(bc.lastActivity)}
      </span>
      {/* Loading spinner pinned to the row's trailing edge (after the
          last-activity timestamp), mirroring the tab + terminal rows. Same
          signal (useBrowserLoading) and component the browser TAB uses. No
          right margin so it sits flush when the close slot is hidden. */}
      <BrowserStreamingSpinner paneId={`browser:${bc.id}`} className="ml-0.5" />
      {/* Pin glyph — same "Fissato" indicator as chat / terminal / project rows.
          Placed as the trailing-most PERSISTENT element (after the timestamp +
          spinner, before the hover-only close slot) so it lands in the SAME
          column as the other rows' pins — putting it before the timestamp pushed
          it left and broke the alignment. Applies to both project-nested and
          top-level browser rows (same component). */}
      {pinned && (
        <span
          className="flex-shrink-0 flex items-center text-app-text-tertiary ml-1"
          title="Fissato"
          aria-label="Fissato"
        >
          <Pin size={12} />
        </span>
      )}
      {onCloseBrowser && (
        // Hover-only close slot (or visible while a close is pending) so the
        // spinner above sits FLUSH at the trailing edge at rest — reserving it
        // always pushed the spinner ~28px in from the edge.
        <span className={`flex-shrink-0 w-6 h-6 items-center justify-center mr-1 relative z-10 ${pendingClose ? 'flex' : 'hidden group-hover:flex'}`}>
          {pendingClose ? (
            <PendingActionRing
              status={pendingClose}
              size={14}
              pendingTitle="Annulla chiusura"
              pendingAriaLabel={`Annulla chiusura browser ${itemName}`}
            />
          ) : (
            <span className="hidden group-hover:flex items-center justify-center w-full h-full">
              <PendingActionRing
                status={null}
                size={14}
                onIdleClick={() => onCloseBrowser(bc.id)}
                idleTitle="Chiudi browser"
                idleAriaLabel={`Chiudi browser ${itemName}`}
              />
            </span>
          )}
        </span>
      )}
      {ctxMenu && (
        <ContextMenuPortal
          open
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          minWidth={200}
        >
          {onTogglePin && (
            <button
              role="menuitem"
              onClick={() => { onTogglePin(); setCtxMenu(null); }}
              className={POPOVER_ITEM}
            >
              {pinned ? <PinOff size={14} className="text-app-text-tertiary" /> : <Pin size={14} className="text-app-text-tertiary" />}
              {pinned ? 'Rimuovi dai Fissati' : 'Fissa'}
            </button>
          )}
          {onCloseBrowser && (
            <button
              role="menuitem"
              onClick={() => { onCloseBrowser(bc.id); setCtxMenu(null); }}
              className={POPOVER_ITEM}
            >
              <X size={14} className="text-app-text-tertiary" />
              Chiudi browser
            </button>
          )}
        </ContextMenuPortal>
      )}
    </div>
  );
}
