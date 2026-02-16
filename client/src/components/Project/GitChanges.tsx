import { useState, useEffect, useCallback, useRef } from 'react';
import { GitBranch, Clock, RefreshCw, User, ArrowDown, ArrowUp, GitCommit, Plus, Minus } from 'lucide-react';
import type { GitStatus } from '../../types';
import { gitApi, filesApi } from '../../lib/api';
import { BranchList } from '../Git/BranchList';
import { CommitDialog } from '../Git/CommitDialog';
import { DiffViewer } from '../Editor/DiffViewer';

interface GitChangesProps {
  projectPath: string;
  compact?: boolean;
}

function statusLabel(status: string): { text: string; color: string; bg: string } {
  switch (status) {
    case 'M': return { text: 'M', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' };
    case 'A': return { text: 'A', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' };
    case 'D': return { text: 'D', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30' };
    case 'R': return { text: 'R', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/30' };
    case '??': return { text: 'U', color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-100 dark:bg-purple-900/30' };
    case 'MM': return { text: 'MM', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' };
    case 'AM': return { text: 'AM', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' };
    default: return { text: status, color: 'text-gray-500 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-800' };
  }
}

export function GitChanges({ projectPath }: GitChangesProps) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string>('');
  const [modifiedContent, setModifiedContent] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Detect dark mode
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    const check = () => setDarkMode(document.documentElement.classList.contains('dark'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setError(null);
      const status = await gitApi.status(projectPath);
      setGitStatus(status);
    } catch (err: any) {
      setError(err.message || 'Failed to load git status');
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    loadStatus();
    refreshTimerRef.current = setInterval(loadStatus, 15000);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [loadStatus]);

  const handleFileClick = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    setLoadingDiff(true);
    try {
      // Get original content from git HEAD
      const original = await gitApi.show(projectPath, filePath);
      // Get current file content
      // Resolve full path from projectPath + relative filePath
      // Note: ~ paths are resolved by the server
      const resolvedProjectPath = projectPath;
      const fullPath = `${resolvedProjectPath}/${filePath}`;
      let modified = '';
      try {
        modified = await filesApi.content(fullPath);
      } catch {
        modified = ''; // File might be deleted
      }
      setOriginalContent(original);
      setModifiedContent(modified);
    } catch (err: any) {
      setOriginalContent('');
      setModifiedContent('Error loading diff: ' + err.message);
    } finally {
      setLoadingDiff(false);
    }
  }, [projectPath]);

  const handleStage = useCallback(async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await gitApi.stage(projectPath, filePath);
      await loadStatus();
      showTemporaryMessage(`Staged: ${filePath}`);
    } catch (err: any) {
      showTemporaryMessage(`Error: ${err.message}`);
    }
  }, [projectPath, loadStatus]);

  const handleUnstage = useCallback(async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await gitApi.unstage(projectPath, filePath);
      await loadStatus();
      showTemporaryMessage(`Unstaged: ${filePath}`);
    } catch (err: any) {
      showTemporaryMessage(`Error: ${err.message}`);
    }
  }, [projectPath, loadStatus]);

  const handlePull = useCallback(async () => {
    try {
      setPulling(true);
      const result = await gitApi.pull(projectPath);
      showTemporaryMessage(result.output || 'Pull complete');
      await loadStatus();
    } catch (err: any) {
      showTemporaryMessage(`Pull failed: ${err.message}`);
    } finally {
      setPulling(false);
    }
  }, [projectPath, loadStatus]);

  const handlePush = useCallback(async () => {
    try {
      setPushing(true);
      const result = await gitApi.push(projectPath);
      showTemporaryMessage(result.output || 'Push complete');
      await loadStatus();
    } catch (err: any) {
      showTemporaryMessage(`Push failed: ${err.message}`);
    } finally {
      setPushing(false);
    }
  }, [projectPath, loadStatus]);

  const showTemporaryMessage = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(null), 3000);
  };

  // Determine if a file is staged based on git status code
  const isFileStaged = (status: string): boolean => {
    // Git status has two columns: index (staged) and worktree
    // If the first char is not ' ' and not '?', it's staged
    return status.length >= 1 && status[0] !== ' ' && status[0] !== '?';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-app-text-tertiary text-[13px]">
          <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
          Loading git status...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-red-500 text-[13px]">{error}</p>
        <button onClick={loadStatus} className="text-[12px] text-primary hover:underline">Retry</button>
      </div>
    );
  }

  if (!gitStatus) return null;

  return (
    <div className="flex h-full">
      {/* Left: status panel */}
      <div className="w-[280px] flex-shrink-0 border-r border-app-border flex flex-col overflow-hidden">
        {/* Header info */}
        <div className="px-3 py-2.5 border-b border-app-border bg-elevated dark:bg-app-panel flex-shrink-0 space-y-1.5">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setShowBranches(!showBranches)}
              className="flex items-center gap-1.5 hover:bg-app-hover px-1.5 py-0.5 rounded transition-colors"
            >
              <GitBranch size={13} className="text-primary" />
              <span className="text-[12px] font-semibold text-app-text-heading">{gitStatus.branch}</span>
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
                  <ArrowDown size={13} />
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
                  <ArrowUp size={13} />
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
          
          {/* Action message */}
          {actionMessage && (
            <div className="text-[10px] text-primary truncate mt-1">
              {actionMessage}
            </div>
          )}
        </div>

        {/* Branches section (collapsible) */}
        {showBranches && (
          <div className="border-b border-app-border max-h-[200px] overflow-y-auto">
            <BranchList
              projectPath={projectPath}
              onBranchSwitch={() => {
                loadStatus();
                setSelectedFile(null);
              }}
            />
          </div>
        )}

        {/* Changed files list */}
        <div className="flex-1 overflow-y-auto">
          {gitStatus.files.length === 0 ? (
            <div className="flex items-center justify-center h-full text-app-text-tertiary text-[12px]">
              <div className="text-center">
                <p>✨ Clean working tree</p>
                <p className="text-[11px] mt-1 opacity-60">No changes to commit</p>
              </div>
            </div>
          ) : (
            <>
              <div className="px-2 py-1 flex items-center justify-between">
                <span className="text-[10px] font-medium text-app-text-tertiary uppercase tracking-wider">
                  Changes ({gitStatus.files.length})
                </span>
                <button
                  onClick={() => setShowCommitDialog(true)}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-primary text-white hover:bg-primary-hover transition-colors"
                >
                  <GitCommit size={10} />
                  Commit
                </button>
              </div>
              {gitStatus.files.map((file) => {
                const st = statusLabel(file.status);
                const isSelected = selectedFile === file.path;
                const staged = isFileStaged(file.status);
                return (
                  <div
                    key={file.path}
                    className={`flex items-center gap-2 px-2 py-[4px] cursor-pointer text-[12px] transition-colors group ${
                      isSelected
                        ? 'bg-primary/10 dark:bg-primary/20'
                        : 'hover:bg-app-hover'
                    }`}
                    onClick={() => handleFileClick(file.path)}
                  >
                    <span className={`${st.color} ${st.bg} text-[10px] font-bold px-1 py-0.5 rounded leading-none flex-shrink-0 min-w-[18px] text-center`}>
                      {st.text}
                    </span>
                    <span className="truncate text-app-text-body">{file.path}</span>
                    {/* Stage/unstage button */}
                    <button
                      onClick={(e) => staged ? handleUnstage(file.path, e) : handleStage(file.path, e)}
                      className="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-app-hover transition-all flex-shrink-0"
                      title={staged ? 'Unstage' : 'Stage'}
                    >
                      {staged ? <Minus size={12} className="text-red-500" /> : <Plus size={12} className="text-green-500" />}
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Right: diff viewer */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            <div className="px-3 py-1.5 border-b border-app-border bg-elevated dark:bg-app-panel flex-shrink-0 flex items-center justify-between">
              <span className="text-[12px] text-app-text-secondary">{selectedFile}</span>
              <div className="flex items-center gap-2 text-[10px] text-app-text-muted">
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

      {/* Commit dialog */}
      {showCommitDialog && gitStatus && (
        <CommitDialog
          projectPath={projectPath}
          files={gitStatus.files}
          onClose={() => setShowCommitDialog(false)}
          onCommitted={() => {
            setShowCommitDialog(false);
            loadStatus();
            showTemporaryMessage('Committed successfully!');
          }}
        />
      )}
    </div>
  );
}
