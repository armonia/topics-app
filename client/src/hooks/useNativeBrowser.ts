/**
 * Phase 30.1 BROWSER-CHAT-06 — Native Electron browser hook.
 *
 * Renderer-side IPC client for window.electronAPI.browserNative. Owns the
 * WebContentsView lifecycle for ONE topic / contextId:
 *   - On mount: create view + register cdpTargetId server-side
 *   - On unmount: destroy view + unregister
 *   - Exposes navigate/goBack/goForward/reload mirroring useRemoteBrowser
 *   - Subscribes to /ws/browser/:contextId for agent_active broadcast
 *     (reuses Phase 30 protocol — same lock UX)
 *
 * Bound to a contextId provided by the caller (the same value used by
 * RemoteBrowserPanel for the WS contextId). The contextId IS the topic-bound
 * key; partitionId is derived as `persist:topic-<contextId>`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseBrowserWsMessage } from '@/types/browser-ws-messages';
import { serverWsBase } from '@/lib/shell/net';
import { DEVICE_PRESETS, type DeviceMode, type BrowserConsoleEntry, type NavHistoryEntry } from '@/components/Browser/browserDevTypes';

const CONSOLE_BUFFER_MAX = 300;

export interface NativeBrowserHandle {
  url: string;
  title: string;
  loading: boolean;
  agentActive: boolean;
  /** Human-readable label of the agent's current action ("Clicca", "Naviga su
   *  example.com", …). Last value seen on agent_active=true; persists through the
   *  brief idle linger so a burst of tool calls shows steady text. */
  agentAction: string | null;
  ready: boolean;             // viewId resolved + cdpTargetId registered
  viewId: string | null;
  /** Optional — Tauri only. A base64 PNG data-URL still of the page, shown in the
   *  placeholder while the native WKWebView is parked off-screen (a dropdown/menu
   *  overlaps it, or a sidebar/divider animation is in flight). A native child
   *  webview always composites ABOVE the DOM, so it can't be z-ordered under an
   *  HTML overlay nor cheaply moved per-frame; freezing to a DOM <img> lets
   *  overlays render over a pixel-perfect still and lets animations move the image,
   *  not the native view. Electron uses overlay windows instead and leaves this
   *  undefined. */
  frozenImage?: string | null;
  /** Favicon URL emitted by Chromium page-favicon-updated. Empty during navigation. */
  faviconUrl: string;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  goHome(): Promise<void>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  toggleDevTools(): Promise<void>;
  /** Phase 30.1 — Find in page (Cmd+F). Pass empty string + findNext=false to clear. */
  findInPage(text: string, options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }): Promise<void>;
  stopFind(): Promise<void>;
  onFindResult(cb: (r: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void): () => void;
  /** Optional — count case-insensitive matches of `text` in the page (Tauri pane,
   *  where window.find gives no count). Undefined on backends that report counts
   *  via onFindResult (Electron CDP). */
  countMatches?(text: string): Promise<number>;
  /** Optional — inspect the element at page CSS coords (Tauri select-element;
   *  Electron uses electronAPI.browserNative.inspectAtPoint instead). */
  inspectAt?(x: number, y: number): Promise<{
    cssPath: string;
    domPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text: string;
  } | null>;
  /** Optional — Cmd+Shift+E select-element. On the Tauri pane the picking runs
   *  IN-PAGE (the native view sits above the DOM, so a React overlay can't catch
   *  the click); the hook dispatches `chat:insert-text` with the picked node. */
  selectMode?: boolean;
  enterSelectMode?(): void;
  exitSelectMode?(): void;
  /** Phase 30.1 — Zoom (Cmd+/-/0). delta=+1 zooms in, -1 out, 'reset' to 100%. Returns new zoom level. */
  setZoom(delta: number | 'reset'): Promise<number>;
  /** Current device-emulation mode (default 'desktop'). */
  deviceMode: DeviceMode;
  /** Apply a device preset. 'mobile'/'tablet' emulate; 'custom' = responsive
   *  resize (real view sized to width/height, no emulation); 'desktop'/'auto'
   *  fill the pane. */
  setDevice(mode: DeviceMode, custom?: { width: number; height: number; deviceScaleFactor?: number }): void;
  /** Responsive-resize viewport (px) when deviceMode==='custom'; null otherwise. */
  responsiveSize: { width: number; height: number } | null;
  /** Live-set the responsive viewport (called continuously while dragging a handle). */
  setResponsiveSize(width: number, height: number): void;
  /** Recent page console messages (ring buffer) for the toolbar quick-console. */
  consoleEntries: BrowserConsoleEntry[];
  /** Counts for the toolbar badge. */
  consoleSummary: { errors: number; warnings: number };
  clearConsole(): void;
  /** Fetch the back/forward navigation history for the Chrome-style menu. */
  getNavEntries(): Promise<{ entries: NavHistoryEntry[]; activeIndex: number }>;
  goToNavIndex(index: number): Promise<void>;
}

