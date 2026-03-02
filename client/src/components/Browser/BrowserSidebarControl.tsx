import { useState, useEffect, useCallback } from 'react';
import { Globe, X } from 'lucide-react';

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
}

export function BrowserSidebarControl({ enabled = true, onContextCount, onOpenBrowser, openBrowserContextIds, focusedBrowserContextId }: BrowserSidebarControlProps) {
  const [contexts, setContexts] = useState<BrowserContext[]>([]);

  useEffect(() => {
    if (!enabled) return;

    const loadContexts = async () => {
      try {
        const resp = await fetch('/api/browser/status');
        if (resp.ok) {
          const data = await resp.json();
          const details = data.details || [];
          setContexts(details);
          onContextCount?.(details.length);
        }
      } catch {
        setContexts([]);
        onContextCount?.(0);
      }
    };

    loadContexts();
    const interval = setInterval(loadContexts, 3000);
    return () => clearInterval(interval);
  }, [enabled, onContextCount]);

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
                {ctx.title || (ctx.url && ctx.url !== 'about:blank' ? new URL(ctx.url).hostname : ctx.id)}
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
          <p className="px-2 py-1 text-[10px] text-app-text-muted">
            No active browser contexts
          </p>
        )}
      </div>
    </div>
  );
}
