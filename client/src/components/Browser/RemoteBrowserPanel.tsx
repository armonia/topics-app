import { BrowserToolbar } from './BrowserToolbar';
import { Globe, Loader2, ChevronUp, ChevronDown, X, AlertTriangle, RotateCw } from 'lucide-react';
import { useRemoteBrowser } from '../../hooks/useRemoteBrowser';
import { useTauriBrowser } from '../../hooks/useTauriBrowser';
import { useBrowserHistory } from '../../hooks/useBrowserHistory';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { SelectElementOverlay } from './SelectElementOverlay';
import { NativeBrowserPlaceholder } from './NativeBrowserPlaceholder';
import { DownloadStrip } from './DownloadStrip';
import { useBrowserSpawner } from '../../state/browserSpawner';
import { signalsActions } from '../../state/signals';
import { isTauri } from '../../lib/shell';
import type { Topic } from '../../types';

/** Report a browser pane's busy state (page loading or an agent driving it)
 *  into the unified signals store, so its tab spinner + the project rollup
 *  react. Shared by the web (useRemoteBrowser) and native (useTauriBrowser)
 *  render paths — both expose loading/agentActive. */
function useReportBrowserActivity(contextId: string, busy: boolean) {
  const paneId = `browser:${contextId}`;
  useEffect(() => {
    signalsActions.setBrowserBusy(paneId, busy);
  }, [paneId, busy]);
  useEffect(() => () => signalsActions.setBrowserBusy(paneId, false), [paneId]);
}

interface RemoteBrowserPanelProps {
  contextId: string;
  initialUrl?: string;
  navigateUrl?: string;
  onUrlChange?: (url: string) => void;
  /** Surfaces the live page `<title>` so the host can label the tab with it
   *  (the title analogue of onUrlChange). Fires only for a non-empty title. */
  onTitleChange?: (title: string) => void;
  onNavigateConsumed?: () => void;
  /** True when this pane is the visible one in its parent's layout
   *  (e.g. the active pane in a keep-alive ladder, or the active group's
   *  active pane in split view). False when the React subtree is mounted
   *  but hidden via `display:none`. Drives WebContentsView visibility
   *  in the Electron native path — the OS-level overlay can't observe
   *  CSS display state on its own. Defaults to true for legacy callers. */
  isVisible?: boolean;
  /** Optional layout-side focus callback. When provided + this browser has
   *  a recorded spawner chat (browserSpawner registry), the toolbar shows a
   *  back-arrow that focuses the spawner topic pane. Undefined = no button. */
  onFocusPanel?: (paneId: string) => void;
  /** Topics map used to look up the spawner's display name for the back
   *  button tooltip. Indexed by topic id. */
  topics?: Record<string, Topic>;
  /** Tauri only — called when the user clicks INSIDE the native WKWebView pane.
   *  A native-pane click never reaches React, so without this the pane can't
   *  activate its own tab. The render site wires it to activate this pane. */
  onSelfFocus?: () => void;
}

// Phase 30 BROWSER-CHAT-04 — local-network URLs (localhost, 127.0.0.1, *.local)
// render via <iframe>. Zero Playwright overhead, full DevTools, and the user
// already has the page on their machine. Agent tools refuse with structured
// error in this mode (acknowledged constraint).
const LOCAL_HOST_RX = /^https?:\/\/(localhost|127\.0\.0\.1|[^/]+\.local)(:|\/|$)/;

