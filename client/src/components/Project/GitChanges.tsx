import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import { GitBranch, Clock, RefreshCw, User, ArrowDown, ArrowUp, GitCommit, Plus, Minus, CheckCircle, Sparkles, ChevronDown, ChevronRight, Undo2, Globe, Trash2, Link, FileText } from 'lucide-react';
import type { GitStatus as _GitStatus } from '../../types';
import { gitApi, filesApi } from '../../lib/api';
import { basename as pathBasename } from '../../lib/path-utils';
import { BranchList } from '../Git/BranchList';
import { DiffViewer } from '../Editor/DiffViewer';
import { useGitStatus, gitCache } from '../../hooks/useGitStatus';
import { useToast } from '../Shared/Toast';

interface GitChangesProps {
  projectPath: string;
  compact?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFileStaged(status: string): boolean {
  return status.length >= 1 && status[0] !== ' ' && status[0] !== '?';
}

function hasUnstagedChanges(status: string): boolean {
  return status === '??' || (status.length >= 2 && status[1] !== ' ');
}

function statusLabel(status: string): { text: string; color: string; bg: string } {
  // `status` is the raw 2-char XY porcelain code (e.g. " M", "M ", "MM", "??").
  // The staged/unstaged predicates read it positionally; for the label we
  // collapse the padding so " M"/"M " both render as "M".
  const s = status.trim();
  switch (s) {
    case 'M': return { text: 'M', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' };
    case 'A': return { text: 'A', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' };
    case 'D': return { text: 'D', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30' };
    case 'R': return { text: 'R', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/30' };
    case '??': return { text: 'U', color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-100 dark:bg-purple-900/30' };
    case 'MM': return { text: 'MM', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' };
    case 'AM': return { text: 'AM', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' };
    default: return { text: s || status, color: 'text-gray-500 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-800' };
  }
}

export function GitChanges({ projectPath, compact = false, expanded = true, onToggle }: GitChangesProps) {
  const { gitStatus, loading, error, notGit, reload: loadStatus } = useGitStatus({ projectPath });
  const toast = useToast();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string>('');
  const [modifiedContent, setModifiedContent] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [stagingAll, setStagingAll] = useState(false);
  const [stagedExpanded, setStagedExpanded] = useState(true);
  const [unstagedExpanded, setUnstagedExpanded] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [remotes, setRemotes] = useState<{ name: string; fetchUrl: string; pushUrl: string }[]>(() => gitCache.get(projectPath)?.remotes ?? []);
  const [remotesExpanded, setRemotesExpanded] = useState(false);
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [newRemoteName, setNewRemoteName] = useState('origin');
  const [newRemoteUrl, setNewRemoteUrl] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [discardConfirm, setDiscardConfirm] = useState<{ files: string[]; group: 'staged' | 'unstaged' } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; group: 'staged' | 'unstaged' } | null>(null);
  const lastClickedRef = useRef<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const commitInputRef = useRef<HTMLInputElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const branchBtnRef = useRef<HTMLButtonElement>(null);

  // Close branch dropdown on click outside
  useEffect(() => {
    if (!showBranches) return;
    const onClick = (e: MouseEvent) => {
      if (
        branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node) &&
        branchBtnRef.current && !branchBtnRef.current.contains(e.target as Node)
      ) {
        setShowBranches(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showBranches]);

  // Detect dark mode
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    const check = () => setDarkMode(document.documentElement.classList.contains('dark'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const loadRemotes = useCallback(async () => {
    try {
      const result = await gitApi.remotes(projectPath);
      setRemotes(result);
      // Update cache
      const prev = gitCache.get(projectPath);
      if (prev) {
        gitCache.set(projectPath, { ...prev, remotes: result });
        window.dispatchEvent(new CustomEvent('git-cache-updated'));
      }
    } catch {
      setRemotes([]);
    }
  }, [projectPath]);

  const handleInit = useCallback(async () => {
    try {
      setInitializing(true);
      await gitApi.init(projectPath);
      await loadStatus();
      await loadRemotes();
    } catch {
      // error state is handled by useGitStatus
    } finally {
      setInitializing(false);
    }
  }, [projectPath, loadStatus, loadRemotes]);

  const handleAddRemote = useCallback(async () => {
    const name = newRemoteName.trim();
    const url = newRemoteUrl.trim();
    if (!name || !url) return;
    try {
      setAddingRemote(true);
      await gitApi.addRemote(projectPath, name, url);
      setNewRemoteName('origin');
      setNewRemoteUrl('');
      setShowAddRemote(false);
      await loadRemotes();
    } catch (err: unknown) {
      toast.error(errMessage(err));
    } finally {
      setAddingRemote(false);
    }
  }, [projectPath, newRemoteName, newRemoteUrl, loadRemotes, toast]);

  const handleRemoveRemote = useCallback(async (name: string) => {
    try {
      await gitApi.removeRemote(projectPath, name);
      await loadRemotes();
    } catch (err: unknown) {
      toast.error(errMessage(err));
    }
  }, [projectPath, loadRemotes, toast]);

  // Load remotes ONCE when the repo first becomes valid (per projectPath) —
  // not on every poll. useGitStatus hands back a fresh gitStatus object each
  // ~15s poll, so depending on its identity refetched remotes every cycle for
  // the panel's lifetime. Remotes change rarely and are reloaded explicitly
  // after init/add/remove.
  const remotesLoadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (notGit || !gitStatus) return;
    if (remotesLoadedForRef.current === projectPath) return;
    remotesLoadedForRef.current = projectPath;
    loadRemotes();
  }, [projectPath, notGit, gitStatus, loadRemotes]);

  const handleFileClick = useCallback(async (filePath: string) => {
    if (compact) {
      // Dispatch event to open diff in editor tabs
      window.dispatchEvent(new CustomEvent('open-file-diff', { detail: { filePath, projectPath } }));
      return;
    }
    setSelectedFile(filePath);
    setLoadingDiff(true);
    try {
      const original = await gitApi.show(projectPath, filePath);
      const fullPath = `${projectPath}/${filePath}`;
      let modified = '';
      try {
        modified = await filesApi.content(fullPath);
      } catch {
        modified = '';
      }
      setOriginalContent(original);
      setModifiedContent(modified);
    } catch (err: unknown) {
      setOriginalContent('');
      setModifiedContent('Error loading diff: ' + errMessage(err));
    } finally {
      setLoadingDiff(false);
    }
  }, [projectPath, compact]);

  const handleStage = useCallback(async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await gitApi.stage(projectPath, filePath);
      await loadStatus();
    } catch (err: unknown) {
      toast.error(errMessage(err));
    }
  }, [projectPath, loadStatus, toast]);

  const handleUnstage = useCallback(async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await gitApi.unstage(projectPath, filePath);
      await loadStatus();
    } catch (err: unknown) {
      toast.error(errMessage(err));
    }
  }, [projectPath, loadStatus, toast]);

  const handleStageAll = useCallback(async () => {
    try {
      setStagingAll(true);
      await gitApi.stageAll(projectPath);
      await loadStatus();
    } catch (err: unknown) {
      toast.error(errMessage(err));
    } finally {
      setStagingAll(false);
    }
  }, [projectPath, loadStatus, toast]);

  const handleUnstageAll = useCallback(async () => {
    try {
      await gitApi.unstageAll(projectPath);
      await loadStatus();
    } catch (err: unknown) {
      toast.error(errMessage(err));
    }
  }, [projectPath, loadStatus, toast]);

  const handleDiscard = useCallback((filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDiscardConfirm({ files: [filePath], group: 'unstaged' });
  }, []);

  const executeDiscard = useCallback(async (files: string[]) => {
    try {
      if (files.length === 1) {
        await gitApi.discard(projectPath, files[0]);
      } else {
        await gitApi.discardFiles(projectPath, files);
      }
      await loadStatus();
    } catch (err: unknown) {
      toast.error(errMessage(err));
    }
    setDiscardConfirm(null);
  }, [projectPath, loadStatus, toast]);

  // --- Multi-select helpers ---
  const getFileList = useCallback((group: 'staged' | 'unstaged') => {
    if (!gitStatus) return [];
    const predicate = group === 'staged' ? isFileStaged : hasUnstagedChanges;
    return gitStatus.files.filter(f => predicate(f.status));
  }, [gitStatus]);

  const handleFileSelect = useCallback((filePath: string, group: 'staged' | 'unstaged', e: React.MouseEvent) => {
    const isMultiKey = e.metaKey || e.ctrlKey;
    const isRange = e.shiftKey;

    if (isRange && lastClickedRef.current) {
      // Shift+click: range select within the same group
      const files = getFileList(group).map(f => f.path);
      const lastIdx = files.indexOf(lastClickedRef.current);
      const curIdx = files.indexOf(filePath);
      if (lastIdx !== -1 && curIdx !== -1) {
        const start = Math.min(lastIdx, curIdx);
        const end = Math.max(lastIdx, curIdx);
        const range = files.slice(start, end + 1);
        setSelectedFiles(prev => {
          const next = new Set(prev);
          for (const f of range) next.add(f);
          return next;
        });
      }
    } else if (isMultiKey) {
      // Cmd/Ctrl+click: toggle single item
      setSelectedFiles(prev => {
        const next = new Set(prev);
        if (next.has(filePath)) next.delete(filePath);
        else next.add(filePath);
        return next;
      });
      lastClickedRef.current = filePath;
    } else {
      // Plain click: single select + open file
      setSelectedFiles(new Set([filePath]));
      lastClickedRef.current = filePath;
      handleFileClick(filePath);
      return;
    }
  }, [getFileList, handleFileClick]);

  const handleContextMenu = useCallback((e: React.MouseEvent, filePath: string, group: 'staged' | 'unstaged') => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicked file is not in selection, select only it
    if (!selectedFiles.has(filePath)) {
      setSelectedFiles(new Set([filePath]));
    }
    setContextMenu({ x: e.clientX, y: e.clientY, group });
  }, [selectedFiles]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Close context menu on outside click / escape
  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu(); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onMouseDown); document.removeEventListener('keydown', onKey); };
  }, [contextMenu, closeContextMenu]);

  // Clear selection when the set of changed files changes
  const fileKeys = useMemo(() => gitStatus?.files.map(f => f.path).sort().join('\n') ?? '', [gitStatus]);
  useEffect(() => { setSelectedFiles(new Set()); }, [fileKeys]);

  // --- Batch context menu actions ---
  const handleBatchStage = useCallback(async () => {
    const files = [...selectedFiles];
    closeContextMenu();
    try {
      await gitApi.stageFiles(projectPath, files);
      await loadStatus();
    } catch (err: unknown) { toast.error(errMessage(err)); }
  }, [selectedFiles, projectPath, loadStatus, closeContextMenu, toast]);

  const handleBatchUnstage = useCallback(async () => {
    const files = [...selectedFiles];
    closeContextMenu();
    try {
      await gitApi.unstageFiles(projectPath, files);
      await loadStatus();
    } catch (err: unknown) { toast.error(errMessage(err)); }
  }, [selectedFiles, projectPath, loadStatus, closeContextMenu, toast]);

  const handleBatchDiscard = useCallback(() => {
    const files = [...selectedFiles];
    closeContextMenu();
    setDiscardConfirm({ files, group: 'unstaged' });
  }, [selectedFiles, closeContextMenu]);

  const handleBatchOpen = useCallback(() => {
    closeContextMenu();
    if (selectedFiles.size === 1) {
      handleFileClick([...selectedFiles][0]);
    }
  }, [selectedFiles, handleFileClick, closeContextMenu]);

  const handleGenerateMessage = useCallback(async () => {
    try {
      setGeneratingMsg(true);
      // Try AI-generated message first, fall back to rule-based
      try {
        const aiResult = await gitApi.aiCommitMessage(projectPath);
        setCommitMessage(aiResult.message);
      } catch {
        const result = await gitApi.diffSummary(projectPath);
        setCommitMessage(result.message);
      }
    } catch (err: unknown) {
      toast.error(errMessage(err));
    } finally {
      setGeneratingMsg(false);
    }
  }, [projectPath, toast]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    try {
      setCommitting(true);
      await gitApi.commit(projectPath, commitMessage);
      setCommitMessage('');
      await loadStatus();
      toast.success('Committed!');
    } catch (err: unknown) {
      toast.error(`Commit failed: ${errMessage(err)}`);
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, projectPath, loadStatus, toast]);

  const handlePull = useCallback(async () => {
    try {
      setPulling(true);
      const result = await gitApi.pull(projectPath);
      toast.success(result.output || 'Pull complete');
      await loadStatus();
    } catch (err: unknown) {
      toast.error(`Pull failed: ${errMessage(err)}`);
    } finally {
      setPulling(false);
    }
  }, [projectPath, loadStatus, toast]);

  const handlePush = useCallback(async () => {
    try {
      setPushing(true);
      const result = await gitApi.push(projectPath);
      toast.success(result.output || 'Push complete');
      await loadStatus();
    } catch (err: unknown) {
      toast.error(`Push failed: ${errMessage(err)}`);
    } finally {
      setPushing(false);
    }
  }, [projectPath, loadStatus, toast]);

  // --- Context menu portal ---
  const renderContextMenu = () => {
    if (!contextMenu) return null;
    const count = selectedFiles.size;
    const label = count > 1 ? `${count} files` : pathBasename([...selectedFiles][0] || '');
    const isUnstaged = contextMenu.group === 'unstaged';

    // Clamp menu to viewport
    const menuWidth = 200;
    const menuHeight = 160;
    const x = Math.min(contextMenu.x, window.innerWidth - menuWidth - 8);
    const y = Math.min(contextMenu.y, window.innerHeight - menuHeight - 8);

    return createPortal(
      <div
        ref={contextMenuRef}
        className="fixed glass-surface border border-app-border rounded-lg shadow-xl py-1 min-w-[180px] z-[10000] text-[12px]"
        style={{ left: x, top: y }}
      >
        <div className="px-3 py-1 text-[11px] text-app-text-muted truncate border-b border-app-border mb-0.5">
          {label}
        </div>
        {count === 1 && (
          <button
            onClick={handleBatchOpen}
            className="w-full text-left px-3 py-1.5 hover:bg-app-hover flex items-center gap-2 text-app-text-body"
          >
            <FileText size={13} className="text-app-text-muted flex-shrink-0" />
            Open Diff
          </button>
        )}
        {isUnstaged ? (
          <button
            onClick={handleBatchStage}
            className="w-full text-left px-3 py-1.5 hover:bg-app-hover flex items-center gap-2 text-app-text-body"
          >
            <Plus size={13} className="text-green-500 flex-shrink-0" />
            Stage {count > 1 ? `${count} Files` : 'File'}
          </button>
        ) : (
          <button
            onClick={handleBatchUnstage}
            className="w-full text-left px-3 py-1.5 hover:bg-app-hover flex items-center gap-2 text-app-text-body"
          >
            <Minus size={13} className="text-red-500 flex-shrink-0" />
            Unstage {count > 1 ? `${count} Files` : 'File'}
          </button>
        )}
        {isUnstaged && (
          <>
            <div className="border-t border-app-border my-0.5" />
            <button
              onClick={handleBatchDiscard}
              className="w-full text-left px-3 py-1.5 hover:bg-app-hover flex items-center gap-2 text-red-500"
            >
              <Undo2 size={13} className="flex-shrink-0" />
              Discard {count > 1 ? `${count} Changes` : 'Changes'}
            </button>
          </>
        )}
      </div>,
      document.body
    );
  };

  // In compact mode, show a minimal header even while loading/error/notGit
  // Non-compact early returns for loading/error
  if (!compact) {
    if (loading && !gitStatus) {
      return (
        <div className="flex items-center justify-center py-4">
          <div className="flex items-center gap-2 text-app-text-tertiary text-[11px]">
            <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
            Loading...
          </div>
        </div>
      );
    }
    if (error) {
      if (notGit) {
        return (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <GitBranch size={28} className="text-app-text-muted opacity-40" />
            <p className="text-app-text-muted text-[12px]">No git repository initialized</p>
            <button
              onClick={handleInit}
              disabled={initializing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors mt-1"
            >
              {initializing ? (
                <div className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <GitBranch size={12} />
              )}
              Initialize Repository
            </button>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center justify-center py-4 gap-1">
          <p className="text-red-500 text-[11px]">{error}</p>
          <button onClick={loadStatus} className="text-[11px] text-primary hover:underline">Retry</button>
        </div>
      );
    }
    if (!gitStatus) return null;
  }

  // ── Compact mode (sidebar) — single render path, no layout shift ────
  if (compact) {
    const hasData = !!gitStatus && !notGit;
    const fileCount = gitStatus?.files.length ?? 0;
    return (
      <div data-testid="git-changes" className={`flex flex-col ${expanded ? 'h-full min-h-0' : ''}`}>
        {/* Header — two-part layout: left flexible, right fixed (no shift) */}
        <div
          onClick={onToggle}
          className="w-full flex items-center h-8 px-3 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none group/git"
        >
          {/* Left: icon + label + chevron */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <GitBranch size={14} className={`flex-shrink-0 ${notGit ? 'text-app-text-muted' : 'text-primary'}`} />
            <span className={`flex-shrink-0 ${notGit ? 'text-app-text-muted' : ''}`}>Git</span>
            <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 text-app-text-tertiary ${expanded ? 'rotate-90' : ''}`} />
          </div>
          {/* Right: branch + badges + refresh */}
          <div className="flex items-center gap-1 flex-shrink-0 ml-auto" onClick={e => e.stopPropagation()}>
            {hasData && (
              <button
                ref={branchBtnRef}
                onClick={(e) => { e.stopPropagation(); setShowBranches(!showBranches); }}
                className="flex items-center gap-0.5 min-w-0 hover:text-primary transition-colors text-app-text-muted"
              >
                <span className="truncate max-w-[80px]">{gitStatus!.branch}</span>
                <ChevronDown size={10} className={`text-app-text-muted flex-shrink-0 transition-transform opacity-0 group-hover/git:opacity-100 ${showBranches ? 'rotate-180 !opacity-100' : ''}`} />
              </button>
            )}
            {hasData && fileCount > 0 && (
              <span className="text-[11px] font-medium text-primary bg-primary/10 px-1.5 py-[1px] rounded-full" title={`${fileCount} changed files`}>
                {fileCount}
              </span>
            )}
            {hasData && gitStatus!.behind > 0 && (
              <button onClick={handlePull} disabled={pulling} className="flex items-center gap-0.5 px-1 py-[1px] rounded-full text-[11px] font-medium text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-40 transition-colors" title={`Pull ${gitStatus!.behind} commits`}>
                {pulling ? <div className="w-2.5 h-2.5 border border-red-300 border-t-red-500 rounded-full animate-spin" /> : <>↓{gitStatus!.behind}</>}
              </button>
            )}
            {hasData && gitStatus!.ahead > 0 && (
              <button onClick={handlePush} disabled={pushing} className="flex items-center gap-0.5 px-1 py-[1px] rounded-full text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 hover:bg-green-500/20 disabled:opacity-40 transition-colors" title={`Push ${gitStatus!.ahead} commits`}>
                {pushing ? <div className="w-2.5 h-2.5 border border-green-300 border-t-green-500 rounded-full animate-spin" /> : <>↑{gitStatus!.ahead}</>}
              </button>
            )}
            <button onClick={loadStatus} className="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary" title="Refresh">
              <span className={`inline-flex items-center justify-center w-[10px] h-[10px] ${loading && !notGit ? 'animate-spin' : ''}`}>
                <RefreshCw size={10} />
              </span>
            </button>
          </div>
        </div>

        {/* Expandable content */}
        {expanded && notGit && (
          <div className="px-3 py-2 flex items-center gap-2">
            <span className="text-[11px] text-app-text-muted">No git repository</span>
            <button
              onClick={handleInit}
              disabled={initializing}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
            >
              {initializing ? (
                <div className="w-2.5 h-2.5 border border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <GitBranch size={10} />
              )}
              Init
            </button>
          </div>
        )}
        {expanded && error && !notGit && (
          <div className="px-3 py-1">
            <p className="text-red-500 text-[11px]">{error}</p>
            <button onClick={loadStatus} className="text-[11px] text-primary hover:underline">Retry</button>
          </div>
        )}
        {expanded && hasData && (
          <>
            {gitStatus!.files.length === 0 ? (
              <div className="px-3 py-3 text-center text-app-text-tertiary text-[11px]">
                <CheckCircle size={14} className="mx-auto mb-1 opacity-40" />
                Clean working tree
              </div>
            ) : (() => {
              // Split files into staged and unstaged groups
              const stagedFiles = gitStatus!.files.filter(f => isFileStaged(f.status));
              const unstagedFiles = gitStatus!.files.filter(f => hasUnstagedChanges(f.status));

              const renderFileRow = (file: { path: string; status: string }, group: 'staged' | 'unstaged') => {
                const st = statusLabel(file.status);
                const basename = pathBasename(file.path) || file.path;
                const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
                const isSelected = selectedFiles.has(file.path);
                return (
                  <div
                    key={`${group}-${file.path}`}
                    className={`flex items-center gap-1.5 px-3 py-[3px] transition-colors group/file cursor-pointer select-none ${
                      isSelected ? 'bg-primary/15 dark:bg-primary/25' : 'hover:bg-app-hover'
                    }`}
                    title={file.path}
                    onClick={(e) => handleFileSelect(file.path, group, e)}
                    onContextMenu={(e) => handleContextMenu(e, file.path, group)}
                  >
                    <span className={`${st.color} ${st.bg} text-[8px] font-bold px-0.5 py-[1px] rounded leading-none flex-shrink-0 min-w-[14px] text-center`}>
                      {st.text}
                    </span>
                    <span className="truncate text-app-text-body min-w-0">
                      {basename}
                      {dir && <span className="text-app-text-muted ml-1 text-[11px]">{dir}</span>}
                    </span>
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/file:opacity-100 transition-all flex-shrink-0">
                      {group === 'unstaged' && (
                        <button
                          onClick={(e) => handleDiscard(file.path, e)}
                          className="p-0.5 rounded hover:bg-app-hover"
                          title="Discard changes"
                        >
                          <Undo2 size={10} className="text-app-text-muted" />
                        </button>
                      )}
                      <button
                        onClick={(e) => group === 'staged' ? handleUnstage(file.path, e) : handleStage(file.path, e)}
                        className="p-0.5 rounded hover:bg-app-hover"
                        title={group === 'staged' ? 'Unstage' : 'Stage'}
                      >
                        {group === 'staged' ? <Minus size={10} className="text-red-500" /> : <Plus size={10} className="text-green-500" />}
                      </button>
                    </div>
                  </div>
                );
              };

              return (
                <>
                  {/* Inline commit row — input + AI + commit all in one line */}
                  <div className="border-t border-app-border px-3 py-1 flex items-center gap-1 flex-shrink-0">
                    <input
                      ref={commitInputRef}
                      type="text"
                      value={commitMessage}
                      onChange={e => setCommitMessage(e.target.value)}
                      placeholder="Message"
                      className="flex-1 min-w-0 h-[22px] px-1.5 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleCommit();
                        }
                      }}
                    />
                    <button
                      onClick={handleGenerateMessage}
                      disabled={generatingMsg}
                      className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-muted hover:text-primary transition-colors disabled:opacity-40 flex-shrink-0"
                      title="AI-generate commit message"
                    >
                      {generatingMsg ? (
                        <div className="w-3 h-3 border border-app-spinner border-t-primary rounded-full animate-spin" />
                      ) : (
                        <Sparkles size={12} />
                      )}
                    </button>
                    <button
                      onClick={handleCommit}
                      disabled={committing || !commitMessage.trim() || stagedFiles.length === 0}
                      className="flex items-center gap-0.5 px-1.5 h-[22px] text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                      title="Commit staged changes"
                    >
                      {committing ? (
                        <div className="w-2.5 h-2.5 border border-white/30 border-t-white rounded-full animate-spin" />
                      ) : (
                        <GitCommit size={10} />
                      )}
                      <kbd className="kbd !text-white/50">⌘↩</kbd>
                    </button>
                  </div>

                  {/* File lists — single Virtuoso scroll context */}
                  <CompactFileList
                    stagedFiles={stagedFiles}
                    unstagedFiles={unstagedFiles}
                    stagedExpanded={stagedExpanded}
                    unstagedExpanded={unstagedExpanded}
                    onToggleStaged={() => setStagedExpanded(v => !v)}
                    onToggleUnstaged={() => setUnstagedExpanded(v => !v)}
                    onUnstageAll={handleUnstageAll}
                    onStageAll={handleStageAll}
                    stagingAll={stagingAll}
                    renderFileRow={renderFileRow}
                    remotes={remotes}
                    remotesExpanded={remotesExpanded}
                    onToggleRemotes={() => setRemotesExpanded(v => !v)}
                    showAddRemote={showAddRemote}
                    onToggleAddRemote={() => setShowAddRemote(v => !v)}
                    newRemoteName={newRemoteName}
                    newRemoteUrl={newRemoteUrl}
                    onRemoteNameChange={setNewRemoteName}
                    onRemoteUrlChange={setNewRemoteUrl}
                    onAddRemote={handleAddRemote}
                    onRemoveRemote={handleRemoveRemote}
                    addingRemote={addingRemote}
                  />
                </>
              );
            })()}

            {/* Show "Add remote" inline when no changes but repo exists */}
            {gitStatus!.files.length === 0 && remotes.length === 0 && (
              <div className="px-3 py-2 border-t border-app-border">
                {!showAddRemote ? (
                  <button
                    onClick={() => setShowAddRemote(true)}
                    className="flex items-center gap-1 text-[11px] text-app-text-muted hover:text-primary transition-colors"
                  >
                    <Link size={10} />
                    Add remote
                  </button>
                ) : (
                  <AddRemoteForm
                    name={newRemoteName}
                    url={newRemoteUrl}
                    onNameChange={setNewRemoteName}
                    onUrlChange={setNewRemoteUrl}
                    onAdd={handleAddRemote}
                    onCancel={() => setShowAddRemote(false)}
                    adding={addingRemote}
                  />
                )}
              </div>
            )}

            {/* Show remotes list when no changes but remotes exist */}
            {gitStatus!.files.length === 0 && remotes.length > 0 && (
              <RemotesSection
                remotes={remotes}
                expanded={remotesExpanded}
                onToggle={() => setRemotesExpanded(v => !v)}
                showAddRemote={showAddRemote}
                onToggleAdd={() => setShowAddRemote(v => !v)}
                newRemoteName={newRemoteName}
                newRemoteUrl={newRemoteUrl}
                onNameChange={setNewRemoteName}
                onUrlChange={setNewRemoteUrl}
                onAdd={handleAddRemote}
                onRemove={handleRemoveRemote}
                adding={addingRemote}
                compact
              />
            )}
          </>
        )}

        {/* Branch dropdown — portal to escape overflow-hidden */}
        {showBranches && branchBtnRef.current && createPortal(
          <div
            ref={branchDropdownRef}
            className="fixed w-52 max-h-[220px] overflow-y-auto glass-surface border border-app-border rounded-md shadow-lg z-[9999]"
            style={{
              top: branchBtnRef.current.getBoundingClientRect().bottom + 4,
              left: branchBtnRef.current.getBoundingClientRect().left,
            }}
          >
            <BranchList
              projectPath={projectPath}
              onBranchSwitch={() => { loadStatus(); setShowBranches(false); }}
              remotes={remotes}
              onAddRemote={async (name, url) => {
                await gitApi.addRemote(projectPath, name, url);
                await loadRemotes();
              }}
              onRemoveRemote={async (name) => {
                await gitApi.removeRemote(projectPath, name);
                await loadRemotes();
              }}
            />
          </div>,
          document.body,
        )}
        {renderContextMenu()}
        {discardConfirm && createPortal(
          <DiscardConfirmDialog
            files={discardConfirm.files}
            onConfirm={() => executeDiscard(discardConfirm.files)}
            onCancel={() => setDiscardConfirm(null)}
          />,
          document.body,
        )}
      </div>
    );
  }

  // ── Full mode (panel) ───────────────────────────────────────────────
  if (!gitStatus) return null;
  const fullStagedFiles = gitStatus.files.filter(f => isFileStaged(f.status));
  const fullUnstagedFiles = gitStatus.files.filter(f => hasUnstagedChanges(f.status));

  const renderFullModeFileRow = (file: { path: string; status: string }, group: 'staged' | 'unstaged') => {
    const st = statusLabel(file.status);
    const isMultiSelected = selectedFiles.has(file.path);
    const isDiffOpen = selectedFile === file.path;
    const basename = pathBasename(file.path) || file.path;
    const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
    return (
      <div
        key={`${group}-${file.path}`}
        className={`flex items-center gap-2 px-2 py-[4px] cursor-pointer text-[12px] transition-colors group select-none ${
          isMultiSelected ? 'bg-primary/15 dark:bg-primary/25' : isDiffOpen ? 'bg-primary/10 dark:bg-primary/20' : 'hover:bg-app-hover'
        }`}
        onClick={(e) => handleFileSelect(file.path, group, e)}
        onContextMenu={(e) => handleContextMenu(e, file.path, group)}
      >
        <span className={`${st.color} ${st.bg} text-[11px] font-bold px-1 py-0.5 rounded leading-none flex-shrink-0 min-w-[18px] text-center`}>
          {st.text}
        </span>
        <span className="truncate text-app-text-body min-w-0">
          {basename}
          {dir && <span className="text-app-text-muted ml-1 text-[11px]">{dir}</span>}
        </span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
          {group === 'unstaged' && (
            <button
              onClick={(e) => handleDiscard(file.path, e)}
              className="p-0.5 rounded hover:bg-app-hover"
              title="Discard changes"
            >
              <Undo2 size={12} className="text-app-text-muted" />
            </button>
          )}
          <button
            onClick={(e) => group === 'staged' ? handleUnstage(file.path, e) : handleStage(file.path, e)}
            className="p-0.5 rounded hover:bg-app-hover"
            title={group === 'staged' ? 'Unstage' : 'Stage'}
          >
            {group === 'staged' ? <Minus size={12} className="text-red-500" /> : <Plus size={12} className="text-green-500" />}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div data-testid="git-changes" className="flex h-full">
      {/* Left: status panel */}
      <div className="w-[280px] flex-shrink-0 border-r border-app-border flex flex-col overflow-hidden">
        {/* Header info */}
        <div className="px-3 py-2.5 border-b border-app-border bg-elevated dark:bg-app-panel flex-shrink-0 space-y-1.5">
          <div className="flex items-center justify-between">
            <button
              ref={branchBtnRef}
              onClick={() => setShowBranches(!showBranches)}
              className="flex items-center gap-1.5 hover:bg-app-hover px-1.5 py-0.5 rounded transition-colors"
            >
              <GitBranch size={14} className="text-primary" />
              <span className="text-[12px] font-semibold text-app-text-heading">{gitStatus.branch}</span>
              <ChevronDown size={10} className={`text-app-text-muted transition-transform ${showBranches ? 'rotate-180' : ''}`} />
            </button>
            <div className="flex items-center gap-1">
              <button
                onClick={handlePull}
                disabled={pulling}
                className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors disabled:opacity-40"
                title="Pull"
              >
                {pulling ? (
                  <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
                ) : (
                  <ArrowDown size={14} />
                )}
              </button>
              <button
                onClick={handlePush}
                disabled={pushing}
                className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors disabled:opacity-40"
                title="Push"
              >
                {pushing ? (
                  <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
                ) : (
                  <ArrowUp size={14} />
                )}
              </button>
              <button
                onClick={loadStatus}
                className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors"
                title="Refresh"
              >
                <RefreshCw size={12} />
              </button>
            </div>
          </div>
          {gitStatus.lastCommit.hash && (
            <div className="text-[11px] text-app-text-muted space-y-0.5">
              <div className="flex items-center gap-1 truncate">
                <Clock size={10} className="flex-shrink-0" />
                <span className="truncate">{gitStatus.lastCommit.message}</span>
              </div>
              <div className="flex items-center gap-1">
                <User size={10} className="flex-shrink-0" />
                <span>{gitStatus.lastCommit.author} · {gitStatus.lastCommit.ago}</span>
              </div>
            </div>
          )}
          {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
            <div className="flex items-center gap-2 text-[11px]">
              {gitStatus.ahead > 0 && (
                <span className="text-green-600 dark:text-green-400">↑{gitStatus.ahead}</span>
              )}
              {gitStatus.behind > 0 && (
                <span className="text-red-600 dark:text-red-400">↓{gitStatus.behind}</span>
              )}
            </div>
          )}

        </div>

        {/* Inline commit area for full mode too */}
        {gitStatus.files.length > 0 && (
          <div className="border-b border-app-border px-3 py-2 space-y-1.5">
            <div className="relative">
              <textarea
                value={commitMessage}
                onChange={e => setCommitMessage(e.target.value)}
                placeholder="Commit message..."
                className="w-full h-[44px] px-2 py-1.5 text-[12px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded resize-none focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleCommit();
                  }
                }}
              />
              <button
                onClick={handleGenerateMessage}
                disabled={generatingMsg}
                className="absolute top-1 right-1 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-muted hover:text-primary transition-colors disabled:opacity-40"
                title="Auto-generate message"
              >
                {generatingMsg ? (
                  <div className="w-3 h-3 border border-app-spinner border-t-primary rounded-full animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
              </button>
            </div>
            <button
              onClick={handleCommit}
              disabled={committing || !commitMessage.trim() || fullStagedFiles.length === 0}
              className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {committing ? (
                <div className="w-2.5 h-2.5 border border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <GitCommit size={10} />
              )}
              Commit <kbd className="kbd !text-white/50">⌘↩</kbd>
            </button>
          </div>
        )}

        {/* Changed files list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {gitStatus.files.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-app-text-tertiary text-[12px]">
              <div className="text-center">
                <CheckCircle size={24} className="mx-auto mb-2 opacity-30" />
                <p>Clean working tree</p>
                <p className="text-[11px] mt-1 opacity-60">No changes to commit</p>
              </div>
            </div>
          ) : (
            <>
              {/* Staged files */}
              {fullStagedFiles.length > 0 && (
                <div className="border-t border-app-border">
                  <div className="flex items-center justify-between px-2 py-1 group/hdr select-none">
                    <button
                      onClick={() => setStagedExpanded(v => !v)}
                      className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider hover:text-app-text-hover transition-colors"
                    >
                      {stagedExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      Staged ({fullStagedFiles.length})
                    </button>
                    <button
                      onClick={handleUnstageAll}
                      className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors opacity-0 group-hover/hdr:opacity-100"
                      title="Unstage all"
                    >
                      <Minus size={10} />
                    </button>
                  </div>
                  {stagedExpanded && fullStagedFiles.map(file => renderFullModeFileRow(file, 'staged'))}
                </div>
              )}

              {/* Unstaged files */}
              {fullUnstagedFiles.length > 0 && (
                <div className="border-t border-app-border">
                  <div className="flex items-center justify-between px-2 py-1 group/hdr select-none">
                    <button
                      onClick={() => setUnstagedExpanded(v => !v)}
                      className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider hover:text-app-text-hover transition-colors"
                    >
                      {unstagedExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      Changes ({fullUnstagedFiles.length})
                    </button>
                    <button
                      onClick={handleStageAll}
                      disabled={stagingAll}
                      className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors disabled:opacity-40 opacity-0 group-hover/hdr:opacity-100"
                      title="Stage all"
                    >
                      {stagingAll ? <div className="w-2.5 h-2.5 border border-app-spinner border-t-primary rounded-full animate-spin" /> : <Plus size={10} />}
                    </button>
                  </div>
                  {unstagedExpanded && fullUnstagedFiles.map(file => renderFullModeFileRow(file, 'unstaged'))}
                </div>
              )}
            </>
          )}

          {/* Remotes section (full mode) */}
          <RemotesSection
            remotes={remotes}
            expanded={remotesExpanded}
            onToggle={() => setRemotesExpanded(v => !v)}
            showAddRemote={showAddRemote}
            onToggleAdd={() => setShowAddRemote(v => !v)}
            newRemoteName={newRemoteName}
            newRemoteUrl={newRemoteUrl}
            onNameChange={setNewRemoteName}
            onUrlChange={setNewRemoteUrl}
            onAdd={handleAddRemote}
            onRemove={handleRemoveRemote}
            adding={addingRemote}
          />
        </div>
      </div>

      {/* Right: diff viewer */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            <div className="px-3 py-1.5 border-b border-app-border bg-elevated dark:bg-app-panel flex-shrink-0 flex items-center justify-between">
              <span className="text-[12px] text-app-text-secondary">{selectedFile}</span>
              <div className="flex items-center gap-2 text-[11px] text-app-text-muted">
                <span>Original (HEAD)</span>
                <span>|</span>
                <span>Modified (Working)</span>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              {loadingDiff ? (
                <div className="flex items-center justify-center h-full">
                  <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
                </div>
              ) : (
                <DiffViewer
                  originalContent={originalContent}
                  modifiedContent={modifiedContent}
                  filename={selectedFile}
                  darkMode={darkMode}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-app-text-tertiary text-[13px]">
            <div className="text-center">
              <GitBranch size={32} className="mx-auto mb-2 opacity-30" />
              <p>Select a changed file to view its diff</p>
            </div>
          </div>
        )}
      </div>

      {/* Branch dropdown — portal to escape overflow-hidden */}
      {showBranches && branchBtnRef.current && createPortal(
        <div
          ref={branchDropdownRef}
          className="fixed w-56 max-h-[320px] overflow-y-auto glass-surface border border-app-border rounded-md shadow-lg z-[9999]"
          style={{
            top: branchBtnRef.current.getBoundingClientRect().bottom + 4,
            left: branchBtnRef.current.getBoundingClientRect().left,
          }}
        >
          <BranchList
            projectPath={projectPath}
            onBranchSwitch={() => { loadStatus(); setSelectedFile(null); setShowBranches(false); }}
            remotes={remotes}
            onAddRemote={async (name, url) => {
              await gitApi.addRemote(projectPath, name, url);
              await loadRemotes();
            }}
            onRemoveRemote={async (name) => {
              await gitApi.removeRemote(projectPath, name);
              await loadRemotes();
            }}
          />
        </div>,
        document.body,
      )}
      {renderContextMenu()}
      {discardConfirm && createPortal(
        <DiscardConfirmDialog
          files={discardConfirm.files}
          onConfirm={() => executeDiscard(discardConfirm.files)}
          onCancel={() => setDiscardConfirm(null)}
        />,
        document.body,
      )}
    </div>
  );
}

// ── Discard confirmation dialog ──────────────────────────────────────

function DiscardConfirmDialog({ files, onConfirm, onCancel }: { files: string[]; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const fileNames = files.map(f => {
    const parts = f.split('/');
    return parts[parts.length - 1];
  });

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-app-border rounded-lg shadow-xl p-5 max-w-md w-full mx-4"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-app-text-heading mb-2">
          Discard Changes
        </h3>
        <p className="text-xs text-app-text-body mb-3">
          This will permanently discard uncommitted changes.
        </p>
        <div className="bg-app-hover rounded px-3 py-2 mb-4 max-h-[120px] overflow-y-auto">
          {files.length === 1 ? (
            <span className="text-xs text-app-text-body font-mono">{fileNames[0]}</span>
          ) : (
            <ul className="space-y-0.5">
              {fileNames.map((name, i) => (
                <li key={i} className="text-xs text-app-text-body font-mono">{name}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-app-border text-app-text-body hover:bg-app-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Compact file list — single Virtuoso, no nested scrollbars ────────

type CompactItem =
  | { type: 'staged-header' }
  | { type: 'unstaged-header' }
  | { type: 'file'; file: { path: string; status: string }; group: 'staged' | 'unstaged' }
  | { type: 'remotes' };

interface CompactFileListProps {
  stagedFiles: { path: string; status: string }[];
  unstagedFiles: { path: string; status: string }[];
  stagedExpanded: boolean;
  unstagedExpanded: boolean;
  onToggleStaged: () => void;
  onToggleUnstaged: () => void;
  onUnstageAll: () => void;
  onStageAll: () => void;
  stagingAll: boolean;
  renderFileRow: (file: { path: string; status: string }, group: 'staged' | 'unstaged') => React.ReactNode;
  remotes: { name: string; fetchUrl: string; pushUrl: string }[];
  remotesExpanded: boolean;
  onToggleRemotes: () => void;
  showAddRemote: boolean;
  onToggleAddRemote: () => void;
  newRemoteName: string;
  newRemoteUrl: string;
  onRemoteNameChange: (v: string) => void;
  onRemoteUrlChange: (v: string) => void;
  onAddRemote: () => void;
  onRemoveRemote: (name: string) => void;
  addingRemote: boolean;
}

function CompactFileList({
  stagedFiles, unstagedFiles,
  stagedExpanded, unstagedExpanded,
  onToggleStaged, onToggleUnstaged,
  onUnstageAll, onStageAll, stagingAll,
  renderFileRow,
  remotes, remotesExpanded, onToggleRemotes,
  showAddRemote, onToggleAddRemote,
  newRemoteName, newRemoteUrl,
  onRemoteNameChange, onRemoteUrlChange,
  onAddRemote, onRemoveRemote, addingRemote,
}: CompactFileListProps) {
  // Build flat item list: headers + files + remotes
  const items = useMemo<CompactItem[]>(() => {
    const list: CompactItem[] = [];
    if (stagedFiles.length > 0) {
      list.push({ type: 'staged-header' });
      if (stagedExpanded) {
        for (const f of stagedFiles) list.push({ type: 'file', file: f, group: 'staged' });
      }
    }
    if (unstagedFiles.length > 0) {
      list.push({ type: 'unstaged-header' });
      if (unstagedExpanded) {
        for (const f of unstagedFiles) list.push({ type: 'file', file: f, group: 'unstaged' });
      }
    }
    if (remotes.length > 0 || showAddRemote) {
      list.push({ type: 'remotes' });
    }
    return list;
  }, [stagedFiles, unstagedFiles, stagedExpanded, unstagedExpanded, remotes.length, showAddRemote]);

  // For small lists, use simple overflow scroll — no Virtuoso overhead
  if (items.length <= 200) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        {renderItems()}
      </div>
    );
  }

  // For large lists, single Virtuoso — one scrollbar
  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <Virtuoso
        style={{ height: '100%' }}
        totalCount={items.length}
        itemContent={i => renderItem(items[i])}
      />
    </div>
  );

  function renderItems() {
    return items.map((item, i) => <div key={i}>{renderItem(item)}</div>);
  }

  function renderItem(item: CompactItem) {
    switch (item.type) {
      case 'staged-header':
        return (
          <div className="border-t border-app-border">
            <div className="flex items-center justify-between px-3 py-1 group/hdr select-none">
              <button
                onClick={onToggleStaged}
                className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider hover:text-app-text-hover transition-colors"
              >
                {stagedExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Staged ({stagedFiles.length})
              </button>
              <button
                onClick={onUnstageAll}
                className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors opacity-0 group-hover/hdr:opacity-100"
                title="Unstage all"
              >
                <Minus size={10} />
              </button>
            </div>
          </div>
        );
      case 'unstaged-header':
        return (
          <div className="border-t border-app-border">
            <div className="flex items-center justify-between px-3 py-1 group/hdr select-none">
              <button
                onClick={onToggleUnstaged}
                className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider hover:text-app-text-hover transition-colors"
              >
                {unstagedExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Changes ({unstagedFiles.length})
              </button>
              <button
                onClick={onStageAll}
                disabled={stagingAll}
                className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors disabled:opacity-40 opacity-0 group-hover/hdr:opacity-100"
                title="Stage all"
              >
                {stagingAll ? <div className="w-2.5 h-2.5 border border-app-spinner border-t-primary rounded-full animate-spin" /> : <Plus size={10} />}
              </button>
            </div>
          </div>
        );
      case 'file':
        return renderFileRow(item.file, item.group);
      case 'remotes':
        return (
          <RemotesSection
            remotes={remotes}
            expanded={remotesExpanded}
            onToggle={onToggleRemotes}
            showAddRemote={showAddRemote}
            onToggleAdd={onToggleAddRemote}
            newRemoteName={newRemoteName}
            newRemoteUrl={newRemoteUrl}
            onNameChange={onRemoteNameChange}
            onUrlChange={onRemoteUrlChange}
            onAdd={onAddRemote}
            onRemove={onRemoveRemote}
            adding={addingRemote}
            compact
          />
        );
    }
  }
}

// ── Helper components ──────────────────────────────────────────────────

interface AddRemoteFormProps {
  name: string;
  url: string;
  onNameChange: (v: string) => void;
  onUrlChange: (v: string) => void;
  onAdd: () => void;
  onCancel: () => void;
  adding: boolean;
}

function AddRemoteForm({ name, url, onNameChange, onUrlChange, onAdd, onCancel, adding }: AddRemoteFormProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="name"
          className="w-[60px] h-[20px] px-1 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
        />
        <input
          type="text"
          value={url}
          onChange={e => onUrlChange(e.target.value)}
          placeholder="https://github.com/..."
          className="flex-1 min-w-0 h-[20px] px-1 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
            if (e.key === 'Escape') onCancel();
          }}
          autoFocus
        />
        <button
          onClick={onAdd}
          disabled={adding || !name.trim() || !url.trim()}
          className="px-1.5 h-[20px] text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
        >
          {adding ? <div className="w-2 h-2 border border-white/30 border-t-white rounded-full animate-spin" /> : 'Add'}
        </button>
      </div>
    </div>
  );
}

interface RemotesSectionProps {
  remotes: { name: string; fetchUrl: string; pushUrl: string }[];
  expanded: boolean;
  onToggle: () => void;
  showAddRemote: boolean;
  onToggleAdd: () => void;
  newRemoteName: string;
  newRemoteUrl: string;
  onNameChange: (v: string) => void;
  onUrlChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (name: string) => void;
  adding: boolean;
  compact?: boolean;
}

function RemotesSection({
  remotes, expanded, onToggle, showAddRemote, onToggleAdd,
  newRemoteName, newRemoteUrl, onNameChange, onUrlChange,
  onAdd, onRemove, adding,
}: RemotesSectionProps) {
  if (remotes.length === 0 && !showAddRemote) return null;

  return (
    <div className="border-t border-app-border">
      <div className="flex items-center justify-between px-3 py-1 group/hdr">
        <button
          onClick={onToggle}
          className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider hover:text-app-text-hover transition-colors"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <Globe size={10} />
          Remotes ({remotes.length})
        </button>
        <button
          onClick={onToggleAdd}
          className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors opacity-0 group-hover/hdr:opacity-100"
          title="Add remote"
        >
          <Plus size={10} />
        </button>
      </div>
      {expanded && (
        <>
          {showAddRemote && (
            <div className="px-3 py-1">
              <AddRemoteForm
                name={newRemoteName}
                url={newRemoteUrl}
                onNameChange={onNameChange}
                onUrlChange={onUrlChange}
                onAdd={onAdd}
                onCancel={onToggleAdd}
                adding={adding}
              />
            </div>
          )}
          {remotes.map(r => (
            <div
              key={r.name}
              className="flex items-center gap-1.5 px-3 py-[3px] text-[11px] group/remote hover:bg-app-hover transition-colors"
            >
              <Globe size={10} className="text-app-text-muted flex-shrink-0" />
              <span className="font-medium text-app-text-heading">{r.name}</span>
              <span className="truncate text-app-text-muted text-[11px] min-w-0">{r.fetchUrl}</span>
              <button
                onClick={() => onRemove(r.name)}
                className="ml-auto p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-app-text-muted hover:text-red-500 transition-all opacity-0 group-hover/remote:opacity-100 flex-shrink-0"
                title={`Remove ${r.name}`}
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
