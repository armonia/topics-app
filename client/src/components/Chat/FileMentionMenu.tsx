import { useState, useEffect, useRef, useMemo } from 'react';
import { File, X, Search } from 'lucide-react';
import type { FileNode } from '../../types';
import { filesApi } from '../../lib/api';

export interface MentionedFile {
  path: string;
  name: string;
}

interface FileMentionMenuProps {
  projectPath: string;
  visible: boolean;
  filter: string;
  onSelect: (file: MentionedFile) => void;
  onClose: () => void;
  selectedIndex: number;
  onIndexChange: (index: number) => void;
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

export function FileMentionMenu({ projectPath, visible, filter, onSelect, onClose: _onClose, selectedIndex, onIndexChange }: FileMentionMenuProps) {
  const [allFiles, setAllFiles] = useState<{ path: string; name: string; depth: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Load project files
  useEffect(() => {
    if (!projectPath || !visible) return;
    
    // Only load once per projectPath
    if (allFiles.length > 0) return;
    
    setLoading(true);
    filesApi.list(projectPath, 4)
      .then(nodes => {
        const flat = flattenFiles(nodes);
        setAllFiles(flat);
      })
      .catch(err => console.error('Failed to load files for @mention:', err))
      .finally(() => setLoading(false));
  }, [projectPath, visible]);

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
      className="absolute bottom-full left-0 right-0 mb-1 bg-white dark:bg-[#1e1e1e] border border-[#e0e0e0] dark:border-[#333] rounded-lg shadow-xl z-50 overflow-hidden max-h-64 flex flex-col"
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-[#e8e8e8] dark:border-[#2a2a2a] flex items-center gap-2">
        <Search size={12} className="text-[#888]" />
        <span className="text-[11px] text-[#888] font-medium">Files</span>
        {filter && <span className="text-[11px] text-[var(--primary)] font-mono">@{filter}</span>}
        <div className="flex-1" />
        <span className="text-[10px] text-[#999] dark:text-[#666]">↑↓ navigate · Enter select · Esc close</span>
      </div>
      
      {/* File list */}
      <div className="overflow-y-auto flex-1">
        {loading ? (
          <div className="px-3 py-4 text-center text-[12px] text-[#888]">
            <div className="w-4 h-4 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin mx-auto mb-2" />
            Loading files...
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-[#888]">
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
                data-mention-idx={idx}
                onClick={() => onSelect({ path: file.path, name: file.name })}
                onMouseEnter={() => onIndexChange(idx)}
                className={`w-full px-3 py-1.5 text-left flex items-center gap-2 transition-colors ${
                  idx === selectedIndex
                    ? 'bg-[var(--primary)]/15 text-[#1a1a1a] dark:text-white'
                    : 'text-[#333] dark:text-[#e5e5e5] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a]'
                }`}
              >
                <File size={13} className="text-[#888] flex-shrink-0" />
                <span className="text-[12px] font-medium truncate">{file.name}</span>
                {dir && (
                  <span className="text-[10px] text-[#aaa] dark:text-[#666] truncate ml-auto flex-shrink-0">
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
  return (
    <span className="inline-flex items-center gap-1 bg-blue-100/80 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-md px-2 py-0.5 text-[11px] font-medium">
      <File size={11} className="flex-shrink-0" />
      <span className="truncate max-w-[120px]">{file.name}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="ml-0.5 text-blue-400 hover:text-blue-600 dark:hover:text-blue-200"
      >
        <X size={11} />
      </button>
    </span>
  );
}
