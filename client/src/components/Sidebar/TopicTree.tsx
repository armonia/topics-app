import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, MessageSquare, TerminalSquare, Globe, FolderOpen, MoreHorizontal, X, CheckCheck } from 'lucide-react';
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
import { createPaneId } from '@/state/pane/adapters';
import type { Topic, UnreadData, PaneType, TerminalSessionInfo } from '@/types';
import { useTabNotifications } from '@/hooks/useTabNotifications';
import { ClaudeIcon } from '@/components/Shared/ClaudeIcon';
import { CodexIcon } from '@/components/Shared/CodexIcon';
import { ProjectFavicon } from '@/components/Shared/ProjectFavicon';
import { ProjectStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner } from '@/components/Layout/StreamingIndicator';
import { SplitMiniMap } from '@/components/Shared/SplitMiniMap';
import { useSplitPosition } from '@/contexts/SplitPositionContext';
import { useAttentionSignals, signalsActions, useTerminalAwaitingFeedback, useProjectAwaitingFeedback } from '@/state/signals';
import { useProjectFocusStore } from '@/state/projectFocus';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
import { sidebarRowCard, ROW_PX, ROW_INSET, SIDEBAR_INDENT_STEP, AWAITING_FEEDBACK_FILL } from '@/lib/selectionStyles';
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
} as const;

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
  onNewTerminal?: (type: 'shell' | 'claude-code' | 'codex', skipPermissions?: boolean) => void;
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
}: TopicTreeProps) {
  // Claude "yolo" toggle state lives inside <PaneAddMenu> now (via
  // useClaudeSkipPermissions in PaneAddMenuItems). No longer threaded
  // through here. The legacy `projectAddMenu` / `addBtnRef` state is
  // also gone — the canonical <PaneAddMenu> component owns its own
  // button ref and open/close state.
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; projectPath: string; projectName: string; allArchived: boolean; unreadTopicIds: string[] } | null>(null);
  const expandedProjects = useMemo(() => new Set(expandedProjectsProp), [expandedProjectsProp]);
  const { isTouch } = useMobile();

  const toggleProject = useCallback((projectId: string) => {
    onToggleProject(prev => {
      const set = new Set(prev);
      if (set.has(projectId)) set.delete(projectId);
      else set.add(projectId);
      return Array.from(set);
    });
  }, [onToggleProject]);

  // Close project context menu on outside click or Escape.
  useEffect(() => {
    if (!projectContextMenu) return;
    const close = () => setProjectContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [projectContextMenu]);

  // ── Build unified items ──────────────────────────────────────────────────

  const { lastNotifiedAt } = useTabNotifications();
  // Attention signals — fed into buildSidebarItems so the sidebar badge counts
  // the same thing the tab bar does (Claude needs-you, finished terminal turns),
  // not just raw server unread.
  const { claudeAttentionTopics, terminalFinishedIds } = useAttentionSignals();
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
  }), [topics, workspaceProjects, terminalSessions, browserContexts, unreadData, showArchived, openPanels, projectOpenPanes, lastNotifiedAt, claudeAttentionTopics, terminalFinishedIds]);

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

  const groupedItems = useMemo(
    () => viewMode === 'grouped' ? groupSidebarItems(filteredItems) : null,
    [filteredItems, viewMode]
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
    }
  };

  // ── Chat item ────────────────────────────────────────────────────────────

  const renderChatItem = (item: SidebarItem, depth = 0) => {
    const topic = item.topic!;
    const isOpen = openPanels.includes(topic.id);
    // Focused directly, OR the active inner chat of the focused project.
    const isFocused = focusedTopicId === topic.id
      || isActiveInnerChild(topic.projectPath, createPaneId('chat', topic.id));

    return (
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
        onClick={(e) => onTopicClick(topic.id, e)}
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
        hideIcon={depth > 0}
      />
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

    return (
      <TerminalSidebarItem
        key={item.id}
        session={ts}
        isFocused={isFocused}
        isOpen={isOpen}
        notificationCount={item.notificationCount}
        isTouch={isTouch}
        depth={depth}
        onTerminalClick={onTerminalClick}
        onCloseTerminal={onCloseTerminal}
        onOpenAsProject={onOpenAsProject}
      />
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
        onOpenBrowser={onOpenBrowser}
        onCloseBrowser={onCloseBrowser}
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
            sidebarRowCard({ focused: folderFilled })
          }`}
          onContextMenu={(e) => {
            e.preventDefault();
            const unreadTopicIds = allChats.filter(t => (unreadData[t.id]?.unreadCount || 0) > 0).map(t => t.id);
            setProjectContextMenu({ x: e.clientX, y: e.clientY, projectPath: pp, projectName: item.name, allArchived, unreadTopicIds });
          }}
        >
          <ProjectRowPendingOverlay projectPath={pp} />
          <ProjectRowAwaitingOverlay projectPath={pp} />
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
              isProjectFocused ? 'text-app-text' : allArchived ? 'text-app-text-muted' : 'text-app-text-secondary hover:text-app-text'
            }`}
            title={pp}
            aria-label={`${item.name} project`}
            data-testid={`project-toggle-${item.name}`}
          >
            {/* Real project icon when the folder ships a favicon / web-manifest
                / index.html <link rel=icon> (resolved by /api/projects/icon).
                Folders without one render nothing — no fake folder glyph. */}
            <ProjectFavicon path={pp} size={14} className="mr-0.5" />
            <span className="truncate flex-1">{item.name}</span>
          </button>
          <div className="flex items-center flex-shrink-0">
            {/* Window-position mini-map: where THIS project's window sits in the
                tiled top-level split (PanelGrid publishes it keyed by project
                path). Only present when more than one window is open — a single
                window has nothing to orient against. Lives on the sidebar row
                only (user preference), never on the top tab bar. */}
            <ProjectSplitMiniMap projectPath={pp} />
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
            <ProjectStreamingSpinner projectPath={pp} className="ml-0.5" />
            {/* Numeric status indicators (git changed-files / ahead-behind /
                running processes / open-chat count) were removed from the
                sidebar project header — they read as cryptic numbers. Only the
                notification badge (unread / "needs you" attention) stays. Git
                and process status live where they're actionable (git/terminal
                panes + the project tab). */}
            {item.notificationCount > 0 && (
              <NotificationBadge count={item.notificationCount} className={`ml-0.5 ${isTouch ? '' : 'group-hover/proj:hidden'}`} />
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

  const renderGroupSection = (type: SidebarItem['type'], items: SidebarItem[]) => {
    const Icon = TYPE_ICONS[type];
    const labels: Record<SidebarItem['type'], string> = {
      project: 'Projects',
      chat: 'Chats',
      terminal: 'Terminals',
      browser: 'Browsers',
    };
    const isCollapsed = collapsedSections.has(type);
    const totalUnread = items.reduce((sum, item) => sum + item.notificationCount, 0);

    return (
      <div key={type} className="flex-shrink-0 border-t border-app-border first:border-t-0">
        {/* Section header — collapsible, matches old sidebar design */}
        <div className="group flex items-center h-11 md:h-8 hover:bg-app-hover transition-colors">
          <button
            onClick={() => toggleSection(type)}
            aria-expanded={!isCollapsed}
            aria-label={`${labels[type]} section`}
            className="flex items-center gap-2 flex-1 h-full text-left"
            style={{ paddingLeft: 12 }}
          >
            <Icon size={14} className="text-app-text-secondary flex-shrink-0" />
            <span className="text-[13px] text-app-text">{labels[type]}</span>
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
        {viewMode === 'timeline' ? (
          // Timeline: flat list sorted by activity
          filteredItems.map(item => renderItem(item))
        ) : (
          // Grouped: collapsible sections by type (mirrors old sidebar layout)
          groupedItems && (['project', 'chat', 'terminal', 'browser'] as const).map(type => {
            const items = groupedItems[type];
            if (items.length === 0) return null;
            return renderGroupSection(type, items);
          })
        )}

        {filteredItems.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-app-text-muted">
            {searchQuery ? 'No results' : 'No active items'}
          </div>
        )}
      </div>

      {/* Project context menu */}
      {projectContextMenu && (() => {
        // Clamp the click point so the menu never spills past the viewport
        // (mirrors ProviderModelPicker's Math.min approach). Width = the menu's
        // min-w (160px); height is estimated from the visible item count
        // (~34px/row desktop + the py-1 wrapper) since we have no ref to measure.
        const MENU_W = 160;
        const itemCount = (projectContextMenu.unreadTopicIds.length > 0 ? 1 : 0) + (onArchiveProject ? 1 : 0);
        const menuH = itemCount * 34 + 8;
        const left = Math.max(8, Math.min(projectContextMenu.x, window.innerWidth - MENU_W - 8));
        const top = Math.max(8, Math.min(projectContextMenu.y, window.innerHeight - menuH - 8));
        return (
        <div
          className="fixed glass-surface border border-app-border rounded-lg shadow-lg py-1 z-[100] min-w-[160px]"
          style={{ top, left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {projectContextMenu.unreadTopicIds.length > 0 && (
            <button
              onClick={() => {
                for (const id of projectContextMenu.unreadTopicIds) {
                  topicsApi.markRead(id).catch(() => {});
                }
                setProjectContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <CheckCheck size={14} />
              <span>Mark all as read</span>
            </button>
          )}
          {onArchiveProject && (
            <button
              onClick={() => {
                onArchiveProject(projectContextMenu.projectPath, !projectContextMenu.allArchived);
                setProjectContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              {projectContextMenu.allArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              <span>{projectContextMenu.allArchived ? 'Restore Project' : 'Archive Project'}</span>
            </button>
          )}
        </div>
        );
      })()}
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
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onCloseTerminal?: (sessionId: string) => void;
  onOpenAsProject?: (path: string) => void;
}

function TerminalSidebarItem({ session: s, isFocused, isOpen, notificationCount = 0, isTouch, depth = 0, projectName, onTerminalClick, onCloseTerminal, onOpenAsProject }: TerminalSidebarItemProps) {
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // v3 sidebar↔topbar sync: also check `close-tab:terminal:<id>` so that
  // closing the terminal pane via the topbar X shows the countdown in
  // the sidebar terminal row too.
  const pendingClose = useTerminalPendingStatus(s.id);

  return (
    <div
      // Same three-state model as chat (TopicItem) so selection means the SAME
      // thing on every sidebar row: the focused item gets the shared neutral
      // SELECTED_SURFACE (= the focused tab), merely-open is subtle, else quiet.
      className={[
        `group/terminal flex items-center h-11 md:h-8 ${ROW_PX}`,
        sidebarRowCard({ focused: isFocused, open: isOpen }),
      ].filter(Boolean).join(' ')}
      style={{ marginLeft: ROW_INSET + depth * SIDEBAR_INDENT_STEP }}
    >
      {pendingClose && <PendingActionProgressOverlay status={pendingClose} />}
      {(s.type === 'claude-code' || s.type === 'claude-code-team') && <TerminalRowAwaitingOverlay sessionId={s.id} />}
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
        <span className="text-[12px] truncate flex-1">{s.name}</span>
        {projectName && (
          <span className="text-[11px] text-app-text-tertiary truncate max-w-[80px] mr-1" title={s.cwd}>
            {projectName}
          </span>
        )}
        {/* Connected-client count removed from the sidebar — it was almost
            always "1" (one viewer per session) and read as a cryptic grey
            number, same noise we already stripped from the project header
            (see the comment near the project row). The live socket count is
            still available server-side if a surface ever genuinely needs it. */}
        {/* Loading spinner + status pinned to the END of the row (after the cwd
            metadata) so "what's working" reads at the trailing edge, mirroring
            the tab bar. A finished turn surfaces as the notification badge, not
            a separate dot. */}
        <TerminalStreamingSpinner sessionId={s.id} className="ml-0.5" />
        <NotificationBadge count={notificationCount} className="ml-0.5" />
      </button>

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

/** Blue "awaiting feedback" wash for a Claude-Code terminal sidebar row —
 *  twin of the chat row overlay (TopicItem), keyed by terminal session id. */
function TerminalRowAwaitingOverlay({ sessionId }: { sessionId: string }) {
  const awaiting = useTerminalAwaitingFeedback(sessionId);
  if (!awaiting) return null;
  return <div aria-hidden className={`absolute inset-0 rounded-lg pointer-events-none ${AWAITING_FEEDBACK_FILL} animate-awaiting-pulse`} />;
}

/** Blue "awaiting feedback" wash for a project folder row — rollup: blue if any
 *  descendant chat/Claude-Code terminal under this project awaits the user. */
function ProjectRowAwaitingOverlay({ projectPath }: { projectPath: string }) {
  const awaiting = useProjectAwaitingFeedback(projectPath);
  if (!awaiting) return null;
  return <div aria-hidden className={`absolute inset-0 rounded-lg pointer-events-none ${AWAITING_FEEDBACK_FILL} animate-awaiting-pulse`} />;
}

/**
 * The project window's position mini-map for its sidebar row. Reads the
 * project path's cell in the published top-level split (undefined unless more
 * than one window is open), and renders the same proportional SplitMiniMap the
 * sidebar chat rows use, with this window's cell lit. Module-scope sub-component
 * because it calls a hook — can't run inside the projects render loop above.
 */
function ProjectSplitMiniMap({ projectPath }: { projectPath: string }) {
  const pos = useSplitPosition(projectPath);
  if (!pos) return null;
  return (
    <SplitMiniMap
      rows={pos.rows}
      rowHeights={pos.rowHeights}
      active={pos.active}
      className="flex-shrink-0 mr-1.5 text-app-text-tertiary"
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
  onOpenBrowser?: (id: string) => void;
  onCloseBrowser?: (id: string) => void;
}

function BrowserSidebarItem({ bc, itemName, depth, isFocused, isOpen, onOpenBrowser, onCloseBrowser }: BrowserSidebarItemProps) {
  // v3 sidebar↔topbar sync: also check `close-tab:browser:<id>` so the
  // sidebar browser row shows the countdown when the close is initiated
  // from the topbar.
  const pendingClose = useBrowserPendingStatus(bc.id);
  return (
    <div
      className={[
        `group flex items-center h-11 md:h-8 cursor-pointer text-[14px] md:text-[13px] ${ROW_PX}`,
        sidebarRowCard({ focused: isFocused, open: isOpen }),
      ].filter(Boolean).join(' ')}
      style={{ marginLeft: ROW_INSET + depth * SIDEBAR_INDENT_STEP }}
      onClick={() => onOpenBrowser?.(bc.id)}
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
    </div>
  );
}
