// Auto-merge a task's worktree branch into its project's main checkout on approve.
//
// Opt-in per board (board_settings.dispatch_auto_merge, default OFF). The review
// route calls tryMerge() after a human approves (review → done). Philosophy:
// programmatic when it's a CLEAN merge (the common case for short-lived task
// branches — zero AI, zero tokens), AI only when there's a real CONFLICT to
// resolve (handed back to the task's own agent, which has the context of what it
// changed).
//
// Git safety (deliberate):
//   • NEVER touch a dirty working tree — a concurrent human/agent session may have
//     uncommitted WIP in the shared main checkout. We refuse (skip) rather than
//     stash someone else's work or fold it into a merge commit.
//   • NEVER merge into a checkout that isn't on `main` (its HEAD is the fork point;
//     merging elsewhere would land on the wrong branch).
//   • NO push — landing is local only; the release pipeline stays the sole pusher.
//   • On any non-zero merge we `merge --abort`, so main is never left mid-conflict.
//   • Serialized per repo path, so two approvals on the same project can't race.

export type AutoMergeResult =
  | { status: "merged"; commit: string; branch: string }
  | { status: "conflict"; branch: string }
  | { status: "nothing"; branch: string }
  | { status: "skipped"; reason: string };

/** Where a task's work lives, resolved from its dispatch topic → worktree → project. */
export interface TaskMergeTarget {
  /** Absolute path of the project's MAIN checkout (the merge target). */
  repoPath: string;
  /** The task's worktree branch, e.g. `topics/lyrical-cobra`. */
  branch: string;
  /** Branch to merge INTO (the integration branch). */
  defaultBranch: string;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AutoMergeDeps {
  /**
   * Resolve a task to its merge target. `null` ⇒ nothing to merge (the task ran
   * in-place with no worktree, or its worktree isn't a `branch`-mode one).
   */
  resolveTaskMerge: (taskId: string) => TaskMergeTarget | null;
  /** Injected for tests. Default: real `git` via Bun.spawn (never throws — returns the code). */
  runGit?: (cwd: string, args: string[]) => Promise<GitRunResult>;
  log?: (msg: string, err?: unknown) => void;
}

async function defaultRunGit(cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

export function createTaskAutoMerge(deps: AutoMergeDeps) {
  const runGit = deps.runGit ?? defaultRunGit;
  const log = deps.log ?? (() => {});

  // Serialize per repo path so two approvals on the same project never run
  // overlapping git operations against the same working tree.
  const queues = new Map<string, Promise<unknown>>();
  function chain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    queues.set(key, tail);
    return next;
  }

  async function tryMerge(taskId: string, title: string): Promise<AutoMergeResult> {
    const target = deps.resolveTaskMerge(taskId);
    if (!target) {
      return { status: "skipped", reason: "nessun worktree/branch per il task (in-place o non dispatchato)" };
    }
    const { repoPath, branch, defaultBranch } = target;

    return chain(repoPath, async (): Promise<AutoMergeResult> => {
      try {
        // Precondition (a): the checkout is on the integration branch. Its HEAD is
        // the fork point of task branches; merging anywhere else lands wrong.
        const head = await runGit(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
        const cur = head.stdout.trim();
        if (cur !== defaultBranch) {
          return { status: "skipped", reason: `il checkout è su '${cur || "detached HEAD"}', non '${defaultBranch}'` };
        }

        // Precondition (b): clean working tree — never merge into someone's WIP.
        const st = await runGit(repoPath, ["status", "--porcelain"]);
        if (st.stdout.trim() !== "") {
          return { status: "skipped", reason: "working tree sporco (WIP non committata) — mergia a mano o pulisci il checkout" };
        }

        // Precondition (c): the branch exists and has commits main doesn't.
        const ahead = await runGit(repoPath, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
        if (ahead.code !== 0) {
          return { status: "skipped", reason: `branch '${branch}' non trovato o non confrontabile con '${defaultBranch}'` };
        }
        if (ahead.stdout.trim() === "0") {
          return { status: "nothing", branch };
        }

        // Merge. --no-ff keeps a merge commit so the landing is auditable even for a
        // fast-forwardable branch.
        const msg = `merge task ${taskId}: ${title}`.replace(/\s+/g, " ").slice(0, 200);
        const merge = await runGit(repoPath, ["merge", "--no-ff", "-m", msg, branch]);
        if (merge.code === 0) {
          const rev = await runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
          return { status: "merged", commit: rev.stdout.trim(), branch };
        }

        // Non-zero: conflict (or any failure). Abort so main is never left mid-merge.
        await runGit(repoPath, ["merge", "--abort"]).catch(() => undefined);
        return { status: "conflict", branch };
      } catch (e) {
        log(`[automerge] tryMerge failed for ${taskId}`, e);
        // Best-effort cleanup, then report as a skip so the approve never breaks.
        await runGit(repoPath, ["merge", "--abort"]).catch(() => undefined);
        return { status: "skipped", reason: `errore interno durante il merge: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
  }

  return { tryMerge };
}

export type TaskAutoMerge = ReturnType<typeof createTaskAutoMerge>;
