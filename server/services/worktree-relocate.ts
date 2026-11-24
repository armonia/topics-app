/**
 * ADOPT, MOVE OR REMOVE A WORKTREE MADE BY ANOTHER TOOL (change worktree-standard, T7).
 *
 * Topics never touches a checkout outside its root on its own: Claude Desktop's
 * `<repo>/.claude/worktrees/`, a sibling `repo-wt-x`, a `git worktree add` by hand
 * are only listed. This module is the by-hand door, one folder at a time, always
 * with a preview first:
 *
 *   adopt   a `reuse` row is made for it, so the cleanup sees it (nothing moves)
 *   move    `git worktree move` into `{root}/{project-slug}/{name}`, then `repair`
 *   remove  `git worktree remove` (no `--force`), the branch is never touched; a
 *           detached HEAD whose commits are on no branch and not on main is refused,
 *           because the folder is then the only thing that keeps them
 *
 * And two doors inside the root, for what the GC only lists:
 *
 *   quarantine  a folder at `{root}/{slug}/{name}` with no `.git`, no row and nothing
 *               git lists (a leftover from before Topics marked its folders) is moved
 *               into the root's quarantine, with every re-check the GC makes except
 *               the marker: the person asking is the proof
 *   restore     a quarantined folder goes back where it came from
 *
 * Every refusal is a fact read from git or the disk: a dirty tree, a submodule
 * (git itself refuses to move or remove those), a lock, a live session or a card
 * working in it. Only folders git lists for a KNOWN project are ever acted on, so
 * a path typed into the route cannot reach anything else.
 *
 * Moving orphans the conversation transcripts Claude keeps per folder: the old
 * ones stay under the old path. That is a warning, not a refusal, and it is the
 * reason a live session blocks the move.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { GitRunner } from "./own-commits";
import type { RelocateAction, RelocateCheckPayload, RelocateRefusal, RelocateResultPayload, RelocateWarning } from "../../shared/worktree-plan";
import { isInsideDir } from "../lib/path-containment";
import { canonicalProjectFor } from "./project-path-resolver";
import { canonicalPath, listRepoWorktrees, writeOwnerMarker, type ListedWorktree } from "./worktree-owner";
import { indexListedWorktrees, nameForAdopted, quarantineGhostFolder, type KnownProject } from "./worktree-root-gc";
import { findQuarantined, restoreQuarantined, slugAndName, surelyAbsent } from "./worktree-root-ledger";
import { headStatusOfCheckout } from "./worktree-head-status";

export interface RelocateRow {
  id: string;
  projectId: string;
  name: string;
  absPath: string;
}

export interface RelocateDeps {
  git: GitRunner;
  /** Topics' worktree root as set now. */
  root: () => string;
  /** Other roots that are still Topics' own (the default one, after the setting moved). */
  extraRoots?: () => readonly string[];
  projects: () => readonly KnownProject[];
  /** The row at this exact path. */
  rowAt: (absPath: string) => RelocateRow | null;
  namesFor: (projectId: string) => Set<string>;
  /** Makes a `ready` row. */
  createRow: (input: { projectId: string; name: string; branchName: string | null; mode: "reuse" | "detached"; absPath: string }) => { id: string };
  setRowPath: (id: string, absPath: string) => boolean;
  /** Removes the row and its folder through the worktree manager (foreign folders: `git worktree remove`, branch kept). */
  removeRow: (id: string) => Promise<boolean>;
  /** A terminal, a sub-agent or a Topics process has its working directory in this folder. */
  liveInside: (absPath: string) => boolean;
  /** A card is working in this row right now. */
  taskActive: (rowId: string) => boolean;
  /** `ok: false` means git could not say, which counts as dirty. */
  dirt: (absPath: string) => Promise<{ ok: boolean; paths: string[]; unregistered?: boolean }>;
  now?: () => Date;
}

const isLinkedCheckout = (absPath: string): boolean => {
  try { return lstatSync(join(absPath, ".git")).isFile(); } catch { return false; }
};

/** The submodules of a checkout that are initialised: git refuses to move or remove such a worktree. */
async function hasInitializedSubmodules(git: GitRunner, absPath: string): Promise<boolean> {
  if (!existsSync(join(absPath, ".gitmodules"))) return false;
  const r = await git(absPath, ["submodule", "status"]);
  if (r.code !== 0) return true; // cannot tell: treat as present, never move on a guess
  return r.stdout.split("\n").some((l) => l.length > 0 && !l.startsWith("-"));
}

/** A name for the moved folder: the row's own, else the folder's, made free among the rows and the folders of the project. */
function targetName(wanted: string, taken: ReadonlySet<string>, slugDir: string): string {
  let present = new Set<string>();
  try { present = new Set(readdirSync(slugDir)); } catch { /* the folder is made at the move */ }
  const all = new Set([...taken, ...present]);
  return nameForAdopted(wanted, all);
}

export interface RelocateFacts {
  from: string;
  project: KnownProject | null;
  row: RelocateRow | null;
  listed: ListedWorktree | null;
}

