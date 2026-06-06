import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search, Plus, Settings, Moon, Sun, File, FolderPlus, FolderOpen,
  Loader2, TerminalSquare, RotateCcw,
} from 'lucide-react';
import { ClaudeIcon } from './ClaudeIcon';
import { ProjectFavicon } from './ProjectFavicon';
import { basename } from '../../lib/path-utils';
import { getProjectLabel } from '../../lib/buildSidebarItems';
import type { Topic, SearchResult } from '../../types';
import type { ClosedTabRecord } from '../../state/pane/adapters';
import { TopicIcon } from '@/lib/topicIcons';
import { searchApi } from '../../lib/api';
import { PANE_CONFIG } from '../../state/pane/adapters';

export interface CommandAction {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode | null;
  category: 'project' | 'topic' | 'action' | 'command' | 'file' | 'message' | 'recent-closed' | 'recent-file';
  shortcut?: string;
  action: () => void;
  /** Raw content for highlight rendering in message results */
  _rawContent?: string;
  /** Sort timestamp used when mixing topics with recently-closed in the main list. */
  _ts?: number;
  /** Optional override for the row's title tooltip — used when the row
   *  carries a long path (cwd, file path) that we want fully revealed on
   *  hover, not just the truncated description. */
  titleOverride?: string;
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
  onOpenProject?: (projectPath: string) => void;
  onNewTopic: () => void;
  onNewProject?: () => void;
  onNewClaude?: () => void;
  onNewTerminal?: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenFileSearch?: () => void;
  themeMode: string;
  projectPath?: string;
  onOpenFile?: (path: string, lineNumber?: number) => void;
  isElectron?: boolean;
  closedTabs?: ClosedTabRecord[];
  onReopenClosedTab?: (record: ClosedTabRecord) => void;
}

