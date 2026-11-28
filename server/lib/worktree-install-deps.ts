/**
 * DEPENDENCIES ARE WHAT A FRESH `git worktree add` LACKS.
 *
 * `git worktree add` materialises TRACKED files only, and `node_modules`
 * (root and `client/`) is not one of them: a fresh worktree is born without
 * it, and every local check (typecheck, lint, unit tests) dies on a missing
 * module before it ever reaches the code. Shared by the agent worktrees
 * (`worktree-manager.ts`) and the throwaway checkout a node delivery is
 * measured on (`node-check-worktree.ts`): both are a `git worktree add` of
 * the same repo, so both need the same fix.
 *
 * Best-effort, always: a failed install (network down, a lockfile the
 * branch broke) must not stop the worktree from existing, nor the checks
 * that do not need it. The checks that do need it go red for a real reason
 * instead of silently skipping, which is the whole point of calling this
 * before them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runBounded } from "./bounded-spawn";
import { installArgv, missingPackageManager } from "./project-scripts";

/** Ceiling on ALL the installs of one worktree (root plus `client/`), shared: a hung one would hold the repo's land chain for everybody. */
export const INSTALL_TIMEOUT_MS = 4 * 60_000;

export interface InstallWorktreeDepsResult {
  ok: number;
  attempted: number;
  ms: number;
  /** An install hit its deadline and its process group was killed. */
  timedOut: boolean;
}

export async function installWorktreeDeps(absPath: string, timeoutMs: number = INSTALL_TIMEOUT_MS): Promise<InstallWorktreeDepsResult> {
  const started = Date.now();
  let ok = 0;
  let attempted = 0;
  let timedOut = false;
  // Root carries `bun-types` (without it the server typecheck dies on "Cannot
  // find type definition file for 'bun'"); `client/` carries eslint and tsc.
  for (const dir of [absPath, join(absPath, "client")]) {
    if (!existsSync(join(dir, "package.json"))) continue;
    attempted += 1;
    const missing = missingPackageManager(dir);
    if (missing) {
      console.warn(`[worktree-install-deps] deps NOT installed in ${dir}: ${missing}`);
      continue;
    }
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) {
      timedOut = true;
      console.warn(`[worktree-install-deps] deps NOT installed in ${dir}: total budget of ${timeoutMs} ms spent`);
      break;
    }
    const run = await runBounded(installArgv(dir), { cwd: dir, timeoutMs: left }); // runtime-dep-ok: the package manager of the USER's project, resolved from its lockfile, not a tool Topics assumes
    if (run.timedOut) {
      timedOut = true;
      console.warn(`[worktree-install-deps] deps NOT installed in ${dir}: timed out after ${timeoutMs} ms`);
      break;
    }
    if (run.exitCode === 0) ok += 1;
    else console.warn(`[worktree-install-deps] deps NOT installed in ${dir}${run.spawnError ? `: ${run.spawnError}` : ""}`);
  }
  return { ok, attempted, ms: Date.now() - started, timedOut };
}
