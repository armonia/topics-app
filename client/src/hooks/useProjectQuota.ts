/**
 * EVERY PROJECT'S QUOTA POINTS, kept fresh for whoever is looking.
 *
 * `GET /api/usage/projects/quota` is a transcript scan the server shares for a
 * minute, so this polls once a minute. The sidebar rows and the Dashboard table
 * ask for the same answer: one shared reading, one timer, started by the first
 * subscriber and stopped with the last.
 */
import { useSyncExternalStore } from 'react';
import type { ProjectQuotaResponse } from '../../../shared/usage-shapes';
import { apiFetch } from '../lib/shell/net';

const POLL_MS = 60_000;

export interface ProjectQuotaState {
  quota: ProjectQuotaResponse | null;
  /** The last read failed; `quota` keeps the previous good reading when there was one. */
  error: boolean;
}

let state: ProjectQuotaState = { quota: null, error: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function read(): Promise<void> {
  try {
    const res = await apiFetch('/api/usage/projects/quota');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = { quota: (await res.json()) as ProjectQuotaResponse, error: false };
  } catch {
    state = { ...state, error: true };
  }
  listeners.forEach((cb) => cb());
}

/** Reads again now, for a caller that just changed what the reading depends on (a project's limit). */
export function refreshProjectQuota(): void {
  void read();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    void read();
    timer = setInterval(() => { void read(); }, POLL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

export function useProjectQuota(): ProjectQuotaState {
  return useSyncExternalStore(subscribe, () => state);
}
