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
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  goHome(): Promise<void>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

export function useNativeBrowser(contextId: string, initialUrl?: string): NativeBrowserHandle {
  const [viewId, setViewId] = useState<string | null>(null);
  const [url, setUrl] = useState<string>(initialUrl ?? 'about:blank');
  const [title, setTitle] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [agentActive, setAgentActive] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);

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

        // Wire url/title/loading streams.
        cleanupsRef.current.push(api.onUrlChange(result.viewId, (u) => mountedRef.current && setUrl(u)));
        cleanupsRef.current.push(api.onTitleChange(result.viewId, (t) => mountedRef.current && setTitle(t)));
        cleanupsRef.current.push(api.onLoadingChange(result.viewId, (l) => mountedRef.current && setLoading(l)));

        setReady(true);
      } catch (err) {
        console.error('[useNativeBrowser] create failed:', err);
      }
    })();

    return () => {
      mountedRef.current = false;
      for (const fn of cleanupsRef.current) {
        try { fn(); } catch { /* ignore */ }
      }
      cleanupsRef.current = [];
      if (createdViewId) {
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

  return { url, title, loading, agentActive, ready, viewId, navigate, goBack, goForward, reload, goHome, setBounds };
}
