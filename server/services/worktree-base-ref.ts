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
 * healthy cards. The right base is what is PUBLISHED, that is `origin/main`,
 * brought forward by a fetch before every birth.
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
  const { ref, fetchError } = await fetchRemoteBase(opts.runGit ?? defaultRunGit, repoPath, mainRef);
  const why = fetchError ? `fetch di 'origin/${mainRef}' fallito (${fetchError})` : "";
  if (ref) return { baseRef: ref, fallback: false, reason: why && `${why}: base dalla copia locale` };
  return { baseRef: "HEAD", fallback: true, reason: why || `nessun 'origin/${mainRef}'` };
}
