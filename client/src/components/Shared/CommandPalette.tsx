import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, Plus, Settings, Moon, Sun, File, Loader2 } from 'lucide-react';
import type { Topic, SearchResult } from '../../types';
import { TopicIcon } from '@/lib/topicIcons';
import { searchApi } from '../../lib/api';

export interface CommandAction {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  category: 'topic' | 'action' | 'command' | 'file' | 'message';
  shortcut?: string;
  action: () => void;
  /** Raw content for highlight rendering in message results */
  _rawContent?: string;
}

function fuzzyMatch(query: string, target: string): boolean {
  let qi = 0;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  topics: Record<string, Topic>;
  onOpenTopic: (id: string) => void;
  onNewTopic: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  themeMode: string;
  projectPath?: string;
  onOpenFile?: (path: string, lineNumber?: number) => void;
  isElectron?: boolean;
}

export function CommandPalette({
  isOpen,
  onClose,
  topics,
  onOpenTopic,
  onNewTopic,
  onToggleTheme,
  onOpenSettings,
  themeMode,
  projectPath,
  onOpenFile,
  isElectron,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [fileList, setFileList] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<CommandAction[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced message search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchTimeout.current = setTimeout(async () => {
      try {
        const data = await searchApi.search(q, 20);
        setSearchResults(
          data.results
            .filter((r: SearchResult) => r.topicId)
            .map((r: SearchResult) => {
              const roleLabel = r.role === 'user' ? 'You' : 'Assistant';
              const truncated = r.content.slice(0, 80).replace(/\n/g, ' ');
              const dateStr = r.timestamp ? new Date(r.timestamp).toLocaleDateString() : '';
              return {
                id: `msg-${r.sessionKey}-${r.timestamp}`,
                label: `${roleLabel}: ${truncated}`,
                description: `${r.topicName}${dateStr ? ' · ' + dateStr : ''}`,
                icon: <TopicIcon name={r.topicIcon} size={14} />,
                category: 'message' as const,
                action: () => { onOpenTopic(r.topicId!); onClose(); },
                _rawContent: r.content.slice(0, 200),
              };
            })
        );
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [query, onOpenTopic, onClose]);

  // Fetch flat file list when palette opens with a project path
  useEffect(() => {
    if (projectPath && isOpen) {
      import('../../lib/api').then(({ filesApi }) => {
        filesApi.flatList(projectPath).then(data => setFileList(data.files)).catch(() => {});
      });
    }
  }, [projectPath, isOpen]);

  // Build actions list
  const actions = useMemo((): CommandAction[] => {
    const items: CommandAction[] = [];

    // Quick actions
    items.push({
      id: 'new-topic',
      label: 'New Chat',
      description: 'Create a new topic',
      icon: <Plus size={14} />,
      category: 'action',
      shortcut: isElectron ? '⌘N' : undefined,
      action: () => { onNewTopic(); onClose(); },
    });
    items.push({
      id: 'settings',
      label: 'Settings',
      description: 'Open app settings',
      icon: <Settings size={14} />,
      category: 'action',
      shortcut: '⌘,',
      action: () => { onOpenSettings(); onClose(); },
    });
    items.push({
      id: 'toggle-theme',
      label: themeMode === 'dark' ? 'Switch to Light Mode' : themeMode === 'light' ? 'Switch to Dark Mode' : 'Toggle Theme',
      icon: themeMode === 'dark' ? <Sun size={14} /> : <Moon size={14} />,
      category: 'action',
      action: () => { onToggleTheme(); onClose(); },
    });

    // Topics
    Object.values(topics)
      .filter(t => !t.archived)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      .forEach(topic => {
        items.push({
          id: `topic-${topic.id}`,
          label: topic.name,
          description: topic.projectPath ? topic.projectPath.split('/').pop() : undefined,
          icon: <TopicIcon name={topic.icon} size={14} color={topic.color || undefined} />,
          category: 'topic',
          action: () => { onOpenTopic(topic.id); onClose(); },
        });
      });

    // Recent files (show when query is empty and projectPath exists)
    if (projectPath && !query.trim()) {
      try {
        const key = `recent-files-${projectPath}`;
        const recent: { path: string; name: string; timestamp: number }[] = JSON.parse(localStorage.getItem(key) || '[]');
        recent.forEach(r => {
          items.push({
            id: `recent-${r.path}`,
            label: r.name,
            description: r.path,
            icon: <File size={14} />,
            category: 'file',
            action: () => {
              onOpenFile?.(projectPath + '/' + r.path);
              onClose();
            },
          });
        });
      } catch {}
    }

    // File search (show when query has text)
    if (projectPath && query.trim() && onOpenFile) {
      const q = query.toLowerCase();
      const matchingFiles = fileList
        .filter(f => {
          const name = f.split('/').pop()?.toLowerCase() || '';
          const path = f.toLowerCase();
          return name.includes(q) || path.includes(q) || fuzzyMatch(q, path);
        })
        .slice(0, 20);

      matchingFiles.forEach(f => {
        const name = f.split('/').pop() || f;
        items.push({
          id: `file-${f}`,
          label: name,
          description: f,
          icon: <File size={14} />,
          category: 'file',
          action: () => {
            onOpenFile(projectPath + '/' + f);
            onClose();
          },
        });
      });
    }

    return items;
  }, [topics, themeMode, onNewTopic, onOpenSettings, onToggleTheme, onOpenTopic, onClose, projectPath, query, fileList, onOpenFile]);

  // Filter actions (file items are already pre-filtered in the actions builder)
  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(a =>
      a.category === 'file' ||
      a.label.toLowerCase().includes(q) ||
      (a.description && a.description.toLowerCase().includes(q))
    );
  }, [actions, query]);

  // Merge filtered items with search results
  const allItems = useMemo(() => [...filtered, ...searchResults], [filtered, searchResults]);

  // Reset selection on filter change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setSearchResults([]);
      setSearchLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (allItems[selectedIndex]) {
        allItems[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [allItems, selectedIndex, onClose]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-cmd-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen) return null;

  // Group by category
  const groupedActions = allItems.reduce((acc, action) => {
    if (!acc[action.category]) acc[action.category] = [];
    acc[action.category].push(action);
    return acc;
  }, {} as Record<string, CommandAction[]>);

  const categoryLabels: Record<string, string> = {
    action: 'Actions',
    file: 'Files',
    topic: 'Topics',
    command: 'Commands',
    message: 'Messages',
  };

  let globalIdx = 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50" />
      <div
        className="relative w-full max-w-lg mx-4 bg-surface rounded-xl shadow-2xl border border-app-border overflow-hidden command-palette-enter"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-app-border">
          <Search size={16} className="text-app-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={projectPath ? "Search files, topics, messages, actions..." : "Search topics, messages, actions..."}
            className="flex-1 bg-transparent text-[14px] text-app-text placeholder-app-placeholder outline-none"
          />
          <kbd className="kbd">ESC</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1" role="listbox" aria-label="Results">
          {allItems.length === 0 && !searchLoading ? (
            <div className="px-4 py-8 text-center text-[13px] text-app-text-muted">
              No results found
            </div>
          ) : (
            <>
              {Object.entries(groupedActions).map(([category, items]) => (
                <div key={category}>
                  <div className="px-4 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-2">
                    {categoryLabels[category] || category}
                    {category === 'message' && searchLoading && (
                      <Loader2 size={10} className="animate-spin" />
                    )}
                  </div>
                  {items.map(item => {
                    const idx = globalIdx++;
                    return (
                      <button
                        key={item.id}
                        role="option"
                        aria-selected={idx === selectedIndex}
                        data-cmd-idx={idx}
                        onClick={item.action}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        className={`w-full px-4 py-2 flex items-center gap-3 text-left transition-colors ${
                          idx === selectedIndex
                            ? 'bg-primary/10 text-primary dark:text-primary-dark'
                            : 'text-app-text hover:bg-app-hover'
                        }`}
                      >
                        <span className={idx === selectedIndex ? 'text-primary dark:text-primary-dark' : 'text-app-text-muted'}>
                          {item.icon}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="text-[13px] font-medium truncate block">
                            {item._rawContent ? highlightQuery(item.label, query) : item.label}
                          </span>
                          {item.description && (
                            <span className="text-[11px] text-app-text-muted truncate block">{item.description}</span>
                          )}
                        </span>
                        {item.shortcut && (
                          <kbd className="kbd">{item.shortcut}</kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              {searchLoading && !groupedActions['message'] && (
                <div className="px-4 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-2">
                  Messages <Loader2 size={10} className="animate-spin" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer with hints */}
        <div className="px-4 py-2 border-t border-app-border flex items-center gap-4 text-[10px] text-app-text-muted">
          <span className="flex items-center gap-1"><kbd className="kbd">↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd className="kbd">↵</kbd> select</span>
          <span className="flex items-center gap-1"><kbd className="kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function highlightQuery(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 text-inherit rounded px-0.5">{part}</mark>
      : part
  );
}
