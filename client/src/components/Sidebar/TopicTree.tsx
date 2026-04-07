import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, Plus, MessageSquare, TerminalSquare, Globe, GitBranch, LayoutGrid, FolderOpen, MoreHorizontal, X, CheckCheck } from 'lucide-react';
// DnD imports preserved for future drag-to-reorder in timeline
// import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
// import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TopicItem } from './TopicItem';
import { topicsApi } from '@/lib/api';
import { createPaneId } from '@/lib/paneConfig';
import type { Topic, UnreadData, PaneType, TerminalSessionInfo } from '@/types';
import { useProjectTabStatus } from '@/hooks/useProjectTabStatus';
import { ClaudeIcon } from '@/components/Shared/ClaudeIcon';
import { useClaudeSkipPermissions } from '@/hooks/useClaudePrefs';
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
  isSessionStreaming?: (sessionKey: string) => boolean;
  stopSession?: (sessionKey: string) => boolean;
  boardTaskCounts?: Record<string, number>;
  onOpenProjectBoard?: (projectPath: string) => void;
  onNewChat?: () => void;
  onNewBrowser?: () => void;
  terminalSessions?: TerminalSessionInfo[];
  browserContexts?: BrowserContextInfo[];
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onNewTerminal?: (type: 'shell' | 'claude-code', skipPermissions?: boolean) => void;
  onCloseTerminal?: (sessionId: string) => void;
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
  isSessionStreaming,
  stopSession,
  boardTaskCounts,
  onOpenProjectBoard,
  onNewChat: _onNewChat,
  onNewBrowser: _onNewBrowser,
  terminalSessions = [],
  browserContexts = [],
  onTerminalClick,
  onNewTerminal: _onNewTerminal,
  onCloseTerminal,
  onOpenBrowser,
  onCloseBrowser,
  viewMode,
  showArchived,
  expandedProjects: expandedProjectsProp,
  onToggleProject,
  projectOpenPanes = {},
}: TopicTreeProps) {
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; projectPath: string; projectName: string; allArchived: boolean; unreadTopicIds: string[] } | null>(null);
  const [projectAddMenu, setProjectAddMenu] = useState<string | null>(null);
  const expandedProjects = useMemo(() => new Set(expandedProjectsProp), [expandedProjectsProp]);
  const addBtnRef = useRef<HTMLButtonElement>(null);
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

  // Count actively streaming sessions
  const activeStreamingCount = isSessionStreaming
    ? Object.values(topics).filter(t => isSessionStreaming(t.sessionKey)).length
    : 0;

  // ── Build unified items ──────────────────────────────────────────────────

  const allItems = useMemo(() => buildSidebarItems({
    topics,
    workspaceProjects,
    terminalSessions,
    browserContexts,
    unreadData,
    showArchived,
    openPanels,
    projectOpenPanes,
  }), [topics, workspaceProjects, terminalSessions, browserContexts, unreadData, showArchived, openPanels, projectOpenPanes]);

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
        isStreaming={isSessionStreaming ? isSessionStreaming(topic.sessionKey) : false}
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
    const isActive = focusedTopicId === paneId || openPanels.includes(paneId);

    return (
      <TerminalSidebarItem
        key={item.id}
        session={ts}
        isActive={isActive}
        isTouch={isTouch}
        depth={depth}
        onTerminalClick={onTerminalClick}
        onCloseTerminal={onCloseTerminal}
      />
    );
  };

  // ── Browser item ─────────────────────────────────────────────────────────

  const renderBrowserItem = (item: SidebarItem, depth = 0) => {
    const bc = item.browser!;
    const paneId = `browser:${bc.id}`;
    const isFocused = focusedTopicId === paneId;
    const isOpen = !isFocused && openPanels.includes(paneId);

    return (
      <div
        key={item.id}
        className={[
          'group flex items-center h-8 cursor-pointer transition-colors duration-100 relative text-[12px] md:text-[13px]',
          isFocused && 'bg-primary/8 dark:bg-primary/15 text-[#10b981]',
          !isFocused && isOpen && 'bg-app-hover text-app-text',
          !isFocused && !isOpen && 'text-app-text-secondary hover:bg-app-hover hover:text-app-text',
        ].filter(Boolean).join(' ')}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => onOpenBrowser?.(bc.id)}
      >
        {isFocused && <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full" style={{ backgroundColor: '#10b981' }} />}
        <Globe size={14} className="flex-shrink-0 mr-2 opacity-60" />
        <span className="flex-1 truncate" title={bc.url}>
          {item.name}
        </span>
        <span className="flex-shrink-0 text-[10px] text-app-text-tertiary tabular-nums group-hover:hidden mr-1">
          {relativeTime(bc.lastActivity)}
        </span>
        {onCloseBrowser && (
          <button
            onClick={(e) => { e.stopPropagation(); onCloseBrowser(bc.id); }}
            className="hidden group-hover:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 hover:text-red-500 transition-all mr-1"
            title="Close browser"
          >
            <X size={12} />
          </button>
        )}
      </div>
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
          className={`group/proj flex items-center h-8 transition-colors relative select-none ${
            isProjectFocused ? 'bg-primary/8 dark:bg-primary/15' : isProjectOpen ? 'bg-app-hover' : 'hover:bg-app-hover'
          }`}
          onContextMenu={(e) => {
            e.preventDefault();
            const unreadTopicIds = allChats.filter(t => (unreadData[t.id]?.unreadCount || 0) > 0).map(t => t.id);
            setProjectContextMenu({ x: e.clientX, y: e.clientY, projectPath: pp, projectName: item.name, allArchived, unreadTopicIds });
          }}
        >
          {isProjectFocused && <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full bg-primary" />}
          <button
            onClick={() => {
              toggleProject(item.id);
              if (!expandedProjects.has(item.id) && onProjectClick) onProjectClick(pp);
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
              <span className={`text-[10px] text-white bg-primary px-1.5 rounded-full min-w-[18px] text-center ${isTouch ? '' : 'group-hover/proj:hidden'}`}>{item.unreadCount}</span>
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
                  <button onClick={(e) => { e.stopPropagation(); onArchiveProject(pp, !allArchived); }} className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors" title={allArchived ? 'Restore Project' : 'Archive Project'}>
                    {allArchived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                  </button>
                )}
                {(onNewTopicInProject || onAddProjectPane) && (
                  <div className="relative hidden group-hover/proj:block">
                    <button
                      onClick={(e) => { e.stopPropagation(); addBtnRef.current = e.currentTarget; setProjectAddMenu(projectAddMenu === pp ? null : pp); }}
                      className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
                      title="Add to project"
                    >
                      <Plus size={12} />
                    </button>
                    <DropdownPortal open={projectAddMenu === pp} anchorRef={addBtnRef} onClose={() => setProjectAddMenu(null)}>
                      {onNewTopicInProject && (
                        <button onClick={() => { onNewTopicInProject(pp); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                          <MessageSquare size={14} /><span>New Chat</span>
                        </button>
                      )}
                      {onAddProjectPane && (
                        <button onClick={() => { onAddProjectPane(pp, 'terminal'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                          <TerminalSquare size={14} /><span>Shell</span>
                        </button>
                      )}
                      {onAddProjectPane && (
                        <button onClick={() => { onAddProjectPane(pp, 'terminal', 'claude-code'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                          <ClaudeIcon size={14} className="text-[#D97757]" /><span className="flex-1 text-left">Claude Code</span>
                          <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
                            <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
                            <span>yolo</span>
                          </label>
                        </button>
                      )}
                      {onAddProjectPane && (
                        <button onClick={() => { onAddProjectPane(pp, 'browser'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                          <Globe size={14} /><span>Browser</span>
                        </button>
                      )}
                      {onAddProjectPane && (
                        <button onClick={() => { onAddProjectPane(pp, 'git'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                          <GitBranch size={14} /><span>Git</span>
                        </button>
                      )}
                    </DropdownPortal>
                  </div>
                )}
              </>
            )}
            {/* Touch: overflow menu */}
            {isTouch && (onNewTopicInProject || onAddProjectPane || onOpenProjectBoard || onArchiveProject) && (
              <TouchProjectMenu
                pp={pp}
                allArchived={allArchived}
                claudeSkipPermissions={claudeSkipPermissions}
                setClaudeSkipPermissions={setClaudeSkipPermissions}
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
        <div className="group flex items-center h-8 hover:bg-app-hover transition-colors">
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
            {totalUnread > 0 && (
              <span className="text-[10px] text-white bg-primary px-1.5 rounded-full min-w-[18px] text-center leading-[14px]">
                {totalUnread}
              </span>
            )}
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
          className="group/ab flex items-center gap-2 w-full h-8 text-left text-[13px] text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors"
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
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
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
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
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
}

function TerminalSidebarItem({ session: s, isActive, isTouch, depth = 0, projectName, onTerminalClick, onCloseTerminal }: TerminalSidebarItemProps) {
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  return (
    <div
      className={`group/terminal w-full flex items-center h-7 transition-colors ${
        isActive ? 'bg-primary/10 text-primary' : 'text-app-text hover:bg-app-hover'
      }`}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      <button
        onClick={() => onTerminalClick?.(s.id, s.name)}
        className="flex items-center gap-2 flex-1 min-w-0 h-full text-left"
        title={`${s.name} — ${s.cwd}`}
      >
        {s.type === 'claude-code'
          ? <ClaudeIcon size={13} className="flex-shrink-0 text-[#D97757]" />
          : <TerminalSquare size={13} className="flex-shrink-0 text-app-text-tertiary" />}
        <span className="text-[12px] truncate flex-1">{s.name}</span>
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
                <button
                  onClick={(e) => { e.stopPropagation(); onCloseTerminal(s.id); setOverflowOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <X size={14} className="flex-shrink-0" />
                  <span>Close</span>
                </button>
              </DropdownPortal>
            </>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTerminal(s.id); }}
              className="hidden group-hover/terminal:flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
              title="Close terminal"
            >
              <X size={10} className="text-app-text-tertiary hover:text-red-500" />
            </button>
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
  claudeSkipPermissions: boolean;
  setClaudeSkipPermissions: (v: boolean) => void;
  onNewTopicInProject?: (projectPath: string) => void;
  onAddProjectPane?: (projectPath: string, type: PaneType, subType?: string) => void;
  onOpenProjectBoard?: (projectPath: string) => void;
  onArchiveProject?: (projectPath: string, archive: boolean) => Promise<boolean>;
}

function TouchProjectMenu({ pp, allArchived, claudeSkipPermissions, setClaudeSkipPermissions, onNewTopicInProject, onAddProjectPane, onOpenProjectBoard, onArchiveProject }: TouchProjectMenuProps) {
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        ref={overflowBtnRef}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
        title="More options"
      >
        <MoreHorizontal size={12} />
      </button>
      <DropdownPortal open={open} anchorRef={overflowBtnRef} onClose={() => setOpen(false)}>
        {onNewTopicInProject && (
          <button onClick={() => { onNewTopicInProject(pp); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <MessageSquare size={14} className="flex-shrink-0" /><span>New Chat</span>
          </button>
        )}
        {onAddProjectPane && (
          <button onClick={() => { onAddProjectPane(pp, 'terminal'); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <TerminalSquare size={14} className="flex-shrink-0" /><span>Shell</span>
          </button>
        )}
        {onAddProjectPane && (
          <button onClick={() => { onAddProjectPane(pp, 'terminal', 'claude-code'); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <ClaudeIcon size={14} className="text-[#D97757] flex-shrink-0" /><span className="flex-1 text-left">Claude Code</span>
            <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
              <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
              <span>yolo</span>
            </label>
          </button>
        )}
        {onAddProjectPane && (
          <button onClick={() => { onAddProjectPane(pp, 'browser'); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <Globe size={14} className="flex-shrink-0" /><span>Browser</span>
          </button>
        )}
        {onAddProjectPane && (
          <button onClick={() => { onAddProjectPane(pp, 'git'); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <GitBranch size={14} className="flex-shrink-0" /><span>Git</span>
          </button>
        )}
        {(onOpenProjectBoard || onArchiveProject) && (onNewTopicInProject || onAddProjectPane) && <div className="h-px bg-app-border mx-2 my-1" />}
        {onOpenProjectBoard && (
          <button onClick={(e) => { e.stopPropagation(); onOpenProjectBoard(pp); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <LayoutGrid size={14} className="flex-shrink-0 text-emerald-500" /><span>Open Board</span>
          </button>
        )}
        {onArchiveProject && (
          <button onClick={(e) => { e.stopPropagation(); onArchiveProject(pp, !allArchived); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            {allArchived ? <ArchiveRestore size={14} className="flex-shrink-0" /> : <Archive size={14} className="flex-shrink-0" />}
            <span>{allArchived ? 'Restore Project' : 'Archive Project'}</span>
          </button>
        )}
      </DropdownPortal>
    </div>
  );
}
