import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { filesApi } from '../../lib/api';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/40" onClick={onClose}>
      <div
        className="w-[600px] max-h-[70vh] bg-white dark:bg-[#1e1e1e] rounded-lg shadow-2xl border border-[#e0e0e0] dark:border-[#333] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e8e8e8] dark:border-[#333]">
          <Search size={16} className="text-[#888] flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search in files…"
            className="flex-1 bg-transparent text-sm outline-none text-[#333] dark:text-[#ddd] placeholder-[#999]"
          />
          {/* Toggles */}
          <button
            onClick={() => setCaseSensitive(v => !v)}
            className={`px-1.5 py-0.5 text-[10px] font-mono rounded border ${caseSensitive ? 'border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10' : 'border-[#ccc] dark:border-[#555] text-[#888]'}`}
            title="Case sensitive"
          >
            Aa
          </button>
          <button
            onClick={() => setUseRegex(v => !v)}
            className={`px-1.5 py-0.5 text-[10px] font-mono rounded border ${useRegex ? 'border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10' : 'border-[#ccc] dark:border-[#555] text-[#888]'}`}
            title="Use regex"
          >
            .*
          </button>
          <button onClick={onClose} className="text-[#888] hover:text-[#555] dark:hover:text-[#ccc]">
            <X size={16} />
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <div className="w-3 h-3 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin" />
            </div>
          )}
          {!loading && query && results.length === 0 && (
            <div className="text-center text-[#888] text-xs py-6">No results found</div>
          )}
          {!loading && Object.entries(grouped).map(([file, fileResults]) => (
            <div key={file} className="border-b border-[#f0f0f0] dark:border-[#2a2a2a] last:border-b-0">
              <div className="px-3 py-1 text-[11px] font-medium text-[#666] dark:text-[#999] bg-[#f8f8f8] dark:bg-[#1a1a1a] sticky top-0">
                {file}
              </div>
              {fileResults.map((r, i) => (
                <button
                  key={`${r.lineNumber}-${i}`}
                  onClick={() => {
                    const fullPath = projectPath + '/' + r.file;
                    onOpenFile?.(fullPath, r.lineNumber);
                    onClose();
                  }}
                  className="w-full text-left px-3 py-1 hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a] flex items-start gap-2 transition-colors"
                >
                  <span className="text-[10px] text-[#999] font-mono w-8 text-right flex-shrink-0 mt-0.5">
                    {r.lineNumber}
                  </span>
                  <span className="text-xs text-[#444] dark:text-[#ccc] font-mono truncate">
                    {highlightMatch(r.line.trim(), r.match)}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {!loading && results.length >= 100 && (
            <div className="text-center text-[#999] text-[10px] py-2">Showing first 100 results</div>
          )}
        </div>
      </div>
    </div>
  );
}