export function RemoteBrowserPanel({ contextId, initialUrl, navigateUrl, onUrlChange, onTitleChange, onNavigateConsumed, isVisible = true, onFocusPanel, topics, onSelfFocus }: RemoteBrowserPanelProps) {
  // ============ Tauri NATIVE path — real child WKWebView (multi-webview). ============
  // Like Electron's WebContentsView but via Window::add_child (browser_* commands).
  // Reuses NativeBrowserPlaceholder for the layout-slot → setBounds geometry. This is
  // the ONLY Tauri path: the native pane is agent-drivable (observe/act/extract/vision
  // delegated over /ws/browser), so there's no reason to fall back to streaming here.
  if (isTauri) {
    return (
      <TauriBrowserPanelInner
        contextId={contextId}
        initialUrl={initialUrl}
        navigateUrl={navigateUrl}
        onUrlChange={onUrlChange}
        onTitleChange={onTitleChange}
        onNavigateConsumed={onNavigateConsumed}
        isVisible={isVisible}
        onFocusPanel={onFocusPanel}
        topics={topics}
        onSelfFocus={onSelfFocus}
      />
    );
  }

  // ============ Streaming code path — WEB only. ============
  // The browser in a plain web client (no native shell) is an interactive screenshot
  // <img> driven by the server's headless browser over /ws/browser. Electron and Tauri
  // both took their native paths above; only the web client falls through here. To keep
  // memory in check, only the VISIBLE pane streams (isVisible → useRemoteBrowser).
  return (
    <RemoteBrowserPanelStreaming
      contextId={contextId}
      initialUrl={initialUrl}
      navigateUrl={navigateUrl}
      onUrlChange={onUrlChange}
      onTitleChange={onTitleChange}
      onNavigateConsumed={onNavigateConsumed}
      onFocusPanel={onFocusPanel}
      topics={topics}
      isVisible={isVisible}
    />
  );
}

/**
 * Shared spawner-aware back-button wiring. Both panel inner-components
 * (streaming + native) call this to derive the BrowserToolbar's
 * `onBackToSpawner` + `spawnerLabel` props from the registry, layout focus
 * callback, and topics map. Returns `undefined` when no back button should
 * render — either because no spawner was recorded, the layout did not pass
 * a focus callback, or the spawner topic no longer exists.
 */
function useBackToSpawner(
  contextId: string,
  onFocusPanel?: (paneId: string) => void,
  topics?: Record<string, Topic>,
): { onBackToSpawner: () => void; spawnerLabel?: string } | undefined {
  const spawnerTopicId = useBrowserSpawner(contextId);
  return useMemo(() => {
    if (!spawnerTopicId || !onFocusPanel) return undefined;
    // Only surface the button when the topic is known to this renderer
    // (avoids a "back to ???" with a dead target if the spawner was
    // archived or closed). Using topics?.[id] is null-safe.
    const topic = topics?.[spawnerTopicId];
    if (!topic) return undefined;
    return {
      onBackToSpawner: () => onFocusPanel(spawnerTopicId),
      spawnerLabel: topic.name,
    };
  }, [spawnerTopicId, onFocusPanel, topics]);
}

/**
 * Tauri native browser pane. Mirrors the Electron native path: a real child
 * WKWebView (driven by useTauriBrowser → browser_* Rust commands) composited
 * over the React layout via the shared NativeBrowserPlaceholder, now with the
 * FULL BrowserToolbar — back/forward/reload, favicon, address bar, per-topic
 * history dropdown, zoom, find-in-page and back-to-spawner, plus the Chrome
 * keyboard shortcuts. Real WKWebView history (browser_back/forward/reload) + a
 * live state poll in useTauriBrowser (url/title/favicon/loading off the page's
 * own readyState) keep the chrome in sync with IN-PAGE navigation too. DevTools,
 * quick-console (poll-drained CONSOLE_PROXY buffer), zoom and device/UA emulation
 * (browser_set_user_agent + letterbox + reload) are all wired to their WKWebView
 * bridges now; BrowserToolbar still self-hides any control whose handler is
 * absent, so there are never dead buttons.
 */
