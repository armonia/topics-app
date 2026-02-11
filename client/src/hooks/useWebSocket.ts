import { useState, useEffect, useRef, useCallback } from 'react';
import type { ConnectionStatus, WSMessage, UnreadData } from '../types';

interface UseWebSocketReturn {
  status: ConnectionStatus;
  unreadData: UnreadData;
  sendWS: (message: WSMessage) => void;
  onMessage: (handler: (msg: WSMessage) => void) => () => void;
  reconnect: () => void;
}

export function useWebSocket(): UseWebSocketReturn {
  const [status, setStatus] = useState<ConnectionStatus>('offline');
  const [unreadData, setUnreadData] = useState<UnreadData>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef<Set<(msg: WSMessage) => void>>(new Set());
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      reconnectAttemptRef.current = 0;
      
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
        const data: WSMessage = JSON.parse(event.data);
        
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
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
      reconnectAttemptRef.current++;
      
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = () => {
      // onclose will handle reconnection
    };
  }, []);

  useEffect(() => {
    connect();
    
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
      }
    };
  }, [connect]);

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
    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    connect();
  }, [connect]);

  return { status, unreadData, sendWS, onMessage, reconnect };
}
