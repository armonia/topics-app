/**
 * A CHECKOUT OF ITS OWN FOR A SUB-AGENT (WORKTREE-14).
 *
 * The board has always given a dispatched card its own worktree; a sub-agent
 * spawned by another session inherited the parent's directory instead, so two
 * children working on the same repository wrote over each other. This module is
 * the birth path of a card, lifted out of `server.ts` so the spawn route can
 * take exactly the same road: base ref by WORKTREE-08, `worktree add` through
 * the manager, and a wait until the row actually reads `ready`.
 *
 * Nothing here decides WHETHER a child gets a worktree — that is the route's
 * opt-in — and nothing here deletes: the sweep (WORKTREE-09/10) stays the only
 * thing that removes a directory.
 */

import { defaultRunGit } from "./own-commits";
import { fetchRemoteBase, resolveWorktreeBaseRef, type WorktreeBaseRef } from "./worktree-base-ref";
import type { GitRunner } from "./own-commits";
import { carriedRef } from "./branch-on-origin";
import type { Worktree } from "../types";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { isInsideDir } from "../lib/path-containment";
import { resolveCargoTargetMode } from "./app-settings";
import { defaultWorktreeRootDir, worktreeRootDir } from "./worktree-root";
import type { CargoTargetMode } from "../../shared/worktree-settings";

/**
 * HOW LONG A WORKTREE IS GIVEN TO BECOME READY, AND WHY IT IS NOT TWO MINUTES.
 *
 * A worktree turns `ready` only AFTER the dependency install finishes
 * (`installDeps`, in `worktree-manager.ts`). Two minutes are enough for a small
 * repository and not enough for a large one: measured on 2026-08-19 at 242
 * seconds. The result was not "it starts slowly", it was "it does NOT start":
 * whoever waited gave up at 120s, the dispatch failed, and the card sat still
 * with nothing saying the delay belonged to a package install.
 *
 * Ten minutes are a ceiling against a STUCK install (dead network, a registry
 * lock), not an estimate of the normal case: when the install works, the answer
 * comes as soon as it ends. Tunable for a repository slower than that one.
 *
 * Read at call time and not at boot because two callers now ask for it, the
 * dispatch and the isolated spawn, and the value has to be the same for both.
 */
export function worktreeReadyMs(): number {
  return Math.max(60_000, Number(process.env.TOPICS_WORKTREE_READY_MS) || 600_000);
}

/** The two collaborators the birth needs, declared so a test can stand in for
 *  both without a git repository or a server. */
export interface AgentWorktreeDeps {
  /** Repo path of a project, for the base-ref probe (`null` ⇒ no git call). */
  projectPath: (projectStoreId: string) => string | null | undefined;
  create: (input: { projectId: string; mode: "branch"; baseRef: string }) => Promise<{ id: string }>;
  awaitMaterialisation: (
    worktreeId: string,
    timeoutMs: number,
  ) => Promise<{ id: string; status: string; errorMessage?: string | null }>;
  /** Injected by the tests of a base from a branch (`resolveBranchBaseRef`). Default: the real `git`. */
  runGit?: GitRunner;
  /** Where the fallback to `HEAD` is said out loud, prefix included by the
   *  caller (a card's birth and a sub-agent's want different labels). */
  warn?: (reason: string) => void;
}

/**
 * Create a branch worktree for a sub-agent and return its id once ready.
 *
 * Same body as the dispatcher's `createWorktree`, comment included: the branch
 * is born from `origin/main` and not from the shared checkout's HEAD, because with
 * `HEAD` a worktree inherited whoever was working here (migration collisions,
 * deliveries resting on commits that never landed). The reasons in full live in
 * `worktree-base-ref.ts`.
 *
 * Throws when materialisation does not reach `ready`: a half-born checkout is
 * not a directory to hand a child.
 */
export async function createAgentWorktree(
  deps: AgentWorktreeDeps,
  projectStoreId: string,
  readyMs: number,
  opts: { baseBranch?: string } = {},
): Promise<string> {
  const warn = deps.warn ?? ((reason: string) => console.warn(`[worktree] ${reason}`));
  const base = opts.baseBranch
    ? await resolveBranchBaseRef(deps.projectPath(projectStoreId), opts.baseBranch, deps.runGit)
    : await resolveWorktreeBaseRef(deps.projectPath(projectStoreId));
  if (base.reason) warn(base.fallback ? `${base.reason}: the worktree starts from HEAD` : base.reason);
  const wt = await deps.create({ projectId: projectStoreId, mode: "branch", baseRef: base.baseRef });
  const ready = await deps.awaitMaterialisation(wt.id, readyMs);
  if (ready.status !== "ready") {
    throw new Error(`worktree ${wt.id}: ${ready.status}${ready.errorMessage ? " " + ready.errorMessage : ""}`);
  }
  return ready.id;
}

/**
 * The base of a card that must start from a GIVEN branch (a node's mirror of a
 * card that already has one): `origin/<branch>`, fetched now. No fallback: a
 * worktree born from main or HEAD instead would redo the work without that
 * branch's commits and conflict with them at the land (df5fd8c5), so a branch
 * origin does not have is an error the caller turns into a failed launch.
 */
