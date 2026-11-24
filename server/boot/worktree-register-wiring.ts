/**
 * Wires the worktree registration door (cross-node addendum, B2, track T8) to
 * this host: the stores, the root, git and the hook token. The decisions live in
 * `services/worktree-register.ts`; this file only connects them.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { AppContext } from "../types";
import type { RegisterDeps } from "../services/worktree-register";
import { canonicalProjectFor } from "../services/project-path-resolver";
import { defaultWorktreeRootDir } from "../services/worktree-root";
import { canonicalPath, readOwnerMarker, worktreeAdminDir, writeOwnerMarker } from "../services/worktree-owner";
import { defaultRunGit } from "../services/own-commits";
import { getOrCreateHookToken } from "../routes/claude-hooks";

export function createRegistrationDoor(ctx: AppContext): { deps: () => RegisterDeps; token: () => string | null } {
  const deps = (): RegisterDeps => {
    const root = ctx.worktreeManager.worktreesDir();
    const def = defaultWorktreeRootDir();
    return {
      roots: () => (resolve(root) === resolve(def) ? [root] : [root, def]),
      canonical: (p) => canonicalPath(p),
      projectFor: (p) => {
        const hit = canonicalProjectFor(p, ctx.projectStore.list(), {
          worktreeOwner: (abs) => ctx.worktreeStore.getByAbsPath(abs)?.projectId ?? null,
          worktreeRoot: root,
        });
        return hit ? { id: hit.id, slug: hit.slug, path: hit.path } : null;
      },
      projectByRef: (ref) => {
        const hit = ctx.projectStore.list().find((p) => p.slug === ref || p.id === ref);
        return hit ? { id: hit.id, slug: hit.slug, path: hit.path } : null;
      },
      isLinkedWorktree: (p) => worktreeAdminDir(p) !== null,
      exists: (p) => existsSync(p),
      headBranch: async (p) => {
        const r = await defaultRunGit(p, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
        const name = r?.code === 0 ? r.stdout.trim() : "";
        return name && name !== "HEAD" ? name : null;
      },
      store: ctx.worktreeStore,
      readMarker: readOwnerMarker,
      writeMarker: writeOwnerMarker,
      machine: () => hostname(),
    };
  };
  return { deps, token: () => getOrCreateHookToken() };
}
