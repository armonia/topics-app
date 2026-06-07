import { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Home, ExternalLink, Globe, Clock, Code2, CornerUpLeft } from 'lucide-react';

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
  /** Phase 30.1 polish — favicon URL emitted by Chromium. Empty during navigation; toolbar falls back to <Globe>. */
  faviconUrl?: string;
  /** Phase 30.1 polish — register a focus-the-URL-bar callback. Cmd+L wires here. */
  onRegisterFocus?: (focusFn: () => void) => void;
  /** Reciprocal of ChatPanel's jump-to-browser button. When this browser was
   *  spawned from a chat (tracked via `browserSpawner` registry), the wrapper
   *  passes a callback that focuses the spawning chat pane. Renders a small
   *  back-arrow chip on the left of the URL bar — hidden when undefined. */
  onBackToSpawner?: () => void;
  /** Optional label shown in the tooltip (e.g. the spawner chat name) so the
   *  user knows where the back button will take them without guessing. */
  spawnerLabel?: string;
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
  faviconUrl,
  onRegisterFocus,
  onBackToSpawner,
  spawnerLabel,
}: BrowserToolbarProps) {
  const [editUrl, setEditUrl] = useState(url);
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [faviconError, setFaviconError] = useState(false);

  // Reset favicon error state when URL changes (new favicon may load).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local error flag to the faviconUrl prop; resets to a constant so it converges immediately and can't loop (faviconUrl is not derived from this state)
  useEffect(() => { setFaviconError(false); }, [faviconUrl]);

  // Phase 30.1 polish — register focus-bar callback so Cmd+L can focus
  // the URL input even when the panel itself isn't focused.
  useEffect(() => {
    if (!onRegisterFocus) return;
    onRegisterFocus(() => {
      const el = urlInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
  }, [onRegisterFocus]);

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
    <div className="relative flex items-center gap-1 px-2 py-1.5 bg-elevated dark:bg-app-panel border-b border-app-border">
      {/* Phase 30.1 polish — Chrome-style indeterminate progress bar at the
          bottom of the toolbar while loading. Inline keyframes + minimal
          DOM (single absolutely-positioned bar, ~3 LOC). */}
      {loading && (
        <>
          <style>{`
            @keyframes browser-toolbar-progress {
              0%   { transform: translateX(-100%) scaleX(0.4); }
              50%  { transform: translateX(0%)    scaleX(0.6); }
              100% { transform: translateX(100%)  scaleX(0.2); }
            }
            .browser-toolbar-progress-bar {
              animation: browser-toolbar-progress 1.4s linear infinite;
              transform-origin: left;
            }
          `}</style>
          <div
            className="absolute left-0 right-0 bottom-0 h-[2px] overflow-hidden pointer-events-none"
            data-testid="browser-toolbar-progress"
            aria-hidden
          >
            <div className="browser-toolbar-progress-bar absolute inset-0 bg-primary" />
          </div>
        </>
      )}
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

      {/* Back-to-spawner — surfaces only when this browser was opened from a
          chat (the spawner registry has a mapping). Sits just before the URL
          bar so it visually pairs with the favicon, making the affordance
          read as "where this page came from". */}
      {onBackToSpawner && (
        <button
          type="button"
          onClick={onBackToSpawner}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-primary/15 text-app-text-secondary hover:text-primary transition-colors"
          title={spawnerLabel ? `Torna alla chat "${spawnerLabel}"` : 'Torna alla chat che ha aperto questo browser'}
          aria-label="Torna alla chat spawner"
          data-testid="browser-back-to-spawner"
        >
          <CornerUpLeft size={14} />
        </button>
      )}

      {/* URL bar */}
      <form onSubmit={handleSubmit} className="flex-1 min-w-0">
        <div className="relative flex items-center">
          {/* Favicon (Electron native mode) or fallback Globe icon */}
          {faviconUrl && !faviconError ? (
            <img
              src={faviconUrl}
              alt=""
              className="absolute left-2 w-3 h-3 object-contain"
              onError={() => setFaviconError(true)}
              data-testid="browser-favicon"
            />
          ) : (
            <Globe size={12} className="absolute left-2 text-app-text-tertiary" />
          )}
          <input
            ref={urlInputRef}
            type="text"
            value={editing ? editUrl : url}
            onChange={(e) => { setEditUrl(e.target.value); setEditing(true); }}
            onFocus={() => { setEditUrl(url); setEditing(true); }}
            onBlur={() => { setTimeout(() => setEditing(false), 200); }}
            placeholder="Enter URL..."
            data-testid="browser-url-input"
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