export async function resolveBranchBaseRef(
  repoPath: string | null | undefined,
  branch: string,
  runGit: GitRunner = defaultRunGit,
): Promise<WorktreeBaseRef> {
  if (!repoPath) throw new Error(`base branch '${branch}': the project has no repo path`);
  // A branch that travelled as a bundle (the node cannot reach origin) is the base itself.
  const carried = carriedRef(branch);
  if ((await runGit(repoPath, ["rev-parse", "--verify", "--quiet", carried])).code === 0) {
    return { baseRef: carried, fallback: false, reason: "" };
  }
  // A failed fetch is a failure here, not a stale copy: the origin card has
  // just pushed, and an older `origin/<branch>` would miss exactly that.
  const { ref, fetchError } = await fetchRemoteBase(runGit, repoPath, branch);
  if (!ref || fetchError) throw new Error(`base branch '${branch}' is not on origin${fetchError ? ` (${fetchError})` : ""}`);
  return { baseRef: ref, fallback: false, reason: "" };
}

/** The directories that can answer "which project is this", most specific first. */
export interface AgentProjectCandidates {
  /** The `cwd` the caller asked for, if any. */
  cwd?: string | null;
  /** The parent session's own working directory. */
  parentCwd?: string | null;
  /** The working directory of the parent's topic (a chat parent has no session row). */
  topicCwd?: string | null;
}

export interface AgentProjectLookup {
  getByPath: (path: string) => { id: string } | null;
  getByAbsPath: (absPath: string) => Pick<Worktree, "projectId"> | null;
}

export type AgentProjectResolution =
  | { ok: true; projectStoreId: string }
  | { ok: false; refusal: string };

/**
 * Which project should the child's worktree belong to?
 *
 * Pure, and it looks twice at every candidate. A parent that is itself a card's
 * agent already stands INSIDE a worktree: `projects.path` does not know that
 * directory, and WORKTREE-01 refuses to create a worktree from a checkout that
 * is one. Reading the worktree row instead gives the real project, and the
 * manager is handed a project id, never a nested path.
 *
 * The refusal names the paths it could not place: "no project" with nothing to
 * look at is a message that sends whoever reads it to the source.
 */
export function resolveAgentProject(
  candidates: AgentProjectCandidates,
  lookup: AgentProjectLookup,
): AgentProjectResolution {
  const tried: string[] = [];
  for (const candidate of [candidates.cwd, candidates.parentCwd, candidates.topicCwd]) {
    if (typeof candidate !== "string" || !candidate) continue;
    tried.push(candidate);
    const project = lookup.getByPath(candidate);
    if (project) return { ok: true, projectStoreId: project.id };
    const worktree = lookup.getByAbsPath(candidate);
    if (worktree) return { ok: true, projectStoreId: worktree.projectId };
  }
  const where = tried.length ? tried.join(", ") : "no known directory";
  return { ok: false, refusal: `isolation 'worktree': no project owns ${where}` };
}

/** Folder of the worktree root that holds caches shared by every worktree of a project. */
export const CACHE_FOLDER = "_cache";

/**
 * The one Rust build directory of a project: `{root}/_cache/cargo/{slug}`. Every
 * worktree of the project compiles into it, so `target/` (the one weight that is
 * not cloned) exists once instead of once per checkout. Cargo's own lock on the
 * directory serialises the builds, which is wanted: four parallel builds took the
 * load to 29 on 09/11/2026.
 */
export function cargoTargetDir(root: string, slug: string): string {
  return join(root, CACHE_FOLDER, "cargo", slug.replace(/[^A-Za-z0-9._-]/g, "-"));
}

/**
 * `CARGO_TARGET_DIR` for an agent working in a worktree of this project, or `{}`.
 * `per-worktree` leaves cargo alone (for build scripts that pin absolute paths:
 * they can stay tied to the first worktree that compiled), and so does a project
 * with no usable slug.
 */
export function cargoTargetEnv(opts: { mode: CargoTargetMode; root: string; slug: string | null | undefined }): Record<string, string> {
  if (opts.mode !== "shared" || !opts.slug || !/[A-Za-z0-9]/.test(opts.slug)) return {};
  return { CARGO_TARGET_DIR: cargoTargetDir(opts.root, opts.slug) };
}

/**
 * The cargo environment of the agent behind a session key: its topic's worktree,
 * when that worktree is one Topics made (under the root, the current one or the
 * default), and the project's slug. An adopted worktree of another tool and a
 * chat with no worktree get nothing. Every failure answers `{}`: a missing cache
 * variable costs a slower first build, never a session.
 */
export function worktreeCargoEnv(
  db: Database,
  sessionKey: string,
  opts: { mode?: CargoTargetMode; root?: string; defaultRoot?: string } = {},
): Record<string, string> {
  try {
    const row = db.prepare(
      `SELECT w.abs_path AS absPath, p.slug AS slug
         FROM topics t JOIN worktrees w ON w.id = t.worktree_id JOIN projects p ON p.id = w.project_id
        WHERE t.session_key = ? LIMIT 1`,
    ).get(sessionKey) as { absPath?: string; slug?: string } | undefined;
    if (!row?.absPath || !row.slug) return {};
    const root = opts.root ?? worktreeRootDir();
    if (!isInsideDir(row.absPath, root) && !isInsideDir(row.absPath, opts.defaultRoot ?? defaultWorktreeRootDir())) return {};
    return cargoTargetEnv({ mode: opts.mode ?? resolveCargoTargetMode(), root, slug: row.slug });
  } catch {
    return {};
  }
}
