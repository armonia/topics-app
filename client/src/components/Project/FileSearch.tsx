import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { filesApi } from '../../lib/api';
import { basename } from '../../lib/path-utils';
import { MODAL_PANEL } from '@/lib/modalStyles';
import { SELECTED_SURFACE } from '@/lib/selectionStyles';

interface SearchResult {
  file: string;
  line: string;
  lineNumber: number;
  match: string;
}

interface FileSearchProps {
  projectPath: string;
  onOpenFile?: (path: string, lineNumber?: number) => void;
  onClose: () => void;
}

export function FileSearch({ projectPath, onOpenFile, onClose }: FileSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [useRegex, setUseRegex] = useState<boolean>(false);
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [regexError, setRegexError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resultRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async (q: string) => {
    setRegexError(null);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    if (useRegex) {
      try { new RegExp(q); } catch (e: unknown) { setRegexError((e instanceof Error && e.message) || 'Invalid regex'); setResults([]); return; }
    }
    setLoading(true);
    try {
      const data = await filesApi.search(projectPath, q, useRegex, caseSensitive);
      setResults(data.results);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, useRegex, caseSensitive]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, doSearch]);

  // Reset selection when results change
  useEffect(() => { setSelectedIdx(-1); }, [results]);

  const openResult = useCallback((r: SearchResult) => {
    const fullPath = projectPath + '/' + r.file;
    onOpenFile?.(fullPath, r.lineNumber);
    onClose();
  }, [projectPath, onOpenFile, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => {
        const next = Math.min(prev + 1, results.length - 1);
        resultRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => {
        const next = Math.max(prev - 1, 0);
        resultRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
      return;
    }
    if (e.key === 'Enter' && selectedIdx >= 0 && selectedIdx < results.length) {
      e.preventDefault();
      openResult(results[selectedIdx]);
    }
  };

  const highlightMatch = (line: string, match: string) => {
    if (!match) return line;
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = useRegex ? new RegExp(match, flags) : new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const parts = line.split(regex);
      const matches = line.match(regex);
      if (!matches) return line;
      return parts.reduce((acc: (string | React.ReactElement)[], part, i) => {
        acc.push(part);
        if (i < matches.length) {
          acc.push(<span key={i} className="bg-yellow-300/60 dark:bg-yellow-500/40 rounded-sm px-0.5">{matches[i]}</span>);
        }
        return acc;
      }, []);
    } catch {
      return line;
    }
  };

  // Group results by file
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.file] ||= []).push(r);
    return acc;
  }, {});

  return (
    <div data-testid="file-search" className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/30 dark:bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`w-[600px] max-w-[92vw] max-h-[70vh] ${MODAL_PANEL} flex flex-col`}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border">
          <Search size={16} className="text-app-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Search in ${basename(projectPath) || 'files'}…`}
            className="flex-1 bg-transparent text-sm outline-none text-app-text-heading placeholder-app-text-faint"
          />
          {/* Toggles */}
          <button
            onClick={() => setCaseSensitive(v => !v)}
            className={`px-1.5 py-0.5 text-[11px] font-mono rounded border ${caseSensitive ? 'border-primary text-primary bg-primary/10' : 'border-app-spinner text-app-text-muted'}`}
            title="Case sensitive"
          >
            Aa
          </button>
          <button
            onClick={() => setUseRegex(v => !v)}
            className={`px-1.5 py-0.5 text-[11px] font-mono rounded border ${useRegex ? 'border-primary text-primary bg-primary/10' : 'border-app-spinner text-app-text-muted'}`}
            title="Use regex"
          >
            .*
          </button>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text-hover">
            <X size={16} />
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
            </div>
          )}
          {regexError && !loading && (
            <div data-testid="regex-error" className="text-center text-red-400 text-xs py-4 px-3">{regexError}</div>
          )}
          {!loading && !regexError && query && results.length === 0 && (
            <div className="text-center text-app-text-muted text-xs py-6">No results found</div>
          )}
          {!loading && (() => {
            let flatIdx = 0;
            return Object.entries(grouped).map(([file, fileResults]) => (
              <div key={file} className="border-b border-app-border-subtle last:border-b-0">
                <div className="px-3 py-1 text-[11px] font-medium text-app-text-secondary bg-app-inset sticky top-0">
                  {file}
                </div>
                {fileResults.map((r, i) => {
                  const idx = flatIdx++;
                  return (
                    <button
                      key={`${r.lineNumber}-${i}`}
                      ref={el => { resultRefs.current[idx] = el; }}
                      onClick={() => openResult(r)}
                      className={`w-full text-left px-3 py-1 flex items-start gap-2 transition-colors ${
                        idx === selectedIdx ? SELECTED_SURFACE : 'hover:bg-app-hover'
                      }`}
                    >
                      <span className="text-[11px] text-app-text-muted font-mono w-8 text-right flex-shrink-0 mt-0.5">
                        {r.lineNumber}
                      </span>
                      <span className="text-xs text-app-text-body font-mono truncate">
                        {highlightMatch(r.line.trim(), r.match)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ));
          })()}
          {!loading && results.length >= 100 && (
            <div className="text-center text-app-text-muted text-[11px] py-2">Showing first 100 results</div>
          )}
        </div>
      </div>
    </div>
  );
}
