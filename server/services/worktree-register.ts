/**
 * THE REGISTRATION DOOR for worktrees Topics did not make (cross-node addendum,
 * B2, track T8).
 *
 * The filesystem is the protocol: a checkout under the worktree root with a
 * `.git` is found by the GC on its own. This door is the accelerator: a creator
 * (the Claude Code hook, Codex, a script) tells Topics about a checkout the moment
 * it exists, so it gets its row and its creator at once instead of after a day,
 * and a GC passing in the first minutes sees it as somebody's.
 *
 *   register   idempotent on the path. A repository no project knows: 202, an
 *              inventory answer, nothing written anywhere (not even in that
 *              repository's `.git`). Inside the root: a `ready` row and the v2
 *              owner marker. Outside: a `reuse` row and no marker (the folder is
 *              not Topics' to mark).
 *   placement  where a creator should put a checkout of a repository (or of a
 *              project, by slug): the one place that applies the root setting,
 *              so nobody re-reads the DB.
 *   unregister forgets the row of a checkout whose folder is gone. A folder still
 *              there is refused: forgetting it would only make it an orphan.
 *
 * Every effect is a dependency, so the decisions are tested without a server.
 */
import { basename } from "node:path";
import { isAbsoluteServerPath } from "../lib/absolute-path";
import { isInsideDir } from "../lib/path-containment";
import { isValidWorktreeName } from "../utils/worktree-naming";
import { nameForAdopted } from "./worktree-root-gc";
import { isWorktreeCreator, pathKey, type OwnerMarker, type WorktreeCreator } from "./worktree-owner";
import type { Worktree } from "../types";

/** What a creator sends. */
export interface RegisterRequest {
  path: unknown;
  creator: unknown;
  session?: unknown;
  /** Checked for shape only: the branch recorded is the one checked out there. */
  branch?: unknown;
  name?: unknown;
}

export interface RegisterProject { id: string; slug: string; path: string }

export interface RegisterDeps {
  platform?: NodeJS.Platform;
  /** The current root, then the roots whose checkouts are still Topics' (the default one). */
  roots: () => string[];
  /** The canonical spelling of a path (links resolved, native case on Windows). */
  canonical: (path: string) => string;
  /** The project a checkout belongs to, through git's common dir; null for an unknown repository. */
  projectFor: (path: string) => RegisterProject | null;
  /** The project named by its slug or id; absent = placement by project answers 404. */
  projectByRef?: (ref: string) => RegisterProject | null;
  /** The folder is a LINKED worktree (its `.git` is a file). */
  isLinkedWorktree: (path: string) => boolean;
  /** The folder exists. */
  exists: (path: string) => boolean;
  /** The branch checked out there, or null when HEAD is detached. */
  headBranch: (path: string) => Promise<string | null>;
  store: {
    list(): Worktree[];
    getByAbsPath(absPath: string): Worktree | null;
    listNamesForProject(projectId: string): Set<string>;
    create(input: { projectId: string; name: string; branchName: string | null; baseRef: string | null; mode: "branch" | "reuse" | "detached"; absPath: string; source?: WorktreeCreator; sessionRef?: string | null }): Worktree;
    update(id: string, patch: { status: "ready" }): unknown;
    delete(id: string): boolean;
  };
  readMarker: (path: string) => OwnerMarker | null;
  writeMarker: (path: string, marker: OwnerMarker) => boolean;
  /** This machine's id, or its host name. */
  machine: () => string;
  now?: () => Date;
}

export type RegisterOutcome =
  | { status: 200; body: { id: string; class: "tracked" | "foreign"; inRoot: boolean; created: boolean } }
  | { status: 202; body: { class: "inventory"; inRoot: boolean } }
  | { status: 400 | 409; body: { error: string } };

const SESSION_FIELD_MAX = 1024;

