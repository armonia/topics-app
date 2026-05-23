import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, MessageSquare, TerminalSquare, Globe, LayoutGrid, FolderOpen, MoreHorizontal, X, CheckCheck, Crown as CrownIcon } from 'lucide-react';
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
import { createPaneId, useProjectTabStatus, getAddableTypesForScope } from '@/state/pane/adapters';
import type { Topic, UnreadData, PaneType, TerminalSessionInfo } from '@/types';
import { useTabNotifications } from '@/hooks/useTabNotifications';
import { ClaudeIcon } from '@/components/Shared/ClaudeIcon';
import { ProjectClaudePhaseIndicator } from '@/components/Layout/ClaudePhaseDot';
import { ProjectStreamingSpinner, TerminalStreamingSpinner, TerminalFinishedDot } from '@/components/Layout/StreamingIndicator';
import { useStreamingCount, signalsActions } from '@/state/signals';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
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
  boardTaskCounts?: Record<string, number>;
  onOpenProjectBoard?: (projectPath: string) => void;
  /** Open (or create + open) the global Master Topic. Renders the
   *  "Master" sidebar shortcut next to Board when provided. */
  onOpenMaster?: () => void;
  onNewChat?: () => void;
  onNewBrowser?: () => void;
  terminalSessions?: TerminalSessionInfo[];
  browserContexts?: BrowserContextInfo[];
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onNewTerminal?: (type: 'shell' | 'claude-code', skipPermissions?: boolean) => void;
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
  boardTaskCounts,
  onOpenProjectBoard,
  onOpenMaster,
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

  // Project tab status for sidebar indicators
  const sidebarProjectPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const t of Object.values(topics)) {
      if (t.projectPath) paths.add(t.projectPath);
    }
    for (const p of workspaceProjects) paths.add(p);
    return [...paths];
  }, [topics, workspaceProjects]);
  const projectTabStatus = useProjectTabStatus(sidebarProjectPaths);

  // Close project context menu on outside click
  useEffect(() => {
    if (!projectContextMenu) return;
    const h = () => setProjectContextMenu(null);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [projectContextMenu]);

  // Total streaming session count from the canonical context. Was a
  // per-render O(N) filter over `topics` driven by the legacy
  // isSessionStreaming prop; now pre-computed once at provider scope.
  const activeStreamingCount = useStreamingCount();

  // ── Build unified items ──────────────────────────────────────────────────

  const { lastNotifiedAt } = useTabNotifications();
  // Master Topics are surfaced exclusively by the dedicated "Master"
  // sidebar shortcut at the top of the tree — hide them from the
  // generic topic list so the user has a single, unambiguous entry
  // point instead of a duplicated row inside the tree.
  const topicsForTree = useMemo(() => {
    const filtered: Record<string, Topic> = {};
    for (const [id, t] of Object.entries(topics)) {
      if (t.agentTeamRole === 'lead') continue;
      filtered[id] = t;
    }
    return filtered;
  }, [topics]);

  const allItems = useMemo(() => buildSidebarItems({
    topics: topicsForTree,
    workspaceProjects,
    terminalSessions,
    browserContexts,
    unreadData,
    showArchived,
    openPanels,
    projectOpenPanes,
    lastNotifiedAt,
  }), [topicsForTree, workspaceProjects, terminalSessions, browserContexts, unreadData, showArchived, openPanels, projectOpenPanes, lastNotifiedAt]);

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
    const isFocused = focusedTopicId === topic.id;

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
        unreadCount={item.unreadCount}
        assignedAgentCount={topic.assignedAgents?.length || 0}
        onToggle={() => {}}
        onClick={(e) => onTopicClick(topic.id, e)}
        onDoubleClick={(e) => onTopicDoubleClick(topic.id, e)}
        onContextMenu={(e) => onTopicContextMenu(e, topic)}
        onArchive={handleArchive}
        onStopStreaming={stopSession ? () => {
          const isFirst = stopSession(topic.sessionKey);
          if (isFirst) onArchiveTopic(topic.id, true);
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
    // Open anywhere — top-level or inside a project — counts as active so the
    // sidebar row matches the terminal's tab state in either surface.
    const isActive = focusedTopicId === paneId || allOpenPaneIds.has(paneId);

    return (
      <TerminalSidebarItem
        key={item.id}
        session={ts}
        isActive={isActive}
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
    const isFocused = focusedTopicId === paneId;
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

    return (
      <div key={item.id}>
        {/* Project header */}
        <div
          className={`group/proj flex items-center h-11 md:h-8 transition-colors relative select-none border-b border-app-border/40 md:border-b-0 ${
            isProjectFocused ? 'bg-primary/8 dark:bg-primary/15' : isProjectOpen ? 'bg-app-hover' : 'hover:bg-app-hover'
          }`}
          onContextMenu={(e) => {
            e.preventDefault();
            const unreadTopicIds = allChats.filter(t => (unreadData[t.id]?.unreadCount || 0) > 0).map(t => t.id);
            setProjectContextMenu({ x: e.clientX, y: e.clientY, projectPath: pp, projectName: item.name, allArchived, unreadTopicIds });
          }}
        >
          <ProjectRowPendingOverlay projectPath={pp} />
          {isProjectFocused && <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full bg-primary" />}
          <button
            onClick={() => {
              toggleProject(item.id);
              if (onProjectClick) onProjectClick(pp);
            }}
            className={`flex items-center gap-2 h-full flex-1 min-w-0 text-left text-[13px] font-medium transition-colors ${
              isProjectFocused ? 'text-primary dark:text-primary-dark' : allArchived ? 'text-app-text-muted' : 'text-app-text-secondary hover:text-app-text'
            }`}
            style={{ paddingLeft: 12 }}
            title={pp}
            aria-label={`${item.name} project`}
            data-testid={`project-toggle-${item.name}`}
          >
            <ChevronRight size={12} className={`transition-transform duration-150 flex-shrink-0 text-app-text-secondary ${isExpanded ? 'rotate-90' : ''}`} />
            <FolderOpen size={14} className="flex-shrink-0 text-app-text-secondary" />
            <span className="truncate flex-1">{item.name}</span>
          </button>
          <div className="flex items-center pr-1 flex-shrink-0">
            {/* Two canonical project-level loading indicators, same
                components the project tab uses (PaneTabBar):
                  phase dot     → Claude lifecycle (running, awaiting…)
                  streaming spinner → an SSE chunk is arriving right now
                Both read from their respective contexts; we just place
                them. */}
            <ProjectClaudePhaseIndicator projectPath={pp} className="mr-1.5" />
            <ProjectStreamingSpinner projectPath={pp} className="mr-1.5" />
            {/* Git/process status indicators */}
            {(() => {
              const ps = projectTabStatus[pp];
              const showBranch = ps?.gitBranch && ps.gitBranch !== 'main' && ps.gitBranch !== 'master';
              const hasStatus = ps && (showBranch || ps.gitFileCount > 0 || ps.gitAhead > 0 || ps.gitBehind > 0 || ps.runningProcessCount > 0);
              return hasStatus ? (
                <span className={`flex items-center gap-1 text-[10px] font-medium mr-1.5 min-w-0 ${isTouch ? '' : 'group-hover/proj:hidden'}`}>
                  {showBranch && <span className="truncate max-w-[60px] text-app-text-tertiary" title={ps.gitBranch}>{ps.gitBranch}</span>}
                  {ps.gitFileCount > 0 && <span className="px-1 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 leading-none py-px">{ps.gitFileCount}</span>}
                  {(ps.gitAhead > 0 || ps.gitBehind > 0) && (
                    <span className="text-blue-500 dark:text-blue-400 leading-none whitespace-nowrap">
                      {ps.gitAhead > 0 && <>{ps.gitAhead}↑</>}{ps.gitBehind > 0 && <>{ps.gitAhead > 0 ? ' ' : ''}{ps.gitBehind}↓</>}
                    </span>
                  )}
                  {ps.runningProcessCount > 0 && (
                    <span className="flex items-center gap-0.5 text-green-500 dark:text-green-400 leading-none">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />{ps.runningProcessCount}
                    </span>
                  )}
                </span>
              ) : null;
            })()}
            {/* Unread / count */}
            {item.unreadCount > 0 ? (
              <NotificationBadge count={item.unreadCount} className={isTouch ? '' : 'group-hover/proj:hidden'} />
            ) : (
              <span className={`text-[10px] text-app-placeholder ${isTouch ? '' : 'group-hover/proj:hidden'}`}>{children.length}</span>
            )}
            {/* Action buttons on hover */}
            {!isTouch && (
              <>
                {onOpenProjectBoard && (
                  <button onClick={(e) => { e.stopPropagation(); onOpenProjectBoard(pp); }} className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-emerald-500 hover:text-emerald-400 transition-colors" title="Open Board">
                    <LayoutGrid size={12} />
                  </button>
                )}
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
                      onNewChat={onNewTopicInProject ? () => onNewTopicInProject(pp) : undefined}
                      onAddPane={onAddProjectPane ? (type, subType) => onAddProjectPane(pp, type, subType) : undefined}
                      availableTypes={onAddProjectPane ? getAddableTypesForScope('project') : []}
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
            {isTouch && (onNewTopicInProject || onAddProjectPane || onOpenProjectBoard || onArchiveProject) && (
              <TouchProjectMenu
                pp={pp}
                allArchived={allArchived}
                onNewTopicInProject={onNewTopicInProject}
                onAddProjectPane={onAddProjectPane}
                onOpenProjectBoard={onOpenProjectBoard}
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
    const totalUnread = items.reduce((sum, item) => sum + item.unreadCount, 0);

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

  // ── Board shortcut (always visible at top) ───────────────────────────────

  const renderBoardShortcut = () => {
    if (searchQuery || !onOpenProjectBoard) return null;
    return (
      <div className="flex-shrink-0">
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('open-all-boards'))}
          className="group/ab flex items-center gap-2 w-full h-11 md:h-8 text-left text-[14px] md:text-[13px] text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors"
          style={{ paddingLeft: 12 }}
          title="View all project boards"
        >
          <LayoutGrid size={14} className={`flex-shrink-0 ${activeStreamingCount > 0 ? 'text-emerald-500' : 'text-app-text-secondary'}`} />
          <span className="flex-1 truncate text-app-text">Board</span>
          {activeStreamingCount > 0 && (
            <span className="flex items-center gap-1 pr-3">
              <span className="w-2.5 h-2.5 border-[1.5px] border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-[10px] text-emerald-500 font-medium tabular-nums">{activeStreamingCount}</span>
            </span>
          )}
          {activeStreamingCount === 0 && Object.keys(boardTaskCounts || {}).length > 0 && (
            <span className="text-[10px] text-app-text-muted tabular-nums pr-3">
              {Object.values(boardTaskCounts || {}).reduce((a, b) => a + b, 0)}
            </span>
          )}
        </button>
        {onOpenMaster && (
          <button
            data-testid="sidebar-master-shortcut"
            onClick={() => onOpenMaster()}
            className="group/mst flex items-center gap-2 w-full h-11 md:h-8 text-left text-[14px] md:text-[13px] text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors"
            style={{ paddingLeft: 12 }}
            title="Open Master · Global (Shift+Cmd+M)"
          >
            <CrownIcon size={14} className="flex-shrink-0 text-purple-400" />
            <span className="flex-1 truncate text-app-text">Master</span>
            <span className="text-[10px] text-app-text-muted/70 tabular-nums pr-3">⇧⌘M</span>
          </button>
        )}
        <div className="border-t border-app-border" />
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div role="tree" aria-label="Sidebar" className="flex flex-col h-full min-h-0">
      {renderBoardShortcut()}

      <div className="flex-1 min-h-0 overflow-y-auto sidebar-scroll">
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
      {projectContextMenu && (
        <div
          className="fixed bg-surface border border-app-border rounded-lg shadow-lg py-1 z-[100] min-w-[160px]"
          style={{ top: projectContextMenu.y, left: projectContextMenu.x }}
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
      )}
    </div>
  );
}

// ── Terminal sidebar item ──────────────────────────────────────────────────────

interface TerminalSidebarItemProps {
  session: TerminalSessionInfo;
  isActive: boolean;
  isTouch: boolean;
  depth?: number;
  projectName?: string;
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onCloseTerminal?: (sessionId: string) => void;
  onOpenAsProject?: (path: string) => void;
}

function TerminalSidebarItem({ session: s, isActive, isTouch, depth = 0, projectName, onTerminalClick, onCloseTerminal, onOpenAsProject }: TerminalSidebarItemProps) {
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // v3 sidebar↔topbar sync: also check `close-tab:terminal:<id>` so that
  // closing the terminal pane via the topbar X shows the countdown in
  // the sidebar terminal row too.
  const pendingClose = useTerminalPendingStatus(s.id);

  return (
    <div
      className={`group/terminal w-full flex items-center h-10 md:h-7 transition-colors border-b border-app-border/40 md:border-b-0 relative ${
        isActive ? 'bg-primary/10 text-primary' : 'text-app-text hover:bg-app-hover'
      }`}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      {pendingClose && <PendingActionProgressOverlay status={pendingClose} />}
      <button
        onClick={() => { signalsActions.clearTerminalFinished(s.id); onTerminalClick?.(s.id, s.name); }}
        className="flex items-center gap-2 flex-1 min-w-0 h-full text-left"
        title={`${s.name} — ${s.cwd}`}
      >
        {s.type === 'claude-code'
          ? <ClaudeIcon size={13} className="flex-shrink-0 text-[#D97757]" />
          : <TerminalSquare size={13} className="flex-shrink-0 text-app-text-tertiary" />}
        <span className="text-[12px] truncate flex-1">{s.name}</span>
        {/* Loading spinner — pulses while this session's pty is producing
            output, mirroring the terminal tab. Same source (useTerminalActivity)
            so the sidebar row and the tab agree. */}
        <TerminalStreamingSpinner sessionId={s.id} className="mr-1" />
        <TerminalFinishedDot sessionId={s.id} className="mr-1" />
        {projectName && (
          <span className="text-[10px] text-app-text-tertiary truncate max-w-[80px]" title={s.cwd}>
            {projectName}
          </span>
        )}
        {s.clients > 0 && (
          <span className="text-[10px] text-app-text-tertiary" title={`${s.clients} connected`}>
            {s.clients}
          </span>
        )}
      </button>

      {/* Inline "Open as project" icon removed — it competed with the
          close-button slot for hover attention and made the row noisy.
          The action is still reachable from the touch overflow menu
          (DropdownPortal below) and from the right-click context menu. */}

      {onCloseTerminal && (
        <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 relative mr-1">
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
  onOpenProjectBoard?: (projectPath: string) => void;
  onArchiveProject?: (projectPath: string, archive: boolean) => Promise<boolean>;
}

function TouchProjectMenu({ pp, allArchived, onNewTopicInProject, onAddProjectPane, onOpenProjectBoard, onArchiveProject }: TouchProjectMenuProps) {
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const hasAddItems = !!(onNewTopicInProject || onAddProjectPane);
  const hasProjectActions = !!(onOpenProjectBoard || onArchiveProject);

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
          onNewChat={onNewTopicInProject ? () => onNewTopicInProject(pp) : undefined}
          onAddPane={onAddProjectPane ? (type, subType) => onAddProjectPane(pp, type, subType) : undefined}
          availableTypes={onAddProjectPane ? getAddableTypesForScope('project') : []}
          showShortcuts={false}
          onClose={close}
        />
        {/* Divider before project-level actions — only when both halves render. */}
        {hasAddItems && hasProjectActions && <div className="h-px bg-app-border mx-2 my-1" />}
        {onOpenProjectBoard && (
          <button onClick={(e) => { e.stopPropagation(); onOpenProjectBoard(pp); close(); }} className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <LayoutGrid size={14} className="flex-shrink-0 text-emerald-500" /><span className="flex-1 text-left">Open Board</span>
          </button>
        )}
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
        'group flex items-center h-11 md:h-8 cursor-pointer transition-colors duration-100 relative text-[14px] md:text-[13px] border-b border-app-border/40 md:border-b-0',
        isFocused && 'bg-primary/8 dark:bg-primary/15 text-[#10b981]',
        !isFocused && isOpen && 'bg-app-hover text-app-text',
        !isFocused && !isOpen && 'text-app-text-secondary hover:bg-app-hover hover:text-app-text',
      ].filter(Boolean).join(' ')}
      style={{ paddingLeft: 12 + depth * 16 }}
      onClick={() => onOpenBrowser?.(bc.id)}
    >
      {pendingClose && <PendingActionProgressOverlay status={pendingClose} />}
      {isFocused && <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full" style={{ backgroundColor: '#10b981' }} />}
      <Globe size={14} className="flex-shrink-0 mr-2 opacity-60" />
      <span className="flex-1 truncate" title={bc.url}>
        {itemName}
      </span>
      <span className="flex-shrink-0 text-[10px] text-app-text-tertiary tabular-nums group-hover:hidden mr-1">
        {relativeTime(bc.lastActivity)}
      </span>
      {onCloseBrowser && (
        <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center mr-1 relative z-10">
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
