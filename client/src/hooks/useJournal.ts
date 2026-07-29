import { useState, useEffect, useCallback, useRef } from 'react';

// Forma dell'evento: `shared/monitoring.ts`.
export type { JournalEvent } from '../../../shared/monitoring';
import type { JournalEvent } from '../../../shared/monitoring';

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

  // Staleness guard: rapid prev/next-day clicks overlap loadDate calls, and a
  // SLOWER older-day response landing after a newer one left events/digest
  // mismatched with the date shown in the header (no auto-correction until
  // the next navigation). Only the CURRENT date's responses may commit.
  const currentDateRef = useRef(currentDate);
  currentDateRef.current = currentDate;

  const fetchEvents = useCallback(async (d: string) => {
    try {
      const res = await fetch(`/api/journal/events?date=${d}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (currentDateRef.current !== d) return; // stale — user navigated on
      setEvents(data.events || []);
    } catch (err) {
      if (currentDateRef.current !== d) return;
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }, []);

  const fetchDigest = useCallback(async (d: string) => {
    try {
      const res = await fetch(`/api/journal/digest?date=${d}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (currentDateRef.current !== d) return; // stale — user navigated on
      setDigest(data.digest || null);
      setDigestExists(data.exists);
    } catch (err) {
      if (currentDateRef.current !== d) return;
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }, []);

  const loadDate = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    setCurrentDate(d);
    currentDateRef.current = d; // sync BEFORE the fetches so guards see it
    await Promise.all([fetchEvents(d), fetchDigest(d)]);
    if (currentDateRef.current === d) setLoading(false);
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
