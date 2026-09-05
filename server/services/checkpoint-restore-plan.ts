/**
 * The restore plan: WHICH paths a rewind may touch, decided before any is.
 *
 * WHY A PLAN AND NOT A RESTORE. The first `restoreTurnCheckpoint` did
 * `git restore --source=<checkpoint> -- .` and then deleted every non-ignored
 * path the checkpoint did not know. On a folder nobody else is in, that IS
 * "the tree as it was before the turn". On the folder the feature is used in,
 * it is not: a person keeps an editor open on the same files, a second chat
 * may be writing in the same worktree, and neither of them appears in the
 * checkpoint. So the old restore rewrote a file the turn never touched (wiping
 * the person's edit) and deleted a file the person had created (the checkpoint
 * had never seen it). Undoing one turn must not undo everybody.
 *
 * THE MANIFEST. Two snapshots bound a turn: the `target` the user wants to go
 * back to, and `latest`, the newest snapshot of the same session, which is the
 * last state this session is known to have produced (normally the `after`
 * mark of the last turn). `git diff target latest` is then exactly the set of
 * paths this session changed since the target: created (undo deletes them),
 * modified (undo rewrites them from the target) or deleted (undo recreates
 * them). Nothing outside that set is ever touched.
 *
 * OWNERSHIP, path by path. The manifest says what the session wrote; it does
 * not say what happened AFTER `latest`. A manifest path whose current worktree
 * content is not what `latest` recorded was touched by somebody else since,
 * and the session no longer owns it: it is skipped, and the skip is reported
 * with a reason instead of being silently rewritten. A plan that restores four
 * paths of five and names the fifth is a good plan; the fifth is somebody
 * else's work.
 *
 * BLOCKERS refuse the WHOLE plan, because in those states no manifest can be
 * trusted: a turn that is still writing (its `after` mark does not exist yet,
 * so its files are still moving), or another session that has snapshotted in
 * this folder after we did (its turn interleaves with ours and neither diff
 * describes the folder). The codes are machine-readable and carry no prose:
 * the client owns its own words.
 *
 * WHO KNOWS THAT A TURN IS RUNNING: the caller, not git. The first draft
 * inferred it from the refs ("newest snapshot is a `before` and the worktree
 * differs from it") and the test that measured it found the hole at once: a
 * turn that writes nothing records no `after` mark, correctly, so the newest
 * snapshot stays a `before` forever, and the next keystroke by the person at
 * the editor would have blocked every restore of that chat, permanently. Git
 * cannot tell "an agent is writing right now" from "the last turn wrote
 * nothing and somebody typed since". The server can: it holds the active
 * stream per session, and passes the fact in as `turnActive`.
 */

import { existsSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  CHECKPOINT_REF_ROOT,
  isGitRepo,
  listTurnCheckpoints,
  runGit,
  sessionRefSlug,
  withWorktreeIndex,
  type RestoreOutcome,
  type TurnCheckpoint,
} from "./turn-checkpoints";

// The plan's shape lives in `shared/checkpoint-plan.ts`, ONE declaration read
// by the routes, the client and this module. `legacy-checkpoint` is a code
// this module never emits: the manual-checkpoint route synthesises it for a
// checkpoint saved before file snapshots existed.
import type {
  RestoreBlocker,
  RestorePathState,
  RestorePlan,
  RestorePlanEntry,
} from "../../shared/checkpoint-plan";

/**
 * A `git restore` with hundreds of argv entries is fine on every platform we
 * ship to, but "fine" has a ceiling somewhere near the OS argument limit, and
 * a turn that regenerated a lockfile directory can produce thousands of paths.
 * Batches this size never get near it.
 */
const RESTORE_BATCH = 200;

/** Pathspecs are globs by default: a path with `*` or `[` in it would match
 *  neighbours. Every git call that takes manifest paths runs with this. */
const LITERAL_PATHS = { GIT_LITERAL_PATHSPECS: "1" };

function refused(targetCommit: string, blockers: RestoreBlocker[]): RestorePlan {
  return { targetCommit, latestCommit: null, entries: [], skipped: [], blockers, safe: false };
}

/**
 * `git diff --name-status` between two commits, as manifest entries.
 *
 * `--no-renames` on purpose: with rename detection on, a file the turn moved
 * comes back as one `R100 old new` record, and undoing it is still two
 * operations (delete `new`, recreate `old`). Asking git not to pair them gives
 * those two records directly and leaves nothing to split.
 */
async function manifestBetween(projectPath: string, from: string, to: string): Promise<RestorePlanEntry[]> {
  const r = await runGit(["diff", "--name-status", "-z", "--no-renames", from, to], projectPath);
  if (r.code !== 0) throw new Error(r.stderr || `git diff exited ${r.code}`);
  const fields = r.stdout.split("\0");
  const out: RestorePlanEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i][0];
    const path = fields[i + 1];
    if (!path) continue;
    // `T` is a type change (file to symlink or back): the target holds the
    // shape we want back, so it restores like a modification.
    const state: RestorePathState | null =
      status === "A" ? "added" : status === "D" ? "deleted" : status === "M" || status === "T" ? "modified" : null;
    if (state) out.push({ path, state });
  }
  return out;
}

/**
 * Another session's newest checkpoint in this folder, if it is younger than
 * `latest`. One `for-each-ref` over the whole root; the slug is the segment
 * right after the root. Git dates are whole seconds, so a snapshot taken in
 * the same second as ours does not count as later: the per-path ownership
 * check still protects whatever it wrote.
 */
