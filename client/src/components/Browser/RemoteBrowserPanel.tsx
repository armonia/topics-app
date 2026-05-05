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

  // Phase 30 BROWSER-CHAT-02 — connection indicator label + class. Computed
  // outside JSX so the testid string-class is easy to assert in E2E.
  const connectionLabel =
    browser.connectionState === 'connected' ? 'Live' :
    browser.connectionState === 'fallback-http' ? 'Polling' :
    browser.connectionState === 'connecting' ? 'Connecting...' :
    'Disconnected';

  const connectionClassPill =
    browser.connectionState === 'connected'
      ? 'bg-green-500/15 text-green-600 dark:text-green-400 connection-live'
      : browser.connectionState === 'fallback-http'
      ? 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 connection-fallback'
      : browser.connectionState === 'connecting'
      ? 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 connection-connecting'
      : 'bg-red-500/15 text-red-600 dark:text-red-400 connection-disconnected';

  const connectionDotClass =
    browser.connectionState === 'connected' ? 'bg-green-500 animate-pulse' :
    browser.connectionState === 'fallback-http' ? 'bg-yellow-500' :
    browser.connectionState === 'connecting' ? 'bg-yellow-500 animate-pulse' :
    'bg-red-500';

  // Click ripple — 500ms lifetime keyed on click timestamp so each click
  // remounts the element and re-triggers the CSS animation.
  const showRipple = !!browser.lastClickPos && (Date.now() - browser.lastClickPos.t < 500);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Phase 30 BROWSER-CHAT-02 — ripple keyframes. Inline so no Tailwind config touch. */}
      <style>{`
        @keyframes ripple {
          0% { transform: scale(0.5); opacity: 0.7; }
          100% { transform: scale(2.5); opacity: 0; }
        }
        .animate-ripple { animation: ripple 0.5s ease-out forwards; }
      `}</style>

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
        {/* Phase 30 BROWSER-CHAT-02 — connection indicator pillola (top-right) */}
        <div
          className={`absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium pointer-events-none transition-colors browser-connection-indicator ${connectionClassPill}`}
          data-testid="browser-connection-indicator"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${connectionDotClass}`} />
          {connectionLabel}
        </div>

        {browser.screenshotSrc && !(browser.connected && (!browser.url || browser.url === 'about:blank')) ? (
          <img
            ref={browser.imgRef}
            src={browser.screenshotSrc}
            alt={browser.title || 'Browser page'}
            className="w-full h-full object-contain cursor-default select-none"
            onClick={browser.onClick}
            onWheel={browser.onWheel}
            draggable={false}
          />
        ) : browser.connected && (!browser.url || browser.url === 'about:blank') ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Globe size={36} className="mx-auto mb-3 text-app-spinner" />
              <p className="text-[13px] text-app-text-muted mb-1">Browser ready</p>
              <p className="text-[11px] text-app-text-faint">Enter a URL above to navigate</p>
            </div>
          </div>
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
            </div>
          </div>
        )}

        {/* Loading overlay during navigation */}
        {browser.loading && browser.screenshotSrc && (
          <div className="absolute inset-0 bg-black/10 flex items-center justify-center pointer-events-none">
            <Loader2 size={20} className="text-white/80 animate-spin" />
          </div>
        )}

        {/* Phase 30 BROWSER-CHAT-02 — click ripple animation. position: fixed
            anchors to viewport coords (browser.lastClickPos uses e.clientX/Y),
            so no container-relative translation needed. Decorative only. */}
        {showRipple && browser.lastClickPos && (
          <span
            key={browser.lastClickPos.t}
            className="fixed pointer-events-none rounded-full bg-app-primary/40 z-50 animate-ripple"
            style={{
              left: browser.lastClickPos.x - 12,
              top: browser.lastClickPos.y - 12,
              width: 24,
              height: 24,
            }}
            data-testid="browser-click-ripple"
          />
        )}
      </div>
    </div>
  );
}
