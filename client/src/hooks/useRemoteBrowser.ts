import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { BrowserWsMessage } from '@/types/browser-ws-messages';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'fallback-http';

// Phase 30 BROWSER-CHAT-04 — DOM info for the select-element pattern (Cursor Cmd+Shift+E).
export interface SelectedElementInfo {
  path: string;
  cssPath: string;
  bbox: { x: number; y: number; w: number; h: number };
  text?: string;
}

interface RemoteBrowserState {
  url: string;
  title: string;
  loading: boolean;
  connected: boolean;
  screenshotSrc: string | null;
  error: string | null;
  connectionState: ConnectionState;
  lastClickPos: { x: number; y: number; t: number } | null;
  // Phase 30 BROWSER-CHAT-04 — agent lock + select-element state.
  agentActive: boolean;
  selectMode: boolean;
  selectedElement: SelectedElementInfo | null;
  pageScaleFactor: number;
}

interface InteractionHandlers {
  onClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  onWheel: (e: React.WheelEvent<HTMLImageElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

interface RemoteBrowser extends RemoteBrowserState, InteractionHandlers {
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  goHome: () => void;
  imgRef: React.RefObject<HTMLImageElement | null>;
  // Phase 30 BROWSER-CHAT-04 — take-control + select-element actions.
  takeControl: () => void;
  enterSelectMode: () => void;
  exitSelectMode: () => void;
  setSelectedElement: (el: SelectedElementInfo | null) => void;
}

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

const IDLE_INTERVAL = 2000;
const ACTIVE_INTERVAL = 300;
const ACTIVE_DURATION = 3000;
const FALLBACK_DELAY_MS = 2000;

const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function mapCoordinates(
  e: React.MouseEvent<HTMLImageElement>,
  img: HTMLImageElement,
  pageScaleFactor = 1,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  const naturalW = img.naturalWidth || VIEWPORT_WIDTH;
  const naturalH = img.naturalHeight || VIEWPORT_HEIGHT;
  const imgAspect = naturalW / naturalH;
  const containerAspect = rect.width / rect.height;

  let displayW: number, displayH: number, offsetX: number, offsetY: number;

  if (containerAspect > imgAspect) {
    displayH = rect.height;
    displayW = displayH * imgAspect;
    offsetX = (rect.width - displayW) / 2;
    offsetY = 0;
  } else {
    displayW = rect.width;
    displayH = displayW / imgAspect;
    offsetX = 0;
    offsetY = (rect.height - displayH) / 2;
  }

  const localX = e.clientX - rect.left - offsetX;
  const localY = e.clientY - rect.top - offsetY;

  if (localX < 0 || localX > displayW || localY < 0 || localY > displayH) {
    return null;
  }

  const scale = pageScaleFactor || 1;
  return {
    x: Math.round(((localX / displayW) * naturalW) / scale),
    y: Math.round(((localY / displayH) * naturalH) / scale),
  };
}

export function useRemoteBrowser(contextId: string): RemoteBrowser {
  const encodedId = useMemo(() => encodeURIComponent(contextId), [contextId]);
  const [state, setState] = useState<RemoteBrowserState>({
    url: '',
    title: '',
    loading: false,
    connected: false,
    screenshotSrc: null,
    error: null,
    connectionState: 'connecting',
    lastClickPos: null,
    agentActive: false,
    selectMode: false,
    selectedElement: null,
    pageScaleFactor: 1,
  });

  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pageScaleFactorRef = useRef<number>(1);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeUntilRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const connectionStateRef = useRef<ConnectionState>('connecting');
  const typeBufRef = useRef<string>('');
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollRef = useRef<number>(0);

  const markActive = useCallback(() => {
    activeUntilRef.current = Date.now() + ACTIVE_DURATION;
  }, []);

  const updateConnectionState = useCallback((next: ConnectionState) => {
    connectionStateRef.current = next;
    setState(s => ({
      ...s,
      connectionState: next,
      connected: next === 'connected' || next === 'fallback-http',
    }));
  }, []);

  // REST fallback — kept for graceful degradation when the WS bridge is down.
  // The interact endpoint does getOrCreate server-side.
  const interact = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/browsers/${encodedId}/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok && mountedRef.current) {
        setState(s => ({ ...s, error: `Interact ${res.status}` }));
      }
    } catch {
      // Silently fail — info poll will detect disconnect.
    }
  }, [encodedId]);

  // Fetch screenshot via REST (used only in fallback-http mode).
  const fetchScreenshot = useCallback(() => {
    if (!mountedRef.current) return;
    const preload = new Image();
    preload.onload = () => {
      if (!mountedRef.current) return;
      setState(s => ({ ...s, screenshotSrc: preload.src }));
    };
    preload.onerror = () => {
      // Don't clear existing screenshot on transient errors.
    };
    preload.src = `/api/browsers/${encodedId}/snapshot?t=${Date.now()}`;
  }, [encodedId]);

  // Fetch context info via REST (URL/title check + connection probe).
  const fetchInfo = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/browsers/${encodedId}`);
      if (!mountedRef.current) return false;
      if (res.ok) {
        const data = await res.json();
        setState(s => ({
          ...s,
          url: data.url || s.url,
          title: data.title || s.title,
          loading: false,
        }));
        return true;
      } else if (res.status === 404) {
        return false;
      }
    } catch {
      // Network error — stay in current state; the next poll/WS attempt retries.
    }
    return false;
  }, [encodedId]);

  // sendInput — WS-first, REST fallback. Switches based on live connection state.
  const sendInput = useCallback((
    action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
    payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle' },
  ) => {
    if (connectionStateRef.current === 'connected' && wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: BrowserWsMessage = { type: 'input', action, payload };
      try {
        wsRef.current.send(JSON.stringify(msg));
        return;
      } catch {
        // WS send failed mid-flight — fall through to REST.
      }
    }
    // Fallback: REST interact. Map action to the REST shape (the existing
    // /api/browsers/:id/interact endpoint expects { action, ...payload }).
    interact({ action, ...payload });
  }, [interact]);

  // WebSocket lifecycle. Opens once per contextId, retries to fallback-http
  // on close/error after FALLBACK_DELAY_MS.
  useEffect(() => {
    mountedRef.current = true;
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProto}://${window.location.host}/ws/browser/${encodedId}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // Browser blocked WS — go straight to fallback.
      updateConnectionState('fallback-http');
      return () => {
        mountedRef.current = false;
      };
    }
    wsRef.current = ws;
    updateConnectionState('connecting');

    ws.onopen = () => {
      if (!mountedRef.current) return;
      updateConnectionState('connected');
      setState(s => ({ ...s, error: null }));
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data) as BrowserWsMessage;
        switch (msg.type) {
          case 'frame': {
            const psf = msg.metadata?.pageScaleFactor;
            if (psf) {
              pageScaleFactorRef.current = psf;
            }
            setState(s => ({
              ...s,
              screenshotSrc: `data:image/jpeg;base64,${msg.data}`,
              ...(psf && psf !== s.pageScaleFactor ? { pageScaleFactor: psf } : {}),
            }));
            break;
          }
          case 'nav':
            if (msg.phase === 'response') {
              setState(s => ({ ...s, url: msg.url, loading: false }));
            }
            break;
          case 'console':
            // Forward to devtools console; full UI surface deferred to plan 30-04.
            console.debug(`[browser ${contextId}] ${msg.level}: ${msg.text}`);
            break;
          case 'agent_active':
            // Phase 30 BROWSER-CHAT-04 — agent lock state surfaced to RemoteBrowserPanel
            // for the "🤖 Agent is controlling…" overlay rendering.
            setState(s => ({ ...s, agentActive: msg.active }));
            break;
          default:
            break;
        }
      } catch (err) {
        console.warn('[useRemoteBrowser] Failed to parse WS message:', err);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      updateConnectionState('disconnected');
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      updateConnectionState('disconnected');
      // Schedule fallback transition. 2s grace allows brief network hiccups
      // to recover via WS retry (added in 30-05 if needed) before falling
      // back to polling.
      fallbackTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (connectionStateRef.current !== 'connected') {
          updateConnectionState('fallback-http');
        }
      }, FALLBACK_DELAY_MS);
    };

    return () => {
      mountedRef.current = false;
      try { ws.close(); } catch {}
      wsRef.current = null;
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
    };
  }, [contextId, encodedId, updateConnectionState]);

  // HTTP polling effect — runs ONLY when the WS dropped to fallback-http.
  // Mirrors the legacy polling loop but gated on connectionState.
  useEffect(() => {
    if (state.connectionState !== 'fallback-http') {
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }
    mountedRef.current = true;
    const poll = async () => {
      if (!mountedRef.current) return;
      const exists = await fetchInfo();
      if (exists) {
        fetchScreenshot();
      }
      const isActive = Date.now() < activeUntilRef.current;
      const interval = isActive ? ACTIVE_INTERVAL : IDLE_INTERVAL;
      pollingRef.current = setTimeout(poll, interval);
    };
    poll();
    return () => {
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [state.connectionState, fetchInfo, fetchScreenshot]);

  // --- Interaction handlers ---

  const navigate = useCallback((url: string) => {
    setState(s => ({ ...s, loading: true, url }));
    markActive();
    if (connectionStateRef.current === 'connected' && wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: BrowserWsMessage = { type: 'nav', url, phase: 'request' };
      try {
        wsRef.current.send(JSON.stringify(msg));
        return;
      } catch {
        // Fall through to REST.
      }
    }
    // REST fallback. interact does getOrCreate — intentional for navigate.
    interact({ action: 'navigate', url }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const goBack = useCallback(() => {
    if (!connectionStateRef.current || connectionStateRef.current === 'disconnected') return;
    markActive();
    interact({ action: 'back' }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const goForward = useCallback(() => {
    if (!connectionStateRef.current || connectionStateRef.current === 'disconnected') return;
    markActive();
    interact({ action: 'forward' }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const reload = useCallback(() => {
    if (!connectionStateRef.current || connectionStateRef.current === 'disconnected') return;
    setState(s => ({ ...s, loading: true }));
    markActive();
    interact({ action: 'reload' }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const goHome = useCallback(() => {
    navigate('about:blank');
  }, [navigate]);

  const onClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (connectionStateRef.current === 'disconnected') return;
    const img = e.currentTarget;
    const coords = mapCoordinates(e, img, pageScaleFactorRef.current);
    if (!coords) return;
    markActive();
    setState(s => ({ ...s, lastClickPos: { x: e.clientX, y: e.clientY, t: Date.now() } }));
    sendInput('click', { x: coords.x, y: coords.y });
  }, [markActive, sendInput]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (connectionStateRef.current === 'disconnected') return;
    const now = Date.now();
    if (now - lastScrollRef.current < 100) return;
    lastScrollRef.current = now;

    const img = e.currentTarget;
    const coords = mapCoordinates(e as unknown as React.MouseEvent<HTMLImageElement>, img, pageScaleFactorRef.current);
    if (!coords) return;

    markActive();
    sendInput('scroll', {
      x: coords.x,
      y: coords.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }, [markActive, sendInput]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (connectionStateRef.current === 'disconnected') return;
    if (e.metaKey || e.ctrlKey) return;

    e.preventDefault();
    e.stopPropagation();
    markActive();

    if (SPECIAL_KEYS.has(e.key)) {
      if (typeBufRef.current) {
        sendInput('type', { text: typeBufRef.current });
        typeBufRef.current = '';
        if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      }
      sendInput('keypress', { key: e.key });
    } else if (e.key.length === 1) {
      typeBufRef.current += e.key;
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      typeTimerRef.current = setTimeout(() => {
        if (typeBufRef.current) {
          sendInput('type', { text: typeBufRef.current });
          typeBufRef.current = '';
        }
      }, 50);
    }
  }, [markActive, sendInput]);

  // Phase 30 BROWSER-CHAT-04 — take-control: optimistic UI lock release +
  // notify server. The server's eager broadcast triggers an idempotent
  // agent_active=false (already cleared locally; the duplicate is a no-op).
  const takeControl = useCallback(() => {
    setState(s => ({ ...s, agentActive: false }));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'take_control' };
        wsRef.current.send(JSON.stringify(msg));
      } catch {
        // Ignore — the optimistic UI update already unblocked the user.
      }
    }
  }, []);

  // Phase 30 BROWSER-CHAT-04 — Cmd+Shift+E enters select-element mode (Cursor pattern).
  const enterSelectMode = useCallback(() => {
    setState(s => ({ ...s, selectMode: true }));
  }, []);
  const exitSelectMode = useCallback(() => {
    setState(s => ({ ...s, selectMode: false, selectedElement: null }));
  }, []);
  const setSelectedElement = useCallback((el: SelectedElementInfo | null) => {
    setState(s => ({ ...s, selectedElement: el, selectMode: false }));
  }, []);

  return useMemo(() => ({
    ...state,
    navigate,
    goBack,
    goForward,
    reload,
    goHome,
    onClick,
    onWheel,
    onKeyDown,
    imgRef,
    takeControl,
    enterSelectMode,
    exitSelectMode,
    setSelectedElement,
  }), [state, navigate, goBack, goForward, reload, goHome, onClick, onWheel, onKeyDown, takeControl, enterSelectMode, exitSelectMode, setSelectedElement]);
}
