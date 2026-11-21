/**
 * THE PAUSE OF EACH PROJECT, one store for every window and surface.
 *
 * The server pushes `project:quota` to all windows when a pause opens or
 * closes, so every chat strip, the board strip and the sidebar meter read the
 * same entry and flip together without a reload. A window that opens after
 * the frame went by (or a socket that was down) reads
 * `GET /api/projects/:id/quota/pause` once on mount and on reconnect.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';
import { subscribeFrames, subscribeReconnect } from '../lib/wsFrameBus';

export type PauseReason = 'limit' | 'hold-until-tomorrow';

export interface ProjectPause {
  paused: boolean;
  reason: PauseReason | null;
  limit: number | null;
  points24h: number | null;
}

const IDLE: ProjectPause = { paused: false, reason: null, limit: null, points24h: null };

let pauses: ReadonlyMap<string, ProjectPause> = new Map();
const listeners = new Set<() => void>();
/** Projects some mounted surface watches: the reconnect re-reads exactly these. */
const watched = new Map<string, number>();

function emit(): void { listeners.forEach((cb) => cb()); }

function parse(raw: unknown): (ProjectPause & { projectId: string }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.projectId !== 'string' || typeof f.paused !== 'boolean') return null;
  const reason = f.reason === 'limit' || f.reason === 'hold-until-tomorrow' ? f.reason : null;
  return {
    projectId: f.projectId,
    paused: f.paused,
    reason: f.paused ? reason : null,
    limit: typeof f.limit === 'number' ? f.limit : null,
    points24h: typeof f.points24h === 'number' ? f.points24h : null,
  };
}

/** Applies a `project:quota` frame or a pause reading; returns false for a malformed payload. */
export function applyProjectPause(raw: unknown): boolean {
  const p = parse(raw);
  if (!p) return false;
  const { projectId, ...state } = p;
  const prev = pauses.get(projectId) ?? IDLE;
  if (prev.paused === state.paused && prev.reason === state.reason && prev.limit === state.limit && prev.points24h === state.points24h) return true;
  const next = new Map(pauses);
  next.set(projectId, state);
  pauses = next;
  emit();
  return true;
}

export function getProjectPause(projectId: string): ProjectPause {
  return pauses.get(projectId) ?? IDLE;
}

/** Test seam: forgets everything. */
export function resetProjectPauses(): void {
  pauses = new Map();
  watched.clear();
  emit();
}

async function readOne(projectId: string): Promise<void> {
  try {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/quota/pause`);
    if (res.ok) applyProjectPause(await res.json());
  } catch { /* the next frame or reconnect tells the truth; a strip is never invented */ }
}

let armed = false;
function arm(): void {
  if (armed) return;
  armed = true;
  subscribeFrames((frame) => { applyProjectPause(frame); }, { types: ['project:quota'] });
  subscribeReconnect(() => { for (const id of watched.keys()) void readOne(id); });
}

function subscribe(cb: () => void): () => void {
  arm();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The pause of one project (`''` = no project: never paused). */
export function useProjectPause(projectId: string): ProjectPause {
  const pause = useSyncExternalStore(subscribe, () => (projectId ? getProjectPause(projectId) : IDLE));
  useEffect(() => {
    if (!projectId) return;
    arm();
    watched.set(projectId, (watched.get(projectId) ?? 0) + 1);
    void readOne(projectId);
    return () => {
      const n = (watched.get(projectId) ?? 1) - 1;
      if (n <= 0) watched.delete(projectId); else watched.set(projectId, n);
    };
  }, [projectId]);
  return pause;
}

/** "Continua" / "Pausa fino a domani": the returning frame updates every window, this one included. */
export async function answerProjectPause(projectId: string, action: 'continue' | 'hold'): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/quota/${action}`, { method: 'POST' });
    return res.ok;
  } catch { return false; }
}
