import { useState, useEffect, useRef, useCallback } from 'react';
import type { ConnectionStatus, WSMessage, UnreadData } from '../types';
import { dispatchFrame, dispatchLifecycle } from '../lib/wsFrameBus';
import { CLIENT_PROTOCOL_VERSION, CLIENT_CAPABILITIES, CLIENT_VERSION } from '../schemas/ws-handshake';
import { validateInbound } from '../schemas/ws-inbound';

interface UseWebSocketReturn {
  status: ConnectionStatus;
  unreadData: UnreadData;
  sendWS: (message: WSMessage) => void;
  onMessage: (handler: (msg: WSMessage) => void) => () => void;
  reconnect: () => void;
  lastConnectedAt: number | null;
}

const OFFLINE_THRESHOLD_MS = 10_000;

export function useWebSocket(): UseWebSocketReturn {
  // Start as 'connected' initially — only show connecting states after a grace period
  // This prevents UI flicker on page load when the WS hasn't connected yet
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [displayStatus, setDisplayStatus] = useState<ConnectionStatus>('connected');
  const connectingGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unreadData, setUnreadData] = useState<UnreadData>({});
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef<Set<(msg: WSMessage) => void>>(new Set());
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Self-reference for reconnection: `connect` schedules a reconnect that must
  // call `connect` again. Referencing the `connect` const directly inside its
  // own body reads it before initialization (react-hooks/immutability) and
  // pins the first closure; routing through a ref always invokes the latest
  // `connect` and removes the use-before-declare.
  const connectRef = useRef<() => void>(() => {});

  const clearOfflineTimer = useCallback(() => {
    if (offlineTimerRef.current) {
      clearTimeout(offlineTimerRef.current);
      offlineTimerRef.current = null;
    }
  }, []);

  const startOfflineTimer = useCallback(() => {
    clearOfflineTimer();
    offlineTimerRef.current = setTimeout(() => {
      setStatus('offline');
    }, OFFLINE_THRESHOLD_MS);
  }, [clearOfflineTimer]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      setLastConnectedAt(Date.now());
      reconnectAttemptRef.current = 0;
      clearOfflineTimer();
      // Notify lifecycle subscribers (e.g. pane-store syncWS resets its
      // monotonic seq gate on reconnect — without this the first
      // `ui-state:init` of a post-restart connection is silently dropped).
      dispatchLifecycle('open');

      // v3 foundations WS-02 — send `hello` so the server learns the client's
      // version + capabilities. Backward-compat: server tolerates clients
      // that don't send hello and treats them as legacy.
      try {
        ws.send(JSON.stringify({
          type: 'hello',
          clientVersion: CLIENT_VERSION,
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: Array.from(CLIENT_CAPABILITIES),
        }));
      } catch {
        // Best-effort; if send fails the server proceeds without handshake info.
      }

      // Start ping interval
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);

        // v3 foundations WS-01 client-side validation: registered types
        // are schema-checked, unknown types pass through. On schema
        // failure we DROP the frame (defense in depth) and log in DEV.
        // Server-side already validates emits via devValidateOutbound,
        // so a failure here means protocol drift or a server bug that
        // slipped through.
        const validation = validateInbound(raw);
        if (!validation.ok) {
          if (import.meta.env.DEV) {
            console.warn(`[WS:inbound] Dropping malformed ${validation.type ?? 'frame'}: ${validation.error}`);
          }
          return;
        }
        const data = raw as WSMessage;

        // Fan out to the module-level frame bus FIRST — the pane-store
        // bootstrap subscribes here (review I4: keeps a single WS per tab
        // instead of bootstrap.ts opening its own). Before this hook,
        // `unread:init` triggers the setState below; both need to run.
        dispatchFrame(data);

        // Handle unread init
        if (data.type === 'unread:init') {
          setUnreadData(data.data || {});
          return;
        }

        // Handle unread updates
        if (data.type === 'unread:updated') {
          setUnreadData(prev => ({
            ...prev,
            [data.topicId]: {
              lastReadAt: prev[data.topicId]?.lastReadAt || new Date().toISOString(),
              unreadCount: data.unreadCount,
            },
          }));
        }

        // Forward to all handlers
        for (const handler of handlersRef.current) {
          try { handler(data); } catch {}
        }
      } catch {}
    };

    ws.onclose = () => {
      setStatus('reconnecting');
      dispatchLifecycle('close');
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Start timer to transition to 'offline' if we can't reconnect quickly
      startOfflineTimer();

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
      reconnectAttemptRef.current++;

      reconnectTimerRef.current = setTimeout(() => {
        connectRef.current();
      }, delay);
    };

    ws.onerror = () => {
      // onclose will handle reconnection
    };
  }, [clearOfflineTimer, startOfflineTimer]);

  useEffect(() => {
    // Keep the self-reference current so scheduled reconnects invoke the
    // latest `connect` closure (deps below re-run this when `connect` changes).
    connectRef.current = connect;
    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      clearOfflineTimer();
      if (wsRef.current) {
        const ws = wsRef.current;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        // CONNECTING sockets: handlers are nullified so they'll silently die
        // without triggering reconnect or the "closed before established" warning
      }
    };
  }, [connect, clearOfflineTimer]);

  const sendWS = useCallback((message: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const onMessage = useCallback((handler: (msg: WSMessage) => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const reconnect = useCallback(() => {
    // Clear any pending reconnect timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    clearOfflineTimer();
    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    setStatus('connecting');
    connect();
  }, [connect, clearOfflineTimer]);

  // Auto-reconnect when app comes back to foreground (mobile/tab switch)
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnect();
      }
    };
    const handleOnline = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnect();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleVisibility);
    };
  }, [reconnect]);

  // Only surface non-connected status after a grace period (avoids flash on load)
  useEffect(() => {
    if (status === 'connected') {
      if (connectingGraceRef.current) { clearTimeout(connectingGraceRef.current); connectingGraceRef.current = null; }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- debounce sync: mirrors the WS `status` into the flicker-suppressed `displayStatus`; the 'connected' branch surfaces immediately, the else branch defers via timer. setDisplayStatus never feeds back into `status`, so this converges and cannot loop
      setDisplayStatus('connected');
    } else {
      if (!connectingGraceRef.current) {
        connectingGraceRef.current = setTimeout(() => {
          setDisplayStatus(status);
          connectingGraceRef.current = null;
        }, 3000);
      }
    }
    return () => { if (connectingGraceRef.current) { clearTimeout(connectingGraceRef.current); connectingGraceRef.current = null; } };
  }, [status]);

  return { status: displayStatus, unreadData, sendWS, onMessage, reconnect, lastConnectedAt };
}
