import { useState, useCallback, useImperativeHandle, forwardRef, memo } from 'react';
import { Check, X, FileCode, Undo2, AlertTriangle } from 'lucide-react';
import { filesApi } from '../../lib/api';
import type { DiffEdit } from '../../lib/diffParser';

export interface DiffBlockHandle {
  apply: () => Promise<boolean>;
  getState: () => ApplyState;
}

interface DiffBlockProps {
  edit: DiffEdit;
}

type ApplyState = 'pending' | 'applying' | 'applied' | 'undoing' | 'rejected' | 'error';

export const DiffBlock = memo(forwardRef<DiffBlockHandle, DiffBlockProps>(function DiffBlock({ edit }, ref) {
  const [state, setState] = useState<ApplyState>('pending');
  const [errorMsg, setErrorMsg] = useState('');
  const [contentAtApply, setContentAtApply] = useState<string | null>(null);

  const handleApply = useCallback(async (): Promise<boolean> => {
    setState('applying');
    try {
      const result = await filesApi.applyEdit(edit.filePath, edit.searchText, edit.replaceText);
      if (result.ok) {
        setState('applied');
        // Store file content snapshot after apply for undo safety check
        try {
          const content = await filesApi.content(edit.filePath);
          setContentAtApply(content);
        } catch {
          // If we can't read the file, undo will proceed without check
        }
        return true;
      } else {
        setState('error');
        setErrorMsg(result.error || 'Failed to apply edit');
        return false;
      }
    } catch (err: any) {
      setState('error');
      setErrorMsg(err.message || 'Network error');
      return false;
    }
  }, [edit]);

  const handleUndo = useCallback(async () => {
    // Check if file has been modified since we applied
    if (contentAtApply) {
      try {
        const currentContent = await filesApi.content(edit.filePath);
        if (currentContent !== contentAtApply) {
          setState('error');
          setErrorMsg('File has been modified since apply. Undo may revert wrong changes.');
          return;
        }
      } catch {
        // If we can't read the file, proceed with undo anyway
      }
    }

    setState('undoing');
    try {
      const result = await filesApi.undoEdit(edit.filePath);
      if (result.ok) {
        setState('pending');
        setContentAtApply(null);
      } else {
        setState('error');
        setErrorMsg(result.error || 'Failed to undo');
      }
    } catch (err: any) {
      setState('error');
      setErrorMsg(err.message || 'Network error');
    }
  }, [edit.filePath, contentAtApply]);

  const handleReject = useCallback(() => {
    setState('rejected');
  }, []);

  // Expose apply method and state for "Apply All" feature
  useImperativeHandle(ref, () => ({
    apply: handleApply,
    getState: () => state,
  }), [handleApply, state]);

  const searchLines = edit.searchText.split('\n');
  const replaceLines = edit.replaceText.split('\n');

  return (
    <div className="my-2 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-[12.5px]">
      {/* File path header */}
      <div className="flex items-center justify-between bg-gray-100 dark:bg-gray-800 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
          <FileCode size={14} />
          <span className="font-mono text-[11px]">{edit.filePath}</span>
        </div>
        <div className="flex items-center gap-1">
          {state === 'pending' && (
            <>
              <button
                onClick={handleApply}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
              >
                <Check size={12} /> Apply
              </button>
              <button
                onClick={handleReject}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <X size={12} /> Reject
              </button>
            </>
          )}
          {state === 'applying' && (
            <span className="text-[11px] text-gray-500">Applying...</span>
          )}
          {state === 'applied' && (
            <>
              <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                <Check size={12} /> Applied
              </span>
              <button
                onClick={handleUndo}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors ml-1"
              >
                <Undo2 size={12} /> Undo
              </button>
            </>
          )}
          {state === 'undoing' && (
            <span className="text-[11px] text-gray-500">Undoing...</span>
          )}
          {state === 'rejected' && (
            <span className="text-[11px] text-gray-400">Dismissed</span>
          )}
          {state === 'error' && (
            <div className="flex items-center gap-2">
              <AlertTriangle size={12} className="text-red-500" />
              <span className="text-[11px] text-red-500">{errorMsg}</span>
              <button
                onClick={() => { setState('pending'); setErrorMsg(''); setContentAtApply(null); }}
                className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Diff content - unified view */}
      <div className={`font-mono text-[12px] leading-[1.6] overflow-x-auto ${state === 'rejected' ? 'opacity-50' : ''}`}>
        {searchLines.map((line, i) => (
          <div key={`s-${i}`} className="px-3 bg-red-500/10 text-red-700 dark:text-red-300">
            <span className="select-none text-red-400 mr-2">-</span>
            {line}
          </div>
        ))}
        {replaceLines.map((line, i) => (
          <div key={`r-${i}`} className="px-3 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <span className="select-none text-emerald-400 mr-2">+</span>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}));
