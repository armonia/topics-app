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
 * QUANTO SI ASPETTA CHE UN WORKTREE SIA PRONTO, E PERCHE' NON SONO DUE MINUTI.
 *
 * Un worktree diventa `ready` solo DOPO l'install delle dipendenze (la fine di
 * `installDeps`, in `worktree-manager.ts`). Due minuti bastano a un repo
 * piccolo e non bastano a uno grosso: misurato il 19/08 su dancerooms,
 * 242 secondi. Il risultato non era «parte lento», era «NON PARTE»: chi
 * aspettava mollava a 120s, il dispatch falliva, e la card restava ferma senza
 * che niente dicesse che il ritardo era di `pnpm install`.
 *
 * Dieci minuti sono un tetto contro un install BLOCCATO (rete morta, lock di
 * un registry), non una stima del caso normale: quando l'install va, si torna
 * appena finisce. Regolabile per chi ha un repo piu' lento di dancerooms.
 *
 * Si legge alla chiamata e non al boot perche' adesso la chiedono in due, il
 * dispatch e lo spawn isolato, e il valore deve essere lo stesso per entrambi.
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
  if (base.fallback) warn(`${base.reason}: il worktree parte da HEAD`);
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