export function CommandPalette({
  isOpen,
  onClose,
  topics,
  onOpenTopic,
  onOpenProject,
  onNewTopic,
  onNewProject,
  onNewClaude,
  onNewTerminal,
  onToggleTheme,
  onOpenSettings,
  themeMode,
  projectPath,
  onOpenFile,
  isElectron,
  closedTabs,
  onReopenClosedTab,
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

  // ── Projects column (always visible accordion, left) ────────────────────
  const projectItems = useMemo((): CommandAction[] => {
    const recentProjects: string[] = (() => {
      try {
        const raw = localStorage.getItem('recent-projects');
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    })();
    const projectPaths = new Set<string>();
    Object.values(topics).forEach(t => { if (t.projectPath) projectPaths.add(t.projectPath); });
    recentProjects.forEach(p => projectPaths.add(p));
    const ordered = [
      ...recentProjects.filter(p => projectPaths.has(p)),
      ...Array.from(projectPaths).filter(p => !recentProjects.includes(p)).sort(),
    ];
    return ordered.map(pp => ({
      id: `project-${pp}`,
      label: getProjectLabel(pp),
      description: pp,
      // Real project icon when the folder ships a favicon / web-manifest /
      // index.html <link rel=icon> (resolved by /api/projects/icon); folders
      // without one render nothing (no fake folder glyph — same convention as
      // TopicTree).
      icon: <ProjectFavicon path={pp} size={14} />,
      category: 'project' as const,
      action: () => { onOpenProject?.(pp); onClose(); },
    }));
  }, [topics, onOpenProject, onClose]);

  // ── Tab recenti (closed tabs, always visible accordion under Projects) ──
  // Moved out of the main list so the right column reads as a clean topic
  // feed. Each entry carries the same metadata as before — pane type icon,
  // cwd/project anchor, full path in tooltip.
  const recentItems = useMemo((): CommandAction[] => {
    if (!closedTabs || !onReopenClosedTab) return [];
    return closedTabs.slice(0, 20).map((record, i) => {
      const paneType = record.pane.type;
      const config = PANE_CONFIG[paneType];
      const timeAgo = formatTimeAgo(record.closedAt);
      const icon = record.terminal?.sessionType === 'claude-code'
        ? <ClaudeIcon size={14} />
        : paneType === 'terminal'
          ? <TerminalSquare size={14} />
          : <RotateCcw size={14} />;
      const parts: string[] = [`Chiusa ${timeAgo}`];
      const cwd = record.terminal?.cwd;
      const projectLabel = record.projectPath ? getProjectLabel(record.projectPath) : null;
      if (paneType === 'terminal' && cwd) {
        const cwdLabel = getProjectLabel(cwd);
        parts.push(projectLabel && projectLabel !== cwdLabel
          ? `${projectLabel} · ${cwdLabel}`
          : cwdLabel);
      } else if (projectLabel) {
        parts.push(projectLabel);
      }
      const titleOverride = (paneType === 'terminal' && cwd)
        ? cwd
        : record.projectPath || undefined;
      return {
        id: `closed-${record.id}`,
        label: record.pane.title || config?.label || paneType,
        description: parts.join(' · '),
        icon,
        category: 'recent-closed' as const,
        _ts: record.closedAt,
        shortcut: i === 0 ? '⌘⇧U' : undefined,
        titleOverride,
        action: () => { onReopenClosedTab(record); onClose(); },
      };
    });
  }, [closedTabs, onReopenClosedTab, onClose]);

  // ── Topics for SEARCH (rendered only when there's a query, sorted by recency) ──
  // Includes ARCHIVED (= closed) topics on purpose: in the 2-state model a
  // closed topic is reopened by finding it here and selecting it (which
  // unarchives + opens via handleTopicClick/openPanel). Archived ones are
  // marked "chiuso" so the state is clear. NOT shown in the empty state
  // (the empty body renders only the Projects + Recently-closed columns).
  const topicItems = useMemo((): CommandAction[] => {
    return Object.values(topics)
      .map(topic => {
        // Guard against NaN — topics without updatedAt/createdAt (e.g. the
        // Master/system topics, or chats created before timestamps were
        // tracked) would otherwise produce NaN which corrupts sort order
        // and pins them silently at the top of the list.
        const raw = new Date(topic.updatedAt || topic.createdAt).getTime();
        const ts = Number.isFinite(raw) ? raw : 0;
        const projLabel = topic.projectPath ? getProjectLabel(topic.projectPath) : undefined;
        const description = topic.archived
          ? (projLabel ? `chiuso · ${projLabel}` : 'chiuso')
          : projLabel;
        return {
          id: `topic-${topic.id}`,
          label: topic.name,
          description,
          icon: <TopicIcon name={topic.icon} size={14} color={topic.color || undefined} />,
          category: 'topic' as const,
          _ts: ts,
          action: () => { onOpenTopic(topic.id); onClose(); },
        };
      })
      .sort((a, b) => (b._ts || 0) - (a._ts || 0));
  }, [topics, onOpenTopic, onClose]);

  // ── File search results (only when query has text) ──────────────────────
  const searchFileItems = useMemo((): CommandAction[] => {
    if (!projectPath || !query.trim() || !onOpenFile) return [];
    const q = query.toLowerCase();
    return fileList
      .filter(f => {
        const name = basename(f).toLowerCase();
        const path = f.toLowerCase();
        return name.includes(q) || path.includes(q) || fuzzyMatch(q, path);
      })
      .slice(0, 20)
      .map(f => {
        const name = basename(f) || f;
        return {
          id: `file-${f}`,
          label: name,
          description: f,
          icon: <File size={14} />,
          category: 'file' as const,
          action: () => { onOpenFile(projectPath + '/' + f); onClose(); },
        };
      });
  }, [projectPath, query, fileList, onOpenFile, onClose]);

  // ── Query-based filtering ───────────────────────────────────────────────
  // Files are pre-filtered by the search effect above; for the other lists
  // we filter on label/description here. With empty query everything is shown.
  const filterByQuery = useCallback((arr: CommandAction[]) => {
    if (!query.trim()) return arr;
    const q = query.toLowerCase();
    return arr.filter(a =>
      a.label.toLowerCase().includes(q) ||
      (a.description && a.description.toLowerCase().includes(q))
    );
  }, [query]);

  const filteredProjects = useMemo(() => filterByQuery(projectItems), [projectItems, filterByQuery]);
  const filteredRecenti = useMemo(() => filterByQuery(recentItems), [recentItems, filterByQuery]);
  const filteredMain = useMemo(() => filterByQuery(topicItems), [topicItems, filterByQuery]);

  // Flat order for keyboard nav, matching the render order in each mode:
  //  · empty (no query): Projects column → Recently-closed column
  //  · query:            Projects → Topics → Recently-closed → Files → Messages
  const allItems = useMemo(() => {
    if (!query.trim()) return [...filteredProjects, ...filteredRecenti];
    return [...filteredProjects, ...filteredMain, ...filteredRecenti, ...searchFileItems, ...searchResults];
  }, [query, filteredProjects, filteredRecenti, filteredMain, searchFileItems, searchResults]);

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

  // Each rendered row needs a stable global index for keyboard nav. We build
  // the indices in the same order `allItems` enumerates them so arrow keys
  // and rendered selection stay in sync.
  const indexOf = (id: string) => allItems.findIndex(it => it.id === id);
  const renderRow = (item: CommandAction, opts?: { compact?: boolean; highlight?: boolean }) => {
    const idx = indexOf(item.id);
    return (
      <PaletteRow
        key={item.id}
        item={item}
        idx={idx}
        selected={idx === selectedIndex}
        onHover={setSelectedIndex}
        compact={opts?.compact}
        highlightTerm={opts?.highlight ? query : undefined}
      />
    );
  };

  return (
    <div data-testid="command-palette" className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50" />
      <div
        className="relative w-full max-w-4xl mx-4 bg-surface rounded-xl shadow-2xl border border-app-border overflow-hidden command-palette-enter flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ maxHeight: '76vh' }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-app-border flex-shrink-0">
          <Search size={16} className="text-app-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={projectPath ? "Cerca file, topic, messaggi…" : "Cerca topic, messaggi…"}
            className="flex-1 bg-transparent text-[14px] text-app-text placeholder-app-placeholder outline-none"
          />
          <kbd className="kbd">ESC</kbd>
        </div>

        {/* Body. Empty (no query) = two side-by-side columns:
            Ultimi progetti | Chiuse di recente. With a query = one full-width
            results list with plain section labels (no collapsible accordions). */}
        <div className="flex-1 min-h-0 flex flex-col">
          {!query.trim() ? (
            <div ref={listRef} className="flex-1 min-h-0 flex">
              {/* Ultimi progetti */}
              <section className="flex-1 min-w-0 overflow-y-auto py-1 border-r border-app-border">
                <div className="px-3 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5">
                  Ultimi progetti
                  {filteredProjects.length > 0 && <span className="text-app-text-tertiary font-normal">{filteredProjects.length}</span>}
                </div>
                {filteredProjects.length > 0 ? (
                  filteredProjects.map(item => renderRow(item, { compact: true }))
                ) : (
                  <div className="px-3 py-2 text-[11px] text-app-text-muted italic">Nessun progetto</div>
                )}
              </section>
              {/* Chiuse di recente */}
              <section className="flex-1 min-w-0 overflow-y-auto py-1">
                <div className="px-3 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5">
                  Chiuse di recente
                  {filteredRecenti.length > 0 && <span className="text-app-text-tertiary font-normal">{filteredRecenti.length}</span>}
                </div>
                {filteredRecenti.length > 0 ? (
                  filteredRecenti.map(item => renderRow(item, { compact: true }))
                ) : (
                  <div className="px-3 py-2 text-[11px] text-app-text-muted italic">Nessuna tab chiusa</div>
                )}
              </section>
            </div>
          ) : (
            <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto py-1" role="listbox" aria-label="Risultati">
              {allItems.length === 0 && !searchLoading ? (
                <div className="px-4 py-8 text-center text-[13px] text-app-text-muted">Nessun risultato</div>
              ) : (
                <>
                  {filteredProjects.length > 0 && (
                    <>
                      <SectionHeader label="Progetti" />
                      {filteredProjects.map(item => renderRow(item, { highlight: true }))}
                    </>
                  )}
                  {filteredMain.length > 0 && (
                    <>
                      <SectionHeader label="Topic" />
                      {filteredMain.map(item => renderRow(item, { highlight: true }))}
                    </>
                  )}
                  {filteredRecenti.length > 0 && (
                    <>
                      <SectionHeader label="Tab chiuse" />
                      {filteredRecenti.map(item => renderRow(item, { highlight: true }))}
                    </>
                  )}
                  {searchFileItems.length > 0 && (
                    <>
                      <SectionHeader label="File" />
                      {searchFileItems.map(item => renderRow(item, { highlight: true }))}
                    </>
                  )}
                  {(searchResults.length > 0 || searchLoading) && (
                    <SectionHeader label="Messaggi" rightSlot={searchLoading ? <Loader2 size={10} className="animate-spin" /> : null} />
                  )}
                  {searchResults.map(item => renderRow(item, { highlight: true }))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Actions bar — wraps to multiple rows so EVERY action stays visible
            (no horizontal scroll that could hide e.g. Apri/Crea Progetto).
            Always at the bottom. Action items are NOT duplicated into the
            result list (the bar is the canonical surface). */}
        <div className="border-t border-app-border px-2 py-1.5 flex items-center gap-1 flex-wrap flex-shrink-0">
          <ActionPill icon={<Plus size={12} />} label="New Chat" onClick={() => { onNewTopic(); onClose(); }} shortcut={isElectron ? '⌘N' : undefined} />
          {onNewClaude && (
            <ActionPill icon={<ClaudeIcon size={12} />} label="Claude" onClick={() => { onNewClaude(); onClose(); }} />
          )}
          {onNewTerminal && (
            <ActionPill icon={<TerminalSquare size={12} />} label="Terminal" onClick={() => { onNewTerminal(); onClose(); }} />
          )}
          {/* Both open the native folder picker (which can select an existing
              folder OR create a new one via the dialog's "New Folder"). Two
              entry points because the user asked for both intents. */}
          {onNewProject && (
            <ActionPill icon={<FolderOpen size={12} />} label="Apri Progetto" onClick={() => { onNewProject(); onClose(); }} />
          )}
          {onNewProject && (
            <ActionPill icon={<FolderPlus size={12} />} label="Crea Progetto" onClick={() => { onNewProject(); onClose(); }} />
          )}
          <ActionPill icon={<Settings size={12} />} label="Settings" shortcut="⌘," onClick={() => { onOpenSettings(); onClose(); }} />
          <ActionPill
            icon={themeMode === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
            label="Theme"
            onClick={() => { onToggleTheme(); onClose(); }}
          />
        </div>

        {/* Footer hints */}
        <div className="px-4 py-1.5 border-t border-app-border flex items-center gap-4 text-[11px] text-app-text-muted flex-shrink-0">
          <span className="flex items-center gap-1"><kbd className="kbd">↑↓</kbd> naviga</span>
          <span className="flex items-center gap-1"><kbd className="kbd">↵</kbd> apri</span>
          <span className="flex items-center gap-1"><kbd className="kbd">esc</kbd> chiudi</span>
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SectionHeader({ label, rightSlot }: { label: string; rightSlot?: React.ReactNode }) {
  return (
    <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-2">
      {label}
      {rightSlot}
    </div>
  );
}

interface PaletteRowProps {
  item: CommandAction;
  idx: number;
  selected: boolean;
  onHover: (idx: number) => void;
  compact?: boolean;
  highlightTerm?: string;
}

function PaletteRow({ item, idx, selected, onHover, compact, highlightTerm }: PaletteRowProps) {
  // Fixed row height keeps closed-tabs, topics, files etc. visually aligned
  // even when some have a description line and some don't. The icon slot is
  // a fixed 14×14 box (rendered empty when item.icon is null) so labels
  // line up across rows with and without icon.
  const rowHeight = compact ? 'h-9' : 'h-11';
  return (
    <button
      role="option"
      aria-selected={selected}
      data-cmd-idx={idx}
      onClick={item.action}
      onMouseEnter={() => onHover(idx)}
      title={item.titleOverride || item.description}
      className={`w-full ${compact ? 'px-3' : 'px-4'} ${rowHeight} flex items-center gap-2.5 text-left transition-colors ${
        selected
          ? 'bg-primary/10 text-primary dark:text-primary-dark'
          : 'text-app-text hover:bg-app-hover'
      }`}
    >
      <span
        className={`w-[14px] h-[14px] flex items-center justify-center flex-shrink-0 ${
          selected ? 'text-primary dark:text-primary-dark' : 'text-app-text-muted'
        }`}
        aria-hidden={!item.icon}
      >
        {item.icon}
      </span>
      <span className="flex-1 min-w-0 flex flex-col justify-center">
        <span className={`${compact ? 'text-[12px]' : 'text-[13px]'} font-medium truncate block leading-tight`}>
          {highlightTerm ? highlightQuery(item.label, highlightTerm) : item.label}
        </span>
        {item.description && (
          <span className="text-[11px] text-app-text-muted truncate block leading-tight mt-0.5">
            {item.description}
          </span>
        )}
      </span>
      {item.shortcut && (
        <kbd className="kbd flex-shrink-0">{item.shortcut}</kbd>
      )}
    </button>
  );
}

function ActionPill({ icon, label, shortcut, onClick }: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-app-text-muted hover:text-app-text hover:bg-app-hover rounded-md transition-colors flex-shrink-0 whitespace-nowrap"
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {icon} {label}
      {shortcut && <kbd className="kbd ml-1 opacity-60">{shortcut}</kbd>}
    </button>
  );
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'ora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h fa`;
  const days = Math.floor(hours / 24);
  return `${days}g fa`;
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
