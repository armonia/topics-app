import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { FileNode } from '../../types';
import { filesApi } from '../../lib/api';
import { getFileIcon } from '../../lib/fileIcons';

const EditorTabs = lazy(() => import('../Editor/EditorTabs').then(m => ({ default: m.EditorTabs })));

interface FileExplorerProps {
  projectPath: string;
  compact?: boolean;
  onOpenFile?: (path: string) => void;
  pendingFile?: string | null;
  onPendingFileConsumed?: () => void;
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
            ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary-dark'
            : isFocused
              ? 'bg-app-hover'
              : 'hover:bg-app-hover text-app-text-body'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        role="treeitem"
        tabIndex={-1}
      >
        {isDir ? (
          <>
            <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-app-text-tertiary">
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
            <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">
              {isExpanded
                ? <FolderOpen size={14} className="text-amber-400" />
                : <Folder size={14} className="text-amber-400" />
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
          <span className="ml-auto text-[10px] text-app-text-faint flex-shrink-0">
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

export function FileExplorer({ projectPath, compact, onOpenFile, pendingFile, onPendingFileConsumed }: FileExplorerProps) {
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
    if (compact && onOpenFile) {
      onOpenFile(node.path);
      return;
    }
    setSelectedFile(node);
    editorTabsRef.current?.openFile(node.path, node.name);
  }, [compact, onOpenFile]);

  // Open file from external source (e.g. Context Inspector memory tree)
  // Retry briefly to handle the case where EditorTabs hasn't mounted yet
  useEffect(() => {
    if (!pendingFile || compact) return;
    const tryOpen = () => {
      if (editorTabsRef.current) {
        const name = pendingFile.split('/').pop() || pendingFile;
        editorTabsRef.current.openFile(pendingFile, name);
        // Set selectedFile so the tree collapses to max-h-[200px]
        setSelectedFile({ name, path: pendingFile, type: 'file' });
        onPendingFileConsumed?.();
        return true;
      }
      return false;
    };
    if (tryOpen()) return;
    // Retry a few times for lazy-loaded EditorTabs
    let attempts = 0;
    const interval = setInterval(() => {
      if (tryOpen() || ++attempts > 10) {
        clearInterval(interval);
        if (attempts > 10) onPendingFileConsumed?.();
      }
    }, 100);
    return () => clearInterval(interval);
  }, [pendingFile, onPendingFileConsumed, compact]);

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
        <div className="flex items-center gap-2 text-app-text-tertiary text-[13px]">
          <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
          Loading files...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-red-500 text-[13px]">{error}</p>
        <button onClick={loadFiles} className="text-[12px] text-primary hover:underline">Retry</button>
      </div>
    );
  }

  if (compact) {
    return (
      <div
        ref={treeRef}
        className="flex-1 overflow-y-auto"
        role="tree"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
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
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* File tree */}
      <div
        ref={treeRef}
        className={`flex-shrink-0 overflow-y-auto border-b border-app-border ${selectedFile ? 'max-h-[200px]' : ''}`}
        role="tree"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-app-border sticky top-0 bg-surface z-10">
          <span className="text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">Explorer</span>
          <button
            onClick={loadFiles}
            className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors"
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
        <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" /></div>}>
          <EditorTabs ref={editorTabsRef} projectPath={projectPath} />
        </Suspense>
      </div>
    </div>
  );
}
