/**
 * The system health list (`GET /api/system/agents-health`, T7) as a hook, for
 * the number next to «Sistema» in the sidebar and for the Health section.
 * Nothing is kept between reads: a problem that was fixed is absent from the
 * next answer, so the number goes down by itself at the next round.
 */
import { useCallback, useEffect, useState } from 'react';
import { readJson } from '../lib/readJson';
import { startVisibleInterval } from './documentVisibility';
import type { HealthProblem, HealthSeverity } from '../../../shared/agents-health';

/** Asked again this often while the window is visible. */
const POLL_MS = 15_000;
const REFRESH_EVENT = 'topics:system-health-refresh';

/** Every mounted reader reads again now, e.g. after a fix. */
export function refreshSystemHealth(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function parseHealth(body: unknown): HealthProblem[] | null {
  const list = (body as { problems?: unknown } | null)?.problems;
  return Array.isArray(list) ? (list as HealthProblem[]) : null;
}

/** The colour of the number: the highest severity present, or null when there is no problem. */
export function highestSeverity(problems: HealthProblem[]): HealthSeverity | null {
  if (problems.length === 0) return null;
  return problems.some((p) => p.severity === 'error') ? 'error' : 'warning';
}

export function useSystemHealth() {
  const [problems, setProblems] = useState<HealthProblem[] | null>(null);
  const load = useCallback(async () => {
    const next = parseHealth(await readJson('/api/system/agents-health', { cache: 'no-store' }));
    if (next) setProblems(next);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read starts on mount; the state is set when the fetch resolves
    void load();
    const onRefresh = () => { void load(); };
    window.addEventListener(REFRESH_EVENT, onRefresh);
    const stop = startVisibleInterval(() => { void load(); }, POLL_MS);
    return () => { window.removeEventListener(REFRESH_EVENT, onRefresh); stop(); };
  }, [load]);
  return { problems, reload: load };
}