async function otherSessionAfter(
  projectPath: string, sessionKey: string, latest: TurnCheckpoint,
): Promise<RestoreBlocker | null> {
  const r = await runGit(["for-each-ref", "--format=%(refname)%09%(creatordate:unix)", CHECKPOINT_REF_ROOT], projectPath);
  if (r.code !== 0 || !r.stdout) return null;
  const ours = sessionRefSlug(sessionKey);
  const ourTime = Math.floor(Date.parse(latest.createdAt) / 1000);
  let newest: { slug: string; at: number } | null = null;
  for (const line of r.stdout.split("\n")) {
    const [ref, unix] = line.split("\t");
    if (!ref?.startsWith(CHECKPOINT_REF_ROOT + "/")) continue;
    const slug = ref.slice(CHECKPOINT_REF_ROOT.length + 1).split("/")[0];
    const at = Number.parseInt(unix ?? "", 10);
    if (!slug || slug === ours || !Number.isFinite(at) || at <= ourTime) continue;
    if (!newest || at > newest.at) newest = { slug, at };
  }
  if (!newest) return null;
  return { code: "other-session-active", detail: `${newest.slug} at ${new Date(newest.at * 1000).toISOString()}` };
}

export interface RestorePlanOptions {
  /** Whether this session is streaming a turn right now. Only the caller
   *  holding the active streams knows; absent means "not known", which the
   *  plan reads as not active. */
  turnActive?: boolean;
}

export async function buildRestorePlan(
  projectPath: string, sessionKey: string, targetCommit: string, opts?: RestorePlanOptions,
): Promise<RestorePlan> {
  if (!(await isGitRepo(projectPath))) return refused(targetCommit, [{ code: "not-a-repo" }]);

  const all = await listTurnCheckpoints(projectPath, sessionKey);
  const latest = all[0];
  const target = all.find((c) => c.commit === targetCommit);
  if (!latest || !target) {
    return refused(targetCommit, [{ code: "no-checkpoint", detail: `${all.length} checkpoints in session` }]);
  }

  const blockers: RestoreBlocker[] = [];
  // While the agent is still writing, the target is usually the newest
  // snapshot itself (the `before` of the running turn), so the manifest is
  // empty and the restore would be a silent no-op: the person would click
  // "undo" and watch nothing happen. The blocker exists to say that out loud.
  // It is not what protects the files; the per-path ownership check below
  // does that regardless.
  if (opts?.turnActive === true) blockers.push({ code: "turn-in-progress" });
  const other = await otherSessionAfter(projectPath, sessionKey, latest);
  if (other) blockers.push(other);

  const manifest = await manifestBetween(projectPath, target.commit, latest.commit);

  // "Which manifest paths did somebody else touch since `latest`?" is one
  // question to git, "how does the worktree differ from `latest`?", asked
  // through a temporary index so untracked files count and staged ones do not
  // interfere (see `withWorktreeIndex`).
  const changedSinceLatest = await withWorktreeIndex(projectPath, async (env) => {
    const r = await runGit(["diff", "--cached", "--name-only", "-z", latest.commit], projectPath, env);
    if (r.code !== 0) throw new Error(r.stderr || `git diff exited ${r.code}`);
    return new Set(r.stdout.split("\0").filter(Boolean));
  });

  const entries: RestorePlanEntry[] = [];
  const skipped: RestorePlanEntry[] = [];
  for (const entry of manifest) {
    if (changedSinceLatest.has(entry.path)) skipped.push({ ...entry, reason: "changed-after-checkpoint" });
    else entries.push(entry);
  }

  return { targetCommit, latestCommit: latest.commit, entries, skipped, blockers, safe: blockers.length === 0 };
}

/**
 * Carry the plan out. Throws on an unsafe plan and NEVER widens to the whole
 * tree: a refused restore leaves the folder exactly as it found it.
 *
 * `git restore --source --worktree` rather than `git checkout <commit>`, for
 * the reason the first version already paid for: `checkout` moves HEAD onto
 * the commit and leaves the repository detached. `restore` leaves HEAD and
 * the index where they were.
 */
export async function applyRestorePlan(projectPath: string, plan: RestorePlan): Promise<RestoreOutcome> {
  if (!plan.safe) {
    throw new Error(`restore refused: ${plan.blockers.map((b) => b.code).join(", ")}`);
  }
  const root = resolve(projectPath);

  let removed = 0;
  for (const entry of plan.entries) {
    if (entry.state !== "added") continue;
    const abs = resolve(root, entry.path);
    // Never step outside the project, whatever a crafted path claims to be.
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    try {
      if (existsSync(abs)) {
        unlinkSync(abs);
        removed++;
      }
    } catch {
      // A path we cannot delete is reported by omission, not by an exception:
      // the rest of the rewind is still worth completing.
    }
  }

  const toWrite = plan.entries.filter((e) => e.state !== "added").map((e) => e.path);
  for (let i = 0; i < toWrite.length; i += RESTORE_BATCH) {
    const batch = toWrite.slice(i, i + RESTORE_BATCH);
    const r = await runGit(
      ["restore", "--source", plan.targetCommit, "--worktree", "--", ...batch],
      projectPath,
      LITERAL_PATHS,
    );
    if (r.code !== 0) throw new Error(r.stderr || `git restore exited ${r.code}`);
  }

  const head = await runGit(["symbolic-ref", "--short", "HEAD"], projectPath);
  return {
    restored: toWrite.length,
    removed,
    branch: head.code === 0 ? head.stdout : null,
    conversationRewound: false,
    skipped: plan.skipped,
  };
}
