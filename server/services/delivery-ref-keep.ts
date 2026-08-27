/**
 * THE REF THAT KEEPS A DELIVERY COMMIT ALIVE after its branch is deleted.
 *
 * ── The measurement that opened this ───────────────────────────────────────
 * On 286 `done` cards carrying a `delivery_commit` written BY THE SYSTEM (git
 * wrote those forty characters, not an agent's prose), 213 pointed at an object
 * the repository no longer holds. The chain is short and it has no villain:
 * the land is a SQUASH, `worktree-manager.ts` then runs `git branch -D`, and
 * from that instant the agent's commit is reachable from no ref at all. The
 * next `gc` is free to drop it, and it does: `git fsck --unreachable` returns
 * zero objects on a repository where 213 delivery commits used to live.
 *
 * ── Why it matters more than the disk it costs ─────────────────────────────
 * `deliveryReportChecks.ts` raises `sha-missing` when a cited commit resolves
 * nowhere. With three quarters of the column pointing at nothing, that finding
 * cannot separate «the commit was pruned» from «the agent invented the sha»,
 * and those are not two shades of the same thing: one is housekeeping, the
 * other is a delivery that never happened. On the same board 17 cards had a
 * branch STILL ALIVE and cited a commit that is not in it. Those are
 * inventions, and they were sitting invisible among 196 prunings.
 *
 * ── What a ref buys ────────────────────────────────────────────────────────
 * A ref is 41 bytes. It holds no working tree, it is not pushed (the default
 * refspec only carries `refs/heads/*`), and it survives both `branch -D` and
 * `gc --prune=now`, because reachability is the only thing gc asks about. So
 * at delivery time we plant `refs/consegne/<taskId>` on the delivered sha, and  allow-italian: the ref name is the subject
 * from that point on a missing sha means ONE thing.
 *
 * ── The expiry, which is the decision this module had to make ──────────────
 * 2.543 done cards would mean 2.543 refs if nothing ever expires. The ref
 * itself is free; what is not free is the object graph it pins, which never
 * shrinks. So the ref is dropped once the card has been `done` for longer than
 * the retention window, whose default is the ninety days this repo already
 * declares in `gc.pruneExpire` (see `own-commits.ts`, which documents the same
 * number for the same reason). One horizon, not two.
 *
 * The alternative on the table was a single multi-valued `refs/consegne/tutte`.  allow-italian: the ref name is the subject
 * It was dropped deliberately: a ref points at ONE object, so keeping N commits
 * alive from one ref means a commit with N parents rewritten at every delivery
 * (or a chain), you cannot let a single entry fall, and `git cat-file -t <sha>`
 * stops being the whole verification.
 *
 * ── Contract, the same one the rest of this area uses ──────────────────────
 * `null` means NOT ACCOUNTABLE (git failed, the path is not a repo, the card is
 * unknown), never `false` and never «drop it». Nothing here may ever throw into
 * a delivery: a hiccup of git must not refuse work that was really done.
 */
import { defaultRunGit, type GitRunResult } from "./own-commits";

/** The namespace, spelled once. Everything else derives from it. */
export const DELIVERY_REF_PREFIX = "refs/consegne";

/**
 * How long a closed card keeps its delivery reachable. Ninety days is not a
 * fresh opinion: it is `gc.pruneExpire` on this repo, i.e. the horizon after
 * which an unreachable object was already assumed gone. `0` means never expire.
 */
export const DELIVERY_REF_RETENTION_DAYS = 90;

export type RunGit = (cwd: string, args: string[]) => Promise<GitRunResult>;

/**
 * A task id is not a ref name until someone checks it. Ids are uuids today, but
 * this builds a path that git will happily create: one `..`, one leading dash,
 * one `.lock` suffix and the update either escapes the namespace or is refused
 * with a message nobody reads. `null` = not a safe name, so no ref.
 */
export function deliveryRefName(taskId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) return null;
  if (taskId.includes("..") || taskId.endsWith(".lock") || taskId.endsWith(".")) return null;
  return `${DELIVERY_REF_PREFIX}/${taskId}`;
}

/** The id back out of a ref name, `null` when the ref is not one of ours. */
export function taskIdOfDeliveryRef(ref: string): string | null {
  const prefix = `${DELIVERY_REF_PREFIX}/`;
  if (!ref.startsWith(prefix)) return null;
  const id = ref.slice(prefix.length);
  return id.length > 0 && !id.includes("/") ? id : null;
}

export interface KeepDeliveryArgs {
  /** Any checkout of the repository: refs are shared by every worktree. */
  repoPath: string;
  taskId: string;
  /** The delivered sha. A short sha is fine, git resolves it. */
  commit: string;
  runGit?: RunGit;
}

/**
 * Plant the ref. `true` = the object is now reachable and will outlive both the
 * branch and the next gc; `false` = it could not be planted, and the caller
 * carries on regardless, because a delivery is never refused over a ref.
 */
