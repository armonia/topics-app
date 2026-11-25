/**
 * The system health list (`GET /api/system/agents-health`, T7) as a hook, for
 * the number next to «Sistema» in the sidebar and for the Health section.
 * Nothing is kept between reads: a problem that was fixed is absent from the
 * next answer, so the number goes down by itself at the next round.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { readJson } from '../lib/readJson';
import { startVisibleInterval } from './documentVisibility';
import type { HealthProblem, HealthSeverity } from '../../../shared/agents-health';

/** Asked again this often while the window is visible. */
const POLL_MS = 15_000;

export function parseHealth(body: unknown): HealthProblem[] | null {
  const list = (body as { problems?: unknown } | null)?.problems;
  return Array.isArray(list) ? (list as HealthProblem[]) : null;
}

/** The colour of the number: the highest severity present, or null when there is no problem. */
export function highestSeverity(problems: HealthProblem[]): HealthSeverity | null {
  if (problems.length === 0) return null;
  return problems.some((p) => p.severity === 'error') ? 'error' : 'warning';
}

// One reading shared by every reader: the panel and the sidebar number always
// show the same list, and a reload from one updates the other at once.
let current: HealthProblem[] | null = null;
let inFlight: Promise<void> | null = null;
let readers = 0;
let stopPolling: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Read the list now; calls made while a fetch is in flight share it. */
export function reloadSystemHealth(): Promise<void> {
  inFlight ??= (async () => {
    try {
      const next = parseHealth(await readJson('/api/system/agents-health', { cache: 'no-store' }));
      if (next) { current = next; emit(); }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Every mounted reader reads again now, e.g. after a fix. */
export function refreshSystemHealth(): void {
  void reloadSystemHealth();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): HealthProblem[] | null {
  return current;
}

export function useSystemHealth() {
  const problems = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (readers++ === 0) {
      void reloadSystemHealth();
      stopPolling = startVisibleInterval(() => { void reloadSystemHealth(); }, POLL_MS);
    } else if (current === null) {
      void reloadSystemHealth();
    }
    return () => {
      if (--readers === 0) { stopPolling?.(); stopPolling = null; }
    };
  }, []);
  return { problems, reload: reloadSystemHealth };
}