function cleanSession(v: unknown, platform: NodeJS.Platform): { id: string; transcript?: string } | null | "bad" {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return "bad";
  const s = v as { id?: unknown; transcript?: unknown };
  // A control byte in the session id is refused, not stripped: the caller sent something that is not an id.
  // eslint-disable-next-line no-control-regex -- the control bytes are exactly what this pattern refuses
  if (typeof s.id !== "string" || !s.id || s.id.length > SESSION_FIELD_MAX || /[\0-\x1f]/.test(s.id)) return "bad";
  if (s.transcript === undefined || s.transcript === null) return { id: s.id };
  if (!isAbsoluteServerPath(s.transcript, platform) || s.transcript.length > SESSION_FIELD_MAX) return "bad";
  return { id: s.id, transcript: s.transcript };
}

/** The row at this path: exact first, then (Windows) by the case-insensitive key. */
export function rowAtPath(deps: Pick<RegisterDeps, "store" | "platform" | "canonical">, absPath: string): Worktree | null {
  const exact = deps.store.getByAbsPath(absPath);
  if (exact) return exact;
  if ((deps.platform ?? process.platform) !== "win32") return null;
  const key = absPath.toLowerCase();
  return deps.store.list().find((w) => pathKey(w.absPath, { platform: "win32", realpath: deps.canonical }) === key) ?? null;
}

function inAnyRoot(deps: RegisterDeps, absPath: string): boolean {
  const platform = deps.platform ?? process.platform;
  return deps.roots().some((r) => isInsideDir(absPath, deps.canonical(r), platform));
}

/**
 * The branch was born with this checkout, so the cleanup may delete it with the
 * folder: the hook's own `worktree-<folder name>`, or one of Topics' `topics/*`.
 * Any other branch (a feature checked out by hand, a branch the user had before)
 * makes a `reuse` row, whose removal leaves the branch alone. Outside the root
 * nothing is ever `branch`.
 */
function creatorOwnsBranch(branch: string, absPath: string): boolean {
  const folder = basename(absPath.replace(/\\/g, "/"));
  return branch === `worktree-${folder}` || branch.startsWith("topics/");
}

export async function registerWorktree(deps: RegisterDeps, req: RegisterRequest): Promise<RegisterOutcome> {
  const platform = deps.platform ?? process.platform;
  if (!isAbsoluteServerPath(req.path, platform)) return { status: 400, body: { error: "path must be an absolute path" } };
  if (!isWorktreeCreator(req.creator) || req.creator === "topics") {
    return { status: 400, body: { error: "creator must name the tool that made the worktree (not topics)" } };
  }
  const creator = req.creator;
  const session = cleanSession(req.session, platform);
  if (session === "bad") return { status: 400, body: { error: "session must be {id, transcript?} with an absolute transcript path" } };
  if (req.branch !== undefined && req.branch !== null && (typeof req.branch !== "string" || !/^[A-Za-z0-9_./-]{1,200}$/.test(req.branch))) {
    return { status: 400, body: { error: "branch contains invalid characters" } };
  }

  const absPath = deps.canonical(req.path);
  const inRoot = inAnyRoot(deps, absPath);
  const project = deps.projectFor(absPath);
  // An unknown repository: an inventory answer, and nothing written anywhere.
  if (!project) return { status: 202, body: { class: "inventory", inRoot } };
  if (!deps.exists(absPath) || !deps.isLinkedWorktree(absPath)) {
    return { status: 400, body: { error: "path is not a linked worktree (a main checkout is never registered)" } };
  }

  // The branch is read off the checkout, never taken from the body: a `branch` row's
  // removal runs `git branch -D` on it. Read BEFORE the row lookup, so lookup and
  // insert run with no await between them and two calls for one path cannot both insert.
  const branch = await deps.headBranch(absPath);
  let row = rowAtPath(deps, absPath);
  let created = false;
  if (row && row.projectId !== project.id) return { status: 409, body: { error: "the path already belongs to another project" } };
  if (!row) {
    const mode: "branch" | "reuse" | "detached" = !branch ? "detached" : inRoot && creatorOwnsBranch(branch, absPath) ? "branch" : "reuse";
    const wanted = typeof req.name === "string" && isValidWorktreeName(req.name) ? req.name : basename(absPath);
    const name = nameForAdopted(wanted, deps.store.listNamesForProject(project.id));
    row = deps.store.create({
      projectId: project.id, name, branchName: branch, baseRef: branch, mode, absPath,
      source: creator, sessionRef: session?.transcript ?? session?.id ?? null,
    });
    deps.store.update(row.id, { status: "ready" });
    created = true;
  }

  // Inside the root the marker is written or completed; outside the folder is not ours to mark.
  if (inRoot) {
    const prior = deps.readMarker(absPath);
    deps.writeMarker(absPath, {
      worktreeId: row.id,
      projectId: project.id,
      createdAt: prior?.createdAt || (deps.now ?? (() => new Date()))().toISOString(),
      creator: prior?.creator && prior.creator !== "topics" ? prior.creator : creator,
      ...(session ?? prior?.session ? { session: session ?? prior!.session! } : {}),
      machine: prior?.machine || deps.machine(),
    });
  }
  return { status: 200, body: { id: row.id, class: inRoot ? "tracked" : "foreign", inRoot, created } };
}