export function useNativeBrowser(contextId: string, initialUrl?: string, onFocused?: () => void): NativeBrowserHandle {
  const [viewId, setViewId] = useState<string | null>(null);
  const [url, setUrl] = useState<string>(initialUrl ?? 'about:blank');
  const [title, setTitle] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [agentActive, setAgentActive] = useState<boolean>(false);
  const [agentAction, setAgentAction] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean>(false);
  const [faviconUrl, setFaviconUrl] = useState<string>('');
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop');
  // Responsive-resize viewport (px) when deviceMode==='custom'. We shrink the
  // REAL WebContentsView to this size (the page reflows naturally, no CDP
  // emulation) and expose DOM drag-handles around it — a "responsive design
  // mode" the user can drag, instead of fixed presets only.
  const [responsiveSize, setResponsiveSizeState] = useState<{ width: number; height: number } | null>(null);
  const [consoleEntries, setConsoleEntries] = useState<BrowserConsoleEntry[]>([]);
  // Bumped when the keepalive ping discovers the main process reaped our view
  // out from under us (reload-storm gap > keepalive grace). Re-runs the create
  // effect so the pane recreates a fresh WebContentsView instead of staying
  // blank forever — see the keepalive effect below.
  const [recreateNonce, setRecreateNonce] = useState(0);

  const cleanupsRef = useRef<Array<() => void>>([]);
  const mountedRef = useRef(true);
  // `initialUrl` is the page to open the view at on mount (e.g. a persisted
  // pane URL restored after restart). It is MOUNT-ONLY: captured into a ref so
  // later changes (the consumer persisting live url updates back onto the pane)
  // do NOT re-run the create effect and recreate the WebContentsView. Live
  // navigation flows through navigate()/navigateUrl, not this.
  const initialUrlRef = useRef(initialUrl);
  // Navigation requested before the WebContentsView/viewId resolved. The
  // create() round-trip is async (it awaits first paint + CDP target
  // resolution), but a navigateUrl can arrive on the very first render —
  // e.g. an agent/terminal calling open_browser_pane spawns the pane AND
  // pushes the URL in the same tick. Without buffering, navigate() would
  // drop that URL (viewId still null) and the effect never re-fires, so the
  // view stays on about:blank → the "browser opens white" bug. We stash the
  // pending URL here and flush it the moment the view is ready.
  const pendingNavigateRef = useRef<string | null>(null);

  // Mount: create WebContentsView + register CDP target server-side.
  useEffect(() => {
    mountedRef.current = true;
    const api = window.electronAPI?.browserNative;
    if (!api) {
      console.warn('[useNativeBrowser] electronAPI.browserNative not available — host should not mount this hook in web mode');
      return;
    }

    let createdViewId: string | null = null;
    const partitionId = `persist:topic-${contextId}`;
    const startUrl = initialUrlRef.current ?? 'about:blank';

    (async () => {
      try {
        const result = await api.create({ topicId: contextId, partitionId, initialUrl: startUrl });
        if (!mountedRef.current) {
          // Unmounted before create resolved — destroy now and bail.
          await api.destroy(result.viewId).catch(() => {});
          return;
        }
        createdViewId = result.viewId;
        setViewId(result.viewId);

        // Register cdpTargetId server-side so the agent CDP dispatcher resolves
        // THIS native view (not an invisible Playwright phantom). create() resolves
        // the targetId after first paint, but if it came back empty (e.g. the view
        // was still on about:blank when /json/list was queried) re-resolve via the
        // dedicated IPC a few times — without a landed registration every browser_*
        // tool for this context silently falls back to Playwright (the about:blank /
        // lost-state bug).
        let cdpTargetId = result.cdpTargetId;
        for (let i = 0; !cdpTargetId && i < 10 && mountedRef.current; i++) {
          await new Promise((r) => setTimeout(r, 150));
          cdpTargetId = await api.getCdpTargetId(result.viewId).catch(() => '');
        }
        if (cdpTargetId) {
          try {
            await fetch(`/api/browsers/${contextId}/cdp-target`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cdpTargetId }),
            });
          } catch (err) {
            console.warn('[useNativeBrowser] cdp-target register failed:', err);
          }
        } else {
          console.warn('[useNativeBrowser] could not resolve cdpTargetId — agent browser tools will report this pane as not ready until it re-registers');
        }

        // Wire url/title/loading/favicon streams.
        cleanupsRef.current.push(api.onUrlChange(result.viewId, (u) => mountedRef.current && setUrl(u)));
        cleanupsRef.current.push(api.onTitleChange(result.viewId, (t) => mountedRef.current && setTitle(t)));
        cleanupsRef.current.push(api.onLoadingChange(result.viewId, (l) => mountedRef.current && setLoading(l)));
        // Reset favicon on URL change so we don't show stale icon during navigation.
        cleanupsRef.current.push(api.onUrlChange(result.viewId, () => mountedRef.current && setFaviconUrl('')));
        cleanupsRef.current.push(api.onFaviconChange(result.viewId, (f) => mountedRef.current && setFaviconUrl(f)));

        setReady(true);

        // Flush any navigation that arrived while the view was still spinning
        // up (see pendingNavigateRef). This is what turns an agent/terminal
        // "open this URL" into an actual page load instead of a blank view.
        const pending = pendingNavigateRef.current;
        if (pending) {
          pendingNavigateRef.current = null;
          if (pending !== startUrl) {
            api.navigate(result.viewId, pending).catch((err) => {
              console.warn('[useNativeBrowser] pending navigate failed:', err);
            });
          }
        }
      } catch (err) {
        console.error('[useNativeBrowser] create failed:', err);
      }
    })();

    // NOTE: intentionally NO `beforeunload` destroy and NO destroy on unmount.
    // A native browser pane is a DURABLE tab: its WebContentsView (and CDP
    // targetId) must outlive React mount/unmount churn — a window reload (Cmd+R /
    // HMR), a tab switch, a DnD remount, a StrictMode double-mount, or any
    // re-render. Destroying it here recreated the view (new targetId) on the next
    // mount, which is exactly what made the agent's browser_* tools go stale
    // between MCP turns ("HTTP 500 cdpTargetId no longer resolves") until the
    // pane was re-opened. Instead the view is kept alive by a keepalive heartbeat
    // (the effect below) and reaped by the main process ONLY when the pings stop
    // for good (= the tab was genuinely closed / left the layout). On unmount we
    // just hide it and stop pinging; if this is a transient unmount the next
    // mount re-claims the same view (create()-reuse by topicId), if it's a real
    // close the main-side reaper collects it after the grace.
    return () => {
      mountedRef.current = false;
      for (const fn of cleanupsRef.current) {
        try { fn(); } catch { /* ignore */ }
      }
      cleanupsRef.current = [];
      if (createdViewId) {
        // Hide (fire-and-forget) so a transient unmount doesn't leave the view
        // floating; do NOT destroy — the keepalive reaper owns the lifetime.
        try { api.setBounds(createdViewId, { x: 0, y: 0, width: 0, height: 0 }); } catch { /* ignore */ }
      }
    };
    // initialUrl intentionally NOT a dep — it's mount-only (initialUrlRef).
    // Re-running on its change would destroy+recreate the view on every
    // persisted url update. Live nav uses navigate()/navigateUrl.
    // recreateNonce IS a dep: bumping it (keepalive saw the view reaped) re-runs
    // this effect to spin up a fresh WebContentsView for the same contextId.
  }, [contextId, recreateNonce]);

  // Direction-B focus: the main process emits 'browser-native:focus' with the
  // view's contextId when the user clicks INSIDE the native WebContentsView (the
  // click never reaches the React DOM). Activate this pane's tab when OUR
  // contextId fires. onFocused is read through a ref so re-subscribing isn't
  // needed when the parent passes a fresh closure.
  const onFocusedRef = useRef(onFocused);
  onFocusedRef.current = onFocused;
  useEffect(() => {
    const api = window.electronAPI?.browserNative;
    if (!api?.onFocus) return;
    return api.onFocus((cid) => {
      if (cid === contextId) onFocusedRef.current?.();
    });
  }, [contextId]);

  // Keepalive heartbeat — while this pane is mounted, ping the main process so
  // it keeps the WebContentsView alive (the reaper only collects a view whose
  // pings have stopped = the tab was genuinely closed). Also periodically
  // re-registers the CDP target server-side so the agent's targetId map self-
  // heals after a server restart or any transient stale-delete — without the
  // agent having to re-open the pane every turn. Cheap: one IPC every 5s.
  useEffect(() => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    let tick = 0;
    const ping = async () => {
      // keepalive resolves false when the main process already reaped this view
      // (a reload-storm gap exceeded the 20s grace). Pinging a dead id forever
      // leaves the pane blank — recreate instead of waiting for the next external
      // reload. An IPC error is NOT treated as dead (assume alive) to avoid
      // thrashing on a transient blip. On an old main without the boolean return,
      // keepalive resolves undefined → never === false → no-op (safe rollout).
      let alive: boolean | void = true;
      try { alive = await api.keepalive(viewId); } catch { alive = true; }
      if (alive === false) {
        if (!mountedRef.current) return;
        console.warn('[useNativeBrowser] native view was reaped — recreating to self-heal');
        setReady(false);
        setViewId(null);
        setRecreateNonce((n) => n + 1);
        return; // skip the cdp refresh this tick; the recreate path re-registers
      }
      // Every ~15s, refresh the server-side cdpTargetId registration (idempotent).
      if (tick++ % 3 === 0) {
        try {
          const cdpTargetId = await api.getCdpTargetId(viewId).catch(() => '');
          if (cdpTargetId) {
            await fetch(`/api/browsers/${contextId}/cdp-target`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cdpTargetId }),
            }).catch(() => {});
          }
        } catch { /* best-effort self-heal */ }
      }
    };
    void ping(); // immediate, so a fresh mount is registered without waiting 5s
    const id = setInterval(() => void ping(), 5000);
    return () => clearInterval(id);
  }, [viewId, contextId]);

  // Subscribe to /ws/browser/:contextId for agent_active broadcast.
  // Uses the same protocol as Phase 30 — single source of truth for lock UX.
  useEffect(() => {
    const ws = new WebSocket(`${serverWsBase()}/ws/browser/${contextId}`);
    ws.addEventListener('message', (e) => {
      try {
        const raw = JSON.parse(typeof e.data === 'string' ? e.data : '');
        const result = parseBrowserWsMessage(raw);
        if (!result.ok) {
          // Drop malformed frames silently — they may come from older servers
          // or future variants this client doesn't understand. The contract
          // is that the server side has validated; this is defense-in-depth.
          return;
        }
        if (result.data.type === 'agent_active') {
          setAgentActive(Boolean(result.data.active));
          // Retain the label across the idle linger: only overwrite on the
          // active=true edge (which carries the action), keep it on active=false.
          if (result.data.active && result.data.action) setAgentAction(result.data.action);
        }
      } catch { /* ignore non-JSON frames */ }
    });
    return () => { try { ws.close(); } catch { /* ignore */ } };
  }, [contextId]);

  // Page console messages → ring buffer for the toolbar quick-console.
  useEffect(() => {
    const api = window.electronAPI?.browserNative;
    if (!api?.onConsoleMessage || !viewId) return;
    return api.onConsoleMessage(viewId, (entry) => {
      if (!mountedRef.current) return;
      const lvl = (['log', 'info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'log') as BrowserConsoleEntry['level'];
      setConsoleEntries(prev => {
        const next = [...prev, { id: entry.id, level: lvl, text: entry.text, source: entry.source }];
        return next.length > CONSOLE_BUFFER_MAX ? next.slice(-CONSOLE_BUFFER_MAX) : next;
      });
    });
  }, [viewId]);

  // Clear the console buffer on a full document load (a fresh navigation starts
  // a new console session — matches Chrome DevTools' "Clear on navigation").
  useEffect(() => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    return api.onLoadingChange(viewId, (l) => {
      if (l && mountedRef.current) setConsoleEntries([]);
    });
  }, [viewId]);

  const consoleSummary = useMemo(() => {
    let errors = 0, warnings = 0;
    for (const e of consoleEntries) {
      if (e.level === 'error') errors++;
      else if (e.level === 'warn') warnings++;
    }
    return { errors, warnings };
  }, [consoleEntries]);

  const clearConsole = useCallback(() => setConsoleEntries([]), []);

  const navigate = useCallback(async (target: string) => {
    const api = window.electronAPI?.browserNative;
    if (!api) return;
    // Idempotent: don't reload if the view is ALREADY at this URL. A re-open
    // (agents/terminals re-fire open_browser_pane each turn → a repeated
    // navigateUrl prop) would otherwise reload the page every time — resetting
    // the SPA route / in-page state and looking like the pane keeps restarting.
    // (The toolbar's reload button / reload() still force an explicit refresh.)
    const norm = (u: string) => (u || '').replace(/#.*$/, '').replace(/\/+$/, '');
    if (viewId && norm(target) === norm(url)) return;
    if (!viewId) {
      // View not ready yet — buffer; the create() effect flushes on resolve.
      // Last write wins (a newer URL supersedes an older pending one).
      pendingNavigateRef.current = target;
      return;
    }
    await api.navigate(viewId, target);
  }, [viewId, url]);

  const goBack = useCallback(async () => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    await api.goBack(viewId);
  }, [viewId]);

  const goForward = useCallback(async () => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    await api.goForward(viewId);
  }, [viewId]);

  const reload = useCallback(async () => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    await api.reload(viewId);
  }, [viewId]);

  const goHome = useCallback(async () => {
    await navigate('about:blank');
  }, [navigate]);

  const setBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    // Hide via {0,0,0,0} when agentActive — see NativeBrowserPlaceholder
    // for the call that handles agent overlay. This setter is the public
    // surface for layout-driven positioning.
    api.setBounds(viewId, bounds).catch(() => {});
  }, [viewId]);

  // Phase 30.1 polish — DevTools toggle (idempotent: open if closed, close if open).
  const toggleDevTools = useCallback(async () => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    await api.toggleDevTools(viewId).catch(() => {});
  }, [viewId]);

  // Phase 30.1 polish — Find in page (Cmd+F). Returns the unsubscribe to
  // stop receiving find result events when the find bar closes.
  const findInPage = useCallback(async (
    text: string,
    options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }
  ) => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    await api.findInPage(viewId, text, options).catch(() => {});
  }, [viewId]);
  const stopFind = useCallback(async () => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    await api.stopFind(viewId).catch(() => {});
  }, [viewId]);
  const onFindResult = useCallback((cb: (r: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void): (() => void) => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return () => undefined;
    return api.onFindResult(viewId, cb);
  }, [viewId]);

  // Phase 30.1 polish — Zoom controls. delta -1 / +1 / 'reset'.
  const setZoom = useCallback(async (delta: number | 'reset'): Promise<number> => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return 0;
    return await api.setZoom(viewId, delta).catch(() => 0);
  }, [viewId]);

  // Device emulation. 'desktop'/'auto' disable emulation (null); mobile/tablet
  // use presets; 'custom' uses the passed metrics.
  const setDevice = useCallback((mode: DeviceMode, custom?: { width: number; height: number; deviceScaleFactor?: number }) => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    setDeviceMode(mode);
    // 'custom' = responsive-resize mode: we physically size the WebContentsView
    // (NativeBrowserPlaceholder) so the page reflows like a real window — no CDP
    // device emulation. Disable any active emulation and let the placeholder
    // pick an initial size (null) the user can then drag via the handles.
    if (mode === 'custom') {
      setResponsiveSizeState(custom ? { width: Math.round(custom.width), height: Math.round(custom.height) } : null);
      api.setDevice(viewId, null).catch(() => {});
      return;
    }
    setResponsiveSizeState(null);
    let params: null | { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean; userAgent?: string } = null;
    if (mode === 'mobile' || mode === 'tablet') {
      const p = DEVICE_PRESETS[mode];
      params = { width: p.width!, height: p.height!, deviceScaleFactor: p.deviceScaleFactor, mobile: p.mobile, userAgent: p.userAgent };
    }
    api.setDevice(viewId, params).catch(() => {});
  }, [viewId]);

  // Live-set the responsive viewport while the user drags a resize handle. Pure
  // state — the placeholder's effect re-issues setBounds so the view follows.
  const setResponsiveSize = useCallback((width: number, height: number) => {
    setResponsiveSizeState({ width: Math.round(width), height: Math.round(height) });
  }, []);

  const getNavEntries = useCallback(async (): Promise<{ entries: NavHistoryEntry[]; activeIndex: number }> => {
    const api = window.electronAPI?.browserNative;
    if (!api?.getNavEntries || !viewId) return { entries: [], activeIndex: -1 };
    return await api.getNavEntries(viewId).catch(() => ({ entries: [], activeIndex: -1 }));
  }, [viewId]);

  const goToNavIndex = useCallback(async (index: number) => {
    const api = window.electronAPI?.browserNative;
    if (!api?.goToNavIndex || !viewId) return;
    await api.goToNavIndex(viewId, index).catch(() => {});
  }, [viewId]);

  return {
    url, title, loading, agentActive, agentAction, ready, viewId, faviconUrl,
    navigate, goBack, goForward, reload, goHome, setBounds, toggleDevTools,
    findInPage, stopFind, onFindResult, setZoom,
    deviceMode, setDevice, responsiveSize, setResponsiveSize,
    consoleEntries, consoleSummary, clearConsole, getNavEntries, goToNavIndex,
  };
}
