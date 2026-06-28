import { BrowserToolbar } from './BrowserToolbar';
import { Globe, Loader2, ChevronUp, ChevronDown, X } from 'lucide-react';
import { useRemoteBrowser } from '../../hooks/useRemoteBrowser';
import { useNativeBrowser } from '../../hooks/useNativeBrowser';
import { useTauriBrowser } from '../../hooks/useTauriBrowser';
import { useBrowserHistory } from '../../hooks/useBrowserHistory';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { SelectElementOverlay } from './SelectElementOverlay';
import { NativeBrowserPlaceholder } from './NativeBrowserPlaceholder';
import { DownloadStrip } from './DownloadStrip';
import { PermissionBar } from './PermissionBar';
import { useBrowserSpawner } from '../../state/browserSpawner';
import { signalsActions } from '../../state/signals';
import { isTauri } from '../../lib/shell';
import type { Topic } from '../../types';

/** Report a browser pane's busy state (page loading or an agent driving it)
 *  into the unified signals store, so its tab spinner + the project rollup
 *  react. Shared by the web (useRemoteBrowser) and native (useNativeBrowser)
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
}

// Phase 30 BROWSER-CHAT-04 — local-network URLs (localhost, 127.0.0.1, *.local)
// render via <iframe>. Zero Playwright overhead, full DevTools, and the user
// already has the page on their machine. Agent tools refuse with structured
// error in this mode (acknowledged constraint).
const LOCAL_HOST_RX = /^https?:\/\/(localhost|127\.0\.0\.1|[^/]+\.local)(:|\/|$)/;

export function RemoteBrowserPanel({ contextId, initialUrl, navigateUrl, onUrlChange, onNavigateConsumed, isVisible = true, onFocusPanel, topics }: RemoteBrowserPanelProps) {
  // Phase 30.1 BROWSER-CHAT-06 — Electron native render path.
  // Detect via window.electronAPI?.browserNative?.isAvailable. In Electron,
  // skip mounting useRemoteBrowser entirely (no WS streaming, no CDP screencast,
  // no <img> rendering). The native hook wires its own /ws/browser/:contextId
  // subscription for agent_active.
  const isElectronNative = Boolean(window.electronAPI?.browserNative?.isAvailable);

  if (isElectronNative) {
    return (
      <NativeBrowserPanelInner
        contextId={contextId}
        initialUrl={initialUrl}
        navigateUrl={navigateUrl}
        onUrlChange={onUrlChange}
        onNavigateConsumed={onNavigateConsumed}
        isVisible={isVisible}
        onFocusPanel={onFocusPanel}
        topics={topics}
      />
    );
  }

  // ============ Tauri NATIVE path — real child WKWebView (multi-webview). ============
  // Like Electron's WebContentsView but via Window::add_child (browser_* commands).
  // Reuses NativeBrowserPlaceholder for the layout-slot → setBounds geometry.
  if (isTauri) {
    return (
      <TauriBrowserPanelInner
        contextId={contextId}
        initialUrl={initialUrl}
        navigateUrl={navigateUrl}
        onUrlChange={onUrlChange}
        onNavigateConsumed={onNavigateConsumed}
        isVisible={isVisible}
        onFocusPanel={onFocusPanel}
        topics={topics}
      />
    );
  }

  // ============ Streaming code path — web AND Tauri. ============
  // Tauri has no per-pane native view (that's the post-Tier-1 "D1" decision), so
  // it shares the web screencast path: an interactive screenshot <img> driven by
  // the server's headless browser over /ws/browser (reachable via the loopback
  // TLS proxy — see lib/shell/net). To keep the single WKWebView renderer's
  // memory in check, only the VISIBLE pane streams (isVisible → useRemoteBrowser).
  return (
    <RemoteBrowserPanelStreaming
      contextId={contextId}
      initialUrl={initialUrl}
      navigateUrl={navigateUrl}
      onUrlChange={onUrlChange}
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
 * console capture and device emulation stay hidden — their WKWebView bridges
 * aren't wired yet and BrowserToolbar self-hides a control whose handler is
 * absent, so there are no dead buttons.
 */
