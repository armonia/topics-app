import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { withTokenQuery } from '../lib/shell/pairing';

// Forme del feed: dichiarate UNA volta in `shared/monitoring.ts`, non più
// ricopiate qui accanto a quelle del server.
export type { ActivityCategory, ActivityEvent } from '../../../shared/monitoring';
import type { ActivityCategory, ActivityEvent } from '../../../shared/monitoring';

export interface ActivityFilters {
  categories: Set<ActivityCategory>;
  levels: Set<string>;
  search: string;
}

const MAX_CLIENT_EVENTS = 2000;

const defaultFilters: ActivityFilters = {
  categories: new Set<ActivityCategory>(),
  levels: new Set(['info', 'warn', 'error']),
  search: '',
};

export function useActivity(enabled = true) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [filters, setFilters] = useState<ActivityFilters>(defaultFilters);
  const [paused, setPaused] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const pausedRef = useRef(paused);
  const pausedBufferRef = useRef<ActivityEvent[]>([]);

  // Keep ref in sync with state so the EventSource callback reads the latest value
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    if (!enabled) {
      // Close existing connection when disabled
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- guarded one-shot: only runs when `enabled` flips off and a live EventSource exists; tears down the external connection and syncs the `connected` flag. Converges (no further state feeds back into this branch).
        setConnected(false);
      }
      return;
    }

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      // LAN-PAIR-01: SSE can't carry headers, so a paired remote device presents
      // the token as a `?token=` query param; bare URL on desktop/loopback.
      const es = new EventSource(withTokenQuery('/api/activity/stream'));
      esRef.current = es;

      es.onopen = () => setConnected(true);

      es.onerror = () => {
        setConnected(false);
        // If the connection is CLOSED (not just temporarily errored), reconnect
        if (es.readyState === EventSource.CLOSED) {
          esRef.current = null;
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'init') {
            setEvents(data.events || []);
          } else if (data.type === 'events') {
            const newEvents = data.events as ActivityEvent[];
            if (pausedRef.current) {
              // Cap the paused buffer too: resume() already keeps only the last
              // MAX_CLIENT_EVENTS, so an uncapped buffer just leaks memory while
              // the feed sits paused during heavy streaming.
              pausedBufferRef.current.push(...newEvents);
              if (pausedBufferRef.current.length > MAX_CLIENT_EVENTS) {
                pausedBufferRef.current = pausedBufferRef.current.slice(-MAX_CLIENT_EVENTS);
              }
            } else {
              setEvents(prev => {
                const next = [...prev, ...newEvents];
                return next.length > MAX_CLIENT_EVENTS ? next.slice(-MAX_CLIENT_EVENTS) : next;
              });
              setNewCount(prev => prev + newEvents.length);
            }
          }
        } catch {}
      };
    }

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [enabled]);

  // Handle paused state changes
  const resume = useCallback(() => {
    setPaused(false);
    if (pausedBufferRef.current.length > 0) {
      const buffered = [...pausedBufferRef.current];
      pausedBufferRef.current = [];
      setEvents(prev => {
        const next = [...prev, ...buffered];
        return next.length > MAX_CLIENT_EVENTS ? next.slice(-MAX_CLIENT_EVENTS) : next;
      });
    }
  }, []);

  const pause = useCallback(() => {
    setPaused(true);
  }, []);

  const resetNewCount = useCallback(() => {
    setNewCount(0);
  }, []);

  const filtered = useMemo(() => {
    return events.filter(e => {
      if (filters.categories.size > 0 && !filters.categories.has(e.category)) return false;
      if (filters.levels.size > 0 && !filters.levels.has(e.level)) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!e.title.toLowerCase().includes(q) && !(e.detail || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [events, filters]);

  return {
    events: filtered,
    allEvents: events,
    connected,
    filters,
    setFilters,
    paused,
    pause,
    resume,
    newCount,
    resetNewCount,
  };
}
