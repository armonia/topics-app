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
import type { BrowserWsMessage } from '@/types/browser-ws-messages';

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

    (async () => {
      try {
        const result = await api.create({ topicId: contextId, partitionId, initialUrl: initialUrl ?? 'about:blank' });
        if (!mountedRef.current) {
          // Unmounted before create resolved — destroy now and bail.
          await api.destroy(result.viewId).catch(() => {});
          return;
        }
        createdViewId = result.viewId;
        setViewId(result.viewId);

        // Register cdpTargetId server-side so agent CDP dispatcher can find this view.
        if (result.cdpTargetId) {
          try {
            await fetch(`/api/browsers/${contextId}/cdp-target`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cdpTargetId: result.cdpTargetId }),
            });
          } catch (err) {
            console.warn('[useNativeBrowser] cdp-target register failed:', err);
          }
        }

        // Wire url/title/loading/favicon streams.
        cleanupsRef.current.push(api.onUrlChange(result.viewId, (u) => mountedRef.current && setUrl(u)));
        cleanupsRef.current.push(api.onTitleChange(result.viewId, (t) => mountedRef.current && setTitle(t)));
        cleanupsRef.current.push(api.onLoadingChange(result.viewId, (l) => mountedRef.current && setLoading(l)));
        // Reset favicon on URL change so we don't show stale icon during navigation.
        cleanupsRef.current.push(api.onUrlChange(result.viewId, () => mountedRef.current && setFaviconUrl('')));
        cleanupsRef.current.push(api.onFaviconChange(result.viewId, (f) => mountedRef.current && setFaviconUrl(f)));

        setReady(true);
      } catch (err) {
        console.error('[useNativeBrowser] create failed:', err);
      }
    })();

    // Phase 30.1 polish — beforeunload listener fires the destroy IPC
    // synchronously when the user navigates / refreshes / closes the tab,
    // BEFORE React has a chance to run its async cleanup. Combined with
    // the main-process did-finish-load orphan sweep, this prevents
    // WebContentsView leaks on hot-reload.
    const onBeforeUnload = () => {
      if (createdViewId && api) {
        // sendBeacon-style — fire and forget; main may not finish before unload
        // but the orphan sweep on next render's did-finish-load is the safety net.
        try { api.destroy(createdViewId); } catch { /* ignore */ }
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('beforeunload', onBeforeUnload);
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
        // Best-effort unregister CDP target server-side.
        fetch(`/api/browsers/${contextId}/cdp-target`, { method: 'DELETE' }).catch(() => {});
      }
    };
  }, [contextId, initialUrl]);

  // Subscribe to /ws/browser/:contextId for agent_active broadcast.
  // Uses the same protocol as Phase 30 — single source of truth for lock UX.
  useEffect(() => {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/browser/${contextId}`);
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(typeof e.data === 'string' ? e.data : '') as BrowserWsMessage;
        if (msg.type === 'agent_active') {
          setAgentActive(Boolean(msg.active));
        }
      } catch { /* ignore non-JSON frames */ }
    });
    return () => { try { ws.close(); } catch { /* ignore */ } };
  }, [contextId]);

  const navigate = useCallback(async (target: string) => {
    const api = window.electronAPI?.browserNative;
    if (!api || !viewId) return;
    await api.navigate(viewId, target);
  }, [viewId]);

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