async function gatherFacts(deps: RelocateDeps, rawPath: string): Promise<RelocateFacts> {
  const from = canonicalPath(rawPath);
  const row = deps.rowAt(rawPath) ?? deps.rowAt(from);
  const projects = deps.projects();
  let project: KnownProject | null = null;
  if (row) project = projects.find((p) => p.id === row.projectId) ?? null;
  if (!project && existsSync(from)) project = canonicalProjectFor(from, projects, { worktreeRoot: deps.root() });
  let listed: ListedWorktree | null = null;
  if (project) {
    const list = await listRepoWorktrees(deps.git, project.path).catch(() => null);
    listed = list?.find((w) => canonicalPath(w.path) === from) ?? null;
  }
  return { from, project, row, listed };
}

/**
 * What `action` would do to the folder, and whether it may. Reads only: nothing
 * is written. This is the preview the person confirms before anything runs.
 */
export async function checkRelocation(deps: RelocateDeps, action: RelocateAction, rawPath: string): Promise<RelocateCheckPayload> {
  if (action === "quarantine" || action === "restore") return (await checkInsideRoot(deps, action, rawPath)).check;
  const facts = await gatherFacts(deps, rawPath);
  return checkWith(deps, action, facts);
}

async function checkWith(deps: RelocateDeps, action: RelocateAction, facts: RelocateFacts): Promise<RelocateCheckPayload> {
  const { from, project, row, listed } = facts;
  const refusals: RelocateRefusal[] = [];
  const warnings: RelocateWarning[] = [];
  let to: string | null = null;

  const roots = [deps.root(), ...(deps.extraRoots?.() ?? [])].map(canonicalPath);
  const present = existsSync(from);
  if (roots.some((r) => isInsideDir(from, r))) refusals.push("inside-root");
  else if (!present) refusals.push("missing");
  else if (!isLinkedCheckout(from)) refusals.push("not-linked");
  else if (!project) refusals.push("no-project");
  else if (!listed) refusals.push("not-listed");

  // Adopting changes nothing on disk, so it needs no more than "this is a real worktree of a known project".
  if (refusals.length === 0 && action === "adopt" && row) warnings.push("already-adopted");

  if (refusals.length === 0 && action !== "adopt") {
    const dirt = await deps.dirt(from);
    if (!dirt.ok || dirt.paths.length > 0) refusals.push("dirty");
    if (await hasInitializedSubmodules(deps.git, from)) refusals.push("submodules");
    if (listed?.locked) refusals.push("locked");
    if (deps.liveInside(from)) refusals.push("live-session");
    if (row && deps.taskActive(row.id)) refusals.push("active-task");
    if (action === "move" && project) {
      const slugDir = join(deps.root(), project.slug);
      const taken = deps.namesFor(project.id);
      if (row) taken.delete(row.name);
      to = join(slugDir, targetName(row?.name ?? basename(from), taken, slugDir));
      if (existsSync(to)) refusals.push("target-exists");
      warnings.push("transcripts");
    }
    if (action === "remove") {
      if (listed?.branch && !listed.detached) warnings.push("branch-kept");
      else if (project && (await headStatusOfCheckout({ absPath: from, branchName: null, mode: "detached" }, project.path, deps.git)) !== "merged") {
        refusals.push("unmerged-commits");
      }
    }
  }

  return {
    action, from, to, projectId: project?.id ?? null, projectName: project?.slug ?? null,
    rowId: row?.id ?? null, ok: refusals.length === 0, refusals, warnings,
  };
}

/** Runs the action, after checking it again: the folder may have changed since the preview. */
export async function runRelocation(deps: RelocateDeps, action: RelocateAction, rawPath: string): Promise<RelocateResultPayload> {
  if (action === "quarantine" || action === "restore") return runInsideRoot(deps, action, rawPath);
  const facts = await gatherFacts(deps, rawPath);
  const check = await checkWith(deps, action, facts);
  if (!check.ok) return { ok: false, check };
  if (!facts.project) return { ok: false, check };
  try {
    if (action === "adopt") return adopt(deps, check, facts);
    if (action === "move") return await move(deps, check, facts);
    return await remove(deps, check, facts);
  } catch (err) {
    return { ok: false, check, error: err instanceof Error ? err.message : String(err) };
  }
}

function adopt(deps: RelocateDeps, check: RelocateCheckPayload, f: RelocateFacts): RelocateResultPayload {
  if (f.row) return { ok: true, check, rowId: f.row.id };
  const project = f.project!;
  const detached = !f.listed || f.listed.detached || !f.listed.branch;
  const name = nameForAdopted(basename(f.from), deps.namesFor(project.id));
  const made = deps.createRow({
    projectId: project.id, name, branchName: detached ? null : f.listed!.branch,
    mode: detached ? "detached" : "reuse", absPath: f.from,
  });
  return { ok: true, check, rowId: made.id };
}

