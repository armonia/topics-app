import { useState, useEffect, useCallback, useRef } from 'react';
import { Globe, X } from 'lucide-react';
import type { WSMessage } from '../../types';

interface BrowserContext {
  id: string;
  url: string;
  title: string;
  lastActivity: number;
}

interface BrowserSidebarControlProps {
  enabled?: boolean;
  onContextCount?: (count: number) => void;
  onOpenBrowser?: (contextId: string) => void;
  openBrowserContextIds?: string[];
  focusedBrowserContextId?: string | null;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

const POLL_INTERVAL_FALLBACK = 30_000; // 30s fallback

// hostname extraction that never throws during render (malformed urls fall back to id)
function safeHostname(url: string, fallback: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

export function BrowserSidebarControl({ enabled = true, onContextCount, onOpenBrowser, openBrowserContextIds, focusedBrowserContextId, onMessage }: BrowserSidebarControlProps) {
  const [contexts, setContexts] = useState<BrowserContext[]>([]);
  // monotonic request token — only forward-moving, so a stale (slower) response can never clobber a newer one
  const reqSeqRef = useRef<number>(0);
  const appliedSeqRef = useRef<number>(0);
  const hasLoadedRef = useRef<boolean>(false);

  const loadContexts = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    try {
      const resp = await fetch('/api/browser/status');
      if (resp.ok) {
        const data = await resp.json() as { details?: BrowserContext[] };
        // Only apply if no newer request was issued/applied meanwhile
        if (seq < appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        const details = data.details || [];
        hasLoadedRef.current = true;
        setContexts(details);
        onContextCount?.(details.length);
      }
    } catch {
      // Transient refresh failure must not wipe a list we already loaded —
      // only clear on the very first (initial-load) failure.
      if (!hasLoadedRef.current) {
        setContexts([]);
        onContextCount?.(0);
      }
    }
  }, [onContextCount]);

  // Initial fetch
  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot fetch syncing external API state into local store; setState runs in an async callback after the response, not a synchronous cascading render
    loadContexts();
  }, [enabled, loadContexts]);

  // WS subscription — trigger re-fetch on browser navigation events
  useEffect(() => {
    if (!enabled || !onMessage) return;
    const unsub = onMessage((msg: WSMessage) => {
      try {
        if (msg.type === 'browser:navigate') {
          loadContexts();
        }
      } catch { /* ignore */ }
    });
    return unsub;
  }, [enabled, onMessage, loadContexts]);

  // Fallback polling — 30s (reduced from 3s)
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(loadContexts, POLL_INTERVAL_FALLBACK);
    return () => clearInterval(interval);
  }, [enabled, loadContexts]);

  const closeContext = useCallback(async (id: string) => {
    try {
      await fetch(`/api/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setContexts(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('[BrowserSidebar] Close context failed:', err);
    }
  }, []);

  const openSet = openBrowserContextIds ? new Set(openBrowserContextIds) : null;

  return (
    <div className="pb-2">
      <div className="px-2 space-y-0.5">
        {contexts.map(ctx => {
          const isFocused = focusedBrowserContextId === ctx.id;
          const isOpen = !isFocused && (openSet?.has(ctx.id) ?? false);

          return (
            <div
              key={ctx.id}
              className={[
                'flex items-center gap-1.5 px-2 py-1 rounded group cursor-pointer transition-colors duration-100 relative',
                isFocused && 'bg-primary/8 dark:bg-primary/15 text-[#10b981]',
                !isFocused && isOpen && 'bg-app-hover text-app-text',
                !isFocused && !isOpen && 'text-app-text-muted hover:bg-app-hover',
              ].filter(Boolean).join(' ')}
              onClick={() => onOpenBrowser?.(ctx.id)}
            >
              {isFocused && (
                <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full" style={{ backgroundColor: '#10b981' }} />
              )}
              <Globe size={12} className={`flex-shrink-0 ${isFocused ? 'opacity-100' : 'opacity-60'}`} />
              <span className="text-[11px] truncate flex-1" title={ctx.url}>
                {ctx.title || (ctx.url && ctx.url !== 'about:blank' ? safeHostname(ctx.url, ctx.id) : ctx.id)}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); closeContext(ctx.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-500 transition-opacity"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}

        {contexts.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-app-text-muted">
            No active browser contexts
          </p>
        )}
      </div>
    </div>
  );
}
