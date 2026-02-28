import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronRight, Archive, ArchiveRestore, Plus, MessageSquare, Terminal, Globe, LayoutGrid, FolderOpen } from 'lucide-react';
import { TopicItem } from './TopicItem';
import { topicsApi } from '@/lib/api';
import { createPaneId } from '@/lib/paneConfig';
import type { Topic, UnreadData, PaneType } from '@/types';
import { useProjectTabStatus } from '@/hooks/useProjectTabStatus';

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
}

export function TopicTree({
  topics,
  workspaceProjects = [],
  searchQuery,
  expandedNodes,
  onToggleNode,
  focusedTopicId,
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
}: TopicTreeProps) {
  const [showProjectsArchived, setShowProjectsArchived] = useState(false);
  const [showChatsArchived, setShowChatsArchived] = useState(false);
  const [showProjects, setShowProjects] = useState(true);
  const [showChats, setShowChats] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [expandedProjectChats, setExpandedProjectChats] = useState<Set<string>>(new Set());
  const [projectAddMenu, setProjectAddMenu] = useState<string | null>(null); // projectPath of open menu
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectAddMenu) return;
    const h = (e: MouseEvent) => { if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setProjectAddMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [projectAddMenu]);
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

  // Close project context menu on outside click
  useEffect(() => {
    if (!projectContextMenu) return;
    const h = () => setProjectContextMenu(null);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [projectContextMenu]);

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
  const allRegularTopics = Object.values(topics).filter(t => !t.projectPath && !t.archived);
  
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

  return (
    <div role="tree" aria-label="Topics">
      {/* Board — always visible above Projects */}
      {!searchQuery && onOpenProjectBoard && (
        <>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-all-boards'))}
            className="group/ab flex items-center gap-2 w-full h-8 text-left text-[13px] text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors"
            style={{ paddingLeft: 12 }}
            title="View all project boards"
          >
            <LayoutGrid size={14} strokeWidth={1.5} className={`flex-shrink-0 ${activeStreamingCount > 0 ? 'text-emerald-500' : 'text-app-text-secondary'}`} />
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
        </>
      )}

      {/* Projects section */}
      {Object.keys(projectGroups).length > 0 && !searchQuery && (
        <>
          <div>
            {/* Projects section header */}
            <div className="group flex items-center h-8 hover:bg-app-hover transition-colors">
              <button
                onClick={() => setShowProjects(!showProjects)}
                aria-expanded={showProjects}
                aria-label="Projects section"
                className="flex items-center gap-2 flex-1 h-full text-left"
                style={{ paddingLeft: 12 }}
              >
                <FolderOpen size={14} strokeWidth={1.5} className="text-app-text-secondary flex-shrink-0" />
                <span className="text-[13px] text-app-text">Projects</span>
                <ChevronRight
                  size={12}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className={`transition-transform duration-150 text-app-text-tertiary ${showProjects ? 'rotate-90' : ''}`}
                />
              </button>
              <div className="flex items-center gap-1 pr-3">
                {totalProjectArchived > 0 && (
                  <button
                    onClick={() => setShowProjectsArchived(!showProjectsArchived)}
                    aria-pressed={showProjectsArchived}
                    aria-label={showProjectsArchived ? `Hide ${totalProjectArchived} archived` : `Show ${totalProjectArchived} archived`}
                    className={`flex-shrink-0 h-6 inline-flex items-center gap-1 px-1.5 rounded transition-all text-[11px] leading-none ${
                      showProjectsArchived
                        ? 'text-primary opacity-100'
                        : 'text-app-text-tertiary opacity-0 md:group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10'
                    }`}
                    title={showProjectsArchived ? "Hide archived" : `Show ${totalProjectArchived} archived`}
                  >
                    <span>Show</span>
                    <Archive size={12} className="flex-shrink-0" />
                  </button>
                )}
              </div>
            </div>

            {showProjects && (
              <div>
                {sortedProjectEntries.map(([projectName, { path, activeTopics, archivedTopics: projectArchived, isTemp }]) => {
                  const isExpanded = expandedProjects.has(projectName);
                  const hasTopics = activeTopics.length > 0 || projectArchived.length > 0;
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
                      <div
                        className={`group/proj flex items-center h-8 transition-colors relative ${
                          isProjectFocused
                            ? 'bg-primary/8 dark:bg-primary/15'
                            : isProjectOpen
                              ? 'bg-app-hover'
                              : 'hover:bg-app-hover'
                        }`}
                        onContextMenu={(e) => {
                          if (!onArchiveProject) return;
                          e.preventDefault();
                          setProjectContextMenu({ x: e.clientX, y: e.clientY, projectPath: path, projectName, allArchived });
                        }}
                      >
                        {isProjectFocused && (
                          <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full bg-primary" />
                        )}
                        <button
                          onClick={() => {
                            const wasExpanded = expandedProjects.has(projectName);
                            toggleProject(projectName);
                            if (!wasExpanded && onProjectClick) {
                              onProjectClick(path);
                            }
                          }}
                          className={`flex items-center gap-2 h-full flex-1 min-w-0 text-left text-[13px] font-medium transition-colors ${
                            isProjectFocused
                              ? 'text-primary dark:text-primary-dark'
                              : allArchived ? 'text-app-text-muted' : 'text-app-text-secondary hover:text-app-text'
                          }`}
                          style={{ paddingLeft: 28 }}
                          title={path}
                        >
                          <ChevronRight
                            size={12}
                            strokeWidth={1.5}
                            className={`transition-transform duration-150 flex-shrink-0 ${isTemp ? 'text-amber-500' : 'text-app-text-secondary'} ${isExpanded ? 'rotate-90' : ''}`}
                          />
                          <span className="truncate flex-1">{projectName}</span>
                        </button>
                        {/* Right side: count + status (default) / action buttons (hover) */}
                        <div className="flex items-center pr-2 flex-shrink-0">
                          {/* Status indicators + count — visible by default, hidden on hover */}
                          {(() => {
                            const ps = projectTabStatus[path];
                            const showBranch = ps?.gitBranch && ps.gitBranch !== 'main' && ps.gitBranch !== 'master';
                            const hasStatus = ps && (showBranch || ps.gitFileCount > 0 || ps.gitAhead > 0 || ps.gitBehind > 0 || ps.runningProcessCount > 0);
                            return hasStatus ? (
                              <span className="flex items-center gap-1 text-[10px] font-medium mr-1.5 group-hover/proj:hidden min-w-0">
                                {showBranch && (
                                  <span className="truncate max-w-[60px] text-app-text-tertiary" title={ps.gitBranch}>{ps.gitBranch}</span>
                                )}
                                {ps.gitFileCount > 0 && (
                                  <span className="px-1 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 leading-none py-px">{ps.gitFileCount}</span>
                                )}
                                {(ps.gitAhead > 0 || ps.gitBehind > 0) && (
                                  <span className="text-blue-500 dark:text-blue-400 leading-none whitespace-nowrap">
                                    {ps.gitAhead > 0 && <>{ps.gitAhead}↑</>}
                                    {ps.gitBehind > 0 && <>{ps.gitAhead > 0 ? ' ' : ''}{ps.gitBehind}↓</>}
                                  </span>
                                )}
                                {ps.runningProcessCount > 0 && (
                                  <span className="flex items-center gap-0.5 text-green-500 dark:text-green-400 leading-none">
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                                    {ps.runningProcessCount}
                                  </span>
                                )}
                              </span>
                            ) : null;
                          })()}
                          {groupUnread > 0 ? (
                            <span className="text-[10px] text-white bg-primary px-1.5 rounded-full min-w-[18px] text-center group-hover/proj:hidden">
                              {groupUnread}
                            </span>
                          ) : (
                            <span className="text-[10px] text-app-placeholder group-hover/proj:hidden">
                              {allChats.length}
                            </span>
                          )}
                          {/* Action buttons — hidden by default, visible on hover */}
                          {onOpenProjectBoard && (
                            <button
                              onClick={(e) => { e.stopPropagation(); onOpenProjectBoard(path); }}
                              className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-emerald-500 hover:text-emerald-400 transition-colors"
                              title="Open Board"
                              aria-label={`Board for ${projectName}`}
                            >
                              <LayoutGrid size={12} />
                            </button>
                          )}
                          {onArchiveProject && (
                            <button
                              onClick={(e) => { e.stopPropagation(); onArchiveProject(path, !allArchived); }}
                              className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
                              title={allArchived ? 'Restore Project' : 'Archive Project'}
                              aria-label={allArchived ? `Restore ${projectName}` : `Archive ${projectName}`}
                            >
                              {allArchived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                            </button>
                          )}
                          {(onNewTopicInProject || onAddProjectPane) && (
                            <div className="relative hidden group-hover/proj:block" ref={projectAddMenu === path ? addMenuRef : undefined}>
                              <button
                                onClick={(e) => { e.stopPropagation(); setProjectAddMenu(projectAddMenu === path ? null : path); }}
                                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
                                title="Add to project"
                                aria-label={`Add to ${projectName}`}
                              >
                                <Plus size={12} />
                              </button>
                              {projectAddMenu === path && (
                                <div className="absolute top-full right-0 mt-1 bg-surface border border-app-border rounded-lg shadow-lg py-1 z-50 min-w-[140px]">
                                  {onNewTopicInProject && (
                                    <button onClick={() => { onNewTopicInProject(path); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                                      <MessageSquare size={13} /><span>New Chat</span>
                                    </button>
                                  )}
                                  {onAddProjectPane && (
                                    <button onClick={() => { onAddProjectPane(path, 'terminal'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                                      <Terminal size={13} /><span>New Terminal</span>
                                    </button>
                                  )}
                                  {onAddProjectPane && (
                                    <button onClick={() => { onAddProjectPane(path, 'browser'); setProjectAddMenu(null); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
                                      <Globe size={13} /><span>New Browser</span>
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      
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
                                    isOpen={openPanels.includes(topic.id)}
                                    isFocused={focusedTopicId === topic.id}
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* Divider between Projects and Chats */}
          <div className="border-t border-app-border" />
        </>
      )}

      {/* Chats section header */}
      {!searchQuery && (allRegularTopics.length > 0 || archivedOutsideProjects.length > 0) && (
        <div className="group flex items-center h-8 hover:bg-app-hover transition-colors">
          <button
            onClick={() => setShowChats(!showChats)}
            aria-expanded={showChats}
            aria-label="Chats section"
            className="flex items-center gap-2 flex-1 h-full text-left"
            style={{ paddingLeft: 12 }}
          >
            <MessageSquare size={14} strokeWidth={1.5} className="text-app-text-secondary flex-shrink-0" />
            <span className="text-[13px] text-app-text">Chats</span>
            <ChevronRight
              size={12}
              strokeWidth={1.5}
              aria-hidden="true"
              className={`transition-transform duration-150 text-app-text-tertiary ${showChats ? 'rotate-90' : ''}`}
            />
          </button>
          {/* Right side: archive toggle button + last update */}
          <div className="flex items-center gap-1 pr-3">
            {archivedOutsideProjects.length > 0 && (
              <button
                onClick={() => setShowChatsArchived(!showChatsArchived)}
                aria-pressed={showChatsArchived}
                aria-label={showChatsArchived ? `Hide ${archivedOutsideProjects.length} archived chats` : `Show ${archivedOutsideProjects.length} archived chats`}
                className={`flex-shrink-0 h-6 inline-flex items-center gap-1 px-1.5 rounded transition-all text-[11px] leading-none ${
                  showChatsArchived
                    ? 'text-primary opacity-100'
                    : 'text-app-text-tertiary opacity-0 md:group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10'
                }`}
                title={showChatsArchived ? "Hide archived" : `Show ${archivedOutsideProjects.length} archived`}
              >
                <span>Show</span>
                <Archive size={12} className="flex-shrink-0" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Chats list */}
      {(showChats || searchQuery) && (
        <div>
          {renderLevel(null, 1, showChatsArchived, true)}
        </div>
      )}

      {Object.keys(topics).length === 0 && (
        <div className="px-4 py-12 text-center">
          <MessageSquare size={36} className="mx-auto mb-3 text-app-text-tertiary" />
          <p className="text-[14px] font-medium text-app-text-secondary mb-1">No topics yet</p>
          <p className="text-[12px] text-app-text-muted mb-4">Create your first topic to get started</p>
          <button
            onClick={() => {
              // Trigger ⌘N shortcut programmatically
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }));
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-white bg-primary hover:bg-primary-hover rounded-lg transition-colors shadow-sm"
          >
            <span>+</span> Create Topic
          </button>
          {!!(window as any).electronAPI?.isElectron && (
            <p className="text-[11px] text-app-placeholder mt-3">or press <kbd className="kbd">⌘N</kbd></p>
          )}
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
            {projectContextMenu.allArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            <span>{projectContextMenu.allArchived ? 'Restore Project' : 'Archive Project'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