async function move(deps: RelocateDeps, check: RelocateCheckPayload, f: RelocateFacts): Promise<RelocateResultPayload> {
  const project = f.project!;
  const to = check.to!;
  mkdirSync(dirname(to), { recursive: true });
  const moved = await deps.git(project.path, ["worktree", "move", f.from, to]);
  if (moved.code !== 0) return { ok: false, check, error: (moved.stderr || moved.stdout || "git worktree move failed").trim() };
  // `repair` makes the two-way pointers agree whatever the filesystem did to the path.
  await deps.git(project.path, ["worktree", "repair", to]).catch(() => undefined);

  const rollback = async (): Promise<void> => { await deps.git(project.path, ["worktree", "move", to, f.from]).catch(() => undefined); };
  const list = await listRepoWorktrees(deps.git, project.path).catch(() => null);
  if (!list?.some((w) => canonicalPath(w.path) === canonicalPath(to))) {
    await rollback();
    return { ok: false, check, error: "git does not list the worktree at its new path; it was put back" };
  }

  let rowId: string;
  try {
    if (f.row) {
      if (!deps.setRowPath(f.row.id, to)) throw new Error("the row could not be updated");
      rowId = f.row.id;
    } else {
      const detached = !f.listed || f.listed.detached || !f.listed.branch;
      const made = deps.createRow({
        projectId: project.id, name: nameForAdopted(basename(to), deps.namesFor(project.id)),
        branchName: detached ? null : f.listed!.branch, mode: detached ? "detached" : "reuse", absPath: to,
      });
      rowId = made.id;
    }
  } catch (err) {
    await rollback();
    return { ok: false, check, error: `${err instanceof Error ? err.message : String(err)}; the worktree was put back` };
  }
  writeOwnerMarker(to, { worktreeId: rowId, projectId: project.id, createdAt: (deps.now?.() ?? new Date()).toISOString() });
  return { ok: true, check, to, rowId };
}

async function remove(deps: RelocateDeps, check: RelocateCheckPayload, f: RelocateFacts): Promise<RelocateResultPayload> {
  const project = f.project!;
  if (f.row) {
    const gone = await deps.removeRow(f.row.id);
    return gone ? { ok: true, check, rowId: f.row.id } : { ok: false, check, error: "the worktree could not be removed" };
  }
  // No `--force`: git itself refuses a dirty or locked checkout.
  const r = await deps.git(project.path, ["worktree", "remove", f.from]);
  return r.code === 0 ? { ok: true, check } : { ok: false, check, error: (r.stderr || r.stdout || "git worktree remove failed").trim() };
}

// ─── Inside the root: quarantine and restore ──────────────────────────────

/** The roots, resolved: a path is compared to them only in its canonical form. */
const rootsOf = (deps: RelocateDeps): string[] => [deps.root(), ...(deps.extraRoots?.() ?? [])].map(canonicalPath);

/** Whether a by-hand `quarantine` or `restore` may run on this path, and the root it acts in. */
async function checkInsideRoot(
  deps: RelocateDeps,
  action: "quarantine" | "restore",
  rawPath: string,
): Promise<{ check: RelocateCheckPayload; root: string | null }> {
  const from = canonicalPath(rawPath);
  const refusals: RelocateRefusal[] = [];
  let to: string | null = null;
  let root: string | null = null;
  if (action === "restore") {
    for (const r of rootsOf(deps)) {
      const q = findQuarantined(r, from);
      if (q) { root = r; to = q.from; break; }
    }
    if (!root || !to) refusals.push("not-quarantined");
    else if (!surelyAbsent(to)) refusals.push("target-exists");
  } else {
    root = rootsOf(deps).find((r) => slugAndName(r, from)) ?? null;
    if (!root) refusals.push("not-a-ghost");
    else if (surelyAbsent(from)) refusals.push("missing");
    else if (!(await isLooseFolder(deps, from))) refusals.push("not-a-ghost");
    else if (deps.liveInside(from)) refusals.push("live-session");
  }
  const check: RelocateCheckPayload = {
    action, from, to, projectId: null, projectName: null, rowId: null,
    ok: refusals.length === 0, refusals, warnings: [],
  };
  return { check, root };
}

/** A real folder with no `.git` (nor its parent), no row, and that no known repository lists. */
async function isLooseFolder(deps: RelocateDeps, absPath: string): Promise<boolean> {
  try {
    if (!lstatSync(absPath).isDirectory()) return false;
  } catch {
    return false;
  }
  if (!surelyAbsent(join(absPath, ".git")) || !surelyAbsent(join(dirname(absPath), ".git"))) return false;
  if (deps.rowAt(absPath)) return false;
  const { listed } = await indexListedWorktrees(deps.git, deps.projects());
  return !listed.has(absPath);
}

async function runInsideRoot(deps: RelocateDeps, action: "quarantine" | "restore", rawPath: string): Promise<RelocateResultPayload> {
  const { check, root } = await checkInsideRoot(deps, action, rawPath);
  if (!check.ok || !root) return { ok: false, check };
  if (action === "restore") {
    const back = restoreQuarantined(root, check.from);
    return back ? { ok: true, check, to: back } : { ok: false, check, error: "the folder could not be moved back" };
  }
  const moved = quarantineGhostFolder(root, check.from, deps.now?.() ?? new Date(), { requireMarker: false });
  return moved ? { ok: true, check, to: moved } : { ok: false, check, error: "the folder changed since the preview and was left where it is" };
}
