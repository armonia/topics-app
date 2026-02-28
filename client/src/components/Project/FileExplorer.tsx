import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Folder, RefreshCw, FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import type { FileNode } from '../../types';
import { filesApi, gitApi } from '../../lib/api';
import { getFileIconDef } from '../../lib/fileIcons';

const EditorTabs = lazy(() => import('../Editor/EditorTabs').then(m => ({ default: m.EditorTabs })));

interface FileExplorerProps {
  projectPath: string;
  compact?: boolean;
  onOpenFile?: (path: string) => void;
  pendingFile?: string | null;
  onPendingFileConsumed?: () => void;
}

const DIR_CHILDREN_LIMIT = 300;

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  expandedOverflow: Set<string>;
  onToggleDir: (path: string) => void;
  onExpandOverflow: (path: string) => void;
  onSelectFile: (node: FileNode) => void;
  focusedPath: string | null;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  renamingPath: string | null;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  newItemParent: string | null;
  newItemType: 'file' | 'dir' | null;
  onNewItemSubmit: (name: string) => void;
  onNewItemCancel: () => void;
  gitFileMap: Map<string, string>;
  gitDirSet: Set<string>;
}

function InlineInput({ depth, icon, onSubmit, onCancel }: {
  depth: number;
  icon: React.ReactNode;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (value.trim()) onSubmit(value.trim());
      else onCancel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-[3px] md:py-[3px] min-h-[44px] md:min-h-[28px] text-[12px] bg-app-hover"
      style={{ paddingLeft: `${depth * 16 + 12}px` }}
    >
      <span className="w-4 h-4 flex-shrink-0" />
      <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">{icon}</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (value.trim()) onSubmit(value.trim()); else onCancel(); }}
        className="flex-1 min-w-0 bg-surface border border-primary/50 rounded px-1.5 py-0.5 text-[12px] text-app-text outline-none focus:border-primary"
      />
    </div>
  );
}

function getGitStatusColor(status: string): string {
  if (status === '??' || status === 'A' || status === 'AM') return 'text-green-400';
  if (status === 'M' || status === 'MM') return 'text-amber-400';
  if (status === 'D') return 'text-red-400';
  if (status === 'R' || status.startsWith('R')) return 'text-blue-400';
  return 'text-amber-400'; // fallback for other statuses
}

function getGitStatusLabel(status: string): string {
  if (status === '??') return 'U';
  if (status === 'A' || status === 'AM') return 'A';
  if (status === 'D') return 'D';
  if (status === 'R' || status.startsWith('R')) return 'R';
  if (status === 'M' || status === 'MM') return 'M';
  return 'M';
}