function TauriBrowserPanelInner({ contextId, initialUrl, navigateUrl, onUrlChange, onNavigateConsumed, isVisible = true, onFocusPanel, topics }: RemoteBrowserPanelProps) {
  const browser = useTauriBrowser(contextId, initialUrl);
  useReportBrowserActivity(contextId, browser.loading);
  const { history, push: pushHistory } = useBrowserHistory(contextId);
  const backToSpawner = useBackToSpawner(contextId, onFocusPanel, topics);
  const focusUrlBarRef = useRef<(() => void) | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');

  // Surface URL changes to the layout (tab title / persisted pane url) + record
  // in per-topic history. browser.url now tracks in-page nav via the poll.
  useEffect(() => {
    if (browser.url) {
      onUrlChange?.(browser.url);
      pushHistory(browser.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on url change only
  }, [browser.url]);

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
      if (!e.altKey && !e.shiftKey && k === 'l') { e.preventDefault(); focusUrlBarRef.current?.(); }
      else if (!e.altKey && !e.shiftKey && k === 'r') { e.preventDefault(); void browser.reload(); }
      else if (!e.altKey && !e.shiftKey && e.key === '[') { e.preventDefault(); void browser.goBack(); }
      else if (!e.altKey && !e.shiftKey && e.key === ']') { e.preventDefault(); void browser.goForward(); }
      else if (!e.altKey && !e.shiftKey && k === 'f') { e.preventDefault(); setFindOpen(true); }
      else if (!e.shiftKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); void browser.setZoom(0.5); }
      else if (!e.shiftKey && e.key === '-') { e.preventDefault(); void browser.setZoom(-0.5); }
      else if (!e.shiftKey && e.key === '0') { e.preventDefault(); void browser.setZoom('reset'); }
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
    void browser.stopFind();
  }, [browser]);

  const findBtn = 'w-6 h-6 flex items-center justify-center rounded text-app-text-muted hover:text-app-text hover:bg-app-hover transition-colors flex-shrink-0';

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface" data-testid="browser-native-panel">
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
        onBackToSpawner={backToSpawner?.onBackToSpawner}
        spawnerLabel={backToSpawner?.spawnerLabel}
        onZoom={browser.setZoom}
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
          <button className={findBtn} title="Precedente (⇧⏎)" onClick={() => runFind(false)}><ChevronUp size={14} aria-hidden /></button>
          <button className={findBtn} title="Successivo (⏎)" onClick={() => runFind(true)}><ChevronDown size={14} aria-hidden /></button>
          <button className={findBtn} title="Chiudi (Esc)" onClick={closeFind}><X size={14} aria-hidden /></button>
        </div>
      )}
      <NativeBrowserPlaceholder browser={browser} isVisible={isVisible} />
    </div>
  );
}

