import { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Home, ExternalLink, Globe, Clock, Code2 } from 'lucide-react';

interface BrowserToolbarProps {
  url: string;
  onUrlChange: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onHome: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Phase 30 BROWSER-CHAT-04 — recent URLs dropdown (per-topic history). */
  history?: string[];
  /** Phase 30.1 polish — DevTools toggle for native WebContentsView. Hidden in web mode (undefined). */
  onToggleDevTools?: () => void;
}

export function BrowserToolbar({
  url,
  onUrlChange,
  onBack,
  onForward,
  onRefresh,
  onHome,
  canGoBack,
  canGoForward,
  loading,
  history,
  onToggleDevTools,
}: BrowserToolbarProps) {
  const [editUrl, setEditUrl] = useState(url);
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyMenuRef = useRef<HTMLDivElement>(null);

  // Close history dropdown on outside click.
  useEffect(() => {
    if (!historyOpen) return;
    const handler = (e: MouseEvent) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [historyOpen]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    let finalUrl = editUrl.trim();
    if (finalUrl && !finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = 'http://' + finalUrl;
    }
    if (finalUrl) {
      onUrlChange(finalUrl);
      setEditing(false);
    }
  }, [editUrl, onUrlChange]);

  const handleOpenExternal = useCallback(() => {
    if (url) {
      window.open(url, '_blank');
    }
  }, [url]);

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-elevated dark:bg-app-panel border-b border-app-border">
      {/* Navigation buttons */}
      <button
        onClick={onBack}
        disabled={!canGoBack}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
        title="Back"
      >
        <ArrowLeft size={14} />
      </button>
      <button
        onClick={onForward}
        disabled={!canGoForward}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
        title="Forward"
      >
        <ArrowRight size={14} />
      </button>
      <button
        onClick={onRefresh}
        className={`w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors ${loading ? 'animate-spin' : ''}`}
        title="Refresh"
      >
        <RotateCw size={14} />
      </button>
      <button
        onClick={onHome}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
        title="Home"
      >
        <Home size={14} />
      </button>

      {/* URL bar */}
      <form onSubmit={handleSubmit} className="flex-1 min-w-0">
        <div className="relative flex items-center">
          <Globe size={12} className="absolute left-2 text-app-text-tertiary" />
          <input
            type="text"
            value={editing ? editUrl : url}
            onChange={(e) => { setEditUrl(e.target.value); setEditing(true); }}
            onFocus={() => { setEditUrl(url); setEditing(true); }}
            onBlur={() => { setTimeout(() => setEditing(false), 200); }}
            placeholder="Enter URL..."
            className="w-full pl-7 pr-2 py-1 text-[12px] bg-surface dark:bg-elevated border border-app-border-input rounded-md focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint transition-colors"
          />
        </div>
      </form>

      {/* Phase 30 BROWSER-CHAT-04 — URL history dropdown (per-topic, last 10) */}
      {history && history.length > 0 && (
        <div className="relative" ref={historyMenuRef}>
          <button
            type="button"
            onClick={() => setHistoryOpen(open => !open)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
            title="Recent URLs"
            data-testid="browser-history-button"
          >
            <Clock size={14} />
          </button>
          {historyOpen && (
            <div
              className="absolute top-full right-0 mt-1 z-50 min-w-[260px] max-w-[480px] bg-surface dark:bg-elevated border border-app-border rounded-md shadow-xl py-1"
              data-testid="browser-history-menu"
            >
              {history.slice(0, 10).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => { onUrlChange(entry); setHistoryOpen(false); }}
                  className="w-full px-3 py-1.5 text-left text-[11px] text-app-text hover:bg-app-hover truncate"
                  title={entry}
                >
                  {entry}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Phase 30.1 polish — DevTools toggle (Electron native only) */}
      {onToggleDevTools && (
        <button
          onClick={onToggleDevTools}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
          title="Toggle DevTools (⌥⌘I)"
          data-testid="browser-devtools-button"
        >
          <Code2 size={14} />
        </button>
      )}

      {/* Open external */}
      <button
        onClick={handleOpenExternal}
        disabled={!url}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
        title="Open in browser"
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );
}
