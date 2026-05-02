/**
 * useCoachmarks — Phase F-extension · fixed-order first-run tooltips.
 *
 * Pattern adopted from the reference desktop client we studied:
 *   · A flat ordered list of coachmark ids (`COACHMARK_ORDER`).
 *   · Each id has a "should I fire?" predicate (`shouldFire`).
 *   · The hook iterates in order, returns the first one whose predicate
 *     matches AND that the user hasn't seen yet.
 *   · Once a coachmark is shown + acknowledged, its id is added to a
 *     localStorage `Set` so it never fires again.
 *
 * Lighter than a full guided tour; more guided than scattered tooltips.
 *
 * Consumers wire:
 *   const next = useCoachmarks({ flags });   // returns id | null
 *   const ack = useCoachmarkAck();           // call to dismiss + advance
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'topics:coachmarks:seen';

/**
 * Canonical coachmark order. The first id whose predicate fires AND
 * isn't yet in the `seen` set is shown. Adding a new entry only requires
 * appending to this list + adding a `should:` lookup below.
 *
 * Mirrors the reference client's `tooltip_first_chat`, `tooltip_worktree`,
 * `tooltip_git_integration`, `tooltip_git_sidebar`,
 * `tooltip_new_session_button`, `tooltip_machine_disconnected` shape.
 */
export const COACHMARK_ORDER = [
  'first-chat',
  'worktree-picker',
  'git-integration',
  'git-sidebar',
  'new-session-button',
  'machine-disconnected',
] as const;

export type CoachmarkId = typeof COACHMARK_ORDER[number];

export interface CoachmarkFlags {
  /** True the very first time the user opens any topic. */
  hasOpenedTopic: boolean;
  /** True once a project is registered (Phase A · projects). */
  hasProject: boolean;
  /** True once a worktree exists for any project (Phase A · worktrees). */
  hasWorktree: boolean;
  /** True once the git watcher has fired at least once. */
  hasGitStatus: boolean;
  /** True when the active machine has gone offline (Phase D). */
  machineOffline: boolean;
}

/**
 * Per-id predicate. The first hit (in COACHMARK_ORDER order) that's
 * also not seen wins.
 *
 * Exported only for unit tests.
 */
export function _shouldFire(id: CoachmarkId, f: CoachmarkFlags): boolean {
  return shouldFire(id, f);
}
function shouldFire(id: CoachmarkId, f: CoachmarkFlags): boolean {
  switch (id) {
    case 'first-chat':           return f.hasOpenedTopic;
    case 'worktree-picker':      return f.hasProject && !f.hasWorktree;
    case 'git-integration':      return f.hasWorktree && !f.hasGitStatus;
    case 'git-sidebar':          return f.hasGitStatus;
    case 'new-session-button':   return f.hasOpenedTopic;
    case 'machine-disconnected': return f.machineOffline;
  }
}

/** Compute the next coachmark to fire, given the seen set + flags. */
export function pickNextCoachmark(
  seen: ReadonlySet<CoachmarkId>,
  flags: CoachmarkFlags,
): CoachmarkId | null {
  for (const id of COACHMARK_ORDER) {
    if (seen.has(id)) continue;
    if (shouldFire(id, flags)) return id;
  }
  return null;
}

function readSeen(): Set<CoachmarkId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((s): s is CoachmarkId => typeof s === 'string'));
  } catch { /* swallow */ }
  return new Set();
}

function writeSeen(seen: Set<CoachmarkId>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...seen])); } catch { /* quota */ }
}

/**
 * Returns the id of the next coachmark to show, or null if none should
 * fire. Caller renders the tooltip and calls `ack(id)` on dismiss.
 */
export function useCoachmarks(flags: CoachmarkFlags): {
  next: CoachmarkId | null;
  ack: (id: CoachmarkId) => void;
  reset: () => void;
} {
  const [seen, setSeen] = useState<Set<CoachmarkId>>(() => readSeen());

  const next = useMemo<CoachmarkId | null>(() => {
    for (const id of COACHMARK_ORDER) {
      if (seen.has(id)) continue;
      if (shouldFire(id, flags)) return id;
    }
    return null;
  }, [seen, flags]);

  const ack = useCallback((id: CoachmarkId) => {
    setSeen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeSeen(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSeen(new Set());
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  // Sync across tabs — if another tab acks a coachmark, this tab updates.
  useEffect(() => {
    const handler = (evt: StorageEvent) => {
      if (evt.key !== STORAGE_KEY) return;
      setSeen(readSeen());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return { next, ack, reset };
}