function TauriBrowserPanelInner({ contextId, initialUrl, navigateUrl, onUrlChange, onTitleChange, onNavigateConsumed, isVisible = true, onFocusPanel, topics, onSelfFocus }: RemoteBrowserPanelProps) {
  const browser = useTauriBrowser(contextId, initialUrl, isVisible, onSelfFocus);
  useReportBrowserActivity(contextId, browser.loading || browser.agentActive);
  const { history, push: pushHistory } = useBrowserHistory(contextId);
  const backToSpawner = useBackToSpawner(contextId, onFocusPanel, topics);
  const focusUrlBarRef = useRef<(() => void) | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findCount, setFindCount] = useState<number | null>(null);

  // Surface URL changes to the layout (tab title / persisted pane url) + record
  // in per-topic history. browser.url now tracks in-page nav via the poll.
  useEffect(() => {
    if (browser.url) {
      onUrlChange?.(browser.url);
      pushHistory(browser.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on url change only
  }, [browser.url]);

  // Surface the live page <title> so the host can label the tab with it (the
  // title analogue of the url effect above). Empty titles are dropped by the
  // host's persist gate, so a page with no <title> won't erase a good label.
  useEffect(() => {
    if (browser.title) onTitleChange?.(browser.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on title change only
  }, [browser.title]);

  // External navigation (agent / spawner / restored pane url).
  useEffect(() => {
    if (navigateUrl) {
      void browser.navigate(navigateUrl);
      onNavigateConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when navigateUrl changes
  }, [navigateUrl]);

  // Keyboard shortcuts (Chrome parity), mirroring the Electron native panel:
  // Cmd+L focus url · Cmd+R reload · Cmd+[ back · Cmd+] forward · Cmd+F find ·
  // Cmd+(+/-/0) zoom. Skip when typing in a different text field.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      const isTextField = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
      const isUrlBar = (target as HTMLInputElement | null)?.dataset?.testid === 'browser-url-input';
      if (isTextField && !isUrlBar) return;
      const k = e.key.toLowerCase();
      if (e.altKey && k === 'i') { e.preventDefault(); void browser.toggleDevTools(); }
      else if (!e.altKey && !e.shiftKey && k === 'l') { e.preventDefault(); focusUrlBarRef.current?.(); }
      else if (!e.altKey && !e.shiftKey && k === 'r') { e.preventDefault(); void browser.reload(); }
      else if (!e.altKey && !e.shiftKey && e.key === '[') { e.preventDefault(); void browser.goBack(); }
      else if (!e.altKey && !e.shiftKey && e.key === ']') { e.preventDefault(); void browser.goForward(); }
      else if (!e.altKey && !e.shiftKey && k === 'f') { e.preventDefault(); setFindOpen(true); }
      else if (!e.shiftKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); void browser.setZoom(0.5); }
      else if (!e.shiftKey && e.key === '-') { e.preventDefault(); void browser.setZoom(-0.5); }
      else if (!e.shiftKey && e.key === '0') { e.preventDefault(); void browser.setZoom('reset'); }
      else if (e.shiftKey && k === 'e') {
        e.preventDefault();
        if (browser.selectMode) browser.exitSelectMode?.(); else browser.enterSelectMode?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [browser]);

  const runFind = useCallback(
    (forward: boolean) => { if (findText) void browser.findInPage(findText, { forward, findNext: true }); },
    [browser, findText],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindText('');
    setFindCount(null);
    void browser.stopFind();
  }, [browser]);

  // Live match count (window.find gives none, so countMatches walks the page text).
  useEffect(() => {
    if (!findOpen || !findText) { setFindCount(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void browser.countMatches?.(findText).then((n) => { if (!cancelled) setFindCount(n); });
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [findOpen, findText, browser]);

  const findBtn = 'w-6 h-6 flex items-center justify-center rounded text-app-text-muted hover:text-app-text hover:bg-app-hover transition-colors flex-shrink-0';

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="browser-native-panel">
      <BrowserToolbar
        url={browser.url}
        onUrlChange={browser.navigate}
        onBack={browser.goBack}
        onForward={browser.goForward}
        onRefresh={browser.reload}
        canGoBack={true}
        canGoForward={true}
        loading={browser.loading}
        history={history}
        faviconUrl={browser.faviconUrl}
        onRegisterFocus={(fn) => { focusUrlBarRef.current = fn; }}
        onToggleDevTools={browser.toggleDevTools}
        onBackToSpawner={backToSpawner?.onBackToSpawner}
        spawnerLabel={backToSpawner?.spawnerLabel}
        agentActive={browser.agentActive}
        agentAction={browser.agentAction}
        onZoom={browser.setZoom}
        zoom={browser.zoom}
        deviceMode={browser.deviceMode}
        onSetDevice={browser.setDevice}
        consoleEntries={browser.consoleEntries}
        consoleSummary={browser.consoleSummary}
        onClearConsole={browser.clearConsole}
      />
      {findOpen && (
        <div className="flex items-center gap-1.5 px-3 h-9 border-b border-app-border bg-app-bg flex-shrink-0">
          <input
            autoFocus
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runFind(!e.shiftKey); }
              else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
            }}
            placeholder="Trova nella pagina"
            data-testid="browser-find-input"
            className="flex-1 h-6 px-2 text-[12px] rounded bg-surface border border-app-border text-app-text placeholder:text-app-text-faint focus:outline-none focus:border-primary"
          />
          {findCount !== null && (
            <span className="text-[11px] text-app-text-muted tabular-nums flex-shrink-0 min-w-[3ch] text-right" data-testid="browser-find-count">
              {findCount}
            </span>
          )}
          <button className={findBtn} title="Precedente (⇧⏎)" onClick={() => runFind(false)}><ChevronUp size={14} aria-hidden /></button>
          <button className={findBtn} title="Successivo (⏎)" onClick={() => runFind(true)}><ChevronDown size={14} aria-hidden /></button>
          <button className={findBtn} title="Chiudi (Esc)" onClick={closeFind}><X size={14} aria-hidden /></button>
        </div>
      )}
      {/* Navigation error strip — native-path parity with BRW-REL-02. Fed by the
          Rust did-fail queue (browser_take_nav_errors). IN FLOW, not an absolute
          overlay: the native WKWebView composites ABOVE the DOM, so an overlay
          would be invisible — shrinking the placeholder repositions the native
          view below the strip instead. The failed load leaves the previous page
          alive, hence the explicit dismiss next to Riprova. */}
      {browser.navError && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border-b border-red-500/30 text-red-700 dark:text-red-300 text-[12px] flex-shrink-0"
          data-testid="browser-nav-error"
          role="alert"
        >
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span className="flex-1 min-w-0 truncate" title={browser.navError.message}>
            {browser.navError.message}
          </span>
          {(browser.navError.url || browser.url) && (
            <button
              onClick={() => browser.navigate(browser.navError!.url || browser.url)}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 font-medium transition-colors flex-shrink-0"
            >
              <RotateCw size={11} />
              Riprova
            </button>
          )}
          <button
            onClick={() => browser.clearNavError?.()}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/15 transition-colors flex-shrink-0"
            title="Chiudi"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <NativeBrowserPlaceholder browser={browser} isVisible={isVisible} />
      <DownloadStrip contextId={contextId} />
    </div>
  );
}

function RemoteBrowserPanelStreaming({ contextId, navigateUrl, onUrlChange, onTitleChange, onNavigateConsumed, onFocusPanel, topics, isVisible = true }: RemoteBrowserPanelProps) {
  // isVisible gates the screencast: only the visible pane streams frames (keeps
  // the single-WKWebView Tauri renderer's memory in check — see useRemoteBrowser).
  const browser = useRemoteBrowser(contextId, isVisible);
  const { imgRef } = browser;
  useReportBrowserActivity(contextId, browser.loading || browser.agentActive);
  const { history, push: pushHistory } = useBrowserHistory(contextId);
  const backToSpawner = useBackToSpawner(contextId, onFocusPanel, topics);

  // React to external navigateUrl prop
  useEffect(() => {
    if (navigateUrl) {
      browser.navigate(navigateUrl);
      onNavigateConsumed?.();
    }
  }, [navigateUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent of URL changes + record in per-topic history.
  useEffect(() => {
    if (browser.url) {
      onUrlChange?.(browser.url);
      pushHistory(browser.url);
    }
  }, [browser.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface the live page <title> so the host can label the tab with it.
  useEffect(() => {
    if (browser.title) onTitleChange?.(browser.title);
  }, [browser.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // Phase 30 BROWSER-CHAT-04 — Cmd+Shift+E enters select-element mode (Cursor pattern).
  // Esc exits the mode without picking. Window-level listener so the shortcut works
  // even when a sub-element of the panel has focus (e.g. iframe in localhost mode).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        browser.enterSelectMode();
      } else if (e.key === 'Escape' && browser.selectMode) {
        browser.exitSelectMode();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on the specific stable members used (enter/exit/selectMode), not the whole `browser` object which is a fresh identity each render and would re-subscribe the listener every render
  }, [browser.enterSelectMode, browser.exitSelectMode, browser.selectMode]);

  // Click ripple — 500ms lifetime keyed on the click timestamp so each click
  // re-triggers the CSS animation. Driven by an effect (not `Date.now()`
  // during render, which is impure and never schedules the auto-hide): a new
  // click timestamp shows the ripple and arms a timer to clear it after 500ms.
  // Declared before the early-return below to keep hook order stable.
  const [showRipple, setShowRipple] = useState(false);
  const clickT = browser.lastClickPos?.t;
  useEffect(() => {
    if (clickT == null) return;
    setShowRipple(true);
    const id = setTimeout(() => setShowRipple(false), 500);
    return () => clearTimeout(id);
  }, [clickT]);

  // localhost iframe fallback — early-return path with full toolbar.
  // NOT under the Tauri shell: there the whole app is a SINGLE WKWebView, and a
  // localhost SPA that frame-busts (`top.location = …`) would navigate the main
  // frame away from Topics and destroy the app (WKWebView doesn't reliably honour
  // the iframe `sandbox` top-nav restriction). Under Tauri we use the streaming
  // path instead (a screenshot <img> driven by the server's headless browser),
  // which can't touch the host frame. Electron uses its native pane; web keeps
  // the live iframe (a hijack there only swaps one browser tab, not the app).
  const isLocalhost = !isTauri && browser.url && LOCAL_HOST_RX.test(browser.url);
  if (isLocalhost) {
    return (
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <BrowserToolbar
          url={browser.url}
          onUrlChange={browser.navigate}
          onBack={browser.goBack}
          onForward={browser.goForward}
          onRefresh={browser.reload}
          canGoBack={true}
          canGoForward={true}
          loading={browser.loading}
          history={history}
          onBackToSpawner={backToSpawner?.onBackToSpawner}
          spawnerLabel={backToSpawner?.spawnerLabel}
          agentActive={browser.agentActive}
          agentAction={browser.agentAction}
        />
        <div className="flex-1 min-h-0 overflow-hidden bg-surface relative">
          <iframe
            src={browser.url}
            className="w-full h-full border-0"
            title="Local site"
            data-testid="browser-localhost-iframe"
            // SECURITY/ISOLATION: confine the framed site to its own browsing
            // context. WITHOUT a sandbox, a localhost app (e.g. an SPA login page)
            // can frame-bust via `top.location = …` and navigate the ENTIRE host
            // webview away from Topics — which is exactly what happens in the
            // Tauri shell (the main UI is a WKWebView, not a separate native
            // pane like Electron's WebContentsView), nuking the whole app.
            // Omitting `allow-top-navigation*` blocks that hijack while still
            // letting the framed app run scripts, submit its login form, keep its
            // own origin/storage, and open OAuth popups. In-frame self-navigation
            // (window.location) is unaffected — only top/parent navigation is denied.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      </div>
    );
  }

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
        onRefresh={browser.reload}        canGoBack={true}
        canGoForward={true}
        loading={browser.loading}
        history={history}
        onBackToSpawner={backToSpawner?.onBackToSpawner}
        spawnerLabel={backToSpawner?.spawnerLabel}
        agentActive={browser.agentActive}
        agentAction={browser.agentAction}
      />

      {/* Content — screenshot viewer */}
      <div
        className="flex-1 min-h-0 overflow-hidden relative bg-surface focus-within:ring-1 focus-within:ring-primary/30"
        tabIndex={0}
        onKeyDown={browser.onKeyDown}
      >
        {/* Phase 30 BROWSER-CHAT-02 — connection indicator pillola (top-right) */}
        <div
          className={`absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium pointer-events-none transition-colors browser-connection-indicator ${connectionClassPill}`}
          data-testid="browser-connection-indicator"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${connectionDotClass}`} />
          {connectionLabel}
        </div>

        {/* Navigation error strip (BRW-REL-02) — a failed goto/launch used to
            be invisible (pane stayed on the previous page / infinite
            "Starting browser…"). Cleared by the next navigation. */}
        {browser.error && (
          <div
            className="absolute top-0 inset-x-0 z-20 flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border-b border-red-500/30 text-red-700 dark:text-red-300 text-[12px]"
            data-testid="browser-nav-error"
            role="alert"
          >
            <AlertTriangle size={13} className="flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate" title={browser.error}>{browser.error}</span>
            {(browser.errorUrl || browser.url) && (
              <button
                onClick={() => browser.navigate(browser.errorUrl || browser.url)}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 font-medium transition-colors flex-shrink-0"
              >
                <RotateCw size={11} />
                Riprova
              </button>
            )}
          </div>
        )}

        {browser.screenshotSrc && !(browser.connected && (!browser.url || browser.url === 'about:blank')) ? (
          <img
            ref={imgRef}
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

        {/* Phase 30 BROWSER-CHAT-04 — agent lock overlay. Renders when the WS
            broadcasts agent_active=true (handler in useRemoteBrowser surfaces
            the message). pointer-events:auto on the overlay swallows clicks
            so the underlying screenshot stays untouched while the agent acts. */}
        {browser.agentActive && (
          <div
            className="absolute inset-0 z-30 bg-black/40 backdrop-blur-[1px] flex items-center justify-center pointer-events-auto"
            data-testid="agent-controlling-overlay"
          >
            <div className="flex flex-col items-center gap-3 bg-surface/90 px-6 py-4 rounded-lg shadow-xl border border-app-border">
              <div className="flex items-center gap-2 text-app-text">
                <span className="text-xl">🤖</span>
                <span className="text-[14px] font-medium">
                  {browser.agentAction ? `L'agente: ${browser.agentAction}` : "L'agente sta controllando…"}
                </span>
              </div>
              <button
                type="button"
                onClick={browser.takeControl}
                className="px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
                data-testid="browser-take-control-button"
              >
                Take control
              </button>
            </div>
          </div>
        )}

        {/* Phase 30 BROWSER-CHAT-04 — select-element overlay (Cursor Cmd+Shift+E pattern).
            Mounts only when selectMode === true so screenshot interaction stays
            unaffected when off. */}
        <SelectElementOverlay
          contextId={contextId}
          active={browser.selectMode}
          imgRef={imgRef}
          pageScaleFactor={browser.pageScaleFactor}
          onPick={(el) => {
            // SelectElementOverlay also dispatches the chat:insert-text custom
            // event before calling onPick (single source of truth for the
            // chat-injection side effect). Here we just persist the picked
            // element on the hook for any downstream consumers.
            browser.setSelectedElement(el);
          }}
          onCancel={() => browser.exitSelectMode()}
        />
      </div>
    </div>
  );
}
