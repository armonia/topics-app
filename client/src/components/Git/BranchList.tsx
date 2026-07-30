import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, Check, RefreshCw, Globe, Monitor, Plus, Trash2, Link } from 'lucide-react';
import { gitApi } from '../../lib/api';
import { useToast } from '../Shared/Toast';
import { ConfirmDialog } from '../Shared/ConfirmDialog';
import { SELECTED_SURFACE } from '../../lib/selectionStyles';

interface Branch {
  name: string;
  current: boolean;
  isRemote: boolean;
  ahead?: number;
  behind?: number;
}

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

interface BranchListProps {
  projectPath: string;
  onBranchSwitch?: () => void;
  remotes?: { name: string; fetchUrl: string; pushUrl: string }[];
  onAddRemote?: (name: string, url: string) => Promise<void>;
  onRemoveRemote?: (name: string) => Promise<void>;
}

export function BranchList({ projectPath, onBranchSwitch, remotes, onAddRemote, onRemoveRemote }: BranchListProps) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const toast = useToast();
  const [showNewInput, setShowNewInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [forceDeleteConfirm, setForceDeleteConfirm] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const [showRemoteInput, setShowRemoteInput] = useState(false);
  const [newRemoteName, setNewRemoteName] = useState('origin');
  const [newRemoteUrl, setNewRemoteUrl] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);

  const loadBranches = useCallback(async () => {
    try {
      setLoading(true);
      const result = await gitApi.branches(projectPath);
      setBranches(result);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `toast` is used only in the catch path; the ToastProvider's context value isn't memoized, so including it would give loadBranches a new identity on every toast and re-trigger the load effect (re-fetching branches whenever any toast appears)
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
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSwitching(null);
    }
  };

  const handleCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      setCreating(true);
      await gitApi.createBranch(projectPath, name, true);
      setNewBranchName('');
      setShowNewInput(false);
      await loadBranches();
      onBranchSwitch?.();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBranch = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteConfirm(name);
  };

  const executeDeleteBranch = useCallback(async (name: string) => {
    setDeleteConfirm(null);
    try {
      setDeleting(name);
      await gitApi.deleteBranch(projectPath, name);
      await loadBranches();
    } catch (err) {
      const message = errMessage(err);
      // `git branch -d` refuses branches with unmerged commits — that failure
      // is exactly the case where a silent force-retry would destroy work, so
      // surface it as its own explicit confirmation instead of auto-retrying.
      if (/not fully merged/i.test(message)) {
        setForceDeleteConfirm(name);
      } else {
        toast.error(message);
      }
    } finally {
      setDeleting(null);
    }
  }, [projectPath, loadBranches, toast]);

  const executeForceDeleteBranch = useCallback(async (name: string) => {
    setForceDeleteConfirm(null);
    try {
      setDeleting(name);
      await gitApi.deleteBranch(projectPath, name, true);
      await loadBranches();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setDeleting(null);
    }
  }, [projectPath, loadBranches, toast]);

  const handleAddRemoteSubmit = async () => {
    const name = newRemoteName.trim();
    const url = newRemoteUrl.trim();
    if (!name || !url || !onAddRemote) return;
    try {
      setAddingRemote(true);
      await onAddRemote(name, url);
      setNewRemoteName('origin');
      setNewRemoteUrl('');
      setShowRemoteInput(false);
      toast.success(`Remote "${name}" added`);
    } catch (err) {
      toast.error(errMessage(err) || 'Failed to add remote');
    } finally {
      setAddingRemote(false);
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
    <>
    <div className="text-[12px]">
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
            className="px-1.5 h-[22px] text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {creating ? <div className="w-2.5 h-2.5 border border-white/30 border-t-white rounded-full animate-spin" /> : 'Create'}
          </button>
        </div>
      )}

      {/* Local branches */}
      <div className="px-2 py-1 flex items-center justify-between">
        <div className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
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
              ? SELECTED_SURFACE
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
            <span className="ml-auto text-[11px] text-green-600 dark:text-green-400 flex-shrink-0">↑{branch.ahead}</span>
          )}
          {(branch.behind !== undefined && branch.behind > 0) && (
            <span className={`${branch.ahead ? '' : 'ml-auto'} text-[11px] text-red-600 dark:text-red-400 flex-shrink-0`}>↓{branch.behind}</span>
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
          <div className="px-2 py-1 mt-1 flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
            <Globe size={10} />
            Remote ({remoteBranches.length})
          </div>
          {remoteBranches.map(branch => {
            // Checkout runs on the STRIPPED name — `switching` holds that, so
            // the spinner compare must use it too (matching against the raw
            // `remotes/origin/…` name never succeeded → zero feedback during a
            // multi-second remote checkout).
            const localName = branch.name.replace(/^remotes\/origin\//, '');
            return (
              <div
                key={branch.name}
                className="flex items-center gap-2 px-2 py-[3px] cursor-pointer hover:bg-app-hover text-app-text-secondary transition-colors"
                onClick={() => handleCheckout(localName)}
              >
                {switching === localName ? (
                  <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin flex-shrink-0" />
                ) : (
                  <Globe size={12} className="flex-shrink-0 opacity-30" />
                )}
                <span className="truncate text-[11px]">{localName}</span>
              </div>
            );
          })}
        </>
      )}

      {/* Remotes (URLs) */}
      {remotes !== undefined && (
        <>
          <div className="px-2 py-1 mt-1 flex items-center justify-between">
            <div className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
              <Link size={10} />
              Remotes{remotes.length > 0 ? ` (${remotes.length})` : ''}
            </div>
            {onAddRemote && (
              <button
                onClick={() => setShowRemoteInput(!showRemoteInput)}
                className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors"
                title="Add remote"
              >
                <Plus size={10} />
              </button>
            )}
          </div>
          {showRemoteInput && onAddRemote && (
            <div className="px-2 py-1">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={newRemoteName}
                  onChange={e => setNewRemoteName(e.target.value)}
                  placeholder="name"
                  className="w-[50px] h-[20px] px-1 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
                />
                <input
                  type="text"
                  value={newRemoteUrl}
                  onChange={e => setNewRemoteUrl(e.target.value)}
                  placeholder="https://github.com/..."
                  className="flex-1 min-w-0 h-[20px] px-1 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleAddRemoteSubmit(); }
                    if (e.key === 'Escape') { setShowRemoteInput(false); setNewRemoteName('origin'); setNewRemoteUrl(''); }
                  }}
                  autoFocus
                />
                <button
                  onClick={handleAddRemoteSubmit}
                  disabled={addingRemote || !newRemoteName.trim() || !newRemoteUrl.trim()}
                  className="px-1.5 h-[20px] text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
                >
                  {addingRemote ? <div className="w-2 h-2 border border-white/30 border-t-white rounded-full animate-spin" /> : 'Add'}
                </button>
              </div>
            </div>
          )}
          {remotes.map(r => (
            <div
              key={r.name}
              className="flex items-center gap-1.5 px-2 py-[3px] text-[11px] group/remote hover:bg-app-hover transition-colors"
            >
              <Link size={10} className="text-app-text-muted flex-shrink-0" />
              <span className="font-medium text-app-text-heading">{r.name}</span>
              <span className="truncate text-app-text-muted text-[11px] min-w-0">{r.fetchUrl}</span>
              {onRemoveRemote && (
                <button
                  onClick={async () => {
                    try {
                      await onRemoveRemote(r.name);
                      toast.success(`Remote "${r.name}" removed`);
                    } catch (err) {
                      toast.error(errMessage(err) || 'Failed to remove remote');
                    }
                  }}
                  className="ml-auto p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-app-text-muted hover:text-red-500 transition-all opacity-0 group-hover/remote:opacity-100 flex-shrink-0"
                  title={`Remove ${r.name}`}
                >
                  <Trash2 size={10} />
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
    {deleteConfirm && createPortal(
      <DeleteBranchConfirmDialog
        branchName={deleteConfirm}
        force={false}
        onConfirm={() => executeDeleteBranch(deleteConfirm)}
        onCancel={() => setDeleteConfirm(null)}
      />,
      document.body,
    )}
    {forceDeleteConfirm && createPortal(
      <DeleteBranchConfirmDialog
        branchName={forceDeleteConfirm}
        force
        onConfirm={() => executeForceDeleteBranch(forceDeleteConfirm)}
        onCancel={() => setForceDeleteConfirm(null)}
      />,
      document.body,
    )}
    </>
  );
}

function DeleteBranchConfirmDialog({ branchName, force, onConfirm, onCancel }: { branchName: string; force: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog
      title={force ? 'Force Delete Branch' : 'Delete Branch'}
      confirmLabel={force ? 'Force Delete' : 'Delete'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {force
        ? <>The branch <span className="font-mono">{branchName}</span> has unmerged commits. Force delete anyway? This will permanently discard those commits.</>
        : <>Delete branch <span className="font-mono">{branchName}</span>? This cannot be undone.</>}
    </ConfirmDialog>
  );
}
