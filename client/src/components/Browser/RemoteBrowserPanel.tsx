import { useState, useEffect, useRef, useCallback } from 'react';
import { BrowserToolbar } from './BrowserToolbar';
import { Globe, Plus, X } from 'lucide-react';

interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

interface RemoteBrowserPanelProps {
  contextId: string;
  initialUrl?: string;
  navigateUrl?: string;
  onUrlChange?: (url: string) => void;
  onNavigateConsumed?: () => void;
}

export function RemoteBrowserPanel({ contextId: _baseContextId, initialUrl, navigateUrl, onUrlChange, onNavigateConsumed }: RemoteBrowserPanelProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [{
    id: '1',
    url: initialUrl || '',
    title: '',
    loading: false,
  }]);
  const [activeTabId, setActiveTabId] = useState('1');
  const tabCounterRef = useRef(1);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onNavigateConsumedRef = useRef(onNavigateConsumed);
  onNavigateConsumedRef.current = onNavigateConsumed;

  const navigateTo = useCallback((url: string) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, loading: true, url } : t));
    onUrlChange?.(url);
  }, [activeTabId, onUrlChange]);

  const goBack = useCallback(() => {
    try { iframeRef.current?.contentWindow?.history.back(); } catch {}
  }, []);

  const goForward = useCallback(() => {
    try { iframeRef.current?.contentWindow?.history.forward(); } catch {}
  }, []);

  const refresh = useCallback(() => {
    if (!activeTab?.url) return;
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      if (iframeRef.current) iframeRef.current.src = activeTab.url;
    }
  }, [activeTab?.url]);

  const goHome = useCallback(() => navigateTo('http://localhost:3000'), [navigateTo]);

  const createTab = useCallback(() => {
    tabCounterRef.current++;
    const newId = String(tabCounterRef.current);
    setTabs(prev => [...prev, { id: newId, url: '', title: '', loading: false }]);
    setActiveTabId(newId);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (next.length === 0) {
        tabCounterRef.current++;
        const newId = String(tabCounterRef.current);
        setActiveTabId(newId);
        return [{ id: newId, url: '', title: '', loading: false }];
      }
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1].id);
      return next;
    });
  }, [activeTabId]);

  // React to external navigateUrl prop
  useEffect(() => {
    if (navigateUrl) {
      navigateTo(navigateUrl);
      onNavigateConsumedRef.current?.();
    }
  }, [navigateUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center bg-[#111118] border-b border-[#1e1e2e] flex-shrink-0 min-h-[28px]">
        <div className="flex items-center flex-1 overflow-x-auto scrollbar-none">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] cursor-pointer select-none border-r border-[#1e1e2e] max-w-[160px] transition-colors ${
                activeTabId === tab.id
                  ? 'bg-[#1a1a24] text-zinc-300'
                  : 'text-zinc-500 hover:text-zinc-400 hover:bg-[#16161e]'
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.loading ? (
                <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <Globe size={11} className="flex-shrink-0" />
              )}
              <span className="truncate">{tab.title || tab.url || 'New Tab'}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-white/10 text-zinc-500 hover:text-zinc-300 flex-shrink-0"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={createTab}
          className="w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors flex-shrink-0"
          title="New tab"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Toolbar */}
      <BrowserToolbar
        url={activeTab?.url || ''}
        onUrlChange={navigateTo}
        onBack={goBack}
        onForward={goForward}
        onRefresh={refresh}
        onHome={goHome}
        canGoBack={true}
        canGoForward={true}
        loading={activeTab?.loading || false}
      />

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden relative bg-surface">
        {!activeTab?.url ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Globe size={36} className="mx-auto mb-3 text-app-spinner" />
              <p className="text-[13px] text-app-text-muted mb-1">No page loaded</p>
              <p className="text-[11px] text-app-text-faint">Enter a URL above or click below</p>
              <button
                onClick={() => navigateTo('http://localhost:3000')}
                className="mt-3 text-[12px] text-primary hover:underline"
              >
                Open localhost:3000
              </button>
            </div>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={activeTab.url}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title={activeTab.title || 'Browser page'}
            onLoad={() => {
              try {
                const href = iframeRef.current?.contentWindow?.location.href;
                if (href && href !== 'about:blank') {
                  setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: href, title: '', loading: false } : t));
                  onUrlChange?.(href);
                }
              } catch {
                // cross-origin — can't read URL
              }
              setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, loading: false } : t));
            }}
          />
        )}
      </div>
    </div>
  );
}
