import { BrowserToolbar } from './BrowserToolbar';
import { Globe, Loader2, ChevronUp, ChevronDown, X, AlertTriangle, RotateCw, Check, Download, Puzzle } from 'lucide-react';
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

/**
 * Whether a persisted pane url is safe to auto-seed into a blank server-side
 * browser context (streaming path). A pane's url can point at a host reachable
 * ONLY from the machine that owns the native pane — a bare hostname ("macbook"),
 * a *.local name, loopback, or a private-LAN IP. Seeding those hangs the headless
 * goto → ERR_CONNECTION_REFUSED, worse than an honest blank pane. Only public
 * http(s) hosts (a registrable dotted name or a public IP) are seedable.
 */
function isSeedableUrl(raw: string | undefined): raw is string {
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  let host: string;
  try { host = new URL(raw).hostname; } catch { return false; }
  if (!host) return false;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') return false;
  if (lower.endsWith('.local') || lower.endsWith('.localhost')) return false;
  // Bare single-label hostname (no dot) → not publicly resolvable (e.g. "macbook").
  const isIPv6 = host.includes(':');
  if (!isIPv6 && !host.includes('.')) return false;
  // Private / link-local IPv4 ranges.
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

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

  // Fresh/EMPTY pane → put the caret in the URL bar so the user can type
  // immediately (audit 2026-07-11: opening a browser tab focused NOTHING —
  // activeElement stayed on the "+" trigger). Re-arms when the pane becomes
  // visible again while still empty; a pane with a page loaded keeps focus
  // wherever the user put it. The 50ms defer lets BrowserToolbar register
  // its focus fn (onRegisterFocus) after first paint.
  const urlBarAutoFocusedRef = useRef(false);
  useEffect(() => {
    const empty = !browser.url || browser.url === 'about:blank';
    if (!isVisible || !empty) { urlBarAutoFocusedRef.current = false; return; }
    if (urlBarAutoFocusedRef.current) return;
    urlBarAutoFocusedRef.current = true;
    const t = setTimeout(() => focusUrlBarRef.current?.(), 50);
    return () => clearTimeout(t);
  }, [isVisible, browser.url]);

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

function RemoteBrowserPanelStreaming({ contextId, initialUrl, navigateUrl, onUrlChange, onTitleChange, onNavigateConsumed, onFocusPanel, topics, isVisible = true }: RemoteBrowserPanelProps) {
  // isVisible gates the screencast: only the visible pane streams frames (keeps
  // the single-WKWebView Tauri renderer's memory in check — see useRemoteBrowser).
  const browser = useRemoteBrowser(contextId, isVisible);
  const { imgRef } = browser;
  useReportBrowserActivity(contextId, browser.loading || browser.agentActive);
  const { history, push: pushHistory } = useBrowserHistory(contextId);
  const backToSpawner = useBackToSpawner(contextId, onFocusPanel, topics);

  // Same fresh/empty-pane URL-bar autofocus as the Tauri branch — see the
  // comment there. Wired through the toolbar's onRegisterFocus below.
  const focusUrlBarRef = useRef<(() => void) | null>(null);
  const urlBarAutoFocusedRef = useRef(false);
  useEffect(() => {
    const empty = !browser.url || browser.url === 'about:blank';
    if (!isVisible || !empty) { urlBarAutoFocusedRef.current = false; return; }
    if (urlBarAutoFocusedRef.current) return;
    urlBarAutoFocusedRef.current = true;
    const t = setTimeout(() => focusUrlBarRef.current?.(), 50);
    return () => clearTimeout(t);
  }, [isVisible, browser.url]);

  // Seed a blank server context with the pane's persisted URL (initialUrl). A
  // browser pane's page can live entirely on ANOTHER client — most notably the
  // Mac's NATIVE WKWebView pane (Tauri path), which never touches this server
  // context. Without this, a web/mobile client connecting to that context finds
  // it blank and sits at "Browser ready" instead of showing the page. The Tauri
  // path already navigates to initialUrl on mount (useTauriBrowser); this is its
  // streaming-path counterpart. Fire once, and only when the server context is
  // genuinely blank — never clobber a context already on a live page.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !browser.connected) return;
    // Only seed PUBLICLY-reachable urls. A pane's persisted url can point at a
    // host only reachable from the machine that owns the native pane (the Mac):
    // a bare hostname ("macbook"), a .local name, loopback, or a private-LAN IP.
    // Seeding those makes the server-side headless hang on the goto (30s) then
    // ERR_CONNECTION_REFUSED — worse than the honest blank "Browser ready". So
    // skip them; public sites (e.g. google.com) still seed.
    if (!isSeedableUrl(initialUrl)) return;
    // Let fetchInfo() (fired in ws.onopen) report the context's real url first,
    // so a context that already holds a page is left untouched.
    const t = setTimeout(() => {
      if (seededRef.current) return;
      seededRef.current = true;
      const blank = !browser.url || browser.url === 'about:blank';
      if (blank) browser.navigate(initialUrl!);
    }, 400);
    return () => clearTimeout(t);
  }, [browser.connected, browser.url, initialUrl, browser.navigate]);

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

  // T2 — native <iframe> path (CodePen-style), early-return with the full
  // toolbar. Used, in the WEB client only, when the current URL is (a) a local
  // dev site OR (b) a remote site the server probed as framable — AND no agent
  // is driving the pane (agents can't reach into a cross-origin iframe, so an
  // agent flips the pane back to the screenshot stream).
  //
  // NOT under the Tauri shell: there the whole app is a SINGLE WKWebView, and an
  // SPA that frame-busts (`top.location = …`) would navigate the main frame away
  // from Topics and destroy the app (WKWebView doesn't reliably honour the iframe
  // `sandbox` top-nav restriction). Under Tauri we use the streaming path instead
  // (a screenshot <img> driven by the server's headless browser), which can't
  // touch the host frame. On web a hijack only swaps this one browser tab, and
  // the sandbox (no `allow-top-navigation`) blocks it anyway.
  const useIframe = !isTauri && !!browser.url && !browser.agentActive &&
    (LOCAL_HOST_RX.test(browser.url) || browser.framable);
  // Task 052f53ef — while a native <iframe> is showing, the server-side headless
  // Chromium has no viewer: pause its screencast (keeps the WS open for
  // agent_active). Resume the instant we fall back to the stream.
  const setStreamActive = browser.setStreamActive;
  useEffect(() => {
    setStreamActive(!useIframe);
  }, [useIframe, setStreamActive]);
  if (useIframe) {
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
            title="Web page"
            data-testid="browser-iframe"
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

  // Hide the pill in the steady 'connected' state — the pulsing green "Live" over
  // a working (or errored, where the red nav strip already speaks) page is noise.
  // It stays visible for the states that carry information: connecting, polling
  // (fallback-http), and disconnected.
  const hideConnectionPill = browser.connectionState === 'connected';


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
        onRegisterFocus={(fn) => { focusUrlBarRef.current = fn; }}
        onBackToSpawner={backToSpawner?.onBackToSpawner}
        spawnerLabel={backToSpawner?.spawnerLabel}
        agentActive={browser.agentActive}
        agentAction={browser.agentAction}
      />

      {/* Content — screenshot viewer. containerRef wires a debounced
          ResizeObserver → the server viewport tracks this element's real size
          (+DPR), so the page reflows to fill it with no fixed-1280 letterbox. */}
      <div
        ref={browser.containerRef}
        className="flex-1 min-h-0 overflow-hidden relative bg-surface focus-within:ring-1 focus-within:ring-primary/30"
        tabIndex={0}
        onKeyDown={browser.onKeyDown}
      >
        {/* Phase 30 BROWSER-CHAT-02 — connection indicator pillola (top-right).
            Hidden on the settled happy path (see hideConnectionPill). */}
        {!hideConnectionPill && (
          <div
            className={`absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium pointer-events-none transition-colors browser-connection-indicator ${connectionClassPill}`}
            data-testid="browser-connection-indicator"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${connectionDotClass}`} />
            {connectionLabel}
          </div>
        )}

        {/* Engine toggle (task 54601eeb) — Native ↔ real Chromium (extensions).
            Shown only when the server advertises the capability
            (TOPICS_CHROMIUM_ENGINE on + a Chromium installed). Streaming-only:
            an iframe pane has no server-side engine. */}
        {browser.engineToggleAvailable && (
          <button
            type="button"
            data-testid="browser-engine-toggle"
            onClick={() => browser.setEngine(browser.engine === 'chromium' ? 'native' : 'chromium')}
            className={`absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border transition-colors ${
              browser.engine === 'chromium'
                ? 'bg-primary/15 border-primary/40 text-primary hover:bg-primary/25'
                : 'bg-surface/90 border-border text-muted hover:bg-surface hover:text-text'
            }`}
            title={browser.engine === 'chromium'
              ? `Chromium reale · ${browser.engineExtensions} estensioni — clicca per tornare al motore nativo`
              : 'Motore nativo — clicca per usare il tuo Chromium reale (con le estensioni)'}
          >
            <Puzzle size={12} className="flex-shrink-0" />
            {browser.engine === 'chromium' ? `Chromium · ${browser.engineExtensions}` : 'Nativo'}
          </button>
        )}

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

        {/* WebRTC shared-session <video> (opt-in). Mounted through negotiation so
            ontrack can attach the stream before ICE connects; overlaid + interactive
            only once active, otherwise the JPEG <img> below stays visible. */}
        {browser.webrtcMounted && (
          <video
            ref={browser.videoRef}
            autoPlay
            playsInline
            muted
            data-testid="browser-webrtc-video"
            className={`absolute inset-0 w-full h-full object-contain bg-black transition-opacity ${
              browser.webrtcActive ? 'opacity-100 z-[1] cursor-default select-none' : 'opacity-0 pointer-events-none'
            }`}
            onClick={browser.onClick}
            onWheel={browser.onWheel}
          />
        )}

        {/* No JPEG rendering — the visible surface is the WebRTC <video> above (when
            active) or a native <iframe> (framable URLs). Underneath: an error+Riprova
            if WebRTC couldn't be established, the empty-URL prompt, or a spinner while
            the shared session negotiates. */}
        {browser.webrtcError ? (
          <div className="flex items-center justify-center h-full" data-testid="browser-webrtc-error">
            <div className="text-center max-w-xs px-4">
              <AlertTriangle size={30} className="mx-auto mb-3 text-red-500" />
              <p className="text-[13px] text-app-text-muted mb-1">Sessione video non disponibile</p>
              <p className="text-[11px] text-app-text-faint mb-3">Il transport WebRTC non si è connesso.</p>
              <button
                type="button"
                onClick={browser.retryWebrtc}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
                data-testid="browser-webrtc-retry"
              >
                <RotateCw size={12} />
                Riprova
              </button>
            </div>
          </div>
        ) : (!browser.url || browser.url === 'about:blank') ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Globe size={36} className="mx-auto mb-3 text-app-spinner" />
              <p className="text-[13px] text-app-text-muted mb-1">Browser ready</p>
              <p className="text-[11px] text-app-text-faint">Enter a URL above to navigate</p>
            </div>
          </div>
        ) : browser.webrtcActive ? null : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 size={28} className="mx-auto mb-2 text-app-spinner animate-spin" />
              <p className="text-[12px] text-app-text-muted">Avvio sessione condivisa…</p>
            </div>
          </div>
        )}

        {/* Loading overlay during navigation (over the live video). */}
        {browser.loading && browser.webrtcActive && (
          <div className="absolute inset-0 bg-black/10 flex items-center justify-center pointer-events-none z-[2]">
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

      {/* Download strip — the web streaming pane has no native download shelf,
          so headless-page downloads (saved server-side under our origin) surface
          here as user-clickable links. Newest last, bounded by the hook. */}
      {browser.downloads.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-t border-app-border bg-app-bg flex-shrink-0 overflow-x-auto"
          data-testid="browser-download-strip"
        >
          <Download size={13} className="text-app-text-muted flex-shrink-0" aria-hidden />
          {browser.downloads.map((d) => (
            <a
              key={d.href}
              href={d.href}
              download
              target="_blank"
              rel="noreferrer"
              title={d.state === 'failed' ? 'Download fallito' : d.filename}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface border border-app-border text-[12px] text-app-text hover:bg-app-hover transition-colors flex-shrink-0 max-w-[220px]"
              data-testid="browser-download-item"
            >
              {d.state === 'completed' ? (
                <Check size={12} className="text-green-600 dark:text-green-400 flex-shrink-0" aria-hidden />
              ) : d.state === 'failed' ? (
                <X size={12} className="text-red-500 flex-shrink-0" aria-hidden />
              ) : (
                <Loader2 size={12} className="animate-spin text-app-spinner flex-shrink-0" aria-hidden />
              )}
              <span className="truncate">{d.filename}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
