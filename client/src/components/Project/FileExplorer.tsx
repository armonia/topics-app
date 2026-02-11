import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { FileNode } from '../../types';
import { filesApi } from '../../lib/api';
import { EditorTabs } from '../Editor/EditorTabs';

interface FileExplorerProps {
  projectPath: string;
  compact?: boolean;
  onOpenFile?: (path: string) => void;
}

// File icon based on extension
function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟡', jsx: '⚛️',
    json: '📋', md: '📝', css: '🎨', scss: '🎨',
    html: '🌐', svg: '🖼️', png: '🖼️', jpg: '🖼️', gif: '🖼️', webp: '🖼️',
    py: '🐍', rs: '🦀', go: '🐹', rb: '💎',
    sh: '🐚', bash: '🐚', zsh: '🐚',
    yaml: '⚙️', yml: '⚙️', toml: '⚙️',
    env: '🔒', lock: '🔒',
    sql: '🗄️', graphql: '◈', gql: '◈',
    swift: '🦅', kt: '🟣', java: '☕',
    txt: '📄', csv: '📊', xml: '📰',
    gitignore: '🚫', dockerfile: '🐳',
  };
  const nameIcons: Record<string, string> = {
    'Dockerfile': '🐳', '.gitignore': '🚫', '.env': '🔒',
    'package.json': '📦', 'tsconfig.json': '🔷', 'Cargo.toml': '🦀',
    'Makefile': '🔧', 'README.md': '📖',
  };
  return nameIcons[name] || icons[ext] || '📄';
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (node: FileNode) => void;
  focusedPath: string | null;
}

function TreeNode({ node, depth, selectedPath, expandedDirs, onToggleDir, onSelectFile, focusedPath }: TreeNodeProps) {
  const isDir = node.type === 'dir';
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isFocused = focusedPath === node.path;

  const handleClick = () => {
    if (isDir) {
      onToggleDir(node.path);
    } else {
      onSelectFile(node);
    }
  };

  return (
    <>
      <div
        className={`flex items-center gap-1 px-2 py-[3px] md:py-[3px] min-h-[44px] md:min-h-[28px] cursor-pointer text-[12px] select-none transition-colors ${
          isSelected
            ? 'bg-[var(--primary)]/10 text-[var(--primary)] dark:bg-[var(--primary)]/20 dark:text-[#4d94ff]'
            : isFocused
              ? 'bg-[#f0f0f0] dark:bg-[#2a2a2a]'
              : 'hover:bg-[#f5f5f5] dark:hover:bg-[#222] text-[#444] dark:text-[#bbb]'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        role="treeitem"
        tabIndex={-1}
      >
        {isDir ? (
          <>
            <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-[#8b8b8b]">
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
            <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">
              {isExpanded
                ? <FolderOpen size={14} className="text-[#dcb67a]" />
                : <Folder size={14} className="text-[#dcb67a]" />
              }
            </span>
          </>
        ) : (
          <>
            <span className="w-4 h-4 flex-shrink-0" />
            <span className="text-[13px] leading-none flex-shrink-0">{getFileIcon(node.name)}</span>
          </>
        )}
        <span className={`truncate ${isDir ? 'font-medium' : ''}`}>{node.name}</span>
        {node.size !== undefined && !isDir && (
          <span className="ml-auto text-[10px] text-[#aaa] dark:text-[#666] flex-shrink-0">
            {node.size < 1024 ? `${node.size}B` : node.size < 1048576 ? `${(node.size / 1024).toFixed(1)}K` : `${(node.size / 1048576).toFixed(1)}M`}
          </span>
        )}
      </div>
      {isDir && isExpanded && node.children && (
        <>
          {node.children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              focusedPath={focusedPath}
            />
          ))}
        </>
      )}
    </>
  );
}

export function FileExplorer({ projectPath }: FileExplorerProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const editorTabsRef = useRef<{ openFile: (path: string, name: string) => void } | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await filesApi.list(projectPath, 3);
      setFiles(result);
      const firstLevel = new Set<string>();
      result.forEach(f => { if (f.type === 'dir') firstLevel.add(f.path); });
      setExpandedDirs(firstLevel);
    } catch (err: any) {
      setError(err.message || 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleToggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelectFile = useCallback((node: FileNode) => {
    setSelectedFile(node);
    editorTabsRef.current?.openFile(node.path, node.name);
  }, []);

  // Flatten tree for keyboard navigation
  const flattenTree = useCallback((nodes: FileNode[]): FileNode[] => {
    const result: FileNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (node.type === 'dir' && expandedDirs.has(node.path) && node.children) {
        result.push(...flattenTree(node.children));
      }
    }
    return result;
  }, [expandedDirs]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const flat = flattenTree(files);
    const currentIdx = flat.findIndex(f => f.path === focusedPath);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(currentIdx + 1, flat.length - 1);
      setFocusedPath(flat[next]?.path || null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(currentIdx - 1, 0);
      setFocusedPath(flat[prev]?.path || null);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const node = flat[currentIdx];
      if (node?.type === 'dir' && !expandedDirs.has(node.path)) {
        handleToggleDir(node.path);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const node = flat[currentIdx];
      if (node?.type === 'dir' && expandedDirs.has(node.path)) {
        handleToggleDir(node.path);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const node = flat[currentIdx];
      if (node) {
        if (node.type === 'dir') handleToggleDir(node.path);
        else handleSelectFile(node);
      }
    }
  }, [files, focusedPath, expandedDirs, flattenTree, handleToggleDir, handleSelectFile]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[#8b8b8b] text-[13px]">
          <div className="w-4 h-4 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin" />
          Loading files...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-red-500 text-[13px]">{error}</p>
        <button onClick={loadFiles} className="text-[12px] text-[var(--primary)] hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* File tree */}
      <div
        ref={treeRef}
        className={`flex-shrink-0 overflow-y-auto border-b border-[#e8e8e8] dark:border-[#2a2a2a] ${selectedFile ? 'max-h-[200px]' : ''}`}
        role="tree"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#e8e8e8] dark:border-[#2a2a2a] sticky top-0 bg-white dark:bg-[#1a1a1a] z-10">
          <span className="text-[11px] font-medium text-[#8b8b8b] uppercase tracking-wider">Explorer</span>
          <button
            onClick={loadFiles}
            className="p-1 rounded hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a] text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
        {files.map(node => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedFile?.path || null}
            expandedDirs={expandedDirs}
            onToggleDir={handleToggleDir}
            onSelectFile={handleSelectFile}
            focusedPath={focusedPath}
          />
        ))}
      </div>

      {/* Editor tabs */}
      <div className="flex-1 min-w-0 min-h-[300px] flex flex-col overflow-hidden">
        <EditorTabs ref={editorTabsRef} projectPath={projectPath} />
      </div>
    </div>
  );
}