function RemoteBrowserPanelStreaming({ contextId, navigateUrl, onUrlChange, onNavigateConsumed, onFocusPanel, topics, isVisible = true }: RemoteBrowserPanelProps) {
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

/**
 * Phase 30.1 BROWSER-CHAT-06 — Inner panel for Electron native render path.
 * Mounted by RemoteBrowserPanel when window.electronAPI.browserNative is
 * available. Uses useNativeBrowser (IPC + WS) and renders the toolbar +
 * NativeBrowserPlaceholder. Cmd+Shift+E select-element overlay is NOT
 * mounted in this mode (deferred — see SUMMARY for rationale).
 */
function NativeBrowserPanelInner({ contextId, initialUrl, navigateUrl, onUrlChange, onNavigateConsumed, isVisible = true, onFocusPanel, topics }: RemoteBrowserPanelProps) {
  const browser = useNativeBrowser(contextId, initialUrl);
  useReportBrowserActivity(contextId, browser.loading || browser.agentActive);
  const { history, push: pushHistory } = useBrowserHistory(contextId);
  const backToSpawner = useBackToSpawner(contextId, onFocusPanel, topics);
  const focusUrlBarRef = useRef<(() => void) | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<{ activeMatchOrdinal: number; matches: number }>({ activeMatchOrdinal: 0, matches: 0 });
  const [selectMode, setSelectMode] = useState(false);

  // Subscribe to find-in-page result events while find bar is open.
  useEffect(() => {
    if (!findOpen) return;
    const unsub = browser.onFindResult((r) => {
      setFindResult({ activeMatchOrdinal: r.activeMatchOrdinal, matches: r.matches });
    });
    return unsub;
  }, [findOpen, browser]);

  // Re-issue find when text or options change (debounced via React batching).
  useEffect(() => {
    if (!findOpen) return;
    if (!findText) {
      browser.stopFind();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing find-result counters when the query empties; resets to constant zero state synced to findText, cannot loop (findText is not derived from findResult)
      setFindResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }
    browser.findInPage(findText, { forward: true, findNext: false });
  }, [findOpen, findText, browser]);

  // Closing the find bar stops the search and clears highlight.
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindText('');
    setFindResult({ activeMatchOrdinal: 0, matches: 0 });
    browser.stopFind();
  }, [browser]);

  useEffect(() => {
    if (navigateUrl) {
      browser.navigate(navigateUrl);
      onNavigateConsumed?.();
    }
  }, [navigateUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (browser.url) {
      onUrlChange?.(browser.url);
      pushHistory(browser.url);
    }
  }, [browser.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Phase 30.1 polish — keyboard shortcuts (Chrome parity):
  //  - Cmd+Opt+I  : toggle DevTools (also wired via toolbar button)
  //  - Cmd+L      : focus URL bar
  //  - Cmd+R      : reload
  //  - Cmd+[      : back
  //  - Cmd+]      : forward
  // Window-level so they fire even when sub-elements have focus. Skip
  // when target is an input/textarea elsewhere in the app — those should
  // own their own shortcuts (e.g. URL bar input handles Enter natively).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // Don't hijack shortcuts inside a different text input (chat input,
      // settings form). Allow on the URL bar itself (browser-url-input).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      const isTextField = (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable);
      const isUrlBar = (target as HTMLInputElement | null)?.dataset?.testid === 'browser-url-input';
      if (isTextField && !isUrlBar) return;

      // Cmd+Opt+I — DevTools
      if (e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        browser.toggleDevTools();
        return;
      }
      // Cmd+L — focus URL bar
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        focusUrlBarRef.current?.();
        return;
      }
      // Cmd+R — reload
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        browser.reload();
        return;
      }
      // Cmd+[ — back
      if (!e.altKey && !e.shiftKey && e.key === '[') {
        e.preventDefault();
        browser.goBack();
        return;
      }
      // Cmd+] — forward
      if (!e.altKey && !e.shiftKey && e.key === ']') {
        e.preventDefault();
        browser.goForward();
        return;
      }
      // Cmd+F — find in page
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      // Cmd++ / Cmd+= — zoom in
      if (!e.shiftKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        browser.setZoom(0.5);
        return;
      }
      // Cmd+- — zoom out
      if (!e.shiftKey && e.key === '-') {
        e.preventDefault();
        browser.setZoom(-0.5);
        return;
      }
      // Cmd+0 — zoom reset
      if (!e.shiftKey && e.key === '0') {
        e.preventDefault();
        browser.setZoom('reset');
        return;
      }
      // Cmd+Shift+E — select element (Cursor-style)
      if (e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setSelectMode((m) => !m);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [browser]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="browser-native-panel">
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
        onToggleDevTools={browser.toggleDevTools}
        faviconUrl={browser.faviconUrl}
        onRegisterFocus={(fn) => { focusUrlBarRef.current = fn; }}
        onBackToSpawner={backToSpawner?.onBackToSpawner}
        spawnerLabel={backToSpawner?.spawnerLabel}
        agentActive={browser.agentActive}
        agentAction={browser.agentAction}
        onZoom={browser.setZoom}
        deviceMode={browser.deviceMode}
        onSetDevice={browser.setDevice}
        consoleEntries={browser.consoleEntries}
        consoleSummary={browser.consoleSummary}
        onClearConsole={browser.clearConsole}
        getNavEntries={browser.getNavEntries}
        onGoToNavIndex={browser.goToNavIndex}
      />
      {/* Phase 30.1 polish — Find-in-page bar. Opens on Cmd+F, closes on Esc
          or "x" button. Sends each keystroke to the WebContentsView via
          findInPage IPC; receives result count via onFindResult. */}
      {findOpen && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-elevated dark:bg-app-panel border-b border-app-border text-[12px]"
          data-testid="browser-find-bar"
        >
          <input
            autoFocus
            type="text"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
              else if (e.key === 'Enter') {
                e.preventDefault();
                if (findText) browser.findInPage(findText, { forward: !e.shiftKey, findNext: true });
              }
            }}
            placeholder="Find in page"
            className="flex-1 px-2 py-1 bg-surface dark:bg-elevated border border-app-border-input rounded-md focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
            data-testid="browser-find-input"
          />
          <span className="text-app-text-muted text-[11px] tabular-nums min-w-[3rem] text-right" data-testid="browser-find-count">
            {findText ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : ''}
          </span>
          <button
            type="button"
            onClick={() => { if (findText) browser.findInPage(findText, { forward: false, findNext: true }); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
            title="Previous (⇧⏎)"
            disabled={!findResult.matches}
          >‹</button>
          <button
            type="button"
            onClick={() => { if (findText) browser.findInPage(findText, { forward: true, findNext: true }); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
            title="Next (⏎)"
            disabled={!findResult.matches}
          >›</button>
          <button
            type="button"
            onClick={closeFind}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
            title="Close (Esc)"
          >×</button>
        </div>
      )}
      <NativeBrowserPlaceholder browser={browser} isVisible={isVisible} />
      {selectMode && browser.viewId && (
        <NativeSelectElementOverlay
          viewId={browser.viewId}
          contextId={contextId}
          onClose={() => setSelectMode(false)}
        />
      )}
      <PermissionBar />
      <DownloadStrip />
    </div>
  );
}