function TreeNode({ node, depth, selectedPath, expandedDirs, expandedOverflow, onToggleDir, onExpandOverflow, onSelectFile, focusedPath, onContextMenu, renamingPath, onRenameSubmit, onRenameCancel, newItemParent, newItemType, onNewItemSubmit, onNewItemCancel, gitFileMap, gitDirSet }: TreeNodeProps) {
  const isDir = node.type === 'dir';
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isFocused = focusedPath === node.path;
  const gitStatus = isDir ? undefined : gitFileMap.get(node.path);
  const dirHasChanges = isDir && gitDirSet.has(node.path);
  const isRenaming = renamingPath === node.path;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameValue, setRenameValue] = useState(node.name);
  const showNewItemInput = isDir && isExpanded && newItemParent === node.path;

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(node.name);
      setTimeout(() => {
        if (renameInputRef.current) {
          renameInputRef.current.focus();
          // Select the name part before the extension for files
          const dotIdx = node.name.lastIndexOf('.');
          if (!isDir && dotIdx > 0) {
            renameInputRef.current.setSelectionRange(0, dotIdx);
          } else {
            renameInputRef.current.select();
          }
        }
      }, 0);
    }
  }, [isRenaming, node.name, isDir]);

  const handleClick = () => {
    if (isRenaming) return;
    if (isDir) {
      onToggleDir(node.path);
    } else {
      onSelectFile(node);
    }
  };

  const handleDoubleClick = () => {
    if (isRenaming || isDir) return;
    // Pin the file pane (make it permanent, not preview)
    window.dispatchEvent(new CustomEvent('pin-file-pane', { detail: { path: node.path } }));
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (renameValue.trim() && renameValue.trim() !== node.name) {
        onRenameSubmit(node.path, renameValue.trim());
      } else {
        onRenameCancel();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRenameCancel();
    }
  };

  const handleRenameBlur = () => {
    if (renameValue.trim() && renameValue.trim() !== node.name) {
      onRenameSubmit(node.path, renameValue.trim());
    } else {
      onRenameCancel();
    }
  };

  return (
    <>
      <div
        className={`flex items-center gap-1.5 px-2 py-[3px] md:py-[3px] min-h-[44px] md:min-h-[28px] cursor-pointer text-[12px] select-none transition-colors ${
          isSelected
            ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary-dark'
            : isFocused
              ? 'bg-app-hover'
              : 'hover:bg-app-hover text-app-text-body'
        }`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={e => onContextMenu(e, node)}
        role="treeitem"
        tabIndex={-1}
      >
        {isDir ? (
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-app-text-tertiary">
            <ChevronRight size={12} className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
          </span>
        ) : (
          <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">{(() => { const d = getFileIconDef(node.name); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
        )}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            onClick={e => e.stopPropagation()}
            className="flex-1 min-w-0 bg-surface border border-primary/50 rounded px-1.5 py-0.5 text-[12px] text-app-text outline-none focus:border-primary"
          />
        ) : (
          <>
            <span className={`truncate ${isDir ? 'font-medium' : ''} ${
              !isSelected && gitStatus ? getGitStatusColor(gitStatus)
              : !isSelected && dirHasChanges ? 'text-amber-400'
              : ''
            }`}>{node.name}</span>
            {gitStatus && !isSelected && (
              <span className={`text-[10px] flex-shrink-0 ml-1 ${getGitStatusColor(gitStatus)}`}>
                {getGitStatusLabel(gitStatus)}
              </span>
            )}
            {node.size !== undefined && !isDir && !gitStatus && (
              <span className="ml-auto text-[10px] text-app-text-faint flex-shrink-0">
                {node.size < 1024 ? `${node.size}B` : node.size < 1048576 ? `${(node.size / 1024).toFixed(1)}K` : `${(node.size / 1048576).toFixed(1)}M`}
              </span>
            )}
          </>
        )}
      </div>
      {isDir && isExpanded && (
        <>
          {showNewItemInput && (
            <InlineInput
              depth={depth + 1}
              icon={newItemType === 'dir'
                ? <Folder size={14} className="text-amber-400" />
                : (() => { const d = getFileIconDef(''); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()
              }
              onSubmit={onNewItemSubmit}
              onCancel={onNewItemCancel}
            />
          )}
          {node.children && (() => {
            const all = node.children;
            const showAll = expandedOverflow.has(node.path);
            const visible = showAll ? all : all.slice(0, DIR_CHILDREN_LIMIT);
            const remaining = all.length - DIR_CHILDREN_LIMIT;
            return (
              <>
                {visible.map(child => (
                  <TreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    selectedPath={selectedPath}
                    expandedDirs={expandedDirs}
                    expandedOverflow={expandedOverflow}
                    onToggleDir={onToggleDir}
                    onExpandOverflow={onExpandOverflow}
                    onSelectFile={onSelectFile}
                    focusedPath={focusedPath}
                    onContextMenu={onContextMenu}
                    renamingPath={renamingPath}
                    onRenameSubmit={onRenameSubmit}
                    onRenameCancel={onRenameCancel}
                    newItemParent={newItemParent}
                    newItemType={newItemType}
                    onNewItemSubmit={onNewItemSubmit}
                    onNewItemCancel={onNewItemCancel}
                    gitFileMap={gitFileMap}
                    gitDirSet={gitDirSet}
                  />
                ))}
                {!showAll && remaining > 0 && (
                  <div
                    className="flex items-center gap-1.5 px-2 py-[3px] md:py-[3px] min-h-[28px] cursor-pointer text-[11px] text-primary hover:bg-primary/5 transition-colors"
                    style={{ paddingLeft: `${(depth + 1) * 16 + 12}px` }}
                    onClick={() => onExpandOverflow(node.path)}
                  >
                    Show {remaining.toLocaleString()} more items...
                  </div>
                )}
              </>
            );
          })()}
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
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [contextMenuNode, setContextMenuNode] = useState<FileNode | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [newItemParent, setNewItemParent] = useState<string | null>(null);
  const [newItemType, setNewItemType] = useState<'file' | 'dir' | null>(null);
  const [expandedOverflow, setExpandedOverflow] = useState<Set<string>>(new Set());
  const [gitFileMap, setGitFileMap] = useState<Map<string, string>>(new Map());
  const [gitDirSet, setGitDirSet] = useState<Set<string>>(new Set());
  const treeRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const editorTabsRef = useRef<{ openFile: (path: string, name: string) => void } | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenuPos(null);
    setContextMenuNode(null);
  }, []);

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

  // Fetch git status and build lookup maps
  useEffect(() => {
    let active = true;
    const fetchGitStatus = async () => {
      try {
        const status = await gitApi.status(projectPath);
        if (!active) return;
        const fileMap = new Map<string, string>();
        const dirSet = new Set<string>();
        for (const f of status.files) {
          const absPath = projectPath + '/' + f.path;
          fileMap.set(absPath, f.status);
          // Propagate to all parent directories
          let dir = absPath.substring(0, absPath.lastIndexOf('/'));
          while (dir.length >= projectPath.length) {
            dirSet.add(dir);
            const next = dir.substring(0, dir.lastIndexOf('/'));
            if (next === dir) break;
            dir = next;
          }
        }
        setGitFileMap(fileMap);
        setGitDirSet(dirSet);
      } catch {
        // silently ignore — not a git repo or git not available
      }
    };
    fetchGitStatus();
    const interval = setInterval(fetchGitStatus, 10_000);
    return () => { active = false; clearInterval(interval); };
  }, [projectPath]);

  const handleExpandOverflow = useCallback((path: string) => {
    setExpandedOverflow(prev => { const next = new Set(prev); next.add(path); return next; });
  }, []);

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

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenuNode(node);
  }, []);

  const getParentDir = useCallback((path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash > 0 ? path.substring(0, lastSlash) : path;
  }, []);

  const handleNewItem = useCallback((type: 'file' | 'dir') => {
    if (!contextMenuNode) return;
    const parentDir = contextMenuNode.type === 'dir' ? contextMenuNode.path : getParentDir(contextMenuNode.path);
    // Ensure the parent dir is expanded so the inline input is visible
    setExpandedDirs(prev => {
      const next = new Set(prev);
      next.add(parentDir);
      return next;
    });
    setNewItemParent(parentDir);
    setNewItemType(type);
    closeContextMenu();
  }, [contextMenuNode, getParentDir, closeContextMenu]);

  const handleNewItemSubmit = useCallback(async (name: string) => {
    if (!newItemParent || !newItemType) return;
    const fullPath = `${newItemParent}/${name}`;
    try {
      await filesApi.create(fullPath, newItemType);
      await loadFiles();
    } catch (err: any) {
      console.error('Failed to create item:', err);
    }
    setNewItemParent(null);
    setNewItemType(null);
  }, [newItemParent, newItemType, loadFiles]);

  const handleNewItemCancel = useCallback(() => {
    setNewItemParent(null);
    setNewItemType(null);
  }, []);

  const handleRename = useCallback(() => {
    if (!contextMenuNode) return;
    setRenamingPath(contextMenuNode.path);
    closeContextMenu();
  }, [contextMenuNode, closeContextMenu]);

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    const parentDir = getParentDir(oldPath);
    const newPath = `${parentDir}/${newName}`;
    try {
      await filesApi.rename(oldPath, newPath);
      await loadFiles();
    } catch (err: any) {
      console.error('Failed to rename:', err);
    }
    setRenamingPath(null);
  }, [getParentDir, loadFiles]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!contextMenuNode) return;
    const confirmed = window.confirm(`Delete "${contextMenuNode.name}"? This cannot be undone.`);
    if (!confirmed) { closeContextMenu(); return; }
    try {
      await filesApi.remove(contextMenuNode.path);
      await loadFiles();
    } catch (err: any) {
      console.error('Failed to delete:', err);
    }
    closeContextMenu();
  }, [contextMenuNode, closeContextMenu, loadFiles]);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenuPos) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenuPos, closeContextMenu]);

  // Compute adjusted context menu position to stay within viewport
  const contextMenuStyle = useCallback(() => {
    if (!contextMenuPos) return { left: 0, top: 0 };
    const menuWidth = 180;
    const menuHeight = 160;
    let x = contextMenuPos.x;
    let y = contextMenuPos.y;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;
    if (x < 0) x = 8;
    if (y < 0) y = 8;
    return { left: x, top: y };
  }, [contextMenuPos]);

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

  // Render the context menu portal
  const contextMenuPortal = contextMenuPos && contextMenuNode && createPortal(
    <div
      ref={contextMenuRef}
      role="menu"
      className="fixed z-50 bg-surface border border-app-border rounded-lg shadow-lg py-1 min-w-[170px]"
      style={contextMenuStyle()}
    >
      <button
        role="menuitem"
        onClick={() => handleNewItem('file')}
        className="w-full text-left px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors flex items-center gap-2"
      >
        <FilePlus size={14} className="text-app-text-tertiary" /> New File
      </button>
      <button
        role="menuitem"
        onClick={() => handleNewItem('dir')}
        className="w-full text-left px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors flex items-center gap-2"
      >
        <FolderPlus size={14} className="text-app-text-tertiary" /> New Folder
      </button>
      <div className="border-t border-app-border my-1" />
      <button
        role="menuitem"
        onClick={handleRename}
        className="w-full text-left px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors flex items-center gap-2"
      >
        <Pencil size={14} className="text-app-text-tertiary" /> Rename
      </button>
      <button
        role="menuitem"
        onClick={handleDelete}
        className="w-full text-left px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-2"
      >
        <Trash2 size={14} /> Delete
      </button>
    </div>,
    document.body
  );

  if (compact) {
    return (
      <>
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
              expandedOverflow={expandedOverflow}
              onToggleDir={handleToggleDir}
              onExpandOverflow={handleExpandOverflow}
              onSelectFile={handleSelectFile}
              focusedPath={focusedPath}
              onContextMenu={handleContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              newItemParent={newItemParent}
              newItemType={newItemType}
              onNewItemSubmit={handleNewItemSubmit}
              onNewItemCancel={handleNewItemCancel}
              gitFileMap={gitFileMap}
              gitDirSet={gitDirSet}
            />
          ))}
        </div>
        {contextMenuPortal}
      </>
    );
  }

  return (
    <>
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
              expandedOverflow={expandedOverflow}
              onToggleDir={handleToggleDir}
              onExpandOverflow={handleExpandOverflow}
              onSelectFile={handleSelectFile}
              focusedPath={focusedPath}
              onContextMenu={handleContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              newItemParent={newItemParent}
              newItemType={newItemType}
              onNewItemSubmit={handleNewItemSubmit}
              onNewItemCancel={handleNewItemCancel}
              gitFileMap={gitFileMap}
              gitDirSet={gitDirSet}
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
      {contextMenuPortal}
    </>
  );
}
