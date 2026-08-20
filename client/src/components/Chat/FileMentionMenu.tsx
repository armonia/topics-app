import { useState, useEffect, useRef, useMemo } from 'react';
import { useT } from '@/hooks/useT';
import { File, X, Search } from 'lucide-react';
import type { FileNode } from '../../types';
import { filesApi } from '../../lib/api';
import { POPOVER_PANEL } from '@/lib/popoverStyles';
import { useDismissable } from '@/hooks/useDismissable';
import { Spinner } from '../Shared/Spinner';

export interface MentionedFile {
  path: string;
  name: string;
}

interface FileMentionMenuProps {
  projectPath: string;
  visible: boolean;
  filter: string;
  onSelect: (file: MentionedFile) => void;
  selectedIndex: number;
  onIndexChange: (index: number) => void;
  /** Dismiss the menu (outside-pointer / Escape). Owned by the parent, which
   *  holds the open flag. */
  onClose?: () => void;
  /** The chat textarea — kept "inside" so typing/clicking in it never
   *  dismisses; restoreFocus:false so the caret is left untouched. */
  inputRef?: React.RefObject<HTMLElement | null>;
}

// Flatten file tree into a flat list of files (no dirs)
function flattenFiles(nodes: FileNode[], prefix = ''): { path: string; name: string; depth: number }[] {
  const result: { path: string; name: string; depth: number }[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push({ path: node.path, name: node.name, depth: prefix.split('/').length - 1 });
    }
    if (node.type === 'dir' && node.children) {
      result.push(...flattenFiles(node.children, prefix ? `${prefix}/${node.name}` : node.name));
    }
  }
  return result;
}

// Simple fuzzy match: all chars of query appear in order in target
function fuzzyMatch(query: string, target: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  
  if (!q) return { match: true, score: 0 };
  
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive matches score higher
      if (lastMatchIdx === ti - 1) score += 2;
      // Matches at word boundaries score higher
      if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '.' || t[ti - 1] === '-' || t[ti - 1] === '_') score += 3;
      score += 1;
      lastMatchIdx = ti;
      qi++;
    }
  }
  
  return { match: qi === q.length, score };
}

export function FileMentionMenu({ projectPath, visible, filter, onSelect, selectedIndex, onIndexChange, onClose, inputRef }: FileMentionMenuProps) {
  const [allFiles, setAllFiles] = useState<{ path: string; name: string; depth: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Unified dismissal: capture-phase outside-pointer + Escape close. The
  // textarea (which drives arrow/Enter selection) stays "inside" and the caret
  // is left untouched (restoreFocus:false).
  useDismissable({
    open: visible,
    onClose: onClose ?? (() => {}),
    refs: inputRef ? [inputRef, menuRef] : [menuRef],
    restoreFocus: false,
  });

  // Load project files — cached PER projectPath. The old guard was a bare
  // `allFiles.length > 0`, which pinned the FIRST project's list forever:
  // switching to a topic of another project kept offering (and inserting)
  // cross-project paths in @mentions.
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectPath || !visible) return;
    if (loadedForRef.current === projectPath && allFiles.length > 0) return;

    loadedForRef.current = projectPath;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot loading flag for the async filesApi fetch (external-system sync); the guard above makes this run at most once per projectPath
    setLoading(true);
    setAllFiles([]);
    filesApi.list(projectPath, 4)
      .then(nodes => {
        if (loadedForRef.current !== projectPath) return; // stale — switched again
        const flat = flattenFiles(nodes);
        setAllFiles(flat);
      })
      .catch(err => console.error('Failed to load files for @mention:', err))
      .finally(() => { if (loadedForRef.current === projectPath) setLoading(false); });
  }, [projectPath, visible, allFiles.length]);

  // Filter and sort files
  const filtered = useMemo(() => {
    if (!filter) return allFiles.slice(0, 20);
    
    return allFiles
      .map(f => {
        // Match against full path relative to project and also just filename
        const relPath = f.path.replace(projectPath + '/', '');
        const pathMatch = fuzzyMatch(filter, relPath);
        const nameMatch = fuzzyMatch(filter, f.name);
        const best = pathMatch.score >= nameMatch.score ? pathMatch : nameMatch;
        return { ...f, ...best, relPath };
      })
      .filter(f => f.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
  }, [allFiles, filter, projectPath]);

  // Scroll selected item into view
  useEffect(() => {
    if (itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!visible) return null;

  return (
    <div
      ref={menuRef}
      data-mention-menu
      className={`absolute bottom-full left-0 right-0 mb-1 ${POPOVER_PANEL} z-50 overflow-hidden max-h-64 flex flex-col`}
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-app-border flex items-center gap-2">
        <Search size={12} className="text-app-text-secondary" />
        <span className="text-[11px] text-app-text-muted font-medium">Files</span>
        {filter && <span className="text-[11px] text-primary font-mono">@{filter}</span>}
        <div className="flex-1" />
        <span className="text-[11px] text-app-text-muted">↑↓ navigate · Enter select · Esc close</span>
      </div>
      
      {/* File list */}
      <div role="listbox" className="overflow-y-auto flex-1">
        {loading ? (
          <div className="px-3 py-4 text-center text-[12px] text-app-text-muted">
            <Spinner size="md" className="mx-auto mb-2" />
            Loading files...
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-app-text-muted">
            No files found
          </div>
        ) : (
          filtered.map((file, idx) => {
            const relPath = file.path.replace(projectPath + '/', '');
            const dir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
            
            return (
              <button
                key={file.path}
                ref={el => { itemRefs.current[idx] = el; }}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                data-mention-idx={idx}
                onClick={() => onSelect({ path: file.path, name: file.name })}
                onMouseEnter={() => onIndexChange(idx)}
                className={`w-full px-3 py-1.5 text-left flex items-center gap-2 transition-colors ${
                  idx === selectedIndex
                    ? 'bg-primary/15 text-app-text'
                    : 'text-app-text hover:bg-app-hover'
                }`}
              >
                <File size={14} className="text-app-text-muted flex-shrink-0" />
                <span className="text-[12px] font-medium truncate">{file.name}</span>
                {dir && (
                  <span className="text-[11px] text-app-text-muted truncate ml-auto flex-shrink-0">
                    {dir}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// Pill component for mentioned files

export function FilePill({ file, onRemove }: { file: MentionedFile; onRemove: () => void }) {
  const tr = useT();
  return (
    <span className="inline-flex items-center gap-1 bg-blue-100/80 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-md px-2 py-0.5 text-[11px] font-medium">
      <File size={12} className="flex-shrink-0" />
      <span className="truncate max-w-[120px]">{file.name}</span>
      <button aria-label={tr('ctx.removeFile')}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="ml-0.5 text-blue-400 hover:text-blue-600 dark:hover:text-blue-200"
      >
        <X size={12} />
      </button>
    </span>
  );
}
