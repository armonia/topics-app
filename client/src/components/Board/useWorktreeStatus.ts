import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { startVisibleInterval } from '../../state/documentVisibility';
import { apiFetch } from '../../lib/shell/net';

/**
 * Worktree folders and local branches of a project, plus the "Pulisci landati"
 * GC pass. Pure data plumbing for `WorktreeControl`: the pane only forwards
 * what this returns.
 */
export function useWorktreeStatus(projectPath: string | undefined, global: boolean) {
  const tr = useT();
  // How many live CHECKOUTS this project holds.
  //
  // The "not on main" chip (next to Publish) counts unlanded BRANCHES; this
  // counts folders. They are two different piles and they move separately: a
  // landed branch frees its worktree, but a worktree kept because the task is
  // still open has no branch to land. With a single number you cannot tell
  // which of the two is growing - and it grew silently up to ~40 worktrees on
  // 21/07. `WorktreeControl` shows them, keeps them distinct and explains them
  // in words.
  const [worktreeCount, setWorktreeCount] = useState(0);
  const [gcRunning, setGcRunning] = useState(false);
  /** Local branches not on main: how many, and how many no task claims. */
  const [branchInv, setBranchInv] = useState<{ total: number; orphan: number; onOpenTasks: number } | null>(null);
  const [gcResult, setGcResult] = useState<string | null>(null);
  useEffect(() => {
    if (!projectPath || global) { setWorktreeCount(0); return; }
    let alive = true;
    const load = () => {
      apiFetch(`/api/worktrees?project_path=${encodeURIComponent(projectPath)}&status=ready`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { worktrees?: unknown[] } | null) => {
          if (alive && Array.isArray(b?.worktrees)) setWorktreeCount(b.worktrees.length);
        })
        .catch(() => {});
    };
    load();
    // The GC runs every 30 minutes and dispatches create worktrees all the
    // time: a count read once at mount goes stale before the reader's eyes.
    const stopPolling = startVisibleInterval(load, 60_000);
    return () => { alive = false; stopPolling(); };
  }, [projectPath, global]);

  // The BRANCHES not on main, with the task that claims them.
  //
  // The "N not on main" chip only counts CLOSED tasks: a branch of a task still
  // in backlog - or of no task - showed up nowhere. That is how four branches
  // with finished work stayed invisible for weeks, while the board kept
  // proposing as "to do" things already written there. The number that matters
  // is the ORPHANS: nobody will claim them.
  useEffect(() => {
    if (!projectPath || global) { setBranchInv(null); return; }
    let alive = true;
    apiFetch(`/api/worktrees/branches?project_path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { summary?: { total: number; orphan: number; onOpenTasks: number } } | null) => {
        if (alive && b?.summary) setBranchInv(b.summary);
      })
      // A project that is not a git repo answers 500: no inventory, and that is
      // fine - it is not an error to show, it is a project with no branches.
      .catch(() => {});
    return () => { alive = false; };
  }, [projectPath, global]);

  // "Pulisci landati": brings the GC pass forward instead of waiting for one.
  //
  // It is not more permissive than the automatic one - it is the SAME pass,
  // which only reaps what is provably safe. That is why the outcome must also
  // say how many it KEPT and why: a bare "0 ripuliti" would make a button that
  // is doing the right thing look broken.
  const runGc = useCallback(async () => {
    setGcRunning(true);
    setGcResult(null);
    try {
      const r = await apiFetch('/api/worktrees/gc', { method: 'POST' });
      const b = (await r.json()) as { summary?: { reaped?: number; landed?: number; freed?: number; kept?: number; slimmed?: number; slimmedBytes?: number; keptReasons?: Record<string, number> } };
      const sm = b?.summary;
      if (!sm) { setGcResult(tr('board.gc.noAnswer')); return; }
      const reasons = Object.entries(sm.keptReasons ?? {}).sort((a, b2) => b2[1] - a[1]).slice(0, 2)
        .map(([m, n]) => `${n}× ${m}`).join('; ');
      // `liberati` is the entry that today does almost all the work (folder
      // gone, branch kept): without it, a pass that frees 77 would say "0
      // ripuliti, 0 landati" and look like it did nothing.
      //
      // The same goes for `snelliti`: a pass that keeps ALL the worktrees may
      // still have freed a few gigabytes of `node_modules`, and without this
      // entry it would only say "0, 0, 0, N tenuti".
      const slimmedNote = (sm.slimmed ?? 0) > 0
        ? `, ${sm.slimmed} snelliti (${Math.round((sm.slimmedBytes ?? 0) / 1_048_576)} MB)`
        : '';
      setGcResult(
        `${sm.reaped ?? 0} ripuliti, ${sm.freed ?? 0} liberati (branch salvo), ${sm.landed ?? 0} landati${slimmedNote}, ${sm.kept ?? 0} tenuti`
        + (reasons ? `: ${reasons}` : ''),
      );
      // The count next to it must reflect the pass that just ran.
      if (projectPath) {
        const rr = await apiFetch(`/api/worktrees?project_path=${encodeURIComponent(projectPath)}&status=ready`);
        if (rr.ok) {
          const bb = (await rr.json()) as { worktrees?: unknown[] };
          if (Array.isArray(bb.worktrees)) setWorktreeCount(bb.worktrees.length);
        }
      }
    } catch {
      setGcResult(tr('board.gc.noAnswer'));
    } finally {
      setGcRunning(false);
    }
  }, [projectPath, tr]);

  return { worktreeCount, gcRunning, branchInv, gcResult, runGc };
}
