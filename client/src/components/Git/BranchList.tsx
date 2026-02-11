// @ts-nocheck — Phase 2 component, APIs not yet implemented
import { useState, useEffect, useCallback } from 'react';
import { GitBranch, Check, RefreshCw, Globe, Monitor } from 'lucide-react';
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

  const localBranches = branches.filter(b => !b.isRemote);
  const remoteBranches = branches.filter(b => b.isRemote);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-[#8b8b8b]">
        <div className="w-3 h-3 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin" />
        Loading branches...
      </div>
    );
  }

  return (
    <div className="text-[12px]">
      {error && (
        <div className="px-3 py-1 text-red-500 text-[11px]">{error}</div>
      )}
      
      {/* Local branches */}
      <div className="px-2 py-1 flex items-center justify-between">
        <div className="flex items-center gap-1 text-[10px] font-medium text-[#8b8b8b] uppercase tracking-wider">
          <Monitor size={10} />
          Local ({localBranches.length})
        </div>
        <button
          onClick={loadBranches}
          className="p-0.5 rounded hover:bg-[#eee] dark:hover:bg-[#333] text-[#8b8b8b]"
          title="Refresh branches"
        >
          <RefreshCw size={10} />
        </button>
      </div>
      {localBranches.map(branch => (
        <div
          key={branch.name}
          className={`flex items-center gap-2 px-2 py-[3px] cursor-pointer transition-colors ${
            branch.current
              ? 'bg-[var(--primary)]/10 dark:bg-[var(--primary)]/20 text-[var(--primary)] dark:text-[#4d94ff]'
              : 'hover:bg-[#f5f5f5] dark:hover:bg-[#222] text-[#444] dark:text-[#bbb]'
          }`}
          onClick={() => !branch.current && handleCheckout(branch.name)}
        >
          {branch.current ? (
            <Check size={12} className="flex-shrink-0 text-[var(--primary)]" />
          ) : switching === branch.name ? (
            <div className="w-3 h-3 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin flex-shrink-0" />
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
        </div>
      ))}

      {/* Remote branches */}
      {remoteBranches.length > 0 && (
        <>
          <div className="px-2 py-1 mt-1 flex items-center gap-1 text-[10px] font-medium text-[#8b8b8b] uppercase tracking-wider">
            <Globe size={10} />
            Remote ({remoteBranches.length})
          </div>
          {remoteBranches.map(branch => (
            <div
              key={branch.name}
              className="flex items-center gap-2 px-2 py-[3px] cursor-pointer hover:bg-[#f5f5f5] dark:hover:bg-[#222] text-[#666] dark:text-[#888] transition-colors"
              onClick={() => handleCheckout(branch.name.replace(/^remotes\/origin\//, ''))}
            >
              {switching === branch.name ? (
                <div className="w-3 h-3 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin flex-shrink-0" />
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
