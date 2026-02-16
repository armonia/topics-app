// @ts-nocheck — Phase 2 component, APIs not yet implemented
import { useState, useCallback, useEffect, useRef } from 'react';
import { X, GitCommit, Upload, Check, Square, CheckSquare } from 'lucide-react';
import { gitApi } from '../../lib/api';

interface ChangedFile {
  path: string;
  status: string;
  staged: boolean;
}

interface CommitDialogProps {
  projectPath: string;
  files: { path: string; status: string }[];
  onClose: () => void;
  onCommitted: () => void;
}

function statusLabel(status: string): { text: string; color: string } {
  switch (status) {
    case 'M': return { text: 'Modified', color: 'text-amber-600 dark:text-amber-400' };
    case 'A': return { text: 'Added', color: 'text-green-600 dark:text-green-400' };
    case 'D': return { text: 'Deleted', color: 'text-red-600 dark:text-red-400' };
    case 'R': return { text: 'Renamed', color: 'text-blue-600 dark:text-blue-400' };
    case '??': return { text: 'Untracked', color: 'text-gray-500 dark:text-gray-400' };
    default: return { text: status, color: 'text-gray-500 dark:text-gray-400' };
  }
}

export function CommitDialog({ projectPath, files, onClose, onCommitted }: CommitDialogProps) {
  const [message, setMessage] = useState('');
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [committing, setCommitting] = useState(false);
  const [pushAfter, setPushAfter] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Initially, all files are unstaged
    setChangedFiles(files.map(f => ({ ...f, staged: false })));
    // Focus the commit message input
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [files]);

  const toggleStage = useCallback(async (filePath: string) => {
    const file = changedFiles.find(f => f.path === filePath);
    if (!file) return;

    try {
      if (file.staged) {
        await gitApi.unstage(projectPath, filePath);
      } else {
        await gitApi.stage(projectPath, filePath);
      }
      setChangedFiles(prev =>
        prev.map(f => f.path === filePath ? { ...f, staged: !f.staged } : f)
      );
    } catch (err: any) {
      setError(err.message);
    }
  }, [projectPath, changedFiles]);

  const stageAll = useCallback(async () => {
    try {
      for (const file of changedFiles) {
        if (!file.staged) {
          await gitApi.stage(projectPath, file.path);
        }
      }
      setChangedFiles(prev => prev.map(f => ({ ...f, staged: true })));
    } catch (err: any) {
      setError(err.message);
    }
  }, [projectPath, changedFiles]);

  const handleCommit = useCallback(async () => {
    if (!message.trim()) return;
    const staged = changedFiles.filter(f => f.staged);
    if (staged.length === 0) {
      setError('No files staged for commit');
      return;
    }

    try {
      setCommitting(true);
      setError(null);
      await gitApi.commit(projectPath, message, staged.map(f => f.path));
      
      if (pushAfter) {
        await gitApi.push(projectPath);
      }
      
      onCommitted();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCommitting(false);
    }
  }, [message, changedFiles, projectPath, pushAfter, onCommitted]);

  const stagedCount = changedFiles.filter(f => f.staged).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-surface dark:bg-app-panel rounded-lg shadow-xl w-[500px] max-h-[80vh] flex flex-col border border-app-border-input"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2">
            <GitCommit size={16} className="text-primary" />
            <span className="text-[14px] font-semibold text-app-text-heading">Commit Changes</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-app-hover text-app-text-tertiary"
          >
            <X size={16} />
          </button>
        </div>

        {/* Commit message */}
        <div className="px-4 py-3 border-b border-app-border">
          <textarea
            ref={inputRef}
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Commit message..."
            className="w-full h-[60px] px-3 py-2 text-[13px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded-md resize-none focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleCommit();
              }
            }}
          />
        </div>

        {/* Files list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
              Files ({stagedCount}/{changedFiles.length} staged)
            </span>
            <button
              onClick={stageAll}
              className="text-[11px] text-primary hover:underline"
            >
              Stage All
            </button>
          </div>
          {changedFiles.map(file => {
            const st = statusLabel(file.status);
            return (
              <div
                key={file.path}
                className="flex items-center gap-2 px-4 py-[5px] cursor-pointer hover:bg-app-hover transition-colors"
                onClick={() => toggleStage(file.path)}
              >
                <span className="flex-shrink-0 text-primary">
                  {file.staged ? <CheckSquare size={14} /> : <Square size={14} className="opacity-40" />}
                </span>
                <span className={`text-[10px] font-bold flex-shrink-0 ${st.color}`}>
                  {st.text}
                </span>
                <span className="text-[12px] truncate text-app-text-body">{file.path}</span>
              </div>
            );
          })}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 text-red-500 text-[12px] border-t border-app-border">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-app-border">
          <label className="flex items-center gap-2 text-[12px] text-app-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={pushAfter}
              onChange={e => setPushAfter(e.target.checked)}
              className="accent-primary"
            />
            Push after commit
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] rounded-md hover:bg-app-hover text-app-text-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCommit}
              disabled={committing || !message.trim() || stagedCount === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {committing ? (
                <>
                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Committing...
                </>
              ) : (
                <>
                  <Check size={14} />
                  Commit {pushAfter ? '& Push' : ''}
                  <span className="text-[10px] opacity-70">⌘↩</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
