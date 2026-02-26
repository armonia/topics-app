import { useState, useEffect, useCallback, useRef } from 'react';
import { GitBranch, Check, RefreshCw, Globe, Monitor, Plus, Trash2 } from 'lucide-react';
import { gitApi } from '../../lib/api';

interface Branch {
  name: string;
  current: boolean;
  isRemote: boolean;
  ahead?: number;
  behind?: number;
}

interface BranchListProps {
  projectPath: string;
  onBranchSwitch?: () => void;
}

export function BranchList({ projectPath, onBranchSwitch }: BranchListProps) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewInput, setShowNewInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const loadBranches = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await gitApi.branches(projectPath);
      setBranches(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  useEffect(() => {
    if (showNewInput && newInputRef.current) {
      newInputRef.current.focus();
    }
  }, [showNewInput]);

  const handleCheckout = async (branchName: string) => {
    try {
      setSwitching(branchName);
      await gitApi.checkout(projectPath, branchName);
      await loadBranches();
      onBranchSwitch?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSwitching(null);
    }
  };

  const handleCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      setCreating(true);
      setError(null);
      await gitApi.createBranch(projectPath, name, true);
      setNewBranchName('');
      setShowNewInput(false);
      await loadBranches();
      onBranchSwitch?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBranch = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setDeleting(name);
      setError(null);
      await gitApi.deleteBranch(projectPath, name);
      await loadBranches();
    } catch (err: any) {
      // If normal delete fails, try force
      try {
        await gitApi.deleteBranch(projectPath, name, true);
        await loadBranches();
      } catch (err2: any) {
        setError(err2.message);
      }
    } finally {
      setDeleting(null);
    }
  };

  const localBranches = branches.filter(b => !b.isRemote);
  const remoteBranches = branches.filter(b => b.isRemote);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-app-text-tertiary">
        <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
        Loading branches...
      </div>
    );
  }

  return (
    <div className="text-[12px]">
      {error && (
        <div className="px-3 py-1 text-red-500 text-[11px]">{error}</div>
      )}

      {/* New branch input */}
      {showNewInput && (
        <div className="px-2 py-1.5 border-b border-app-border flex items-center gap-1">
          <input
            ref={newInputRef}
            type="text"
            value={newBranchName}
            onChange={e => setNewBranchName(e.target.value)}
            placeholder="branch-name"
            className="flex-1 min-w-0 h-[22px] px-1.5 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); handleCreateBranch(); }
              if (e.key === 'Escape') { setShowNewInput(false); setNewBranchName(''); }
            }}
            disabled={creating}
          />
          <button
            onClick={handleCreateBranch}
            disabled={creating || !newBranchName.trim()}
            className="px-1.5 h-[22px] text-[10px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {creating ? <div className="w-2.5 h-2.5 border border-white/30 border-t-white rounded-full animate-spin" /> : 'Create'}
          </button>
        </div>
      )}

      {/* Local branches */}
      <div className="px-2 py-1 flex items-center justify-between">
        <div className="flex items-center gap-1 text-[10px] font-medium text-app-text-tertiary uppercase tracking-wider">
          <Monitor size={10} />
          Local ({localBranches.length})
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowNewInput(!showNewInput)}
            className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors"
            title="New branch"
          >
            <Plus size={10} />
          </button>
          <button
            onClick={loadBranches}
            className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary"
            title="Refresh branches"
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </div>
      {localBranches.map(branch => (
        <div
          key={branch.name}
          className={`flex items-center gap-2 px-2 py-[3px] cursor-pointer transition-colors group ${
            branch.current
              ? 'bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary-dark'
              : 'hover:bg-app-hover text-app-text-body'
          }`}
          onClick={() => !branch.current && handleCheckout(branch.name)}
        >
          {branch.current ? (
            <Check size={12} className="flex-shrink-0 text-primary" />
          ) : switching === branch.name ? (
            <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin flex-shrink-0" />
          ) : (
            <GitBranch size={12} className="flex-shrink-0 opacity-40" />
          )}
          <span className="truncate">{branch.name}</span>
          {(branch.ahead !== undefined && branch.ahead > 0) && (
            <span className="ml-auto text-[10px] text-green-600 dark:text-green-400 flex-shrink-0">↑{branch.ahead}</span>
          )}
          {(branch.behind !== undefined && branch.behind > 0) && (
            <span className={`${branch.ahead ? '' : 'ml-auto'} text-[10px] text-red-600 dark:text-red-400 flex-shrink-0`}>↓{branch.behind}</span>
          )}
          {/* Delete button — only on non-current branches */}
          {!branch.current && (
            <button
              onClick={(e) => handleDeleteBranch(branch.name, e)}
              className="ml-auto p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-app-text-muted hover:text-red-500 transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
              title={`Delete ${branch.name}`}
            >
              {deleting === branch.name ? (
                <div className="w-2.5 h-2.5 border border-app-spinner border-t-red-500 rounded-full animate-spin" />
              ) : (
                <Trash2 size={10} />
              )}
            </button>
          )}
        </div>
      ))}

      {/* Remote branches */}
      {remoteBranches.length > 0 && (
        <>
          <div className="px-2 py-1 mt-1 flex items-center gap-1 text-[10px] font-medium text-app-text-tertiary uppercase tracking-wider">
            <Globe size={10} />
            Remote ({remoteBranches.length})
          </div>
          {remoteBranches.map(branch => (
            <div
              key={branch.name}
              className="flex items-center gap-2 px-2 py-[3px] cursor-pointer hover:bg-app-hover text-app-text-secondary transition-colors"
              onClick={() => handleCheckout(branch.name.replace(/^remotes\/origin\//, ''))}
            >
              {switching === branch.name ? (
                <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin flex-shrink-0" />
              ) : (
                <Globe size={12} className="flex-shrink-0 opacity-30" />
              )}
              <span className="truncate text-[11px]">{branch.name.replace(/^remotes\/origin\//, '')}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
