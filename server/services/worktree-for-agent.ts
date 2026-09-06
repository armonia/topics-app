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

import { resolveWorktreeBaseRef } from "./worktree-base-ref";
import type { Worktree } from "../types";

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
  /** Where the fallback to `HEAD` is said out loud, prefix included by the
   *  caller (a card's birth and a sub-agent's want different labels). */
  warn?: (reason: string) => void;
}

/**
 * Create a branch worktree for a sub-agent and return its id once ready.
 *
 * Same body as the dispatcher's `createWorktree`, comment included: the branch
 * is born from MAIN and not from the shared checkout's HEAD, because with
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
): Promise<string> {
  const warn = deps.warn ?? ((reason: string) => console.warn(`[worktree] ${reason}`));
  const base = await resolveWorktreeBaseRef(deps.projectPath(projectStoreId));
  if (base.fallback) warn(`${base.reason}: the worktree starts from HEAD`);
  const wt = await deps.create({ projectId: projectStoreId, mode: "branch", baseRef: base.baseRef });
  const ready = await deps.awaitMaterialisation(wt.id, readyMs);
  if (ready.status !== "ready") {
    throw new Error(`worktree ${wt.id}: ${ready.status}${ready.errorMessage ? " " + ready.errorMessage : ""}`);
  }
  return ready.id;
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
