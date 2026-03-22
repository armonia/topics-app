import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, Plus, MessageSquare, TerminalSquare, Globe, GitBranch, LayoutGrid, FolderOpen, MoreHorizontal, X } from 'lucide-react';
import { TopicItem } from './TopicItem';
import { topicsApi } from '@/lib/api';
import { createPaneId } from '@/lib/paneConfig';
import type { Topic, UnreadData, PaneType, TerminalSessionInfo } from '@/types';
import { useProjectTabStatus } from '@/hooks/useProjectTabStatus';
import { ClaudeIcon } from '@/components/Shared/ClaudeIcon';
import { useClaudeSkipPermissions } from '@/hooks/useClaudePrefs';
import { DropdownPortal } from '@/components/Shared/DropdownPortal';
import { useMobile } from '@/hooks/useMobile';

function getProjectLabel(projectPath: string | undefined): { name: string; isTemp: boolean } {
  if (!projectPath) return { name: 'Unlinked', isTemp: false };
  const dirName = projectPath.split('/').pop() || '';
  if (!dirName) return { name: 'Unlinked', isTemp: false };
  const isTemp = projectPath.startsWith('/tmp/') || projectPath.startsWith('/private/tmp/');
  return { name: isTemp ? `${dirName} (temp)` : dirName, isTemp };
}

interface TopicTreeProps {
  topics: Record<string, Topic>;
  workspaceProjects?: string[];
  searchQuery: string;
  expandedNodes: Set<string>;
  onToggleNode: (topicId: string) => void;
  focusedTopicId: string | null;
  projectActiveTopics?: Record<string, string | null>;
  previewPanelId: string | null;
  openPanels: string[];
  onTopicClick: (topicId: string, e?: React.MouseEvent) => void;
  onTopicDoubleClick: (topicId: string, e?: React.MouseEvent) => void;
  onTopicContextMenu: (e: React.MouseEvent, topic: Topic) => void;
  getChildren: (parentId: string | null) => Topic[];
  getArchivedTopics: () => Topic[];
  unreadData: UnreadData;
  onArchiveTopic: (topicId: string, archive: boolean) => Promise<boolean>;
  onArchiveProject?: (projectPath: string, archive: boolean) => Promise<boolean>;
  onNewTopicInProject?: (projectPath: string) => void;
  onAddProjectPane?: (projectPath: string, type: PaneType) => void;
  onProjectClick?: (projectPath: string) => void;
  isSessionStreaming?: (sessionKey: string) => boolean;
  stopSession?: (sessionKey: string) => boolean;
  boardTaskCounts?: Record<string, number>;
  onOpenProjectBoard?: (projectPath: string) => void;
  onNewChat?: () => void;
  onNewBrowser?: () => void;
  terminalSessions?: TerminalSessionInfo[];
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onNewTerminal?: (type: 'shell' | 'claude-code', skipPermissions?: boolean) => void;
  onCloseTerminal?: (sessionId: string) => void;
  showProjects: boolean;
  setShowProjects: (v: boolean) => void;
  showChats: boolean;
  setShowChats: (v: boolean) => void;
  showTerminals: boolean;
  setShowTerminals: (v: boolean) => void;
  showProjectsArchived: boolean;
  setShowProjectsArchived: (v: boolean) => void;
  showChatsArchived: boolean;
  setShowChatsArchived: (v: boolean) => void;
}

