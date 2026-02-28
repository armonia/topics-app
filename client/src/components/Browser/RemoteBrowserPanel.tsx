import { BrowserToolbar } from './BrowserToolbar';
import { Globe, Loader2 } from 'lucide-react';
import { useRemoteBrowser } from '../../hooks/useRemoteBrowser';
import { useEffect } from 'react';

interface RemoteBrowserPanelProps {
  contextId: string;
  initialUrl?: string;
  navigateUrl?: string;
  onUrlChange?: (url: string) => void;
  onNavigateConsumed?: () => void;
}

export function RemoteBrowserPanel({ contextId, navigateUrl, onUrlChange, onNavigateConsumed }: RemoteBrowserPanelProps) {
  const browser = useRemoteBrowser(contextId);

  // React to external navigateUrl prop
  useEffect(() => {
    if (navigateUrl) {
      browser.navigate(navigateUrl);
      onNavigateConsumed?.();
    }
  }, [navigateUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent of URL changes
  useEffect(() => {
    if (browser.url) onUrlChange?.(browser.url);
  }, [browser.url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Toolbar */}
      <BrowserToolbar
        url={browser.url}
        onUrlChange={browser.navigate}
        onBack={browser.goBack}
        onForward={browser.goForward}
        onRefresh={browser.reload}
        onHome={browser.goHome}
        canGoBack={true}
        canGoForward={true}
        loading={browser.loading}
      />

      {/* Content — screenshot viewer */}
      <div
        className="flex-1 min-h-0 overflow-hidden relative bg-surface focus-within:ring-1 focus-within:ring-primary/30"
        tabIndex={0}
        onKeyDown={browser.onKeyDown}
      >
        {browser.screenshotSrc ? (
          <img
            ref={browser.imgRef}
            src={browser.screenshotSrc}
            alt={browser.title || 'Browser page'}
            className="w-full h-full object-contain cursor-default select-none"
            onClick={browser.onClick}
            onWheel={browser.onWheel}
            draggable={false}
          />
        ) : browser.connected || browser.loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 size={28} className="mx-auto mb-2 text-app-spinner animate-spin" />
              <p className="text-[12px] text-app-text-muted">Starting browser...</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Globe size={36} className="mx-auto mb-3 text-app-spinner" />
              <p className="text-[13px] text-app-text-muted mb-1">No browser session</p>
              <p className="text-[11px] text-app-text-faint">Enter a URL above to start</p>
              <button
                onClick={() => browser.navigate('http://localhost:3000')}
                className="mt-3 text-[12px] text-primary hover:underline"
              >
                Open localhost:3000
              </button>
            </div>
          </div>
        )}

        {/* Loading overlay during navigation */}
        {browser.loading && browser.screenshotSrc && (
          <div className="absolute inset-0 bg-black/10 flex items-center justify-center pointer-events-none">
            <Loader2 size={20} className="text-white/80 animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
