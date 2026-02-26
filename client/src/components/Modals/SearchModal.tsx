import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { searchApi } from '../../lib/api';
import type { SearchResult } from '../../types';
import { TopicIcon } from '@/lib/topicIcons';

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectResult: (topicId: string) => void;
}

export function SearchModal({ isOpen, onClose, onSelectResult }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const data = await searchApi.search(q, 30);
      setResults(data.results);
      setSelectedIndex(0);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => doSearch(value), 300);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      const result = results[selectedIndex];
      if (result.topicId) {
        onSelectResult(result.topicId);
        onClose();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // Group results by topic
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    const key = r.topicId || r.sessionKey;
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose} role="dialog" aria-modal="true" aria-label="Search messages">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
      <div
        className="relative w-full max-w-2xl mx-4 bg-surface rounded-xl shadow-2xl border border-app-border-light overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-app-border">
          <Search size={18} className="text-app-text-tertiary flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search messages across all topics..."
            className="flex-1 bg-transparent text-app-text placeholder-app-placeholder outline-none text-[14px]"
          />
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text transition-colors" aria-label="Close search">
            <X size={15} />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto">
          {loading && (
            <div className="px-4 py-8 flex items-center justify-center gap-2 text-app-text-tertiary text-[13px]">
              <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
              Searching...
            </div>
          )}
          
          {!loading && query && results.length === 0 && (
            <div className="px-4 py-8 text-center text-app-text-muted text-[13px]">No results found</div>
          )}

          {!loading && !query && (
            <div className="px-4 py-8 text-center text-app-text-muted text-[13px]">
              Type to search across all conversations
            </div>
          )}

          {!loading && Object.entries(grouped).map(([key, groupResults]) => {
            const first = groupResults[0];
            return (
              <div key={key} className="border-b border-app-border last:border-b-0">
                <div className="px-4 py-2 bg-app-hover flex items-center gap-2">
                  <TopicIcon name={first.topicIcon} size={14} className="text-app-text-secondary" />
                  <span className="text-[11px] font-semibold text-app-text-secondary">{first.topicName}</span>
                  <span className="text-[11px] text-app-text-muted">({groupResults.length})</span>
                </div>
                {groupResults.slice(0, 3).map((result, i) => {
                  const globalIndex = results.indexOf(result);
                  return (
                    <button
                      key={i}
                      className={`w-full text-left px-4 py-2.5 hover:bg-app-hover transition-colors ${
                        globalIndex === selectedIndex ? 'bg-primary/10' : ''
                      }`}
                      onClick={() => {
                        if (result.topicId) {
                          onSelectResult(result.topicId);
                          onClose();
                        }
                      }}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-[11px] font-medium ${result.role === 'user' ? 'text-primary' : 'text-emerald-500'}`}>
                          {result.role === 'user' ? 'You' : 'Assistant'}
                        </span>
                        {result.timestamp && (
                          <span className="text-[11px] text-app-text-muted">
                            {new Date(result.timestamp).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <div className="text-[13px] text-app-text line-clamp-2">
                        {highlightQuery(result.content.slice(0, 200), query)}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-app-border flex items-center gap-4 text-[11px] text-app-text-muted">
          <span>↑↓ Navigate</span>
          <span>↵ Open topic</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}

function highlightQuery(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 text-inherit rounded px-0.5">{part}</mark>
      : part
  );
}
