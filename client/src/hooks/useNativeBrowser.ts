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
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseBrowserWsMessage } from '@/types/browser-ws-messages';

export interface NativeBrowserHandle {
  url: string;
  title: string;
  loading: boolean;
  agentActive: boolean;
  ready: boolean;             // viewId resolved + cdpTargetId registered
  viewId: string | null;
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
  /** Phase 30.1 — Zoom (Cmd+/-/0). delta=+1 zooms in, -1 out, 'reset' to 100%. Returns new zoom level. */
  setZoom(delta: number | 'reset'): Promise<number>;
}

export function useNativeBrowser(contextId: string, initialUrl?: string): NativeBrowserHandle {
  const [viewId, setViewId] = useState<string | null>(null);
  const [url, setUrl] = useState<string>(initialUrl ?? 'about:blank');
  const [title, setTitle] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [agentActive, setAgentActive] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);
  const [faviconUrl, setFaviconUrl] = useState<string>('');

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

    // NOTE: intentionally NO `beforeunload` destroy. A window reload (Cmd+R /
    // Vite HMR / dev-server restart) must KEEP this native WebContentsView alive
    // so the tab restores its page after the refresh and the agent's CDP
    // targetId stays valid (no stale-target 500s). The view is a child
    // WebContents and survives the renderer reload on its own; the main process
    // hides it during the reload and re-claims it when this hook remounts
    // (create()-reuse by topicId), destroying it only if it's never re-claimed
    // (deferred reclaim sweep). A genuine tab close still destroys the view via
    // the React unmount cleanup below.

    return () => {
      mountedRef.current = false;
      for (const fn of cleanupsRef.current) {
        try { fn(); } catch { /* ignore */ }
      }
      cleanupsRef.current = [];
      if (createdViewId) {
        // Hide BEFORE destroy so during the short async destroy window the
        // user doesn't see a flash of the orphan view. setBounds(0,0,0,0)
        // is synchronous from the renderer's perspective (fire-and-forget IPC).
        try { api.setBounds(createdViewId, { x: 0, y: 0, width: 0, height: 0 }); } catch { /* ignore */ }
        api.destroy(createdViewId).catch(() => {});
        // NOTE: intentionally NOT unregistering the CDP target here. React unmounts
        // this hook on tab-switch / DnD / StrictMode churn while the native view
        // SURVIVES (Electron reuses it by topicId; destroy is 500ms-deferred). The
        // old eager DELETE emptied the server registry during that window, so a
        // browser_* tool that ran between unmount and the next mount's re-register
        // fell back to an invisible Playwright phantom (state appeared to reset
        // between turns). The dispatcher self-cleans a genuinely stale target on its
        // next getPage (and a real close drops the view), so skipping the DELETE is
        // safe and keeps the agent bound to the real, persisted view.
      }
    };
    // initialUrl intentionally NOT a dep — it's mount-only (initialUrlRef).
    // Re-running on its change would destroy+recreate the view on every
    // persisted url update. Live nav uses navigate()/navigateUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextId]);

  // Subscribe to /ws/browser/:contextId for agent_active broadcast.
  // Uses the same protocol as Phase 30 — single source of truth for lock UX.
  useEffect(() => {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/browser/${contextId}`);
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
        }
      } catch { /* ignore non-JSON frames */ }
    });
    return () => { try { ws.close(); } catch { /* ignore */ } };
  }, [contextId]);

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

  return {
    url, title, loading, agentActive, ready, viewId, faviconUrl,
    navigate, goBack, goForward, reload, goHome, setBounds, toggleDevTools,
    findInPage, stopFind, onFindResult, setZoom,
  };
}
