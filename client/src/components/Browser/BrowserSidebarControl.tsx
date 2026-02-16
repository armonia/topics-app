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
}

export function BrowserSidebarControl({ enabled = true }: BrowserSidebarControlProps) {
  const [contexts, setContexts] = useState<BrowserContext[]>([]);
  const [serviceRunning, setServiceRunning] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    const loadContexts = async () => {
      try {
        const resp = await fetch('/api/browser/status');
        if (resp.ok) {
          const data = await resp.json();
          setServiceRunning(data.running);
          setContexts(data.details || []);
        }
      } catch {
        setServiceRunning(false);
        setContexts([]);
      }
    };

    loadContexts();
    const interval = setInterval(loadContexts, 3000);
    return () => clearInterval(interval);
  }, [enabled]);

  const closeContext = useCallback(async (id: string) => {
    try {
      await fetch(`/api/browsers/${id}`, { method: 'DELETE' });
      setContexts(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('[BrowserSidebar] Close context failed:', err);
    }
  }, []);

  return (
    <div className="pb-2">
      {/* Status */}
      <div className="px-3 py-1">
        <div className={`flex items-center gap-1.5 text-[11px] ${serviceRunning ? 'text-green-500' : 'text-app-text-muted'}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${serviceRunning ? 'bg-green-500' : 'bg-app-text-muted'}`} />
          {serviceRunning ? 'Playwright ready' : 'Idle'}
        </div>
      </div>

      {/* Context list */}
      <div className="px-2 space-y-0.5">
        {contexts.map(ctx => (
          <div
            key={ctx.id}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-app-text-muted hover:bg-app-hover group"
          >
            <Globe size={11} className="flex-shrink-0 opacity-60" />
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
        ))}

        {contexts.length === 0 && (
          <p className="px-2 py-1 text-[10px] text-app-text-muted">
            No active browser contexts
          </p>
        )}
      </div>
    </div>
  );
}
