import { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, FolderGit2, FolderClock, MessageCircle, Archive, Plus, MessageSquare, Terminal } from 'lucide-react';
import { TopicItem } from './TopicItem';
import { topicsApi } from '@/lib/api';
import type { Topic, UnreadData, PaneType } from '@/types';

function getProjectLabel(projectPath: string | undefined): { name: string; isTemp: boolean } {
  if (!projectPath) return { name: 'Unlinked', isTemp: false };
  const dirName = projectPath.split('/').pop() || '';
  if (!dirName) return { name: 'Unlinked', isTemp: false };
  const isTemp = projectPath.startsWith('/tmp/') || projectPath.startsWith('/private/tmp/');
  return { name: isTemp ? `${dirName} (temp)` : dirName, isTemp };
}

interface TopicTreeProps {
  topics: Record<string, Topic>;
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
  onNewTopicInProject?: (projectPath: string) => void;
  onAddProjectPane?: (projectPath: string, type: PaneType) => void;
  onProjectClick?: (projectPath: string) => void;
  isSessionStreaming?: (sessionKey: string) => boolean;
}

export function TopicTree({
  topics,
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
  onNewTopicInProject,
  onAddProjectPane,
  onProjectClick,
  isSessionStreaming,
}: TopicTreeProps) {
  const [showProjectsArchived, setShowProjectsArchived] = useState(false);
  const [showChatsArchived, setShowChatsArchived] = useState(false);
  const [showProjects, setShowProjects] = useState(true);
  const [showChats, setShowChats] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [projectAddMenu, setProjectAddMenu] = useState<string | null>(null); // projectPath of open menu
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectAddMenu) return;
    const h = (e: MouseEvent) => { if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setProjectAddMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [projectAddMenu]);
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

    // Get sorted list of chat topics (non-project, non-archived)
    const chatTopics = Object.values(topics)
      .filter(t => !t.projectPath && !t.archived)
      .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

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

  const renderLevel = (parentId: string | null, depth = 0, includeArchived = false): React.ReactNode[] => {
    const children = getChildren(parentId).sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
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
          onToggle={() => onToggleNode(topic.id)}
          onClick={(e) => onTopicClick(topic.id, e)}
          onDoubleClick={(e) => onTopicDoubleClick(topic.id, e)}
          onContextMenu={(e) => onTopicContextMenu(e, topic)}
          onArchive={handleArchive}
          isArchived={topic.archived}
          isDragOver={dragOverId === topic.id}
          onSidebarDragStart={() => handleSidebarDragStart(topic.id)}
          onSidebarDragOver={() => handleSidebarDragOver(topic.id)}
          onSidebarDrop={() => handleSidebarDrop(topic.id)}
          onSidebarDragEnd={handleSidebarDragEnd}
        />
      );

      if (hasChildren && isExpanded) {
        result.push(...renderLevel(topic.id, depth + 1, includeArchived));
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

  // Sort project groups: regular projects first, temp projects last
  const sortedProjectEntries = Object.entries(projectGroups).sort(([, a], [, b]) => {
    if (a.isTemp !== b.isTemp) return a.isTemp ? 1 : -1;
    return 0;
  });

  // Non-project archived topics
  const archivedOutsideProjects = archivedTopics.filter(t => !t.projectPath);

  // Count archived for display
  const totalProjectArchived = Object.values(projectGroups).reduce((sum, g) => sum + g.archivedTopics.length, 0);

  return (
    <div role="tree" aria-label="Topics">
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
                <ChevronRight
                  size={14}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className={`transition-transform duration-150 text-app-text-secondary ${showProjects ? 'rotate-90' : ''}`}
                />
                <FolderGit2 size={14} strokeWidth={1.5} className="text-app-text-muted" aria-hidden="true" />
                <span className="text-[13px] text-app-text">Projects</span>
              </button>
              <div className="flex items-center pr-3">
                {totalProjectArchived > 0 && (
                  <button
                    onClick={() => setShowProjectsArchived(!showProjectsArchived)}
                    aria-pressed={showProjectsArchived}
                    aria-label={showProjectsArchived ? `Hide ${totalProjectArchived} archived` : `Show ${totalProjectArchived} archived`}
                    className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded transition-all mr-1.5 ${
                      showProjectsArchived
                        ? 'text-primary opacity-100'
                        : 'text-app-text-tertiary opacity-0 md:group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10'
                    }`}
                    title={showProjectsArchived ? "Hide archived" : `Show ${totalProjectArchived} archived`}
                  >
                    <Archive size={12} />
                  </button>
                )}
                <span className="text-[11px] text-app-text-muted opacity-0 md:group-hover:opacity-100 transition-opacity tabular-nums">{Object.keys(projectGroups).length}</span>
              </div>
            </div>

            {showProjects && (
              <div>
                {sortedProjectEntries.map(([projectName, { path, activeTopics, archivedTopics: projectArchived, isTemp }]) => {
                  const isExpanded = expandedProjects.has(projectName);
                  // Combine active and archived (if showing) and sort by name
                  const allChats = showProjectsArchived
                    ? [...activeTopics, ...projectArchived].sort((a, b) => a.name.localeCompare(b.name))
                    : activeTopics;

                  // Sum unread counts for all topics in this project group
                  const groupUnread = allChats.reduce((sum, t) => sum + (unreadData[t.id]?.unreadCount || 0), 0);
                  const FolderIcon = isTemp ? FolderClock : FolderGit2;

                  return (
                    <div key={projectName}>
                      {/* Project folder item */}
                      <div className="group/proj flex items-center h-8 hover:bg-app-hover transition-colors">
                        <button
                          onClick={() => {
                            const wasExpanded = expandedProjects.has(projectName);
                            toggleProject(projectName);
                            if (!wasExpanded && onProjectClick) {
                              onProjectClick(path);
                            }
                          }}
                          className="flex items-center gap-1.5 h-full flex-1 min-w-0 text-left text-[12px] font-medium text-app-text-secondary hover:text-app-text transition-colors"
                          style={{ paddingLeft: 24 }}
                          title={path}
                        >
                          <ChevronRight
                            size={11}
                            strokeWidth={1.5}
                            className={`transition-transform duration-150 flex-shrink-0 text-app-text-secondary ${isExpanded ? 'rotate-90' : ''}`}
                          />
                          <FolderIcon size={14} strokeWidth={1.5} className={isTemp ? 'text-amber-500 flex-shrink-0' : 'text-blue-500 flex-shrink-0'} />
                          <span className="truncate flex-1">{projectName}</span>
                          {groupUnread > 0 ? (
                            <span className="text-[10px] text-white bg-primary px-1.5 rounded-full min-w-[18px] text-center flex-shrink-0">
                              {groupUnread}
                            </span>
                          ) : (
                            <span className="text-[10px] text-app-placeholder flex-shrink-0">
                              {allChats.length}
                            </span>
                          )}
                        </button>
                        {(onNewTopicInProject || onAddProjectPane) && (
                          <div className="relative" ref={projectAddMenu === path ? addMenuRef : undefined}>
                            <button
                              onClick={(e) => { e.stopPropagation(); setProjectAddMenu(projectAddMenu === path ? null : path); }}
                              className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover/proj:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-all mr-1"
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
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      
                      {/* Chats under this project - all inline */}
                      {isExpanded && (
                        <div>
                          {allChats.map(topic => (
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
                              onToggle={() => {}}
                              onClick={(e) => onTopicClick(topic.id, e)}
                              onDoubleClick={(e) => onTopicDoubleClick(topic.id, e)}
                              onContextMenu={(e) => onTopicContextMenu(e, topic)}
                              onArchive={handleArchive}
                              isArchived={topic.archived}
                            />
                          ))}
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
            <ChevronRight
              size={14}
              strokeWidth={1.5}
              aria-hidden="true"
              className={`transition-transform duration-150 text-app-text-secondary ${showChats ? 'rotate-90' : ''}`}
            />
            <MessageCircle size={14} strokeWidth={1.5} className="text-app-text-muted" aria-hidden="true" />
            <span className="text-[13px] text-app-text">Chats</span>
          </button>
          {/* Right side: archive toggle button + count */}
          <div className="flex items-center pr-3">
            {archivedOutsideProjects.length > 0 && (
              <button
                onClick={() => setShowChatsArchived(!showChatsArchived)}
                aria-pressed={showChatsArchived}
                aria-label={showChatsArchived ? `Hide ${archivedOutsideProjects.length} archived chats` : `Show ${archivedOutsideProjects.length} archived chats`}
                className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded transition-all mr-1.5 ${
                  showChatsArchived
                    ? 'text-primary opacity-100'
                    : 'text-app-text-tertiary opacity-0 md:group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10'
                }`}
                title={showChatsArchived ? "Hide archived" : `Show ${archivedOutsideProjects.length} archived`}
              >
                <Archive size={12} />
              </button>
            )}
            <span className="text-[11px] text-app-text-muted opacity-0 md:group-hover:opacity-100 transition-opacity tabular-nums">
              {allRegularTopics.length}
            </span>
          </div>
        </div>
      )}

      {/* Chats list */}
      {(showChats || searchQuery) && (
        <div>
          {renderLevel(null, 0, showChatsArchived)}
        </div>
      )}

      {Object.keys(topics).length === 0 && (
        <div className="px-4 py-12 text-center">
          <div className="text-4xl mb-3">💬</div>
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
          <p className="text-[11px] text-app-placeholder mt-3">or press <kbd className="kbd">⌘N</kbd></p>
        </div>
      )}
    </div>
  );
}
