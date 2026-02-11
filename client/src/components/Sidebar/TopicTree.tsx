import { useState, useCallback } from 'react';
import { ChevronRight, FolderGit2, MessageCircle, Archive } from 'lucide-react';
import { TopicItem } from './TopicItem';
import { topicsApi } from '@/lib/api';
import type { Topic, UnreadData } from '@/types';

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
  getProjectTopics: () => Topic[];
  searchTopics: (query: string) => Topic[];
  unreadData: UnreadData;
  onArchiveTopic: (topicId: string, archive: boolean) => Promise<boolean>;
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
  getProjectTopics: _getProjectTopics,
  unreadData,
  onArchiveTopic,
}: TopicTreeProps) {
  const [showProjectsArchived, setShowProjectsArchived] = useState(false);
  const [showChatsArchived, setShowChatsArchived] = useState(false);
  const [showProjects, setShowProjects] = useState(true);
  const [showChats, setShowChats] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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
    const projectName = topic.projectPath?.split('/').pop() || 'Unknown';
    if (!acc[projectName]) {
      acc[projectName] = { path: topic.projectPath!, activeTopics: [], archivedTopics: [] };
    }
    if (topic.archived) {
      acc[projectName].archivedTopics.push(topic);
    } else {
      acc[projectName].activeTopics.push(topic);
    }
    return acc;
  }, {} as Record<string, { path: string; activeTopics: Topic[]; archivedTopics: Topic[] }>);

  // Non-project archived topics
  const archivedOutsideProjects = archivedTopics.filter(t => !t.projectPath);

  // Count archived for display
  const totalProjectArchived = Object.values(projectGroups).reduce((sum, g) => sum + g.archivedTopics.length, 0);

  return (
    <div className="py-1">
      {/* Projects section */}
      {Object.keys(projectGroups).length > 0 && !searchQuery && (
        <>
          <div>
            {/* Projects section header */}
            <div className="group flex items-center">
              <button
                onClick={() => setShowProjects(!showProjects)}
                className="flex items-center gap-2 h-9 pr-2 flex-1 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#252525] transition-colors"
                style={{ paddingLeft: 12 }}
              >
                <ChevronRight
                  size={14}
                  strokeWidth={1.5}
                  className={`transition-transform duration-150 text-[#666] dark:text-[#999] ${showProjects ? 'rotate-90' : ''}`}
                />
                <FolderGit2 size={14} strokeWidth={1.5} className="text-[#888]" />
                <span className="text-[13px] text-[#1a1a1a] dark:text-[#e5e5e5] flex-1">Projects</span>
                <span className="text-[11px] text-[#888] bg-[#eee] dark:bg-[#333] px-1.5 rounded">{Object.keys(projectGroups).length}</span>
              </button>
              {/* Show archived toggle - visible on hover */}
              {totalProjectArchived > 0 && (
                <button
                  onClick={() => setShowProjectsArchived(!showProjectsArchived)}
                  className={`mr-2 flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded transition-all ${
                    showProjectsArchived 
                      ? 'bg-[var(--primary)]/10 text-[var(--primary)] dark:text-[#5599ff] opacity-100' 
                      : 'text-[#8b8b8b] opacity-0 group-hover:opacity-100 hover:bg-[#f0f0f0] dark:hover:bg-[#252525]'
                  }`}
                  title={showProjectsArchived ? "Hide archived" : "Show archived"}
                >
                  <Archive size={13} />
                  <span>{totalProjectArchived}</span>
                </button>
              )}
            </div>
            
            {showProjects && (
              <div>
                {Object.entries(projectGroups).map(([projectName, { path, activeTopics, archivedTopics: projectArchived }]) => {
                  const isExpanded = expandedProjects.has(projectName);
                  // Combine active and archived (if showing) and sort by name
                  const allChats = showProjectsArchived 
                    ? [...activeTopics, ...projectArchived].sort((a, b) => a.name.localeCompare(b.name))
                    : activeTopics;
                  
                  return (
                    <div key={projectName}>
                      {/* Project folder item */}
                      <button
                        onClick={() => toggleProject(projectName)}
                        className="group/proj flex items-center gap-1.5 h-8 pr-2 w-full text-left text-[12px] font-medium text-[#666] dark:text-[#999] hover:text-[#333] dark:hover:text-[#ccc] hover:bg-[#f5f5f5] dark:hover:bg-[#222] transition-colors"
                        style={{ paddingLeft: 24 }}
                        title={path}
                      >
                        <ChevronRight
                          size={11}
                          strokeWidth={1.5}
                          className={`transition-transform duration-150 flex-shrink-0 text-[#666] dark:text-[#999] ${isExpanded ? 'rotate-90' : ''}`}
                        />
                        <FolderGit2 size={14} strokeWidth={1.5} className="text-blue-500 flex-shrink-0" />
                        <span className="truncate flex-1">{projectName}</span>
                        <span className="text-[10px] text-[#b0b0b0] dark:text-[#555] flex-shrink-0">
                          {allChats.length}
                        </span>
                      </button>
                      
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
          <div className="mx-2 my-2 border-t border-[#e5e5e5] dark:border-[#333]" />
        </>
      )}

      {/* Chats section header */}
      {!searchQuery && (allRegularTopics.length > 0 || archivedOutsideProjects.length > 0) && (
        <div className="group flex items-center">
          <button
            onClick={() => setShowChats(!showChats)}
            className="flex items-center gap-2 h-9 pr-2 flex-1 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#252525] transition-colors"
            style={{ paddingLeft: 12 }}
          >
            <ChevronRight
              size={14}
              strokeWidth={1.5}
              className={`transition-transform duration-150 text-[#666] dark:text-[#999] ${showChats ? 'rotate-90' : ''}`}
            />
            <MessageCircle size={14} strokeWidth={1.5} className="text-[#888]" />
            <span className="text-[13px] text-[#1a1a1a] dark:text-[#e5e5e5] flex-1">Chats</span>
            <span className="text-[11px] text-[#888] bg-[#eee] dark:bg-[#333] px-1.5 rounded">
              {showChatsArchived ? allRegularTopics.length + archivedOutsideProjects.length : allRegularTopics.length}
            </span>
          </button>
          {/* Show archived toggle - visible on hover */}
          {archivedOutsideProjects.length > 0 && (
            <button
              onClick={() => setShowChatsArchived(!showChatsArchived)}
              className={`mr-2 flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded transition-all ${
                showChatsArchived 
                  ? 'bg-[var(--primary)]/10 text-[var(--primary)] dark:text-[#5599ff] opacity-100' 
                  : 'text-[#8b8b8b] opacity-0 group-hover:opacity-100 hover:bg-[#f0f0f0] dark:hover:bg-[#252525]'
              }`}
              title={showChatsArchived ? "Hide archived" : "Show archived"}
            >
              <Archive size={13} />
              <span>{archivedOutsideProjects.length}</span>
            </button>
          )}
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
          <p className="text-[14px] font-medium text-[#666] dark:text-[#aaa] mb-1">No topics yet</p>
          <p className="text-[12px] text-[#b0b0b0] dark:text-[#666] mb-4">Create your first topic to get started</p>
          <button
            onClick={() => {
              // Trigger ⌘N shortcut programmatically
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }));
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-white bg-[var(--primary)] hover:bg-[var(--primary-hover)] rounded-lg transition-colors shadow-sm"
          >
            <span>+</span> Create Topic
          </button>
          <p className="text-[11px] text-[#b0b0b0] dark:text-[#555] mt-3">or press <kbd className="kbd">⌘N</kbd></p>
        </div>
      )}
    </div>
  );
}