export function TopicTree({
  topics,
  workspaceProjects = [],
  searchQuery,
  expandedNodes,
  onToggleNode,
  focusedTopicId,
  projectActiveTopics,
  previewPanelId,
  openPanels,
  onTopicClick,
  onTopicDoubleClick,
  onTopicContextMenu,
  getChildren,
  getArchivedTopics,
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
  onNewChat,
  onNewBrowser: _onNewBrowser,
  terminalSessions = [],
  onTerminalClick,
  onNewTerminal,
  onCloseTerminal,
  showProjects,
  setShowProjects,
  showChats,
  setShowChats,
  showTerminals,
  setShowTerminals,
  showProjectsArchived,
  setShowProjectsArchived,
  showChatsArchived,
  setShowChatsArchived,
}: TopicTreeProps) {
  const terminalAddRef = useRef<HTMLButtonElement>(null);
  const [terminalAddOpen, setTerminalAddOpen] = useState(false);
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [expandedProjectChats, setExpandedProjectChats] = useState<Set<string>>(new Set());
  const [openSectionMenu, setOpenSectionMenu] = useState<'projects' | 'chats' | null>(null);
  const projectsOverflowRef = useRef<HTMLButtonElement>(null);
  const chatsOverflowRef = useRef<HTMLButtonElement>(null);
  const [projectOverflowMenu, setProjectOverflowMenu] = useState<string | null>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [projectAddMenu, setProjectAddMenu] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; projectPath: string; projectName: string; allArchived: boolean } | null>(null);


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
  const { isTouch } = useMobile();

  // Close project context menu on outside click
  useEffect(() => {
    if (!projectContextMenu) return;
    const h = () => setProjectContextMenu(null);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [projectContextMenu]);



  // ── Projects section height (fixed pixel height, Chats fills remaining space) ──
  const PROJECTS_HEIGHT_KEY = 'topics-sidebar-projects-height';
  const [projectsSectionHeight, setProjectsSectionHeight] = useState(() => {
    try {
      const saved = localStorage.getItem(PROJECTS_HEIGHT_KEY);
      return saved ? Math.max(80, parseInt(saved, 10)) : 250;
    } catch { return 250; }
  });
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const projectsDrag = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(PROJECTS_HEIGHT_KEY, String(projectsSectionHeight)); } catch {}
  }, [projectsSectionHeight]);

  const handleProjectsDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    projectsDrag.current = { startY: e.clientY, startHeight: projectsSectionHeight };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [projectsSectionHeight]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!projectsDrag.current || !treeContainerRef.current) return;
      const maxH = treeContainerRef.current.clientHeight * 0.85;
      const delta = e.clientY - projectsDrag.current.startY;
      setProjectsSectionHeight(Math.max(80, Math.min(maxH, projectsDrag.current.startHeight + delta)));
    };
    const onUp = () => {
      if (!projectsDrag.current) return;
      projectsDrag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const [draggedId, setDraggedId] = useState<string | null>(null);

  const handleSidebarDragStart = useCallback((topicId: string) => {
    setDraggedId(topicId);
  }, []);

  const handleSidebarDragOver = useCallback((topicId: string) => {
    if (draggedId && draggedId !== topicId) {
      setDragOverId(topicId);
    }
  }, [draggedId]);

  const handleSidebarDrop = useCallback((targetId: string) => {
    if (!draggedId || draggedId === targetId) {
      setDragOverId(null);
      setDraggedId(null);
      return;
    }

    // Get sorted list of chat topics (non-project, non-archived) — same order as rendered
    const chatTopics = Object.values(topics)
      .filter(t => !t.projectPath && !t.archived)
      .sort((a, b) => {
        const so = (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity);
        if (so !== 0) return so;
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      });

    const fromIdx = chatTopics.findIndex(t => t.id === draggedId);
    const toIdx = chatTopics.findIndex(t => t.id === targetId);

    if (fromIdx >= 0 && toIdx >= 0) {
      const reordered = [...chatTopics];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      const order = reordered.map(t => t.id);
      topicsApi.reorder(order).catch(console.error);
    }

    setDragOverId(null);
    setDraggedId(null);
  }, [draggedId, topics]);

  const handleSidebarDragEnd = useCallback(() => {
    setDragOverId(null);
    setDraggedId(null);
  }, []);

  const toggleProject = (projectName: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectName)) {
        next.delete(projectName);
      } else {
        next.add(projectName);
      }
      return next;
    });
  };

  const handleArchive = async (topicId: string, archive: boolean) => {
    await onArchiveTopic(topicId, archive);
  };

  const renderLevel = (parentId: string | null, depth = 0, includeArchived = false, hideIcon = false): React.ReactNode[] => {
    const children = getChildren(parentId).sort((a, b) => {
      // Root-level chats: always sort by recency (ignore manual sortOrder)
      if (parentId === null) {
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      }
      const so = (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity);
      if (so !== 0) return so;
      // No manual order — newest first
      return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
    });
    const result: React.ReactNode[] = [];

    for (const topic of children) {
      // Skip project topics in regular chat list (they appear in Projects section)
      if (topic.projectPath) continue;
      
      // Skip archived unless includeArchived is true
      if (topic.archived && !includeArchived) continue;
      
      if (searchQuery && !matchesSearchWithDescendants(topic)) continue;

      const subChildren = getChildren(topic.id);
      const hasChildren = subChildren.length > 0;
      const isExpanded = expandedNodes.has(topic.id);
      const isOpen = openPanels.includes(topic.id);
      const isFocused = focusedTopicId === topic.id;
      const unread = unreadData[topic.id]?.unreadCount || 0;

      result.push(
        <TopicItem
          key={topic.id}
          topic={topic}
          depth={depth}
          hasChildren={hasChildren}
          isExpanded={isExpanded}
          isOpen={isOpen}
          isFocused={isFocused}
          isPreview={previewPanelId === topic.id}
          isStreaming={isSessionStreaming ? isSessionStreaming(topic.sessionKey) : false}
          unreadCount={unread}
          assignedAgentCount={topic.assignedAgents?.length || 0}
          onToggle={() => onToggleNode(topic.id)}
          onClick={(e) => onTopicClick(topic.id, e)}
          onDoubleClick={(e) => onTopicDoubleClick(topic.id, e)}
          onContextMenu={(e) => onTopicContextMenu(e, topic)}
          onArchive={handleArchive}
          onStopStreaming={stopSession ? () => {
            const isFirst = stopSession(topic.sessionKey);
            if (isFirst) onArchiveTopic(topic.id, true);
          } : undefined}
          isArchived={topic.archived}
          hideIcon={hideIcon}
          isDragOver={dragOverId === topic.id}
          onSidebarDragStart={() => handleSidebarDragStart(topic.id)}
          onSidebarDragOver={() => handleSidebarDragOver(topic.id)}
          onSidebarDrop={() => handleSidebarDrop(topic.id)}
          onSidebarDragEnd={handleSidebarDragEnd}
        />
      );

      if (hasChildren && isExpanded) {
        result.push(...renderLevel(topic.id, depth + 1, includeArchived, hideIcon));
      }
    }

    return result;
  };

  const matchesSearch = (topic: Topic): boolean => {
    if (!searchQuery) return true;
    return topic.name.toLowerCase().includes(searchQuery.toLowerCase());
  };

  const matchesSearchWithDescendants = (topic: Topic): boolean => {
    if (matchesSearch(topic)) return true;
    const children = getChildren(topic.id);
    return children.some(child => matchesSearchWithDescendants(child));
  };

  const archivedTopics = getArchivedTopics();
  // Get all topics with projectPath
  const allProjectTopics = Object.values(topics).filter(t => t.projectPath);

  // Group all project topics by project path
  const projectGroups = allProjectTopics.reduce((acc, topic) => {
    const { name: projectName, isTemp } = getProjectLabel(topic.projectPath);
    if (!acc[projectName]) {
      acc[projectName] = { path: topic.projectPath!, activeTopics: [], archivedTopics: [], isTemp };
    }
    if (topic.archived) {
      acc[projectName].archivedTopics.push(topic);
    } else {
      acc[projectName].activeTopics.push(topic);
    }
    return acc;
  }, {} as Record<string, { path: string; activeTopics: Topic[]; archivedTopics: Topic[]; isTemp: boolean }>);

  // Merge workspace projects that have no topics yet
  const existingPaths = new Set(Object.values(projectGroups).map(g => g.path));
  for (const wsPath of workspaceProjects) {
    if (existingPaths.has(wsPath)) continue;
    const { name: projectName, isTemp } = getProjectLabel(wsPath);
    if (!projectGroups[projectName]) {
      projectGroups[projectName] = { path: wsPath, activeTopics: [], archivedTopics: [], isTemp };
    }
  }

  // Sort project groups: regular projects first, temp projects last
  const sortedProjectEntries = Object.entries(projectGroups).sort(([, a], [, b]) => {
    if (a.isTemp !== b.isTemp) return a.isTemp ? 1 : -1;
    return 0;
  });

  // Non-project archived topics
  const archivedOutsideProjects = archivedTopics.filter(t => !t.projectPath);

  // Count archived for display
  const totalProjectArchived = Object.values(projectGroups).reduce((sum, g) => sum + g.archivedTopics.length, 0);

  // Count actively streaming sessions across all topics
  const activeStreamingCount = isSessionStreaming
    ? Object.values(topics).filter(t => isSessionStreaming(t.sessionKey)).length
    : 0;

  const hasProjects = Object.keys(projectGroups).length > 0;
  // Chats section is anchored at bottom with fixed pixel height (like Browser/Git/Processes)

  // ── Shared project header row — used in both Projects section and pinned section ──
  const renderProjectHeader = (opts: {
    projectName: string; path: string; allChats: Topic[]; allArchived: boolean; isTemp: boolean;
    isExpanded: boolean; isProjectFocused: boolean; isProjectOpen: boolean; groupUnread: number;
  }) => {
    const { projectName, path, allChats, allArchived, isTemp, isExpanded, isProjectFocused, isProjectOpen, groupUnread } = opts;
    return (
      <div
        className={`group/proj flex items-center h-8 transition-colors relative select-none ${
          isProjectFocused ? 'bg-primary/8 dark:bg-primary/15' : isProjectOpen ? 'bg-app-hover' : 'hover:bg-app-hover'
        }`}
        onContextMenu={(e) => {
          if (!onArchiveProject) return;
          e.preventDefault();
          setProjectContextMenu({ x: e.clientX, y: e.clientY, projectPath: path, projectName, allArchived });
        }}
      >
        {isProjectFocused && <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full bg-primary" />}
        <button
          onClick={() => {
            const wasExpanded = expandedProjects.has(projectName);
            toggleProject(projectName);
            if (!wasExpanded && onProjectClick) onProjectClick(path);
          }}
          className={`flex items-center gap-2 h-full flex-1 min-w-0 text-left text-[13px] font-medium transition-colors ${
            isProjectFocused ? 'text-primary dark:text-primary-dark' : allArchived ? 'text-app-text-muted' : 'text-app-text-secondary hover:text-app-text'
          }`}
          style={{ paddingLeft: 28 }}
          title={path}
        >
          <ChevronRight size={12} className={`transition-transform duration-150 flex-shrink-0 ${isTemp ? 'text-amber-500' : 'text-app-text-secondary'} ${isExpanded ? 'rotate-90' : ''}`} />
          <span className="truncate flex-1">{projectName}</span>
        </button>
        <div className="flex items-center pr-1 flex-shrink-0">
          {(() => {
            const ps = projectTabStatus[path];
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
          {groupUnread > 0 ? (
            <span className={`text-[10px] text-white bg-primary px-1.5 rounded-full min-w-[18px] text-center ${isTouch ? '' : 'group-hover/proj:hidden'}`}>{groupUnread}</span>
          ) : (
            <span className={`text-[10px] text-app-placeholder ${isTouch ? '' : 'group-hover/proj:hidden'}`}>{allChats.length}</span>
          )}
          {isTouch && (onNewTopicInProject || onAddProjectPane || onOpenProjectBoard || onArchiveProject) && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); overflowBtnRef.current = e.currentTarget; setProjectOverflowMenu(projectOverflowMenu === path ? null : path); }}
                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
                title="More options"
              >
                <MoreHorizontal size={12} />
              </button>
              <DropdownPortal open={projectOverflowMenu === path} anchorRef={overflowBtnRef} onClose={() => setProjectOverflowMenu(null)}>
                {onNewTopicInProject && (
                  <button onClick={() => { onNewTopicInProject(path); setProjectOverflowMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                    <MessageSquare size={14} className="flex-shrink-0" /><span>New Chat</span>
                  </button>
                )}
                {onAddProjectPane && (
                  <button onClick={() => { onAddProjectPane(path, 'terminal'); setProjectOverflowMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                    <TerminalSquare size={14} className="flex-shrink-0" /><span>Shell</span>
                  </button>
                )}
                {onAddProjectPane && (
                  <button onClick={() => { onAddProjectPane(path, 'terminal'); setProjectOverflowMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                    <ClaudeIcon size={14} className="text-[#D97757] flex-shrink-0" /><span className="flex-1 text-left">Claude Code</span>
                    <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
                      <span>yolo</span>
                    </label>
                  </button>
                )}
                {onAddProjectPane && (
                  <button onClick={() => { onAddProjectPane(path, 'browser'); setProjectOverflowMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                    <Globe size={14} className="flex-shrink-0" /><span>Browser</span>
                  </button>
                )}
                {onAddProjectPane && (
                  <button onClick={() => { onAddProjectPane(path, 'git'); setProjectOverflowMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                    <GitBranch size={14} className="flex-shrink-0" /><span>Git</span>
                  </button>
                )}
                {(onOpenProjectBoard || onArchiveProject) && (onNewTopicInProject || onAddProjectPane) && <div className="h-px bg-app-border mx-2 my-1" />}
                {onOpenProjectBoard && (
                  <button onClick={(e) => { e.stopPropagation(); onOpenProjectBoard(path); setProjectOverflowMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                    <LayoutGrid size={14} className="flex-shrink-0 text-emerald-500" /><span>Open Board</span>
                  </button>
                )}
                {onArchiveProject && (
                  <button onClick={(e) => { e.stopPropagation(); onArchiveProject(path, !allArchived); setProjectOverflowMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                    {allArchived ? <ArchiveRestore size={14} className="flex-shrink-0" /> : <Archive size={14} className="flex-shrink-0" />}
                    <span>{allArchived ? 'Restore Project' : 'Archive Project'}</span>
                  </button>
                )}
              </DropdownPortal>
            </div>
          )}
          {!isTouch && (
            <>
              {onOpenProjectBoard && (
                <button onClick={(e) => { e.stopPropagation(); onOpenProjectBoard(path); }} className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-emerald-500 hover:text-emerald-400 transition-colors" title="Open Board">
                  <LayoutGrid size={12} />
                </button>
              )}
              {onArchiveProject && (
                <button onClick={(e) => { e.stopPropagation(); onArchiveProject(path, !allArchived); }} className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors" title={allArchived ? 'Restore Project' : 'Archive Project'}>
                  {allArchived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                </button>
              )}
              {(onNewTopicInProject || onAddProjectPane) && (
                <div className="relative hidden group-hover/proj:block">
                  <button
                    onClick={(e) => { e.stopPropagation(); addBtnRef.current = e.currentTarget; setProjectAddMenu(projectAddMenu === path ? null : path); }}
                    className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
                    title="Add to project"
                  >
                    <Plus size={12} />
                  </button>
                  <DropdownPortal open={projectAddMenu === path} anchorRef={addBtnRef} onClose={() => setProjectAddMenu(null)}>
                    {onNewTopicInProject && (
                      <button onClick={() => { onNewTopicInProject(path); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                        <MessageSquare size={14} /><span>New Chat</span>
                      </button>
                    )}
                    {onAddProjectPane && (
                      <button onClick={() => { onAddProjectPane(path, 'terminal'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                        <TerminalSquare size={14} /><span>Shell</span>
                      </button>
                    )}
                    {onAddProjectPane && (
                      <button onClick={() => { onAddProjectPane(path, 'terminal'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                        <ClaudeIcon size={14} className="text-[#D97757]" /><span className="flex-1 text-left">Claude Code</span>
                        <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
                          <span>yolo</span>
                        </label>
                      </button>
                    )}
                    {onAddProjectPane && (
                      <button onClick={() => { onAddProjectPane(path, 'browser'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                        <Globe size={14} /><span>Browser</span>
                      </button>
                    )}
                    {onAddProjectPane && (
                      <button onClick={() => { onAddProjectPane(path, 'git'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                        <GitBranch size={14} /><span>Git</span>
                      </button>
                    )}
                  </DropdownPortal>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div ref={treeContainerRef} role="tree" aria-label="Topics" className="flex flex-col h-full min-h-0">
      {/* Board — always visible above Projects */}
      {!searchQuery && onOpenProjectBoard && (
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
      )}

      {/* Projects section — fixed pixel height when both open, flex-1 when only section */}
      {hasProjects && !searchQuery && (
        <div
          className={`flex flex-col ${showProjects ? 'min-h-0' : ''} ${showProjects && showChats ? 'flex-shrink-0' : showProjects ? 'flex-1 min-h-0' : 'flex-shrink-0'}`}
          style={showProjects && showChats ? { height: projectsSectionHeight } : undefined}
        >
          {/* Projects section header */}
          <div className="flex-shrink-0 group flex items-center h-8 hover:bg-app-hover transition-colors">
            <button
              onClick={() => setShowProjects(!showProjects)}
              aria-expanded={showProjects}
              aria-label="Projects section"
              className="flex items-center gap-2 flex-1 h-full text-left"
              style={{ paddingLeft: 12 }}
            >
              <FolderOpen size={14} className="text-app-text-secondary flex-shrink-0" />
              <span className="text-[13px] text-app-text">Projects</span>
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={`transition-transform duration-150 text-app-text-tertiary ${showProjects ? 'rotate-90' : ''}`}
              />
            </button>
            <div className="flex items-center gap-1 pr-1">
              {totalProjectArchived > 0 && (
                <div className="relative">
                  <button
                    ref={projectsOverflowRef}
                    onClick={() => setOpenSectionMenu(openSectionMenu === 'projects' ? null : 'projects')}
                    className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 ${
                      showProjectsArchived
                        ? 'opacity-100 text-primary'
                        : `${isTouch ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'} text-app-text-tertiary hover:text-app-text`
                    }`}
                    title="More options"
                    aria-label="More options"
                  >
                    <MoreHorizontal size={12} />
                  </button>
                  <DropdownPortal open={openSectionMenu === 'projects'} anchorRef={projectsOverflowRef} onClose={() => setOpenSectionMenu(null)}>
                    <button
                      onClick={() => { setShowProjectsArchived(!showProjectsArchived); setOpenSectionMenu(null); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    >
                      <Archive size={14} className="flex-shrink-0" />
                      <span>{showProjectsArchived ? `Hide ${totalProjectArchived} archived` : `Show ${totalProjectArchived} archived`}</span>
                    </button>
                  </DropdownPortal>
                </div>
              )}
              {onNewTopicInProject && sortedProjectEntries.length > 0 && (
                <button
                  onClick={() => onNewTopicInProject(sortedProjectEntries[0][1].path)}
                  className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded ${isTouch ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'} hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-all`}
                  title="New chat in project"
                  aria-label="New chat in project"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          </div>

          {showProjects && (
            <div className="flex-1 min-h-0 overflow-y-auto sidebar-scroll">
              {sortedProjectEntries.map(([projectName, { path, activeTopics, archivedTopics: projectArchived, isTemp }]) => {
                const isExpanded = expandedProjects.has(projectName);
                const allArchived = activeTopics.length === 0 && projectArchived.length > 0;

                // Hide fully-archived projects unless "show archived" is on (but always show projects with no topics)
                if (allArchived && !showProjectsArchived) return null;
                // Combine active and archived (if showing) — newest first
                const sortByRecent = (a: Topic, b: Topic) =>
                  (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
                const allChats = showProjectsArchived
                  ? [...activeTopics, ...projectArchived].sort(sortByRecent)
                  : [...activeTopics].sort(sortByRecent);

                // Sum unread counts for all topics in this project group
                const groupUnread = allChats.reduce((sum, t) => sum + (unreadData[t.id]?.unreadCount || 0), 0);
                const projectPaneId = createPaneId('project', path);
                const isProjectFocused = focusedTopicId === projectPaneId;
                const isProjectOpen = openPanels.includes(projectPaneId);
                return (
                  <div key={projectName}>
                    {/* Project folder item */}
                    {renderProjectHeader({ projectName, path, allChats, allArchived, isTemp, isExpanded, isProjectFocused, isProjectOpen, groupUnread })}
                    {/* Chats under this project - all inline */}
                    {isExpanded && (
                      <div>
                        {(() => {
                          const PROJECT_CHAT_LIMIT = 100;
                          const showAll = expandedProjectChats.has(projectName);
                          const visible = showAll ? allChats : allChats.slice(0, PROJECT_CHAT_LIMIT);
                          const remaining = allChats.length - PROJECT_CHAT_LIMIT;
                          return (
                            <>
                              {visible.map(topic => (
                                <TopicItem
                                  key={`project-${topic.id}`}
                                  topic={topic}
                                  depth={2}
                                  hasChildren={false}
                                  isExpanded={false}
                                  isOpen={isProjectOpen && projectActiveTopics?.[path] === topic.id}
                                  isFocused={isProjectFocused && projectActiveTopics?.[path] === topic.id}
                                  isPreview={previewPanelId === topic.id}
                                  isStreaming={isSessionStreaming ? isSessionStreaming(topic.sessionKey) : false}
                                  unreadCount={unreadData[topic.id]?.unreadCount || 0}
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
                                  isArchived={topic.archived}
                                  hideIcon
                                />
                              ))}
                              {!showAll && remaining > 0 && (
                                <button
                                  onClick={() => setExpandedProjectChats(prev => { const next = new Set(prev); next.add(projectName); return next; })}
                                  className="w-full py-1 text-[11px] text-primary hover:bg-primary/5 transition-colors text-center"
                                  style={{ paddingLeft: 44 }}
                                >
                                  Show {remaining} more chats...
                                </button>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                    {/* Pinned active topic when project is collapsed */}
                    {!isExpanded && (() => {
                      const activeTopicId = projectActiveTopics?.[path];
                      if (!activeTopicId || (!isProjectOpen && !isProjectFocused)) return null;
                      const activeTopic = allChats.find(t => t.id === activeTopicId);
                      if (!activeTopic) return null;
                      return (
                        <TopicItem
                          key={`pinned-active-${activeTopic.id}`}
                          topic={activeTopic}
                          depth={2}
                          hasChildren={false}
                          isExpanded={false}
                          isOpen={isProjectOpen && projectActiveTopics?.[path] === activeTopic.id}
                          isFocused={isProjectFocused && projectActiveTopics?.[path] === activeTopic.id}
                          isPreview={previewPanelId === activeTopic.id}
                          isStreaming={isSessionStreaming ? isSessionStreaming(activeTopic.sessionKey) : false}
                          unreadCount={unreadData[activeTopic.id]?.unreadCount || 0}
                          assignedAgentCount={activeTopic.assignedAgents?.length || 0}
                          onToggle={() => {}}
                          onClick={(e) => onTopicClick(activeTopic.id, e)}
                          onDoubleClick={(e) => onTopicDoubleClick(activeTopic.id, e)}
                          onContextMenu={(e) => onTopicContextMenu(e, activeTopic)}
                          onArchive={handleArchive}
                          onStopStreaming={stopSession ? () => {
                            const isFirst = stopSession(activeTopic.sessionKey);
                            if (isFirst) onArchiveTopic(activeTopic.id, true);
                          } : undefined}
                          isArchived={activeTopic.archived}
                          hideIcon
                        />
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          )}
          {/* Pinned: open/focused projects when section is collapsed — full accordion */}
          {!showProjects && (() => {
            const pinnedEntries = sortedProjectEntries.filter(([, { path }]) => {
              const paneId = createPaneId('project', path);
              return openPanels.includes(paneId) || focusedTopicId === paneId;
            });
            if (!pinnedEntries.length) return null;
            return (
              <div className="flex-shrink-0">
                {pinnedEntries.map(([projectName, { path, activeTopics, archivedTopics: projectArchived, isTemp }]) => {
                  const isExpanded = expandedProjects.has(projectName);
                  const sortByRecent = (a: Topic, b: Topic) =>
                    (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
                  const allChats = showProjectsArchived
                    ? [...activeTopics, ...projectArchived].sort(sortByRecent)
                    : [...activeTopics].sort(sortByRecent);
                  const allArchived = activeTopics.length === 0 && projectArchived.length > 0;
                  const groupUnread = allChats.reduce((sum, t) => sum + (unreadData[t.id]?.unreadCount || 0), 0);
                  const projectPaneId = createPaneId('project', path);
                  const isProjectFocused = focusedTopicId === projectPaneId;
                  const isProjectOpen = openPanels.includes(projectPaneId);
                  return (
                    <div key={projectName}>
                      {renderProjectHeader({ projectName, path, allChats, allArchived, isTemp, isExpanded, isProjectFocused, isProjectOpen, groupUnread })}
                      {isExpanded && (
                        <div>
                          {allChats.map(topic => (
                            <TopicItem
                              key={`pinned-project-${topic.id}`}
                              topic={topic}
                              depth={2}
                              hasChildren={false}
                              isExpanded={false}
                              isOpen={isProjectOpen && projectActiveTopics?.[path] === topic.id}
                              isFocused={isProjectFocused && projectActiveTopics?.[path] === topic.id}
                              isPreview={previewPanelId === topic.id}
                              isStreaming={isSessionStreaming ? isSessionStreaming(topic.sessionKey) : false}
                              unreadCount={unreadData[topic.id]?.unreadCount || 0}
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
                              isArchived={topic.archived}
                              hideIcon
                            />
                          ))}
                        </div>
                      )}
                      {/* Pinned active topic when project is collapsed */}
                      {!isExpanded && (() => {
                        const activeTopicId = projectActiveTopics?.[path];
                        if (!activeTopicId || (!isProjectOpen && !isProjectFocused)) return null;
                        const activeTopic = allChats.find(t => t.id === activeTopicId);
                        if (!activeTopic) return null;
                        return (
                          <TopicItem
                            key={`pinned-section-active-${activeTopic.id}`}
                            topic={activeTopic}
                            depth={2}
                            hasChildren={false}
                            isExpanded={false}
                            isOpen={isProjectOpen && projectActiveTopics?.[path] === activeTopic.id}
                            isFocused={isProjectFocused && projectActiveTopics?.[path] === activeTopic.id}
                            isPreview={previewPanelId === activeTopic.id}
                            isStreaming={isSessionStreaming ? isSessionStreaming(activeTopic.sessionKey) : false}
                            unreadCount={unreadData[activeTopic.id]?.unreadCount || 0}
                            assignedAgentCount={activeTopic.assignedAgents?.length || 0}
                            onToggle={() => {}}
                            onClick={(e) => onTopicClick(activeTopic.id, e)}
                            onDoubleClick={(e) => onTopicDoubleClick(activeTopic.id, e)}
                            onContextMenu={(e) => onTopicContextMenu(e, activeTopic)}
                            onArchive={handleArchive}
                            onStopStreaming={stopSession ? () => {
                              const isFirst = stopSession(activeTopic.sessionKey);
                              if (isFirst) onArchiveTopic(activeTopic.id, true);
                            } : undefined}
                            isArchived={activeTopic.archived}
                            hideIcon
                          />
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* Resize handle: Projects ↔ Chats */}
      {hasProjects && !searchQuery && (
        <div
          className={`h-[1px] flex-shrink-0 relative bg-app-border transition-colors z-10 ${showProjects && showChats ? 'cursor-row-resize hover:bg-primary' : ''}`}
          onMouseDown={showProjects && showChats ? handleProjectsDragStart : undefined}
        >
          {showProjects && showChats && <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />}
        </div>
      )}

      {/* Chats section — flex-1 fills remaining space below Projects */}
      {!searchQuery && (
        <div className={`flex flex-col ${showChats ? 'flex-1 min-h-0' : 'flex-shrink-0'}`}>

          {/* Chats section header */}
          <div className="flex-shrink-0 group flex items-center h-8 hover:bg-app-hover transition-colors">
            <button
              onClick={() => setShowChats(!showChats)}
              aria-expanded={showChats}
              aria-label="Chats section"
              className="flex items-center gap-2 flex-1 h-full text-left"
              style={{ paddingLeft: 12 }}
            >
              <MessageSquare size={14} className="text-app-text-secondary flex-shrink-0" />
              <span className="text-[13px] text-app-text">Chats</span>
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={`transition-transform duration-150 text-app-text-tertiary ${showChats ? 'rotate-90' : ''}`}
              />
            </button>
            <div className="flex items-center gap-1 pr-1">
              {archivedOutsideProjects.length > 0 && (
                <div className="relative">
                  <button
                    ref={chatsOverflowRef}
                    onClick={() => setOpenSectionMenu(openSectionMenu === 'chats' ? null : 'chats')}
                    className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 ${
                      showChatsArchived
                        ? 'opacity-100 text-primary'
                        : `${isTouch ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'} text-app-text-tertiary hover:text-app-text`
                    }`}
                    title="More options"
                    aria-label="More options"
                  >
                    <MoreHorizontal size={12} />
                  </button>
                  <DropdownPortal open={openSectionMenu === 'chats'} anchorRef={chatsOverflowRef} onClose={() => setOpenSectionMenu(null)}>
                    <button
                      onClick={() => { setShowChatsArchived(!showChatsArchived); setOpenSectionMenu(null); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    >
                      <Archive size={14} className="flex-shrink-0" />
                      <span>{showChatsArchived ? `Hide ${archivedOutsideProjects.length} archived` : `Show ${archivedOutsideProjects.length} archived`}</span>
                    </button>
                  </DropdownPortal>
                </div>
              )}
              {onNewChat && (
                <button
                  onClick={onNewChat}
                  className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded ${isTouch ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'} hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-all`}
                  title="New chat"
                  aria-label="New chat"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Chats list — scrollable */}
          {showChats && (
            <div className="flex-1 min-h-0 overflow-y-auto sidebar-scroll">
              {renderLevel(null, 1, showChatsArchived, true)}
            </div>
          )}
          {/* Pinned: open/focused chats when section is collapsed */}
          {!showChats && (() => {
            const pinned = Object.values(topics).filter(t =>
              !t.projectPath && (openPanels.includes(t.id) || focusedTopicId === t.id)
            );
            if (!pinned.length) return null;
            return (
              <div className="flex-shrink-0">
                {pinned.map(t => (
                  <TopicItem
                    key={t.id}
                    topic={t}
                    depth={1}
                    hasChildren={false}
                    isExpanded={false}
                    isOpen={openPanels.includes(t.id)}
                    isFocused={focusedTopicId === t.id}
                    isPreview={previewPanelId === t.id}
                    isStreaming={isSessionStreaming ? isSessionStreaming(t.sessionKey) : false}
                    unreadCount={unreadData[t.id]?.unreadCount || 0}
                    assignedAgentCount={t.assignedAgents?.length || 0}
                    onToggle={() => {}}
                    onClick={(e) => onTopicClick(t.id, e)}
                    onDoubleClick={(e) => onTopicDoubleClick(t.id, e)}
                    onContextMenu={(e) => onTopicContextMenu(e, t)}
                    onArchive={handleArchive}
                    isArchived={t.archived}
                    hideIcon
                  />
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Terminals section — collapsible, between Chats and Browser */}
      {!searchQuery && (
        <div className="flex-shrink-0 border-t border-app-border">
          <div className="flex-shrink-0 group flex items-center h-8 hover:bg-app-hover transition-colors">
            <button
              onClick={() => setShowTerminals(!showTerminals)}
              aria-expanded={showTerminals}
              aria-label="Terminals section"
              className="flex items-center gap-2 flex-1 h-full text-left"
              style={{ paddingLeft: 12 }}
            >
              <TerminalSquare size={14} className="text-app-text-secondary flex-shrink-0" />
              <span className="text-[13px] text-app-text">Terminals</span>
              <span className="text-[11px] text-app-text-tertiary">{terminalSessions.length}</span>
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={`transition-transform duration-150 text-app-text-tertiary ${showTerminals ? 'rotate-90' : ''}`}
              />
            </button>
            <div className="flex items-center gap-1 pr-1">
              {onNewTerminal && (
                <>
                  <button
                    ref={terminalAddRef}
                    onClick={() => setTerminalAddOpen(!terminalAddOpen)}
                    className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded ${isTouch ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'} hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-all`}
                    title="New terminal"
                    aria-label="New terminal"
                  >
                    <Plus size={12} />
                  </button>
                  <DropdownPortal open={terminalAddOpen} anchorRef={terminalAddRef} onClose={() => setTerminalAddOpen(false)}>
                    <button
                      onClick={() => { onNewTerminal('shell'); setTerminalAddOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    >
                      <TerminalSquare size={14} className="flex-shrink-0" />
                      <span>Shell</span>
                    </button>
                    <button
                      onClick={() => { onNewTerminal('claude-code', claudeSkipPermissions); setTerminalAddOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
                    >
                      <ClaudeIcon size={14} className="text-[#D97757] flex-shrink-0" />
                      <span className="flex-1 text-left">Claude Code</span>
                      <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
                        <span>yolo</span>
                      </label>
                    </button>
                  </DropdownPortal>
                </>
              )}
            </div>
          </div>
          {showTerminals && (
            <div className="overflow-y-auto sidebar-scroll" style={{ maxHeight: 200 }}>
              {terminalSessions.map(s => {
                const paneId = `terminal:${s.id}`;
                const isActive = focusedTopicId === paneId || openPanels.includes(paneId);
                return (
                  <TerminalSidebarItem
                    key={s.id}
                    session={s}
                    isActive={isActive}
                    isTouch={isTouch}
                    onTerminalClick={onTerminalClick}
                    onCloseTerminal={onCloseTerminal}
                  />
                );
              })}
            </div>
          )}
          {/* Pinned: open/focused terminals when section is collapsed */}
          {!showTerminals && (() => {
            const pinned = terminalSessions.filter(s => {
              const paneId = `terminal:${s.id}`;
              return openPanels.includes(paneId) || focusedTopicId === paneId;
            });
            if (!pinned.length) return null;
            return (
              <div className="flex-shrink-0">
                {pinned.map(s => {
                  const paneId = `terminal:${s.id}`;
                  const isActive = focusedTopicId === paneId || openPanels.includes(paneId);
                  return (
                    <TerminalSidebarItem
                      key={s.id}
                      session={s}
                      isActive={isActive}
                      isTouch={isTouch}
                      onTerminalClick={onTerminalClick}
                      onCloseTerminal={onCloseTerminal}
                    />
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* Search mode — single scrollable area */}
      {searchQuery && (
        <div className="flex-1 min-h-0 overflow-y-auto sidebar-scroll">
          {renderLevel(null, 1, showChatsArchived, true)}
        </div>
      )}

      {/* Project context menu */}
      {projectContextMenu && onArchiveProject && (
        <div
          className="fixed bg-surface border border-app-border rounded-lg shadow-lg py-1 z-[100] min-w-[160px]"
          style={{ top: projectContextMenu.y, left: projectContextMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
        </div>
      )}
    </div>
  );
}

// ── Terminal sidebar item (mirrors TopicItem mobile/desktop pattern) ──────────

interface TerminalSidebarItemProps {
  session: TerminalSessionInfo;
  isActive: boolean;
  isTouch: boolean;
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onCloseTerminal?: (sessionId: string) => void;
}

function TerminalSidebarItem({ session: s, isActive, isTouch, onTerminalClick, onCloseTerminal }: TerminalSidebarItemProps) {
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  return (
    <div
      className={`group/terminal w-full flex items-center h-7 transition-colors ${
        isActive ? 'bg-primary/10 text-primary' : 'text-app-text hover:bg-app-hover'
      }`}
      style={{ paddingLeft: 24 }}
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
        {s.clients > 0 && (
          <span className="text-[10px] text-app-text-tertiary" title={`${s.clients} connected`}>
            {s.clients}
          </span>
        )}
      </button>

      {onCloseTerminal && (
        <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 relative mr-1">
          {isTouch ? (
            /* Mobile: ··· sempre visibile → dropdown */
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
                  <span>Close terminal</span>
                </button>
              </DropdownPortal>
            </>
          ) : (
            /* Desktop: X al hover */
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTerminal(s.id); }}
              className="hidden group-hover/terminal:flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
              title="Close terminal"
            >
              <X size={12} className="text-app-text-tertiary" />
            </button>
          )}
        </span>
      )}
    </div>
  );
}