/**
 * Phase 30.1 polish — Cmd+Shift+E select element in Electron native mode.
 *
 * In web mode (Phase 30 streaming), SelectElementOverlay handles this.
 * Native mode needed its own component because the inspect call goes
 * through Electron IPC (browser-native:inspect-at-point) which executes
 * a script in the WebContentsView's page context — coords passed are in
 * the page's CSS pixels, NOT screen pixels.
 *
 * Behavior: full-pane transparent overlay catches the next click. The
 * click coordinates are translated from overlay-local CSS px to the
 * WebContentsView's CSS px (same coordinate system since WebContentsView
 * fills the placeholder slot 1:1). Result is dispatched as a
 * 'chat:insert-text' CustomEvent — same protocol as the streaming variant
 * so the chat input picks it up identically in both modes.
 */
function NativeSelectElementOverlay({
  viewId,
  contextId,
  onClose,
}: {
  viewId: string;
  contextId: string;
  onClose: () => void;
}) {
  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLDivElement;
    const rect = target.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    const api = window.electronAPI?.browserNative;
    if (!api) { onClose(); return; }
    const info = await api.inspectAtPoint(viewId, x, y);
    onClose();
    if (!info) return;
    // Mirror SelectElementOverlay's payload shape exactly for parity.
    const payload = `Selected element on ${contextId}: ${info.cssPath} @ ${info.domPath} (bbox: ${info.bbox.x},${info.bbox.y},${info.bbox.w},${info.bbox.h})${info.text ? ` — "${info.text}"` : ''}`;
    window.dispatchEvent(new CustomEvent('chat:insert-text', { detail: { text: payload } }));
  }, [viewId, contextId, onClose]);

  // Esc closes without picking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 cursor-crosshair"
      style={{ background: 'rgba(0, 102, 255, 0.05)', backdropFilter: 'none' }}
      onClick={handleClick}
      data-testid="browser-native-select-overlay"
    >
      <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 bg-primary text-white text-[11px] rounded-full shadow-lg pointer-events-none">
        Click to select an element · Esc to cancel
      </div>
    </div>
  );
}
