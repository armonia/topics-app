import { useState, useEffect, useCallback } from 'react';
import { Globe, ChevronDown, ChevronRight, X } from 'lucide-react';

interface BrowserContext {
  id: string;
  url: string;
  title: string;
  lastActivity: number;
}

interface BrowserSidebarControlProps {
  expanded?: boolean;
  onToggle?: () => void;
}

export function BrowserSidebarControl({ expanded = false }: BrowserSidebarControlProps) {
  const [contexts, setContexts] = useState<BrowserContext[]>([]);
  const [isExpanded, setIsExpanded] = useState(expanded);
  const [serviceRunning, setServiceRunning] = useState(false);

  // Load contexts from REST API
  useEffect(() => {
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
  }, []);

  const closeContext = useCallback(async (id: string) => {
    try {
      await fetch(`/api/browsers/${id}`, { method: 'DELETE' });
      setContexts(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('[BrowserSidebar] Close context failed:', err);
    }
  }, []);

  return (
    <div className="border-t border-[#e8e8e8] dark:border-[#2a2a2a]">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#252525] transition-colors"
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Globe size={14} className={serviceRunning ? 'text-[var(--primary)]' : 'text-[#888]'} />
        <span className="text-[13px] text-[#1a1a1a] dark:text-[#e5e5e5] flex-1">Browser</span>
        {contexts.length > 0 && (
          <span className="text-[11px] text-[#888] bg-[#eee] dark:bg-[#333] px-1.5 rounded">
            {contexts.length}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="pb-2">
          {/* Status */}
          <div className="px-3 py-1">
            <div className={`flex items-center gap-1.5 text-[11px] ${serviceRunning ? 'text-green-500' : 'text-[#888]'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${serviceRunning ? 'bg-green-500' : 'bg-[#888]'}`} />
              {serviceRunning ? 'Playwright ready' : 'Idle'}
            </div>
          </div>

          {/* Context list */}
          <div className="px-2 space-y-0.5">
            {contexts.map(ctx => (
              <div
                key={ctx.id}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-[#666] dark:text-[#888] hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a] group"
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
              <p className="px-2 py-1 text-[10px] text-[#999]">
                No active browser contexts
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
