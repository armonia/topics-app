import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { parseBrowserWsMessage, type BrowserWsMessage } from '@/types/browser-ws-messages';
import { serverWsBase } from '@/lib/shell/net';
import { mapCoordinates } from './browserCoords';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'fallback-http';

// Phase 30 BROWSER-CHAT-04 — DOM info for the select-element pattern (Cursor Cmd+Shift+E).
export interface SelectedElementInfo {
  path: string;
  cssPath: string;
  bbox: { x: number; y: number; w: number; h: number };
  text?: string;
}

/** A download the headless page triggered, saved server-side. `href` points at
 *  our own origin (user-clicked link) — the web pane has no native shelf. */
export interface DownloadInfo {
  filename: string;
  href: string;
  size?: number;
  state: 'started' | 'completed' | 'failed';
}

interface RemoteBrowserState {
  url: string;
  title: string;
  loading: boolean;
  connected: boolean;
  screenshotSrc: string | null;
  error: string | null;
  /** URL whose navigation produced `error` — the Retry affordance re-sends it. */
  errorUrl: string | null;
  connectionState: ConnectionState;
  lastClickPos: { x: number; y: number; t: number } | null;
  // Phase 30 BROWSER-CHAT-04 — agent lock + select-element state.
  agentActive: boolean;
  /** Human-readable label of the agent's current action (active=true edge). */
  agentAction: string | null;
  selectMode: boolean;
  selectedElement: SelectedElementInfo | null;
  pageScaleFactor: number;
  /** Downloads the headless page triggered (server-saved, surfaced as links). */
  downloads: DownloadInfo[];
  /** T2: whether the CURRENT url allows being framed (probed server-side). The
   *  panel renders a native <iframe> when framable AND no agent is driving. */
  framable: boolean;
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
  /** Callback ref for the pane content element — wires a debounced ResizeObserver
   *  that streams the pane's real size (+DPR) to the server (kills the letterbox). */
  containerRef: (el: HTMLElement | null) => void;
  // Phase 30 BROWSER-CHAT-04 — take-control + select-element actions.
  takeControl: () => void;
  enterSelectMode: () => void;
  exitSelectMode: () => void;
  setSelectedElement: (el: SelectedElementInfo | null) => void;
}

const IDLE_INTERVAL = 2000;
const ACTIVE_INTERVAL = 300;
const ACTIVE_DURATION = 3000;
const FALLBACK_DELAY_MS = 2000;
// WS auto-reconnect: exponential backoff capped here. A transient drop now
// restores the full-fidelity stream instead of stranding the pane in HTTP
// polling forever (fallback-http stays as a parallel floor until WS returns).
const MAX_RECONNECT_DELAY_MS = 10000;
// Match the server's bandwidth-safe DPR ceiling (browser-service clampDsf).
const MAX_DSF = 2;
// Local-network URLs are always framable (and reachable) — decided client-side,
// never via the server probe (which would resolve localhost to the SERVER).
const LOCAL_HOST_RX = /^https?:\/\/(localhost|127\.0\.0\.1|[^/]+\.local)(:|\/|$)/;
// Watchdog: `loading` is set true on navigate/reload and is normally cleared by
// the server's `nav`/`response` message. If that message is lost (server crash,
// dropped WS frame, a disconnect right after the request), `loading` — and thus
// the pane's busy spinner — would otherwise stick ON forever. This is the upper
// bound after which we force-clear it. Deliberately long: it must be a true
// backstop for a LOST completion signal, not fire during a genuinely slow page
// load (heavy assets / high latency can legitimately take 30s+) — firing early
// would flip the spinner off while the page is still loading, a deceptive
// "done" signal. The happy path clears in well under a second, so this only
// ever fires when something is actually wrong.
const NAV_LOADING_TIMEOUT_MS = 60000;

const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

/**
 * @param isVisible When false (pane is hidden behind another tab/split), inbound
 *   screencast frames are dropped instead of applied — the last frame is retained
 *   so there's no blank on reveal, but the per-frame base64 decode + `<img>` repaint
 *   is skipped. This keeps the single-WKWebView Tauri renderer's memory/CPU in check
 *   when many browser panes exist but only one is on screen. The WS stays open
 *   (so agent-active / nav state still update); only the costly frame paint pauses.
 */
