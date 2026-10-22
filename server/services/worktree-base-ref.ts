/**
 * Where a card's branch is born: from `origin/main`, not from the HEAD of the
 * shared checkout and not from the local `main`.
 *
 * With `baseRef: "HEAD"` every task worktree inherited whatever branch the
 * checkout running the server was on. On 11/08 that single line produced, in one
 * night: task branches carrying 147 commits of other people (the land published
 * third-party work until it learned to take only its own); deliveries resting on
 * commits that never landed; TWO migration number collisions, because the agent
 * counted from a tree stuck at 088 while main was already at 089; a manifest
 * regenerated without somebody else's migration; and an agent that "fixed" two
 * tests on main chasing a message that only existed on an unlanded branch,
 * leaving main red for an hour.
 *
 * Moving to the local `main` only moved the problem: nobody updates it, and on
 * 21/10 it was 646 commits behind (and 6 ahead, a land never published). Card
 * branches were born from stale bases and `land-drags-foreign-commits` fired on
 * healthy cards. The base is therefore what is PUBLISHED, `origin/main`,
 * brought forward by a fetch before every birth.
 *
 * WITH ONE EXCEPTION, and it is the whole reason this file is not three lines:
 * the land writes to the LOCAL main and never pushes. So the moment card A
 * lands, the local main carries work `origin/main` does not have. A card B born
 * from `origin/main` then cannot see A, its land collides with A, and the only
 * repair anybody can suggest — rebase onto the trunk — does nothing, because B
 * is already based on it. The card bounces between review and land forever.
 * When the local main is AHEAD, it is the trunk: it is where the land merges,
 * and it already contains `origin/main` (the land brings it in first, see
 * `syncLandingBase` in task-automerge.ts).
 *
 * THE FETCH IS BOUNDED (that one ref, `--no-tags`, the runner's deadline) and
 * its failure does NOT block the dispatch: if `origin/main` already exists
 * locally we start from that copy and `reason` says the fetch failed (possibly
 * an old base, but still a remote ref); if it does not exist, or there is no
 * remote, we fall back to `HEAD`. The fallback is DECLARED in the result so the
 * caller can warn instead of discovering it from the symptoms: better the old
 * defect than a dispatch that does not start.
 */

import type { GitRunner } from "./own-commits";
import { SPAWN_TIMEOUT, runBounded } from "../lib/bounded-spawn";

export interface WorktreeBaseRef {
  /** Il ref da passare a `worktreeManager.create({ baseRef })`. */
  baseRef: string;
  /**
   * `true` = si è ripiegato su `HEAD` perché il ramo d'integrazione non è
   * verificabile. Non è un errore, è una rinuncia: chi chiama la logga.
   */
  fallback: boolean;
  /** Why we fell back, or why the fetch failed while the base came from the local copy. Empty = all went well. */
  reason: string;
}

export interface WorktreeBaseRefOptions {
  /** The integration branch. Default `main`: its copy on `origin` is used. */
  mainRef?: string;
  /** Iniettato nei test. Default: `git` vero. */
  runGit?: GitRunner;
}

export async function defaultRunGit(cwd: string, args: string[]) {
  const r = await runBounded(["git", "-C", cwd, ...args], { stderr: "pipe", timeoutMs: SPAWN_TIMEOUT.query });
  if (r.spawnFailed) return { code: 1, stdout: "", stderr: r.spawnError ?? "" };
  return { code: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Brings `origin/<branch>` forward with a bounded fetch and says which ref to
 * use: `null` if it does not even exist in cache. Empty `fetchError` = the fetch
 * worked. Shared with the land (`task-automerge.ts`): same base, same fetch.
 */
export async function fetchRemoteBase(
  run: GitRunner,
  repoPath: string,
  branch: string,
): Promise<{ ref: string | null; fetchError: string }> {
  const fetch = await run(repoPath, ["fetch", "--no-tags", "origin", branch]);
  const ref = `origin/${branch}`;
  const have = await run(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]);
  const fetchError = fetch.code === 0 ? "" : (fetch.stderr ?? "").trim().slice(-120) || "fetch fallito";
  return { ref: have.code === 0 ? ref : null, fetchError };
}

/**
 * The trunk a card is born from and lands on.
 *
 * `origin/<branch>` when the local branch has nothing of its own, the LOCAL
 * branch when it carries lands nobody published yet. Returns `null` when there
 * is no remote copy at all: then the caller falls back on its own.
 */
export async function resolveTrunkRef(
  run: GitRunner,
  repoPath: string,
  branch: string,
): Promise<{ ref: string | null; fetchError: string; localAhead: number }> {
  const { ref: remote, fetchError } = await fetchRemoteBase(run, repoPath, branch);
  if (!remote) return { ref: null, fetchError, localAhead: 0 };
  const ahead = await run(repoPath, ["rev-list", "--count", `${remote}..${branch}`]);
  const localAhead = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;
  return { ref: localAhead > 0 ? branch : remote, fetchError, localAhead };
}

/**
 * `repoPath` may be missing (project with no known path): with no repo to ask,
 * we cannot claim the remote exists, and the answer is the fallback.
 *
 * The question is on the full `refs/remotes/origin/<main>`: a file or a branch
 * with the same name would make the request ambiguous.
 */
export async function resolveWorktreeBaseRef(
  repoPath: string | null | undefined,
  opts: WorktreeBaseRefOptions = {},
): Promise<WorktreeBaseRef> {
  const mainRef = opts.mainRef ?? "main";
  if (!repoPath) return { baseRef: "HEAD", fallback: true, reason: "progetto senza path di repo" };
  const { ref, fetchError, localAhead } = await resolveTrunkRef(opts.runGit ?? defaultRunGit, repoPath, mainRef);
  const why = fetchError ? `fetch di 'origin/${mainRef}' fallito (${fetchError})` : "";
  if (ref) {
    const ahead = localAhead > 0
      ? `'${mainRef}' locale è avanti di ${localAhead} commit su origin (land non pubblicati): la base è quello`
      : "";
    return { baseRef: ref, fallback: false, reason: [why && `${why}: base dalla copia locale`, ahead].filter(Boolean).join("; ") };
  }
  return { baseRef: "HEAD", fallback: true, reason: why || `nessun 'origin/${mainRef}'` };
}
