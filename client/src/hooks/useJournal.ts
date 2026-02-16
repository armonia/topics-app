import { useState, useEffect, useCallback } from 'react';

export interface JournalEvent {
  id: string;
  timestamp: string;
  sessionKey: string;
  type: 'tool_call' | 'message' | 'session_start' | 'session_end' | 'error';
  summary: string;
  detail?: string;
}

interface UseJournalOptions {
  date?: string;
  enabled?: boolean;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function useJournal({ date, enabled = true }: UseJournalOptions = {}) {
  const [currentDate, setCurrentDate] = useState(date || formatDate(new Date()));
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [digest, setDigest] = useState<string | null>(null);
  const [digestExists, setDigestExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async (d: string) => {
    try {
      const res = await fetch(`/api/journal/events?date=${d}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }, []);

  const fetchDigest = useCallback(async (d: string) => {
    try {
      const res = await fetch(`/api/journal/digest?date=${d}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDigest(data.digest || null);
      setDigestExists(data.exists);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }, []);

  const loadDate = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    setCurrentDate(d);
    await Promise.all([fetchEvents(d), fetchDigest(d)]);
    setLoading(false);
  }, [fetchEvents, fetchDigest]);

  // Load data when date changes
  useEffect(() => {
    if (!enabled) return;
    loadDate(currentDate);
  }, [enabled, currentDate, loadDate]);

  const goToPreviousDay = useCallback(() => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() - 1);
    setCurrentDate(formatDate(d));
  }, [currentDate]);

  const goToNextDay = useCallback(() => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + 1);
    const today = formatDate(new Date());
    const next = formatDate(d);
    if (next <= today) setCurrentDate(next);
  }, [currentDate]);

  const goToToday = useCallback(() => {
    setCurrentDate(formatDate(new Date()));
  }, []);

  const generateDigest = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/journal/digest/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: currentDate }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setDigest(data.digest);
      setDigestExists(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setGenerating(false);
    }
  }, [currentDate]);

  const isToday = currentDate === formatDate(new Date());

  return {
    currentDate,
    events,
    digest,
    digestExists,
    loading,
    generating,
    error,
    isToday,
    goToPreviousDay,
    goToNextDay,
    goToToday,
    generateDigest,
    refresh: () => loadDate(currentDate),
  };
}