export function useRemoteBrowser(contextId: string, isVisible = true): RemoteBrowser {
  const encodedId = useMemo(() => encodeURIComponent(contextId), [contextId]);

  // Read inside the long-lived WS `onmessage` closure without re-subscribing the
  // socket on every visibility toggle (re-running the WS effect would close+reopen
  // the connection — churn + lost in-flight state).
  const isVisibleRef = useRef(isVisible);
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  const [state, setState] = useState<RemoteBrowserState>({
    url: '',
    title: '',
    loading: false,
    connected: false,
    screenshotSrc: null,
    error: null,
    errorUrl: null,
    connectionState: 'connecting',
    lastClickPos: null,
    agentActive: false,
    agentAction: null,
    selectMode: false,
    selectedElement: null,
    pageScaleFactor: 1,
    downloads: [],
    framable: false,
  });

  const imgRef = useRef<HTMLImageElement | null>(null);
  // Newest frame delivered so far. Frames after the first are direct
  // `img.src` writes (no setState), so state.screenshotSrc goes stale by
  // design — this ref lets a remounted <img> re-assert the newest frame
  // instead of showing the stale first one until the page next repaints.
  const lastFrameSrcRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pageScaleFactorRef = useRef<number>(1);
  // Latest CDP frame metadata (CSS-px device dims) for click mapping at HiDPI.
  const frameMetaRef = useRef<{ deviceWidth?: number; deviceHeight?: number }>({});
  // This client's DPR, clamped to the server's bandwidth-safe ceiling (2×).
  const dsfRef = useRef<number>(
    Math.max(1, Math.min(MAX_DSF, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)),
  );
  // Pane content element + its ResizeObserver, and the last size actually sent
  // (dedup guard). See containerRef + sendResize below.
  const containerElRef = useRef<HTMLElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentSizeRef = useRef<{ w: number; h: number; dsf: number }>({ w: 0, h: 0, dsf: 0 });
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeUntilRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const connectionStateRef = useRef<ConnectionState>('connecting');
  const typeBufRef = useRef<string>('');
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // See NAV_LOADING_TIMEOUT_MS — force-clears a stuck `loading` if the nav
  // completion signal never arrives.
  const loadingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLoadingWatchdog = useCallback(() => {
    if (loadingWatchdogRef.current) {
      clearTimeout(loadingWatchdogRef.current);
      loadingWatchdogRef.current = null;
    }
  }, []);

  // Arm the watchdog when a navigation starts. Re-arming cancels the prior
  // timer so only the latest in-flight nav is timed.
  const armLoadingWatchdog = useCallback(() => {
    clearLoadingWatchdog();
    loadingWatchdogRef.current = setTimeout(() => {
      loadingWatchdogRef.current = null;
      if (!mountedRef.current) return;
      // Lost completion signal: say so (BRW-REL-02) — silently flipping the
      // spinner off left the pane looking idle on whatever page it had.
      setState(s => (s.loading
        ? { ...s, loading: false, error: 'Navigation timed out (no response from browser)', errorUrl: s.url || null }
        : s));
    }, NAV_LOADING_TIMEOUT_MS);
  }, [clearLoadingWatchdog]);
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

  // Stream the pane's real size (+DPR) to the server so its viewport matches the
  // pane — kills the fixed-1280 letterbox and renders HiDPI-sharp. Deduped (a
  // no-op resize is skipped) and only sent while the WS is live; the value is
  // force-re-sent on every (re)connect (see ws.onopen) so the server viewport
  // is correct even after a context recreate.
  const sendResize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    const dsf = dsfRef.current;
    const last = lastSentSizeRef.current;
    if (last.w === width && last.h === height && last.dsf === dsf) return;
    lastSentSizeRef.current = { w: width, h: height, dsf };
    if (connectionStateRef.current === 'connected' && wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'resize', width, height, deviceScaleFactor: dsf };
        wsRef.current.send(JSON.stringify(msg));
      } catch { /* dropped — re-sent on next reconnect/resize */ }
    }
  }, []);

  // Callback ref for the pane content element: wires a debounced (~150ms)
  // ResizeObserver that reports size changes via sendResize. Re-attaching (or
  // null on unmount) tears down the previous observer + timer.
  const containerRef = useCallback((el: HTMLElement | null) => {
    if (resizeObserverRef.current) { resizeObserverRef.current.disconnect(); resizeObserverRef.current = null; }
    if (resizeDebounceRef.current) { clearTimeout(resizeDebounceRef.current); resizeDebounceRef.current = null; }
    containerElRef.current = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      sendResize(Math.round(r.width), Math.round(r.height));
    };
    const ro = new ResizeObserver(() => {
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(measure, 150);
    });
    ro.observe(el);
    resizeObserverRef.current = ro;
    measure(); // initial size (also force-re-sent on ws.onopen)
  }, [sendResize]);

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

  // WebSocket lifecycle with exponential-backoff auto-reconnect. `connect()` is
  // (re)invoked by the mount effect, the backoff timer, and focus/online wake —
  // a transient drop restores the full-fidelity stream instead of stranding the
  // pane in HTTP polling. fallback-http stays as a parallel floor until the WS
  // returns (a successful onopen supersedes it).
  useEffect(() => {
    mountedRef.current = true;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!mountedRef.current) return;
      // Dedup guard: if a socket is already connecting or open, don't spawn a
      // duplicate. The backoff timer, focus/online wake, and React StrictMode's
      // double-mount can all race a second connect(); only (re)connect when the
      // current socket is truly gone (null / CLOSING / CLOSED).
      const cur = wsRef.current;
      if (cur && (cur.readyState === WebSocket.CONNECTING || cur.readyState === WebSocket.OPEN)) return;
      const wsUrl = `${serverWsBase()}/ws/browser/${encodedId}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        // Browser blocked WS — go straight to fallback (no retry loop).
        updateConnectionState('fallback-http');
        return;
      }
      wsRef.current = ws;
      if (connectionStateRef.current !== 'connected') updateConnectionState('connecting');

    // Every handler is inert unless `ws` is STILL the current socket — a
    // superseded socket (StrictMode double-mount, a reconnect that replaced it)
    // must not touch connection state or it would flap the pane to disconnected.
    ws.onopen = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      updateConnectionState('connected');
      // NOTE: reconnectAttempt is NOT reset here — only a real FRAME (stable
      // connection) resets the backoff. A flapping server (open→close→open→…
      // with no frame) must let the backoff GROW so its reconnects move away
      // from the fallback timer and polling can engage. See the 'frame' case.
      // Don't clear `error` here: it's a NAVIGATION error now (BRW-REL-02),
      // owned by navigate()/nav-response. Clearing on (re)connect let the WS
      // retry churn wipe the strip milliseconds after a failed nav set it.
      //
      // Do NOT clear the fallback timer here: a FLAPPING server (open→close→
      // open→close before delivering any frame) would otherwise reset it on
      // every brief open and never degrade to polling. The fallback timer is
      // cleared only once a real FRAME proves the stream works (see 'frame').
      // Sync url/title from the server's known context state once on connect.
      // The bridge streams `frame`s but only emits a `nav` message on an
      // actual navigation — a pane that (re)connects to an already-navigated
      // context would otherwise sit at an empty url (screenshot suppressed by
      // the "enter a URL" empty-state gate) until the next navigation. This
      // GET is the server's source of truth; `data.url || s.url` never clobbers
      // a fresher optimistic/nav value.
      fetchInfo();
      // Force-(re)send the pane size so the server viewport matches on (re)connect
      // — after a context recreate the server starts at the default otherwise.
      lastSentSizeRef.current = { w: 0, h: 0, dsf: 0 };
      const el = containerElRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        sendResize(Math.round(r.width), Math.round(r.height));
      }
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      try {
        const raw = JSON.parse(event.data);
        const result = parseBrowserWsMessage(raw);
        if (!result.ok) {
          // Defense-in-depth: server should already validate emits. Log
          // protocol drift but don't crash the consumer.
          if (import.meta.env.DEV) {
            console.warn(`[browser ${contextId}] Invalid WS message:`, result.error);
          }
          return;
        }
        const msg = result.data;
        switch (msg.type) {
          case 'frame': {
            // A real frame proves the WS stream works: clear any pending
            // fallback-to-polling timer and (re)assert 'connected'. Done BEFORE
            // the isVisible gate so a hidden pane still counts as connected, and
            // this is the ONLY place the fallback timer + reconnect backoff are
            // reset (a flapping server that never delivers a frame must still
            // degrade to polling, with a GROWING backoff).
            reconnectAttempt = 0;
            if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null; }
            if (connectionStateRef.current !== 'connected') updateConnectionState('connected');
            // Hidden pane: drop the frame (keep the last one painted) to skip the
            // base64 decode + img repaint. See the isVisible param docs above.
            if (!isVisibleRef.current) break;
            const psf = msg.metadata?.pageScaleFactor;
            if (psf) {
              pageScaleFactorRef.current = psf;
            }
            // Stash the device (CSS-px) dims for HiDPI-correct click mapping.
            frameMetaRef.current = {
              deviceWidth: msg.metadata?.deviceWidth,
              deviceHeight: msg.metadata?.deviceHeight,
            };
            const src = `data:image/jpeg;base64,${msg.data}`;
            // Steady-state frames are DIRECT DOM writes (same pattern as the
            // drag paths in SplitTree/useGridResize): at ~15fps a setState
            // here re-rendered the whole 667-line panel — 3 unmemoized
            // toolbars included — per frame. React state only records the
            // transitions that change WHAT renders: the first frame
            // (placeholder → <img>) and a pageScaleFactor change (rare).
            // Re-renders from other state leave the img alone because its
            // src prop (the first-frame value) never changes.
            lastFrameSrcRef.current = src;
            const img = imgRef.current;
            if (img) img.src = src;
            setState(s => {
              const firstFrame = s.screenshotSrc === null;
              const psfChanged = !!psf && psf !== s.pageScaleFactor;
              if (!firstFrame && !psfChanged) return s; // same ref: no render
              return {
                ...s,
                ...(firstFrame ? { screenshotSrc: src } : {}),
                ...(psfChanged ? { pageScaleFactor: psf } : {}),
              };
            });
            break;
          }
          case 'nav':
            if (msg.phase === 'response') {
              clearLoadingWatchdog();
              setState(s => ({ ...s, url: msg.url, loading: false, error: null, errorUrl: null }));
            } else if (msg.phase === 'error') {
              // Failed goto/launch: the page is still on the previous URL —
              // surface the reason instead of silently clearing the spinner
              // (BRW-REL-02). Cleared by the next successful nav/response.
              clearLoadingWatchdog();
              setState(s => ({ ...s, loading: false, error: msg.error || 'Navigation failed', errorUrl: msg.url }));
            }
            break;
          case 'console':
            // Forward to devtools console; full UI surface deferred to plan 30-04.
            console.debug(`[browser ${contextId}] ${msg.level}: ${msg.text}`);
            break;
          case 'agent_active':
            // Phase 30 BROWSER-CHAT-04 — agent lock state surfaced to RemoteBrowserPanel
            // for the "🤖 agent is controlling…" overlay. Retain the action label
            // across the idle linger: overwrite only on the active=true edge.
            setState(s => ({
              ...s,
              agentActive: msg.active,
              agentAction: msg.active && msg.action ? msg.action : s.agentAction,
            }));
            break;
          case 'download':
            // Defense-in-depth: only ever render a link into our own served
            // downloads dir — never a javascript:/data:/external href, even if
            // the message were spoofed. Anything else is dropped.
            if (!msg.href.startsWith('/media/browser/downloads/')) break;
            // Surface the server-saved download as a clickable link (the web
            // pane has no native shelf). Dedup by href: update its state, or
            // append; keep the strip bounded to the most recent few.
            setState(s => {
              const next = s.downloads.slice();
              const i = next.findIndex(d => d.href === msg.href);
              const info: DownloadInfo = { filename: msg.filename, href: msg.href, size: msg.size, state: msg.state };
              if (i >= 0) next[i] = info; else next.push(info);
              return { ...s, downloads: next.slice(-8) };
            });
            break;
          default:
            break;
        }
      } catch (err) {
        console.warn('[useRemoteBrowser] Failed to parse WS message:', err);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      updateConnectionState('disconnected');
    };

    ws.onclose = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      updateConnectionState('disconnected');
      // (a) Floor: after a 2s grace, degrade to HTTP polling so the pane stays
      // usable even if the WS can't be restored. Only arm once.
      if (!fallbackTimerRef.current) {
        fallbackTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          if (connectionStateRef.current !== 'connected') {
            updateConnectionState('fallback-http');
          }
        }, FALLBACK_DELAY_MS);
      }
      // (b) But keep trying to restore the full WS stream with exponential
      // backoff — a successful reconnect (onopen) supersedes polling.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
    }; // end connect()

    connect();

    // Reconnect immediately when the tab regains focus or the network returns
    // (e.g. after sleep) instead of waiting out the backoff.
    const onWake = () => {
      if (!mountedRef.current) return;
      // Only kick a reconnect when we're actually down — never interrupt an
      // in-flight connect (connecting) or a healthy socket (connected).
      const st = connectionStateRef.current;
      if (st === 'connected' || st === 'connecting') return;
      reconnectAttempt = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connect();
    };
    window.addEventListener('online', onWake);
    window.addEventListener('focus', onWake);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { wsRef.current?.close(); } catch { /* already gone */ }
      wsRef.current = null;
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      clearLoadingWatchdog();
    };
  }, [contextId, encodedId, updateConnectionState, clearLoadingWatchdog, fetchInfo, sendResize]);

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

  // T2 — framing probe: whether the CURRENT url can be rendered as a native
  // <iframe>. Reset to false the instant the url changes (so a new page never
  // flashes the previous page's iframe), then probe http(s) URLs server-side.
  // localhost / non-http are decided in the panel, not here.
  useEffect(() => {
    const url = state.url;
    setState(s => (s.framable ? { ...s, framable: false } : s));
    if (!url || !/^https?:\/\//i.test(url) || LOCAL_HOST_RX.test(url)) return;
    let cancelled = false;
    fetch(`/api/browsers/framable?url=${encodeURIComponent(url)}`)
      .then(r => (r.ok ? r.json() : { framable: false }))
      .then((d: { framable?: boolean }) => {
        if (!cancelled && mountedRef.current) {
          setState(s => (s.url === url ? { ...s, framable: !!d.framable } : s));
        }
      })
      .catch(() => { /* network error → leave framable=false (stream) */ });
    return () => { cancelled = true; };
  }, [state.url]);

  // --- Interaction handlers ---

  const navigate = useCallback((url: string) => {
    setState(s => ({ ...s, loading: true, url, error: null, errorUrl: null }));
    armLoadingWatchdog();
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
  }, [interact, markActive, fetchScreenshot, fetchInfo, armLoadingWatchdog]);

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
    armLoadingWatchdog();
    markActive();
    interact({ action: 'reload' }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo, armLoadingWatchdog]);

  const goHome = useCallback(() => {
    navigate('about:blank');
  }, [navigate]);

  const onClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (connectionStateRef.current === 'disconnected') return;
    const img = e.currentTarget;
    const coords = mapCoordinates(e, img, {
      pageScaleFactor: pageScaleFactorRef.current,
      deviceWidth: frameMetaRef.current.deviceWidth,
      deviceHeight: frameMetaRef.current.deviceHeight,
      deviceScaleFactor: dsfRef.current,
    });
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
    const coords = mapCoordinates(e as unknown as React.MouseEvent<HTMLImageElement>, img, {
      pageScaleFactor: pageScaleFactorRef.current,
      deviceWidth: frameMetaRef.current.deviceWidth,
      deviceHeight: frameMetaRef.current.deviceHeight,
      deviceScaleFactor: dsfRef.current,
    });
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

  // After every commit: if the <img> (re)mounted it carries the stale
  // state.screenshotSrc — re-assert the newest direct-written frame. A cheap
  // string compare on the (now rare) panel renders, a write only on remount.
  useEffect(() => {
    const img = imgRef.current;
    const last = lastFrameSrcRef.current;
    if (img && last && img.src !== last) img.src = last;
  });

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
    containerRef,
    takeControl,
    enterSelectMode,
    exitSelectMode,
    setSelectedElement,
  }), [state, navigate, goBack, goForward, reload, goHome, onClick, onWheel, onKeyDown, containerRef, takeControl, enterSelectMode, exitSelectMode, setSelectedElement]);
}