/** Where a creator puts a checkout of `repo`: `{root}/{slug}/…`, and the project when one is known. */
export function placementFor(
  deps: Pick<RegisterDeps, "roots" | "projectFor" | "platform">,
  repo: unknown,
): { status: 200; body: { root: string; slug: string; projectId: string | null } } | { status: 400; body: { error: string } } {
  const platform = deps.platform ?? process.platform;
  if (!isAbsoluteServerPath(repo, platform)) return { status: 400, body: { error: "repo must be an absolute path" } };
  // The hook sends git's common dir (`<repo>/.git`): the repository is its parent.
  const trimmed = repo.replace(/[\\/]+$/, "");
  const repoDir = /[\\/]\.git$/.test(trimmed) ? trimmed.slice(0, -".git".length - 1) : trimmed;
  const project = deps.projectFor(repoDir);
  const slug = project?.slug || basename(repoDir.replace(/\\/g, "/")).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return { status: 200, body: { root: deps.roots()[0]!, slug, projectId: project?.id ?? null } };
}

/**
 * Where a checkout of a project goes, by the project's slug or id: what
 * `topics-worktree add <project>` asks, since a tool outside Topics knows the
 * name of a project and not the folder of its repository.
 */
export function placementForProject(
  deps: Pick<RegisterDeps, "roots" | "projectByRef">,
  ref: unknown,
): { status: 200; body: { root: string; slug: string; projectId: string; repo: string } } | { status: 400 | 404; body: { error: string } } {
  if (typeof ref !== "string" || !ref.trim() || ref.length > 200) return { status: 400, body: { error: "project must be a slug or an id" } };
  const project = deps.projectByRef?.(ref.trim()) ?? null;
  if (!project) return { status: 404, body: { error: "no such project" } };
  return { status: 200, body: { root: deps.roots()[0]!, slug: project.slug, projectId: project.id, repo: project.path } };
}

/** Forgets the row of a checkout whose folder is gone. Unknown path: nothing to do. */
export function forgetWorktree(
  deps: Pick<RegisterDeps, "store" | "platform" | "canonical" | "exists">,
  path: unknown,
): { status: 200; body: { removed: boolean; id: string | null } } | { status: 400 | 409; body: { error: string } } {
  if (!isAbsoluteServerPath(path, deps.platform ?? process.platform)) return { status: 400, body: { error: "path must be an absolute path" } };
  const absPath = deps.canonical(path);
  const row = rowAtPath(deps, absPath);
  if (!row) return { status: 200, body: { removed: false, id: null } };
  // A row Topics made is dropped by Topics' own delete, which also handles its branch and its card.
  if ((row.source ?? "topics") === "topics") return { status: 409, body: { error: "a worktree Topics made is removed by Topics, not unregistered" } };
  if (deps.exists(absPath)) return { status: 409, body: { error: "the folder is still there: remove it first, or let the GC judge it" } };
  return { status: 200, body: { removed: deps.store.delete(row.id), id: row.id } };
}
