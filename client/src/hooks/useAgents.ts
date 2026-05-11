import { useState, useEffect, useCallback, useRef } from 'react';
import type { WSMessage } from '../types';

const AGENTS_CACHE_KEY = 'agents-sessions-cache';

function getCachedSessions(): AgentSession[] {
  try {
    const raw = localStorage.getItem(AGENTS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setCachedSessions(sessions: AgentSession[]) {
  try { localStorage.setItem(AGENTS_CACHE_KEY, JSON.stringify(sessions)); } catch {}
}

export interface AgentSession {
  key: string;
  kind: 'main' | 'group' | 'cron' | 'hook' | 'node' | 'subagent' | 'other';
  channel: string;
  displayName: string;
  status: 'active' | 'idle' | 'completed' | 'error';
  model?: string;
  updatedAt: number;
  sessionId?: string;
  totalTokens?: number;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  abortedLastRun?: boolean;
  lastMessage?: string;
  topicId?: string;
  topicName?: string;
}

interface UseAgentsOptions {
  activeMinutes?: number;
  enabled?: boolean;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

const POLL_INTERVAL_ACTIVE = 5000;
const POLL_INTERVAL_BACKGROUND = 30000;
const POLL_INTERVAL_WS_CONNECTED = 60000; // WS is primary source; poll rarely as consistency check

export function useAgents({ activeMinutes = 120, enabled = true, onMessage }: UseAgentsOptions = {}) {
  const [sessions, setSessions] = useState<AgentSession[]>(getCachedSessions);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const fetchingRef = useRef(false);
  const lastUpdateRef = useRef<number>(0);

  // Cross-tab sync for agent sessions cache
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== AGENTS_CACHE_KEY || !e.newValue) return;
      try { setSessions(JSON.parse(e.newValue)); } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const fetchSessions = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const fetchTime = Date.now();
      const res = await fetch(`/api/agents/sessions?activeMinutes=${activeMinutes}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const fetched: AgentSession[] = data.sessions || [];
      // Only apply poll results if no newer WS update arrived
      setSessions(prev => {
        if (lastUpdateRef.current > fetchTime) return prev;
        // Clean up stale sessions: only keep sessions present in the latest fetch
        // Merge with existing data, keeping the most recent updatedAt
        const merged = fetched.map(s => {
          const existing = prev.find(p => p.key === s.key);
          if (existing && existing.updatedAt > s.updatedAt) return existing;
          return s;
        });
        return merged;
      });
      lastUpdateRef.current = fetchTime;
      setCachedSessions(fetched);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [activeMinutes]);

  // Initial fetch
  useEffect(() => {
    if (!enabled) return;
    fetchSessions();
  }, [enabled, fetchSessions]);

  // Polling — reduce frequency when WS is connected (WS is primary source)
  useEffect(() => {
    if (!enabled) return;
    const interval = wsConnected
      ? POLL_INTERVAL_WS_CONNECTED
      : (isVisible ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_BACKGROUND);
    const timer = setInterval(fetchSessions, interval);
    return () => clearInterval(timer);
  }, [enabled, isVisible, wsConnected, fetchSessions]);

  // Track panel visibility
  const setVisible = useCallback((visible: boolean) => {
    setIsVisible(visible);
  }, []);

  // WebSocket updates (timestamp-based merge — most recent wins)
  useEffect(() => {
    if (!enabled || !onMessage) return;
    setWsConnected(true);
    // Fetch immediately on WS connect to catch up
    fetchSessions();
    const unsub = onMessage((msg: WSMessage) => {
      try {
      if (msg.type === 'agents:sessions' && Array.isArray(msg.sessions)) {
        const now = Date.now();
        lastUpdateRef.current = now;
        // The WSAgentsSessionsMessage type declares a minimal shape on
        // the wire (`key`, `status`, optional metadata). The server
        // actually sends the full `AgentSession` payload; the wire type
        // is conservative to avoid duplicating the rich shape in the
        // WSMessage union. We trust the server's shape here.
        const incoming = msg.sessions as unknown as AgentSession[];
        setSessions(prev => {
          // Merge: for each session, keep whichever has a newer updatedAt
          const incomingMap = new Map(incoming.map(s => [s.key, s]));
          const prevMap = new Map(prev.map(s => [s.key, s]));
          const allKeys = new Set([...incomingMap.keys(), ...prevMap.keys()]);
          const merged: AgentSession[] = [];
          for (const key of allKeys) {
            const inc = incomingMap.get(key);
            const old = prevMap.get(key);
            if (inc && old) {
              merged.push(inc.updatedAt >= old.updatedAt ? inc : old);
            } else if (inc) {
              merged.push(inc);
            }
            // If only in prev but not in incoming WS update, drop it (session cleanup)
          }
          return merged;
        });
      }
      // Also update from stream events
      if (msg.type === 'stream:start' && msg.sessionKey) {
        const now = Date.now();
        lastUpdateRef.current = now;
        setSessions(prev => {
          const existing = prev.find(s => s.key === msg.sessionKey);
          if (existing) {
            return prev.map(s => s.key === msg.sessionKey ? { ...s, status: 'active' as const, updatedAt: now } : s);
          }
          return prev;
        });
      }
      if (msg.type === 'stream:end' && msg.sessionKey) {
        const now = Date.now();
        lastUpdateRef.current = now;
        setSessions(prev =>
          prev.map(s => s.key === msg.sessionKey ? { ...s, status: 'idle' as const, updatedAt: now } : s)
        );
      }
      } catch (err) {
        console.warn('[useAgents] WS message handler error:', err);
      }
    });
    return () => {
      unsub();
      setWsConnected(false);
    };
  }, [enabled, onMessage, fetchSessions]);

  const activeSessions = sessions.filter(s => s.status === 'active');
  const idleSessions = sessions.filter(s => s.status === 'idle');

  return {
    sessions,
    activeSessions,
    idleSessions,
    loading,
    error,
    refresh: fetchSessions,
    setVisible,
  };
}