export async function keepDeliveryCommit(args: KeepDeliveryArgs): Promise<boolean> {
  const ref = deliveryRefName(args.taskId);
  if (!ref || !/^[0-9a-f]{4,40}$/i.test(args.commit)) return false;
  const run = args.runGit ?? defaultRunGit;
  // The type is asked FIRST, and not out of caution: `update-ref` accepts any
  // object, so a tag or a tree would be pinned just as happily and the ref
  // would then answer a question nobody asked. It also turns a short sha into
  // the full one, which is what the column holds.
  const type = await run(args.repoPath, ["cat-file", "-t", args.commit]);
  if (type.code !== 0 || type.stdout.trim() !== "commit") return false;
  const full = await run(args.repoPath, ["rev-parse", "--verify", `${args.commit}^{commit}`]);
  const sha = full.code === 0 ? full.stdout.trim() : args.commit;
  const res = await run(args.repoPath, ["update-ref", ref, sha]);
  return res.code === 0;
}

/** Every delivery this repository is keeping alive. `null` = git could not say. */
export async function listKeptDeliveries(
  repoPath: string,
  runGit: RunGit = defaultRunGit,
): Promise<Array<{ taskId: string; ref: string; commit: string }> | null> {
  const res = await runGit(repoPath, [
    "for-each-ref", "--format=%(refname) %(objectname)", `${DELIVERY_REF_PREFIX}/`,
  ]);
  if (res.code !== 0) return null;
  const out: Array<{ taskId: string; ref: string; commit: string }> = [];
  for (const line of res.stdout.split("\n")) {
    const [ref, commit] = line.trim().split(/\s+/);
    if (!ref || !commit) continue;
    const taskId = taskIdOfDeliveryRef(ref);
    if (taskId) out.push({ taskId, ref, commit });
  }
  return out;
}

/** What the board knows about a card, reduced to what the expiry needs. */
export interface DeliveryRefLife {
  /** `null` = no such card here. Unknown is not the same as closed. */
  status: string | null;
  /** ISO timestamp of the closing, `null` when the card never recorded one. */
  completedAt: string | null;
}

export interface DropDecision {
  drop: boolean;
  /** Why, in one word, for the log line and for the tests. */
  reason: "open" | "unknown" | "undated" | "kept" | "expired" | "forever";
}

/**
 * Does this ref still have a job? Four ways to say KEEP and one to say drop,
 * and the asymmetry is the point: dropping is irreversible (the object goes at
 * the next gc and no one can tell afterwards whether it was ever there), while
 * keeping costs 41 bytes. So anything we cannot date, we keep.
 */
export function decideDeliveryRefDrop(
  life: DeliveryRefLife,
  now: number,
  retentionDays: number = DELIVERY_REF_RETENTION_DAYS,
): DropDecision {
  if (retentionDays <= 0) return { drop: false, reason: "forever" };
  // Unknown card: the ref may belong to a board this database does not hold
  // (one repository, several projects, an app reinstalled next to its repo).
  // Dropping on absence would quietly delete another board's evidence.
  if (life.status === null) return { drop: false, reason: "unknown" };
  if (life.status !== "done") return { drop: false, reason: "open" };
  if (!life.completedAt) return { drop: false, reason: "undated" };
  const closed = Date.parse(life.completedAt);
  if (!Number.isFinite(closed)) return { drop: false, reason: "undated" };
  const ageDays = (now - closed) / 86_400_000;
  return ageDays > retentionDays
    ? { drop: true, reason: "expired" }
    : { drop: false, reason: "kept" };
}

export interface PruneDeliveryRefsArgs {
  repoPath: string;
  /** The card behind a ref, as the database has it now. */
  lifeOf: (taskId: string) => DeliveryRefLife;
  now?: number;
  retentionDays?: number;
  runGit?: RunGit;
}

export interface PruneSummary {
  kept: number;
  dropped: string[];
}

/**
 * One pass of the broom over a repository. `null` = the refs could not be read,
 * so nothing was touched: the pass says nothing rather than guessing.
 */
export async function pruneDeliveryRefs(args: PruneDeliveryRefsArgs): Promise<PruneSummary | null> {
  const run = args.runGit ?? defaultRunGit;
  const retention = args.retentionDays ?? DELIVERY_REF_RETENTION_DAYS;
  if (retention <= 0) return { kept: 0, dropped: [] };
  const refs = await listKeptDeliveries(args.repoPath, run);
  if (refs === null) return null;
  const now = args.now ?? Date.now();
  const summary: PruneSummary = { kept: 0, dropped: [] };
  for (const r of refs) {
    const verdict = decideDeliveryRefDrop(args.lifeOf(r.taskId), now, retention);
    if (!verdict.drop) { summary.kept += 1; continue; }
    // `-d <ref> <sha>` and not a bare delete: the sha is the guard against
    // deleting a ref that moved between the read and the write, which is how a
    // sweep loses something it never looked at.
    const res = await run(args.repoPath, ["update-ref", "-d", r.ref, r.commit]);
    if (res.code === 0) summary.dropped.push(r.taskId);
    else summary.kept += 1;
  }
  return summary;
}
