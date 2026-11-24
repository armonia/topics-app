/**
 * Wires the by-hand relocation of foreign worktrees (change worktree-standard, T7)
 * to this host: the stores, the manager, the GC's own questions about who is
 * inside a folder, and the real git. The decisions live in
 * `services/worktree-relocate.ts`; this file only connects them.
 */
import type { AppContext } from "../types";
import type { WorktreeGcRunner } from "../services/worktree-gc-runner";
import { defaultRunGit } from "../services/own-commits";
import { worktreeDirtProbe } from "../services/task-automerge";
import { ownedWorktreeRoots } from "../services/worktree-root";
import { checkRelocation, runRelocation, type RelocateDeps } from "../services/worktree-relocate";

export function createRelocateService(
  ctx: AppContext,
  gc: Pick<WorktreeGcRunner, "isBusyInside" | "isTaskActive">,
) {
  const roots = () => ownedWorktreeRoots(ctx.worktreeStore.list(), new Set(ctx.projectStore.list().map((p) => p.slug)));
  const deps = (): RelocateDeps => ({
    git: defaultRunGit,
    root: () => ctx.worktreeManager.worktreesDir(),
    // Every root Topics used, not only the default: a root changed twice still counts as inside.
    extraRoots: () => roots().extraRoots,
    projects: () => ctx.projectStore.list().map((p) => ({ id: p.id, slug: p.slug, path: p.path })),
    rowAt: (absPath) => {
      const w = ctx.worktreeStore.getByAbsPath(absPath);
      return w ? { id: w.id, projectId: w.projectId, name: w.name, absPath: w.absPath } : null;
    },
    namesFor: (projectId) => new Set(ctx.worktreeStore.listNamesForProject(projectId)),
    createRow: (input) => {
      const row = ctx.worktreeStore.create({ ...input, baseRef: input.branchName });
      ctx.worktreeStore.update(row.id, { status: "ready" });
      return { id: row.id };
    },
    setRowPath: (id, absPath) => ctx.worktreeStore.update(id, { absPath }) !== null,
    removeRow: (id) => ctx.worktreeManager.delete(id, { deleteBranch: false, includeForeign: true }),
    liveInside: (absPath) => gc.isBusyInside(absPath),
    taskActive: (rowId) => gc.isTaskActive(rowId),
    dirt: (absPath) => worktreeDirtProbe(absPath),
  });
  return {
    check: (action: Parameters<typeof checkRelocation>[1], path: string) => checkRelocation(deps(), action, path),
    run: (action: Parameters<typeof runRelocation>[1], path: string) => runRelocation(deps(), action, path),
  };
}

export type RelocateService = ReturnType<typeof createRelocateService>;
